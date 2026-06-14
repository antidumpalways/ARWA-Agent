/**
 * Test calling execute_strategy via MCP create_awaiting_deploy
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, TransactionV1 } from 'casper-js-sdk';
dotenv.config();

const timeout = setTimeout(() => { 
  console.log('Timeout'); 
  process.exit(1); 
}, 60000);

async function main() {
  const url = process.env.CSPR_CLOUD_MCP_URL;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const contractHash = process.env.AGENT_VAULT_CONTRACT_HASH?.replace('hash-', '');
  const keyPath = process.env.AGENT_SECRET_KEY_PATH!;
  
  console.log('Contract:', contractHash);
  
  // Load key
  const pem = readFileSync(keyPath, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  const agentPubKey = pk.toHex();
  console.log('Agent pubkey:', agentPubKey);
  
  // Connect to MCP
  const transport = new StreamableHTTPClientTransport(new URL(url!), {
    requestInit: { headers: { 'X-CSPR-Cloud-Api-Key': apiKey } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('Connected to MCP');
  
  // Check create_awaiting_deploy tool schema
  const tools = await client.listTools();
  const createTool = tools.tools.find(t => t.name === 'create_awaiting_deploy');
  console.log('\ncreate_awaiting_deploy schema:');
  console.log(JSON.stringify(createTool?.inputSchema, null, 2));
  
  // Build a simple contract call using create_awaiting_deploy
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  
  console.log('\n--- Creating awaiting deploy ---');
  try {
    const result = await client.callTool({
      name: 'create_awaiting_deploy',
      arguments: {
        // Try to build a contract call
        transaction_type: 'contract_call',
        contract_package_hash: contractHash,
        entry_point: 'execute_strategy',
        sender: agentPubKey,
        args: {
          action: 'swap',
          amount_in: '1000000',
          amount_out: '990000',
          token_in: ZERO_ADDR,
          token_out: ZERO_ADDR,
          pair: 'CSPR/sCSPR',
          tx_hash: 'test-tx',
          x402_proof: 'test-proof',
          x402_signer: ZERO_ADDR,
          outcome: 'success',
        },
        // Payment amount in motes (3 CSPR)
        payment_amount: '3000000000',
      }
    });
    const text = result.content?.[0]?.text || JSON.stringify(result);
    console.log('Result:', text.slice(0, 3000));
    
    // If we got a deploy/transaction back, try to sign and submit it
    // Parse the response to find the transaction JSON
    const match = text.match(/\{[^{}]*"hash"[^{}]*\}/);
    if (match) {
      console.log('\nFound transaction JSON, attempting to sign...');
      // This would need proper parsing
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }
  
  clearTimeout(timeout);
  process.exit(0);
}

main().catch(e => { 
  clearTimeout(timeout); 
  console.error('Error:', e.message); 
  process.exit(1); 
});
