import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // Check if user has any LP positions
  const positions = await client.callTool({
    name: 'get_liquidity_positions',
    arguments: {
      account_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  console.log('=== Liquidity positions ===');
  console.log(positions.content?.[0]?.text?.slice(0, 2000));

  // Test build_remove_liquidity
  console.log('\n=== build_remove_liquidity (1 LP token - test amount) ===');
  try {
    const r = await client.callTool({
      name: 'build_remove_liquidity',
      arguments: {
        token_a: 'WCSPR',
        token_b: 'sCSPR',
        liquidity: '1',  // minimal amount to test structure
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Result (first 1500 chars):');
    console.log(text.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  // Test optimal_liquidity_amounts
  console.log('\n=== optimal_liquidity_amounts (1 WCSPR to WCSPR/sCSPR) ===');
  try {
    const r = await client.callTool({
      name: 'optimal_liquidity_amounts',
      arguments: {
        token_a: 'WCSPR',
        token_b: 'sCSPR',
        amount_a: '1',
      },
    });
    console.log('Result:', r.content?.[0]?.text?.slice(0, 1000));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });