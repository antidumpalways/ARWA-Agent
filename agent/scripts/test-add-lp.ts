import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // Get the full pairs list to find WCSPR/sCSPR pair
  const pairs = await client.callTool({
    name: 'get_pairs',
    arguments: { limit: 50 },
  });
  const text = pairs.content?.[0]?.text ?? '';

  // Find WCSPR pair
  const wcsprIdx = text.indexOf('"WCSPR"');
  console.log('WCSPR found at index:', wcsprIdx);
  if (wcsprIdx >= 0) {
    // Find the parent contractPackageHash
    const before = text.substring(Math.max(0, wcsprIdx - 500), wcsprIdx);
    const pkgs = [...before.matchAll(/"contractPackageHash":\s*"([a-f0-9]{64})"/g)];
    console.log('Latest WCSPR pair contractPackageHash:', pkgs[pkgs.length - 1]?.[1]);
  }

  // Test build_add_liquidity for WCSPR/sCSPR pair
  // WCSPR package: 3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e
  // sCSPR package: baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3
  console.log('\n=== Test: build_add_liquidity for WCSPR/sCSPR pair ===');
  console.log('Using very small amount (1 motes) due to MCP 10^9 multiplier bug');
  try {
    const r = await client.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'WCSPR',
        token_b: 'sCSPR',
        amount_a: '1',  // 1 motes (after 10^9 multiplier -> 10^18 = 1 CSPR in raw)
        amount_b: '1',
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const rText = r.content?.[0]?.text ?? '';
    console.log('Result (first 1500 chars):');
    console.log(rText.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });