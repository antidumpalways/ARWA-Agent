import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // Get pair details for each sCSPR pair
  const pairs = [
    { id: 'f7fce0f02cde3238b68020a8e6304bd0c04f9dd25e157c43a5c003325703b2b9', desc: 'CSPRHAM/sCSPR' },
    { id: '4df32b3e0b563244e21b31634aa61274022f2e850ed8a969af7e98d08c999ee0', desc: 'WCSPR/?' },
  ];
  for (const p of pairs) {
    try {
      const d = await client.callTool({
        name: 'get_pair_details',
        arguments: { pair: p.id },
      });
      console.log(`=== ${p.desc} (${p.id.slice(0, 12)}...) ===`);
      console.log(d.content?.[0]?.text?.slice(0, 800));
      console.log('');
    } catch (e: any) {
      console.log(`${p.desc}: ${e.message?.slice(0, 200)}`);
    }
  }

  // Get balances for ALL tokens
  const bal = await client.callTool({
    name: 'get_token_balance',
    arguments: {
      account_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  console.log('=== Agent token balances ===');
  console.log(bal.content?.[0]?.text?.slice(0, 1500));

  // Try build_add_liquidity for CSPRHAM/sCSPR pair
  console.log('\n=== Test: build_add_liquidity for CSPRHAM/sCSPR pair ===');
  console.log('Using tiny amount: 1 motes (will be 10^9 motes = 1 token on-chain)');
  try {
    const r = await client.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'CSPRHAM',
        token_b: 'sCSPR',
        amount_a: '1',
        amount_b: '1',
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Result (first 1500):');
    console.log(text.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });