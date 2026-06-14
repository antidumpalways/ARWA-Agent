/**
 * Test building TransactionV1 for contract call (Casper 2.0 format)
 */
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { 
  PrivateKey, 
  KeyAlgorithm, 
  TransactionV1,
  TransactionEntryPoint,
  TransactionTarget,
  TransactionInvocationTarget,
  Args,
  CLValue,
  ContractPackageHash,
  Timestamp,
  Duration,
  TransactionRuntime,
  HttpHandler,
  RpcClient,
} from 'casper-js-sdk';
dotenv.config();

const timeout = setTimeout(() => { 
  console.log('Timeout'); 
  process.exit(1); 
}, 60000);

async function main() {
  const cfg = {
    contractHash: process.env.AGENT_VAULT_CONTRACT_HASH?.replace('hash-', '')!,
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
  
  // Build args
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  const args = new Args();
  args.insert('action', CLValue.newCLString('swap'));
  args.insert('amount_in', CLValue.newCLUInt256(BigInt('1000000')));
  args.insert('amount_out', CLValue.newCLUInt256(BigInt('990000')));
  args.insert('token_in', CLValue.newCLKey(ZERO_ADDR));
  args.insert('token_out', CLValue.newCLKey(ZERO_ADDR));
  args.insert('pair', CLValue.newCLString('CSPR/sCSPR'));
  args.insert('tx_hash', CLValue.newCLString('test-tx'));
  args.insert('x402_proof', CLValue.newCLString('test-proof'));
  args.insert('x402_signer', CLValue.newCLKey(ZERO_ADDR));
  args.insert('outcome', CLValue.newCLString('success'));
  
  console.log('\nBuilding TransactionV1...');
  
  try {
    // Try to build a TransactionV1 for contract call
    // This is the Casper 2.0 format
    
    // Create the transaction header
    const header = {
      chainName: cfg.chainName,
      timestamp: new Timestamp(new Date()),
      ttl: new Duration(1_800_000), // 30 minutes
      initiator: pk,
    };
    
    // Create the entry point
    const entryPoint = TransactionEntryPoint.custom('execute_strategy');
    
    // Create the target (contract package)
    const packageHash = ContractPackageHash.fromJSON(cfg.contractHash);
    const target = TransactionTarget.storedVersionedContractByHash(packageHash, 1);
    
    // Create the invocation target
    const invocationTarget = TransactionInvocationTarget.byPackageVersion(packageHash, 1);
    
    // Build the transaction
    const tx = new TransactionV1(
      header,
      entryPoint,
      target,
      args,
      TransactionRuntime.VmCasperV2,
      // Payment
      undefined, // Will use standard payment
    );
    
    console.log('Transaction built, signing...');
    await tx.sign(sk);
    
    console.log('Transaction signed, submitting...');
    
    // Submit via RPC
    const handler = new HttpHandler(cfg.rpcUrl);
    handler.setCustomHeaders({ Authorization: cfg.apiKey });
    const client = new RpcClient(handler);
    
    const result = await client.putTransaction(tx);
    console.log('Submit result:', JSON.stringify(result, null, 2).slice(0, 1000));
    
    // Wait for execution
    console.log('Waiting for execution...');
    const txHash = (result as any).transaction_hash?.hash || (result as any).hash;
    if (txHash) {
      const execResult = await client.waitForTransaction(txHash, 60000);
      console.log('Execution result:', JSON.stringify(execResult, null, 2).slice(0, 2000));
    }
    
  } catch (e: any) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack?.split('\n').slice(0, 5).join('\n'));
  }
  
  clearTimeout(timeout);
  process.exit(0);
}

main().catch(e => { 
  clearTimeout(timeout); 
  console.error('Error:', e.message); 
  process.exit(1); 
});
