import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // Get all pairs paginated
  const pairs = await client.callTool({
    name: 'get_pairs',
    arguments: { limit: 100 },
  });
  const text = pairs.content?.[0]?.text ?? '';
  // Extract all pair contractPackageHashes
  const pairs2 = [...text.matchAll(/"contractPackageHash":\s*"([a-f0-9]{64})"/g)].map(m => m[1]);
  console.log(`Found ${pairs2.length} pairs:`);
  pairs2.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));

  // Get tokens with pagination
  const tokens = await client.callTool({
    name: 'get_tokens',
    arguments: {},
  });
  const tText = tokens.content?.[0]?.text ?? '';
  const tokens2 = [...tText.matchAll(/"symbol":\s*"([A-Z]+)"/g)].map(m => m[1]);
  console.log(`\nFound ${tokens2.length} unique tokens:`, [...new Set(tokens2)]);

  // Get LP positions for agent
  console.log('\n=== Get LP positions for agent account ===');
  const pos = await client.callTool({
    name: 'get_liquidity_positions',
    arguments: {
      account_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  console.log(pos.content?.[0]?.text?.slice(0, 2000));

  // Token balances
  console.log('\n=== Token balances for agent ===');
  const bal = await client.callTool({
    name: 'get_token_balance',
    arguments: {
      account_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  console.log(bal.content?.[0]?.text?.slice(0, 2000));

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });