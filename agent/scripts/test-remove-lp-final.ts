/**
 * Test remove_liquidity on testnet.
 * Note: requires an existing LP position. We do a tiny add first (smaller module bytes?)
 * then remove. Actually skip add — just test remove with 100% percentage to see structure.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, Hash, TransactionV1, Transaction } from 'casper-js-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_PATH || process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';
const WCSPR_CAT_PAIR = '4df32b3e0b563244e21b31634aa61274022f2e850ed8a969af7e98d08c999ee0';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  const r: any = await mcp.callTool({
    name: 'build_remove_liquidity',
    arguments: {
      pair: WCSPR_CAT_PAIR,
      percentage: 100,
      sender_public_key: PK,
    },
  });
  const text = r.content?.[0]?.text ?? '';
  console.log('=== build_remove_liquidity output (first 2500) ===');
  console.log(text.slice(0, 2500));

  // Extract tx
  const txPositions: number[] = [];
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txPositions.push(p);
  }
  console.log(`\nFound ${txPositions.length} tx(s)`);
  if (txPositions.length === 0) {
    console.log('No txs found');
    return;
  }

  const extractTx = (start: number): string | null => {
    let depth = 0, inStr = false, escape = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    return text.substring(start, end + 1);
  };

  for (let i = 0; i < txPositions.length; i++) {
    const txStr = extractTx(txPositions[i])!;
    console.log(`\n=== Tx ${i + 1} ===`);
    console.log('Size:', txStr.length, 'bytes');
    const parsed = JSON.parse(txStr);
    console.log('target:', JSON.stringify(parsed.payload?.fields?.target).slice(0, 200));
    console.log('entry_point:', parsed.payload?.fields?.entry_point);
    console.log('gas:', parsed.payload?.pricing_mode?.PaymentLimited?.payment_amount);
  }

  // Try to submit (likely fails because no LP position)
  if (txPositions.length > 0) {
    console.log('\n=== Try submit (likely fails — no LP) ===');
    const pem = readFileSync(SECRET_KEY, 'utf-8');
    const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    for (let i = 0; i < txPositions.length; i++) {
      const txStr = extractTx(txPositions[i])!;
      const json = JSON.parse(txStr);
      if (json.payload?.pricing_mode?.PaymentLimited) {
        json.payload.pricing_mode.PaymentLimited.payment_amount = 100_000_000_000;
      }
      const txHash = Hash.fromHex(json.hash);
      const tx = new TransactionV1(txHash, json.payload, []);
      tx.sign(sk);
      const approval = tx.approvals?.[0];
      const signedJson = {
        ...json,
        approvals: [{
          signer: approval?.signer?.toHex?.() || '',
          signature: approval?.signature?.toString?.() || '',
        }],
      };
      try {
        const resp = await axios.post(RPC, {
          jsonrpc: '2.0',
          method: 'account_put_transaction',
          params: { transaction: { Version1: signedJson } },
          id: 1
        }, {
          headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
          timeout: 60000,
        });
        if (resp.data.error) {
          console.log(`  Tx ${i + 1} error:`, resp.data.error.message);
        } else {
          const resultHash = resp.data.result?.transaction_hash?.Version1 || resp.data.result?.transaction_hash;
          console.log(`  Tx ${i + 1}: ${resultHash}`);
        }
      } catch (e: any) {
        console.log(`  Tx ${i + 1} fail:`, e.message?.slice(0, 200));
      }
    }
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });