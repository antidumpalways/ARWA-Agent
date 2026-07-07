/**
 * Stakeholder deposit simulator — request-driven.
 *
 * Exports `triggerDeposit()` which performs ONE real on-chain
 * deposit into the StakeholderDeposit contract, picking a random
 * stakeholder profile (Mall XYZ / Apt-3B-Jakarta / Spotify).
 *
 * The dashboard calls this via the backend `/api/simulator/tick`
 * endpoint, which then calls `triggerDeposit()` and returns the
 * resulting tx hash. After the deposit finalises, the dashboard
 * fires `/api/cycle` so the agent sees the event, runs the strategy,
 * and writes the audit log — all within one user click.
 */
import { readFileSync } from 'fs';
import {
  ContractCallBuilder, Args, CLValue,
  PrivateKey, KeyAlgorithm,
} from 'casper-js-sdk';
import axios from 'axios';
import { loadConfig } from '../config';

interface StakeholderProfile {
  label: string;
  sourceKind: string;
  amountRange: [number, number];   // [min, max] CSPR
  interval: number;                 // ms (unused in request-driven mode)
}

const STAKEHOLDERS: StakeholderProfile[] = [
  { label: 'Mall XYZ Operator',     sourceKind: 'parking', amountRange: [10, 100],  interval: 45_000 },
  { label: 'Apt-3B-Jakarta',        sourceKind: 'rental',  amountRange: [200, 500], interval: 180_000 },
  { label: 'Spotify-Royalty-Q2',    sourceKind: 'royalty', amountRange: [5, 50],    interval: 90_000 },
];

let nextRoundRobin = 0;

function pickStakeholder(): StakeholderProfile {
  const sh = STAKEHOLDERS[nextRoundRobin % STAKEHOLDERS.length];
  nextRoundRobin += 1;
  return sh;
}

function randomIn([min, max]: [number, number]): number {
  return min + Math.random() * (max - min);
}

let cachedKey: PrivateKey | null = null;
function getAgentKey(): PrivateKey {
  if (cachedKey) return cachedKey;
  const cfg = loadConfig();
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  try { cachedKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519); }
  catch { cachedKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1); }
  return cachedKey;
}

let cachedPkg: string | null = null;
function getPkgHash(): string {
  if (cachedPkg) return cachedPkg;
  const cfg = loadConfig();
  const v = cfg.STAKEHOLDER_DEPOSIT_CONTRACT_HASH;
  if (!v) throw new Error('STAKEHOLDER_DEPOSIT_CONTRACT_HASH not set');
  cachedPkg = v.replace('hash-', '');
  return cachedPkg;
}

export interface DepositResult {
  ok: boolean;
  txHash: string;
  stakeholder: string;
  sourceKind: string;
  amountCspr: number;
  error?: string;
}

/**
 * Trigger ONE on-chain deposit from a random stakeholder.
 * Returns the deploy hash + metadata.
 */
export async function triggerDeposit(): Promise<DepositResult> {
  const cfg = loadConfig();
  const sh = pickStakeholder();
  const amountCspr = randomIn(sh.amountRange);
  const amountMotes = BigInt(Math.floor(amountCspr * 1e9));
  const nonce = Date.now();

  try {
    const sk = getAgentKey();
    const pkgHash = getPkgHash();

    const clArgs = Args.fromMap({
      amount:        CLValue.newCLUint64(amountMotes),
      source_label:  CLValue.newCLString(sh.label.slice(0, 64)),
      source_kind:   CLValue.newCLString(sh.sourceKind.slice(0, 32)),
      strategy_hint: CLValue.newCLString('auto'),
      nonce:         CLValue.newCLUint64(BigInt(nonce)),
    });

    const tx: any = new ContractCallBuilder()
      .byPackageHash(pkgHash, 1)
      .entryPoint('deposit')
      .from(sk.publicKey)
      .chainName(cfg.CASPER_CHAIN_NAME)
      .runtimeArgs(clArgs)
      .payment(3000000000, 1)
      .ttl(1800000)
      .build();
    tx.sign(sk);

    const json = JSON.parse(JSON.stringify(tx));
    const r = await axios.post(cfg.CASPER_RPC_URL, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: json } },
      id: 1,
    }, {
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}),
      },
      timeout: 60_000,
    });

    if (r.data.error) {
      return {
        ok: false,
        txHash: '',
        stakeholder: sh.label,
        sourceKind: sh.sourceKind,
        amountCspr,
        error: JSON.stringify(r.data.error),
      };
    }

    const txHash = r.data.result?.transaction_hash?.Version1 ?? '';
    try {
      const { recordStakeholderDeposit } = await import('../agent/fundState');
      recordStakeholderDeposit(amountMotes.toString());
    } catch {}
    return {
      ok: true,
      txHash,
      stakeholder: sh.label,
      sourceKind: sh.sourceKind,
      amountCspr,
    };
  } catch (e: any) {
    return {
      ok: false,
      txHash: '',
      stakeholder: sh.label,
      sourceKind: sh.sourceKind,
      amountCspr,
      error: e?.message ?? String(e),
    };
  }
}

export const STAKEHOLDER_PROFILES = STAKEHOLDERS;
