/**
 * Stakeholder deposit simulator — continuous worker that simulates
 * real RWA stakeholders (parking operators, rental owners, royalty
 * issuers) depositing native CSPR into the StakeholderDeposit
 * contract on Casper 2.0 testnet.
 *
 * Each "stakeholder" is a separate key, but for the demo we use the
 * agent's own key with different source_label/source_kind values to
 * simulate multi-stakeholder flow. Real production would use
 * per-stakeholder keys.
 *
 * The actual CSPR transfer happens via the agent's key (we attach the
 * deposit amount as the runtime arg amount — see StakeholderDeposit
 * contract's payable vs arg-amount pattern).
 *
 * Usage:
 *   node scripts/stakeholder-deposit-simulator.ts           # continuous
 *   node scripts/stakeholder-deposit-simulator.ts --count=N  # N deposits then exit
 */

import { readFileSync } from 'fs';
import {
  ContractCallBuilder, Args, CLValue,
  PrivateKey, KeyAlgorithm,
} from 'casper-js-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { recordStakeholderDeposit } from '../src/agent/fundState';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RPC = process.env.CASPER_RPC_URL!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PKG_HASH_FULL = process.env.STAKEHOLDER_DEPOSIT_CONTRACT_HASH ?? '';
const PKG_HASH = PKG_HASH_FULL.replace('hash-', '');

interface Stakeholder {
  label: string;       // "Mall XYZ Operator"
  sourceKind: string;  // "parking" | "rental" | "royalty"
  amountRange: [number, number];  // [min, max] CSPR per deposit
  interval: number;    // ms between deposits
}

const STAKEHOLDERS: Stakeholder[] = [
  {
    label: 'Mall XYZ Operator',
    sourceKind: 'parking',
    amountRange: [10, 100],   // 10-100 CSPR per parking tick
    interval: 45_000,         // every 45 seconds
  },
  {
    label: 'Apt-3B-Jakarta',
    sourceKind: 'rental',
    amountRange: [200, 500],  // 200-500 CSPR monthly rental
    interval: 180_000,        // every 3 minutes
  },
  {
    label: 'Spotify-Royalty-Stream-2026Q2',
    sourceKind: 'royalty',
    amountRange: [5, 50],     // 5-50 CSPR royalty batch
    interval: 90_000,         // every 90 seconds
  },
];

const argv = process.argv.slice(2);
const countArg = argv.find(a => a.startsWith('--count='));
const MAX_DEPOSITS = countArg ? parseInt(countArg.split('=')[1], 10) : Infinity;

async function makeDeposit(sk: PrivateKey, sh: Stakeholder): Promise<string> {
  const amountCspr = randomIn(sh.amountRange);
  const amountMotes = BigInt(Math.floor(amountCspr * 1e9));
  const nonce = Date.now();

  const clArgs = Args.fromMap({
    amount:        CLValue.newCLUint64(amountMotes),
    source_label:  CLValue.newCLString(sh.label.slice(0, 64)),
    source_kind:   CLValue.newCLString(sh.sourceKind.slice(0, 32)),
    strategy_hint: CLValue.newCLString('auto'),
    nonce:         CLValue.newCLUint64(BigInt(nonce)),
  });

  const tx: any = new ContractCallBuilder()
    .byPackageHash(PKG_HASH, 1)
    .entryPoint('deposit')
    .from(sk.publicKey)
    .chainName(process.env.CASPER_CHAIN_NAME || 'casper-test')
    .runtimeArgs(clArgs)
    .payment(3000000000, 1)
    .ttl(1800000)
    .build();
  tx.sign(sk);

  const json = JSON.parse(JSON.stringify(tx));
  const r = await axios.post(RPC, {
    jsonrpc: '2.0', method: 'account_put_transaction',
    params: { transaction: { Version1: json } }, id: 1,
  }, {
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: API_KEY } : {}),
    },
    timeout: 60_000,
  });

  if (r.data.error) {
    throw new Error(`deposit failed: ${JSON.stringify(r.data.error)}`);
  }
  return r.data.result?.transaction_hash?.Version1 ?? '';
}

function randomIn([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  if (!PKG_HASH_FULL) {
    throw new Error('STAKEHOLDER_DEPOSIT_CONTRACT_HASH not set');
  }

  const pem = readFileSync(process.env.AGENT_SECRET_KEY_PATH!, 'utf-8');
  let sk: PrivateKey;
  try { sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519); }
  catch { sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1); }

  console.log(`[deposit-sim] StakeholderDeposit: ${PKG_HASH_FULL}`);
  console.log(`[deposit-sim] Agent: ${sk.publicKey.toHex().slice(0, 16)}...`);
  console.log(`[deposit-sim] Stakeholders: ${STAKEHOLDERS.length}`);
  console.log(`[deposit-sim] Mode: ${MAX_DEPOSITS === Infinity ? 'continuous' : `count=${MAX_DEPOSITS}`}`);
  console.log('');

  let totalDeposits = 0;

  // Round-robin loop across stakeholders with their own intervals.
  const lastRun: Record<string, number> = {};
  for (const sh of STAKEHOLDERS) lastRun[sh.label] = 0;

  while (totalDeposits < MAX_DEPOSITS) {
    const now = Date.now();
    for (const sh of STAKEHOLDERS) {
      if (totalDeposits >= MAX_DEPOSITS) break;
      if (now - (lastRun[sh.label] ?? 0) < sh.interval) continue;

      try {
        const txHash = await makeDeposit(sk, sh);
        const amountCspr = randomIn(sh.amountRange);
        const amountMotes = BigInt(Math.floor(amountCspr * 1e9));
        console.log(
          `[deposit-sim] ${new Date().toISOString()} ` +
          `${sh.label.padEnd(28)} ` +
          `${sh.sourceKind.padEnd(8)} ` +
          `${amountCspr.toFixed(2).padStart(8)} CSPR ` +
          `→ ${txHash}`
        );
        // v0.8.2: record this deposit in the local fund state cache so
        // the dashboard's /api/fund endpoint reflects real activity
        // without needing to query Odra state directly.
        recordStakeholderDeposit(amountMotes.toString());
        lastRun[sh.label] = now;
        totalDeposits += 1;
      } catch (e: any) {
        console.warn(`[deposit-sim] ${sh.label} deposit failed: ${e.message?.slice(0, 100)}`);
      }
    }
    if (totalDeposits < MAX_DEPOSITS) await sleep(5_000);
  }

  console.log(`\n[deposit-sim] Done. ${totalDeposits} deposits total.`);
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });