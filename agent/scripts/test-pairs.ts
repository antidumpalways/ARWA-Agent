import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  console.log('\n=== Test 1: build_add_liquidity with 1 CSPR + 1 sCSPR ===');
  // CSPR/sCSPR pair token addresses (from MCP quote output earlier)
  // Need to know actual pair contract address
  const pairs = await client.callTool({
    name: 'get_pairs',
    arguments: { limit: 5 },
  });
  console.log('Pairs:', pairs.content?.[0]?.text?.slice(0, 1500));

  console.log('\n=== Test 2: get_pair_details for first pair ===');
  // parse pair address from pairs result
  const text = pairs.content?.[0]?.text ?? '';
  const m = text.match(/address["\s:]+(contract-[a-f0-9]+|hash-[a-f0-9]+|[a-f0-9]{64})/i);
  if (m) {
    const pairAddr = m[1];
    console.log('Using pair:', pairAddr);
    const details = await client.callTool({
      name: 'get_pair_details',
      arguments: { pair: pairAddr },
    });
    console.log('Details:', details.content?.[0]?.text?.slice(0, 800));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });