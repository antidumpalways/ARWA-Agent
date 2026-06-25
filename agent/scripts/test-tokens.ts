import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  console.log('=== All available pairs ===');
  const pairs = await client.callTool({
    name: 'get_pairs',
    arguments: { limit: 20 },
  });
  const text = pairs.content?.[0]?.text ?? '';
  console.log(text.slice(0, 3000));

  console.log('\n=== Tokens ===');
  const tokens = await client.callTool({
    name: 'get_tokens',
    arguments: {},
  });
  console.log((tokens.content?.[0]?.text ?? '').slice(0, 2000));

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });