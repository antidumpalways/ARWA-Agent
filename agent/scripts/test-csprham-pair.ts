/**
 * Add liquidity to CSPRHAM/sCSPR pair using package hash.
 * The pair has sCSPR (liquid staking token) — most relevant for ARWA.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, Hash, TransactionV1 } from 'casper-js-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
// CSPRHAM package hash (meme token, 18 decimals)
const CSPRHAM_PKG = '76203e2fda3c7a72187efbd982b83d2e4feb36a8c1ce5796d33bd5265fe7fd41';
// sCSPR package hash (Staked CSPR, 9 decimals)
const SCSPR_PKG = 'baa50d1500aa5361c497c06b40f2822ebb0b5fce5b1c3a037ea628cb68d920f3';
// CSPRHAM/sCSPR pair contract package
const PAIR = 'f7fce0f02cde3238b68020a8e6304bd0c04f9dd25e157c43a5c003325703b2b9';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // Use ID 'CSPRHAM' since it's the symbol (even though earlier said "not recognised")
  // Try with package_hash instead
  console.log('=== Try build_add_liquidity with package_hash ===');
  try {
    const r: any = await mcp.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: CSPRHAM_PKG,
        token_b: SCSPR_PKG,
        amount_a: '1',
        amount_b: '1',
        sender_public_key: PK,
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Result (first 1500):');
    console.log(text.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  console.log('\n=== Try build_add_liquidity with symbol CSPRHAM ===');
  try {
    const r: any = await mcp.callTool({
      name: 'build_add_liquidity',
      arguments: {
        token_a: 'CSPRHAM',
        token_b: 'sCSPR',
        amount_a: '1000000000000000000', // 1 CSPRHAM (18 decimals)
        amount_b: '1',                   // 1 sCSPR (9 decimals)
        sender_public_key: PK,
      },
    });
    const text = r.content?.[0]?.text ?? '';
    console.log('Result (first 1500):');
    console.log(text.slice(0, 1500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });