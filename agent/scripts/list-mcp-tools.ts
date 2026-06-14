import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import dotenv from 'dotenv';
dotenv.config();

const timeout = setTimeout(() => { 
  console.log('Timeout after 15s'); 
  process.exit(1); 
}, 15000);

async function main() {
  const url = process.env.CSPR_CLOUD_MCP_URL;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  console.log('MCP URL:', url);
  console.log('API Key:', apiKey?.slice(0, 8) + '...');
  
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { 
      headers: { 'X-CSPR-Cloud-Api-Key': apiKey },
    } 
  });
  
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  console.log('Connecting...');
  
  await client.connect(transport);
  console.log('Connected!');
  
  const tools = await client.listTools();
  clearTimeout(timeout);
  
  console.log('\nAvailable tools (' + tools.tools.length + '):');
  for (const tool of tools.tools) {
    console.log('  -', tool.name);
  }
  
  process.exit(0);
}

main().catch(e => { 
  clearTimeout(timeout); 
  console.error('Error:', e.message); 
  process.exit(1); 
});
