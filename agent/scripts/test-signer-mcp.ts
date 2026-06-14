import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  // Connect to signer MCP
  const signerUrl = 'http://localhost:3002/mcp';
  console.log('Connecting to signer MCP:', signerUrl);
  
  const transport = new StreamableHTTPClientTransport(new URL(signerUrl));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  
  await client.connect(transport);
  console.log('Connected!');
  
  // List tools
  const tools = await client.listTools();
  console.log('\nSigner MCP tools:');
  for (const tool of tools.tools) {
    console.log(`  - ${tool.name}: ${tool.description?.slice(0, 100) || 'No description'}`);
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
