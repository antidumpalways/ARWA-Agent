/**
 * Demo bootstrap — for v0.8.2 demo recording. Calls deposit_for_strategy
 * on AgentVault v2 with a small amount to populate the dashboard's AUM
 * card. In production this would be triggered automatically by the
 * stakeholderEventConsumer when new deposits arrive.
 *
 * Usage:
 *   node scripts/demo-bootstrap-vault.ts
 */
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import { depositForStrategy, getCustodiedCspr } from '../src/casper/vaultCustodian';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEPOSIT_AMOUNT_MOTES = '5000000000'; // 5 CSPR

async function main() {
  const pem = readFileSync(process.env.AGENT_SECRET_KEY_PATH!, 'utf-8');
  let sk: PrivateKey;
  try { sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519); }
  catch { sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1); }

  console.log('Agent:', sk.publicKey.toHex());

  console.log('\nBefore:');
  const before = await getCustodiedCspr();
  console.log('  custodied CSPR:', before);

  console.log('\nCalling deposit_for_strategy (5 CSPR)...');
  const txHash = await depositForStrategy(
    DEPOSIT_AMOUNT_MOTES,
    'demo-bootstrap-rental-pool',
  );
  console.log('  tx:', txHash);

  // Wait + re-read
  await new Promise(r => setTimeout(r, 5000));
  console.log('\nAfter:');
  const after = await getCustodiedCspr();
  console.log('  custodied CSPR:', after);
  console.log('  delta         :', Number(after) - Number(before), 'motes');

  console.log('\nDone. Check /api/fund on the backend.');
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });