/**
 * Query contract info via MCP to find the correct hash format
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
dotenv.config();

const timeout = setTimeout(() => { 
  console.log('Timeout'); 
  process.exit(1); 
}, 30000);

async function main() {
  const url = process.env.CSPR_CLOUD_MCP_URL;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const packageHash = process.env.AGENT_VAULT_CONTRACT_HASH?.replace('hash-', '');
  
  console.log('Package hash:', packageHash);
  
  const transport = new StreamableHTTPClientTransport(new URL(url!), {
    requestInit: { headers: { 'X-CSPR-Cloud-Api-Key': apiKey } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('Connected');
  
  // Get contract package info
  console.log('\n--- get_contract_package ---');
  try {
    const result = await client.callTool({
      name: 'get_contract',
      arguments: { contract_hash: packageHash }
    });
    const text = result.content?.[0]?.text || JSON.stringify(result);
    console.log(text.slice(0, 3000));
  } catch (e: any) {
    console.log('Error:', e.message);
  }
  
  // Get contracts by package
  console.log('\n--- get_contracts_by_contract_package ---');
  try {
    const result = await client.callTool({
      name: 'get_contracts_by_contract_package',
      arguments: { contract_package_hash: packageHash }
    });
    const text = result.content?.[0]?.text || JSON.stringify(result);
    console.log(text.slice(0, 3000));
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
