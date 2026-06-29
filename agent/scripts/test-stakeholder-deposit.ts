/**
 * Smoke test for StakeholderDeposit on Casper 2.0 testnet.
 * Calls `deposit(source_label, source_kind, strategy_hint, nonce)` with
 * attached CSPR (1 CSPR) via ContractCallBuilder + TransactionV1.
 */
import { readFileSync } from 'fs';
import {
  ContractCallBuilder, Args, CLValue,
  PrivateKey, KeyAlgorithm,
} from 'casper-js-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PKG_HASH_FULL = process.env.STAKEHOLDER_DEPOSIT_CONTRACT_HASH ?? '';
const PKG_HASH = PKG_HASH_FULL.replace('hash-', '');

const ATTACHED_MOTES = '1000000000'; // 1 CSPR

async function main() {
  if (!PKG_HASH_FULL) {
    throw new Error('STAKEHOLDER_DEPOSIT_CONTRACT_HASH not set in .env');
  }

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  let sk: PrivateKey;
  try { sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519); }
  catch { sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1); }
  const pk = sk.publicKey;

  const clArgs = Args.fromMap({
    amount:        CLValue.newCLUint64(BigInt(ATTACHED_MOTES)),
    source_label:  CLValue.newCLString('P1'),
    source_kind:   CLValue.newCLString('parking'),
    strategy_hint: CLValue.newCLString('auto'),
    nonce:         CLValue.newCLUint64(BigInt(Date.now())),
  });

  const tx: any = new ContractCallBuilder()
    .byPackageHash(PKG_HASH, 1)
    .entryPoint('deposit')
    .from(pk)
    .chainName(process.env.CASPER_CHAIN_NAME || 'casper-test')
    .runtimeArgs(clArgs)
    .payment(3000000000, 1)
    .ttl(1800000)
    .build();

  tx.sign(sk);

  const json = JSON.parse(JSON.stringify(tx));
  console.log('Payload preview:', JSON.stringify(json.payload.fields, null, 2).slice(0, 500));

  const submitBody = {
    jsonrpc: '2.0',
    method: 'account_put_transaction',
    params: { transaction: { Version1: json } },
    id: 1,
  };
  const headers: any = { 'Content-Type': 'application/json' };
  if (API_KEY) headers.Authorization = API_KEY;

  console.log('\nSubmitting deposit tx (attached 1 CSPR)...');
  const r = await axios.post(RPC, submitBody, { headers, timeout: 60000 });
  if (r.data.error) {
    console.error('RPC error:', JSON.stringify(r.data.error));
    process.exit(1);
  }
  const txHash = r.data.result?.transaction_hash?.Version1;
  console.log('Deposit tx hash:', txHash);
  console.log(`https://testnet.cspr.live/deploy/${txHash}`);

  // Wait + verify
  await new Promise(r => setTimeout(r, 8000));
  const verify = await axios.post(RPC, {
    jsonrpc: '2.0', id: 1,
    method: 'info_get_transaction',
    params: { transaction_hash: { Version1: txHash } },
  }, { headers, timeout: 20000 });
  const errMsg = verify.data.result?.execution_info?.execution_result?.Version2?.error_message;
  const consumed = verify.data.result?.execution_info?.execution_result?.Version2?.consumed;
  const transfers = verify.data.result?.execution_info?.execution_result?.Version2?.transfers ?? [];
  console.log('\n=== Verification ===');
  console.log('Error message :', errMsg ?? '(none — success!)');
  console.log('Gas consumed  :', consumed, 'motes');
  console.log('Transfers     :', JSON.stringify(transfers));
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });