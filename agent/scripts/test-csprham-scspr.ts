/**
 * Test remove_liquidity for CSPRHAM/sCSPR pair (the one with sCSPR liquid staking)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';
const CSPRHAM_SCSPR_PAIR = 'f7fce0f02cde3238b68020a8e6304bd0c04f9dd25e157c43a5c003325703b2b9';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  console.log('=== Quote: 1 CSPRHAM -> sCSPR ===');
  try {
    const r = await mcp.callTool({
      name: 'get_quote',
      arguments: {
        token_in: 'CSPRHAM',
        token_out: 'sCSPR',
        amount: '1000000000000000000',  // 1 CSPRHAM (18 decimals)
        type: 'exact_in',
      },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 600));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  console.log('\n=== build_add_liquidity CSPRHAM/sCSPR (smaller amount) ===');
  console.log('Note: CSPRHAM has 18 decimals, sCSPR has 9 decimals');
  console.log('Using 1000000 (will be 10^15 on-chain for CSPRHAM, 10^9 for sCSPR)');
  try {
    const r = await mcp.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'CSPRHAM',
        token_b: 'sCSPR',
        amount_a: '1000000',
        amount_b: '1000000',
        sender_public_key: PK,
      },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  console.log('\n=== build_remove_liquidity for CSPRHAM/sCSPR (5% test) ===');
  try {
    const r = await mcp.callTool({
      name: 'build_remove_liquidity',
      arguments: {
        pair: CSPRHAM_SCSPR_PAIR,
        percentage: 5,
        sender_public_key: PK,
      },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  // Also get_portfolio_value
  console.log('\n=== get_portfolio_value for agent ===');
  try {
    const r = await mcp.callTool({
      name: 'get_portfolio_value',
      arguments: { account_public_key: PK },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 1000));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });