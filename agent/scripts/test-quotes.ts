import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // Try several pairs with quote
  const pairs = [
    ['CSPR', 'WCSPR'],
    ['CSPR', 'USDT'],
    ['CSPR', 'sCSPR'],
    ['CSPR', 'WBTC'],
  ];
  for (const [tIn, tOut] of pairs) {
    console.log(`\n=== Quote ${tIn} -> ${tOut} (1 CSPR) ===`);
    try {
      const res = await client.callTool({
        name: 'get_quote',
        arguments: { token_in: tIn, token_out: tOut, amount: '1000000000', type: 'exact_in' },
      });
      console.log(res.content?.[0]?.text?.slice(0, 300));
    } catch (e: any) {
      console.log('FAIL:', e.message?.slice(0, 100));
    }
  }
  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });