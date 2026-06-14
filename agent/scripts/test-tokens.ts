import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  
  const result = await client.callTool({
    name: 'get_tokens',
    arguments: {}
  });
  console.log('Tokens:', result.content?.[0]?.text);
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
