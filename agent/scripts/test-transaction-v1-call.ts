/**
 * Test TransactionV1 contract call
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { buildContractCallTransactionV1, signAndSubmitTransactionV1 } from '../src/casper/transactionV1';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
dotenv.config();

async function main() {
  const contractHash = process.env.AGENT_VAULT_CONTRACT_HASH!;
  const keyPath = process.env.AGENT_SECRET_KEY_PATH!;
  const chainName = process.env.CASPER_CHAIN_NAME || 'casper-test';

  console.log('Contract:', contractHash);
  console.log('Chain:', chainName);

  // Load key to get account hash
  const pem = readFileSync(keyPath, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  console.log('Agent pubkey:', pk.toHex());
  console.log('Agent account hash:', pk.accountHash().toHex());

  // Build args for execute_strategy
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  const args: Record<string, { clType: string; value: any }> = {
    action:        { clType: 'string',   value: 'swap' },
    amount_in:     { clType: 'u256',     value: '1000000' },
    amount_out:    { clType: 'u256',     value: '990000' },
    token_in:      { clType: 'key',      value: ZERO_ADDR },
    token_out:     { clType: 'key',      value: ZERO_ADDR },
    pair:          { clType: 'string',   value: 'CSPR/sCSPR' },
    tx_hash:       { clType: 'string',   value: 'test-tx' },
    x402_proof:    { clType: 'string',   value: 'test-proof' },
    x402_signer:   { clType: 'key',      value: ZERO_ADDR },
    outcome:       { clType: 'string',   value: 'success' },
  };

  console.log('\nBuilding TransactionV1...');
  try {
    const tx = buildContractCallTransactionV1(
      contractHash,
      'execute_strategy',
      args,
      chainName
    );

    console.log('Transaction built, signing and submitting...');
    const result = await signAndSubmitTransactionV1(tx);
    console.log('TX Hash:', result.txHash);
    console.log('Result:', JSON.stringify(result.result, null, 2).slice(0, 2000));
  } catch (e: any) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
