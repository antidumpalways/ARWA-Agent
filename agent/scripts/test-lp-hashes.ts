import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'arwa-test', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);

  // CSPRHAM/sCSPR pair
  const pairCsprHamScspr = 'f7fce0f02cde3238b68020a8e6304bd0c04f9dd25e157c43a5c003325703b2b9';
  // sCSPR package hash
  const sCSPR = 'baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3';
  // CSPRHAM package hash
  const CSPRHAM = '76203e2fda3c7a72187efbd982b83d2e4feb36a8c1ce5796d33bd5265fe7fd41';
  // CSPR package hash
  const CSPR = '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';
  // WCSPR package hash
  const WCSPR = '9778323e017580e876adb11813ba20856b166c63ce6001c2d2f989300aac4143';

  // Quote for CSPRHAM/sCSPR swap (to see current rate)
  console.log('=== Quote: 1 CSPRHAM -> sCSPR (test price) ===');
  try {
    const q = await client.callTool({
      name: 'get_quote',
      arguments: {
        token_in: CSPRHAM,
        token_out: sCSPR,
        amount: '1000000000000000000',  // 1 CSPRHAM (18 decimals)
        type: 'exact_in',
      },
    });
    console.log(q.content?.[0]?.text?.slice(0, 500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  // Build add liquidity with package hashes
  console.log('\n=== build_add_liquidity for CSPRHAM/sCSPR (using package hashes) ===');
  console.log('Use 1 mote (will become 10^9 = 1 token on-chain)');
  try {
    const r = await client.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: CSPRHAM,
        token_b: sCSPR,
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

  // Test remove_liquidity
  console.log('\n=== build_remove_liquidity for CSPRHAM/sCSPR ===');
  console.log('Test with percentage=1 (1% of position) - expected to fail if no position');
  try {
    const r = await client.callTool({
      name: 'build_remove_liquidity',
      arguments: {
        pair: pairCsprHamScspr,
        percentage: 1,
        sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Result (first 1000):');
    console.log(text.slice(0, 1000));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });