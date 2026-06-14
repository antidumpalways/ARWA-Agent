/**
 * Test CSPR.trade MCP via SDK client
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const url = 'http://localhost:3001/mcp';
  console.log('Connecting to:', url);

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  
  await client.connect(transport);
  console.log('Connected!');

  // List tools
  const tools = await client.listTools();
  console.log('\nAvailable tools:', tools.tools.map(t => t.name).join(', '));

  // Test get_quote
  console.log('\n--- Testing get_quote ---');
  try {
    const result = await client.callTool({
      name: 'get_quote',
      arguments: {
        token_in: 'CSPR',
        token_out: 'sCSPR',
        amount: '1000000000', // 1 CSPR
        type: 'exact_in'
      }
    });
    console.log('Quote result:', JSON.stringify(result, null, 2));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  // Test build_swap
  console.log('\n--- Testing build_swap ---');
  try {
    const result = await client.callTool({
      name: 'build_swap',
      arguments: {
        token_in: 'CSPR',
        token_out: 'sCSPR',
        amount: '1000000000',
        type: 'exact_in',
        min_amount_out: '990000000',
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
        slippage_tolerance_bps: 50
      }
    });
    console.log('Build swap result:', JSON.stringify(result, null, 2).slice(0, 2000));
  } catch (e: any) {
    console.log('Error:', e.message);
  }

  process.exit(0);
}

main().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
