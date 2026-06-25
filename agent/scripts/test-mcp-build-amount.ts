import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  const amounts = ['1000000000', '10000000000', '100000000000', '1000000000000'];
  for (const amt of amounts) {
    console.log(`\n=== Input amount: ${amt} (${Number(amt) / 1e9} CSPR) ===`);
    const result = await client.callTool({
      name: 'build_swap',
      arguments: {
        token_in: 'CSPR',
        token_out: 'sCSPR',
        amount: amt,
        type: 'exact_in',
        min_amount_out: '0',
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
        slippage_tolerance_bps: 50,
      },
    });
    const text = result.content?.[0]?.text ?? '';
    // Extract human-readable summary
    const summary = text.split('\n').slice(0, 4).join(' | ');
    console.log('Summary:', summary);
    // Extract amount in hex from "Swap X CSPR"
    const amtMatch = text.match(/Swap ([\d.]+) CSPR/);
    console.log('Effective CSPR:', amtMatch?.[1]);
    // Extract bytes for attached_value / amount
    const bvMatch = text.match(/"(attached_value|amount)","bytes":"([0-9a-f]+)"/g);
    console.log('Args bytes:', bvMatch?.slice(0, 2));
  }
  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });