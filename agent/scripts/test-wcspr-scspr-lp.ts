import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // WCSPR/sCSPR pair contract package hash
  // Need to find it - from previous data the WCSPR pairs were:
  // 1. f9df859... (WCSPR/CSPRHAM)
  // 4. 4df32b3e... (WCSPR/CSPRCAT)
  // Need WCSPR/sCSPR pair. Let me check all WCSPR pairs

  // Get all 10 pairs and check which one is WCSPR/sCSPR
  const allPairs = await client.callTool({
    name: 'get_pairs',
    arguments: { limit: 100 },
  });
  const text = allPairs.content?.[0]?.text ?? '';
  // Find WCSPR followed by sCSPR within a pair (look for object with both)
  const pairBlocks = text.split('"contractPackageHash"').slice(1);
  let wcsprScsprPair = null;
  for (const blk of pairBlocks) {
    if (blk.includes('"WCSPR"') && blk.includes('"sCSPR"')) {
      // Get the package hash from the beginning of this block
      const m = blk.match(/^:\s*"([a-f0-9]{64})"/);
      if (m) {
        wcsprScsprPair = m[1];
        break;
      }
    }
  }
  console.log('WCSPR/sCSPR pair:', wcsprScsprPair);

  // Get the build_add_liquidity response for WCSPR/sCSPR with small amount
  console.log('\n=== build_add_liquidity for WCSPR/sCSPR ===');
  console.log('Tiny amount: 1 motes (becomes 10^9 on-chain due to MCP bug)');
  try {
    const r = await client.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'WCSPR',
        token_b: 'sCSPR',
        amount_a: '1',
        amount_b: '1',
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Add Liquidity result (first 2000):');
    console.log(text.slice(0, 2000));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });