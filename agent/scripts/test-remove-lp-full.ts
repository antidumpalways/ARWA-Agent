/**
 * Test remove_liquidity and analyze a more realistic add_liquidity.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, Hash, TransactionV1, Transaction } from 'casper-js-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // 1. First, check if agent now has any LP position from the prior add attempt
  console.log('=== Agent LP positions after attempted add ===');
  const pos = await mcp.callTool({
    name: 'get_liquidity_positions',
    arguments: { account_public_key: PK },
  });
  console.log(pos.content?.[0]?.text?.slice(0, 2000));

  // 2. Try build_remove_liquidity
  console.log('\n=== build_remove_liquidity (1% of position) ===');
  // Use the WCSPR/sCSPR pair (4df32b3e is WCSPR/CSPRCAT; f9df8598 is WCSPR/CSPRHAM)
  // Need to find the WCSPR/sCSPR pair
  const allPairs = await mcp.callTool({
    name: 'get_pairs',
    arguments: { limit: 100 },
  });
  const pairsText = allPairs.content?.[0]?.text ?? '';
  // find pair with WCSPR and sCSPR
  const pairBlocks = pairsText.split('"contractPackageHash"').slice(1);
  let wcsprScsprPair: string | null = null;
  for (const blk of pairBlocks) {
    if (blk.includes('"WCSPR"') && blk.includes('"sCSPR"')) {
      const m = blk.match(/^:\s*"([a-f0-9]{64})"/);
      if (m) { wcsprScsprPair = m[1]; break; }
    }
  }
  console.log('WCSPR/sCSPR pair:', wcsprScsprPair);

  if (wcsprScsprPair) {
    try {
      const r = await mcp.callTool({
        name: 'build_remove_liquidity',
        arguments: {
          pair: wcsprScsprPair,
          percentage: 100,  // 100% (max)
          sender_public_key: PK,
        },
      });
      console.log('Remove Liquidity result (first 2000):');
      console.log((r.content?.[0]?.text ?? '').slice(0, 2000));
    } catch (e: any) {
      console.log('Remove error:', e.message?.slice(0, 300));
    }
  }

  // 3. Test optimal_liquidity_amounts
  console.log('\n=== optimal_liquidity_amounts for 1 sCSPR ===');
  try {
    const r = await mcp.callTool({
      name: 'optimal_liquidity_amounts',
      arguments: {
        token_a: 'WCSPR',
        token_b: 'sCSPR',
        amount_a: '1000000000',  // 1 CSPR (9 decimals)
      },
    });
    console.log((r.content?.[0]?.text ?? '').slice(0, 800));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });