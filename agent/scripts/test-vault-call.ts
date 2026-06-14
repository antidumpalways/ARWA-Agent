/**
 * Test calling AgentVault.execute_strategy via MCP create_awaiting_deploy
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
dotenv.config();

const timeout = setTimeout(() => { 
  console.log('Timeout after 30s'); 
  process.exit(1); 
}, 30000);

async function main() {
  const url = process.env.CSPR_CLOUD_MCP_URL;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const contractHash = process.env.AGENT_VAULT_CONTRACT_HASH;
  const keyPath = process.env.AGENT_SECRET_KEY_PATH;
  
  console.log('MCP URL:', url);
  console.log('Contract:', contractHash);
  
  // Load agent key
  const pem = readFileSync(keyPath!, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  const agentPubKey = pk.toHex();
  const agentAccountHash = pk.accountHash().toHex();
  console.log('Agent pubkey:', agentPubKey);
  console.log('Agent account hash:', agentAccountHash);
  
  // Connect to MCP
  const transport = new StreamableHTTPClientTransport(new URL(url!), {
    requestInit: { headers: { 'X-CSPR-Cloud-Api-Key': apiKey } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('Connected to MCP');
  
  // First, check what tools are available for contract calls
  const tools = await client.listTools();
  const relevantTools = tools.tools.filter(t => 
    t.name.includes('contract') || 
    t.name.includes('deploy') || 
    t.name.includes('awaiting') ||
    t.name.includes('call')
  );
  console.log('\nRelevant tools:');
  for (const t of relevantTools) {
    console.log(`  - ${t.name}: ${t.description?.slice(0, 80)}`);
  }
  
  // Try to get contract entry points
  console.log('\n--- Getting contract entry points ---');
  try {
    const entryPointsResult = await client.callTool({
      name: 'get_contract_entry_points',
      arguments: { contract_package_hash: contractHash?.replace('hash-', '') }
    });
    console.log('Entry points:', JSON.stringify(entryPointsResult, null, 2).slice(0, 2000));
  } catch (e: any) {
    console.log('Error getting entry points:', e.message);
  }
  
  clearTimeout(timeout);
  process.exit(0);
}

main().catch(e => { 
  clearTimeout(timeout); 
  console.error('Error:', e.message); 
  process.exit(1); 
});
