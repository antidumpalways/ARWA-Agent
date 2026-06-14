/**
 * Test execute_strategy with minimal args
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, HttpHandler, RpcClient } from 'casper-js-sdk';
import { buildContractCallDeploy, signAndSubmitDeploy } from '../src/casper/signer';
dotenv.config();

async function main() {
  const cfg = {
    contractHash: process.env.AGENT_VAULT_CONTRACT_HASH!,
    keyPath: process.env.AGENT_SECRET_KEY_PATH!,
    chainName: process.env.CASPER_CHAIN_NAME || 'casper-test',
    rpcUrl: process.env.CASPER_RPC_URL || 'https://node.testnet.cspr.cloud/rpc',
    apiKey: process.env.CSPR_CLOUD_API_KEY!,
  };
  
  console.log('Contract:', cfg.contractHash);
  console.log('Chain:', cfg.chainName);
  
  // Load key
  const pem = readFileSync(cfg.keyPath, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  console.log('Agent pubkey:', pk.toHex());
  console.log('Agent account hash:', pk.accountHash().toHex());
  
  // Minimal args (short strings)
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  const args: Record<string, { clType: string; value: any }> = {
    action:        { clType: 'string',   value: 'swap' },
    amount_in:     { clType: 'u256',     value: '1000000' },
    amount_out:    { clType: 'u256',     value: '990000' },
    token_in:      { clType: 'key',      value: ZERO_ADDR },
    token_out:     { clType: 'key',      value: ZERO_ADDR },
    pair:          { clType: 'string',   value: 'CSPR/sCSPR' },
    tx_hash:       { clType: 'string',   value: 'test-tx-hash' },
    x402_proof:    { clType: 'string',   value: 'test-proof' },  // Short!
    x402_signer:   { clType: 'key',      value: ZERO_ADDR },
    outcome:       { clType: 'string',   value: 'success' },
  };
  
  console.log('\nBuilding deploy...');
  const deploy = buildContractCallDeploy(
    cfg.contractHash,
    'execute_strategy',
    args,
    cfg.chainName
  );
  
  console.log('Signing and submitting...');
  try {
    const result = await signAndSubmitDeploy(deploy);
    console.log('Deploy hash:', result.deployHash);
    console.log('Result:', JSON.stringify(result.result, null, 2).slice(0, 1000));
  } catch (e: any) {
    console.log('Error:', e.message);
    if (e.sourceErr) {
      console.log('Source error:', JSON.stringify(e.sourceErr));
    }
  }
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
