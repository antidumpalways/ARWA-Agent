import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // WCSPR/sCSPR pair contract package from previous query
  const pair = 'f9df859876321d4335e3c84ef4efa09ca38486e35ea49295a661908c3ccefcee';

  // Get all tools to find add/remove_liquidity schemas
  const tools = await client.listTools();
  const addLiq = tools.tools.find(t => t.name === 'build_add_liquidity');
  const remLiq = tools.tools.find(t => t.name === 'build_remove_liquidity');
  const optLiq = tools.tools.find(t => t.name === 'optimal_liquidity_amounts');
  console.log('=== build_add_liquidity schema ===');
  console.log(JSON.stringify(addLiq?.inputSchema, null, 2));
  console.log('\n=== build_remove_liquidity schema ===');
  console.log(JSON.stringify(remLiq?.inputSchema, null, 2));
  console.log('\n=== optimal_liquidity_amounts schema ===');
  console.log(JSON.stringify(optLiq?.inputSchema, null, 2));

  // Test build_remove_liquidity with correct schema
  console.log('\n=== build_remove_liquidity with percentage=1 ===');
  try {
    const r = await client.callTool({
      name: 'build_remove_liquidity',
      arguments: {
        pair,
        percentage: 1,
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log(text.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });