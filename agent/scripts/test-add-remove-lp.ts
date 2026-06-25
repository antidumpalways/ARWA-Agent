/**
 * Test add_liquidity with higher gas limit + verify remove_liquidity afterwards.
 *
 * Add_liquidity on testnet needs > 50 CSPR gas (default in MCP). We'll patch
 * the gas_payment_amount in the unsigned JSON before signing.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import {
  HttpHandler, RpcClient, PrivateKey, KeyAlgorithm, PublicKey, Hash,
  TransactionV1, Transaction
} from 'casper-js-sdk';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';
const WCSPR_CAT_PAIR = '4df32b3e0b563244e21b31634aa61274022f2e850ed8a969af7e98d08c999ee0';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // 1. Add_liquidity WCSPR/CSPRCAT (existing testnet pair, 9+18 decimals)
  console.log('=== build_add_liquidity WCSPR/CSPRCAT (amount=1) ===');
  const r: any = await mcp.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR',
      token_b: 'CSPRCAT',
      amount_a: '1',
      amount_b: '1',
      sender_public_key: PK,
    },
  });
  const text = r.content?.[0]?.text ?? '';

  // Extract tx JSONs by walking back from each "hash" anchor
  const txPositions: number[] = [];
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txPositions.push(p);
  }
  console.log(`Found ${txPositions.length} txs`);

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
  const txs: string[] = [];
  for (const p of txPositions) { const tx = extractTx(p); if (tx) txs.push(tx); }
  if (txs.length < 3) { console.log('Not enough txs'); return; }

  // Patch add_liquidity (tx[2]) gas to 100 CSPR
  const addTx = JSON.parse(txs[2]);
  addTx.payload.pricing_mode = {
    PaymentLimited: { gas_price_tolerance: 1, payment_amount: 100_000_000_000, standard_payment: true }
  };
  txs[2] = JSON.stringify(addTx);

  // Sign + submit
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const handler = new HttpHandler(RPC);
  handler.setCustomHeaders({ Authorization: API_KEY });
  const client = new RpcClient(handler);

  const submit = async (jsonStr: string, label: string) => {
    const json = JSON.parse(jsonStr);
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
    const wrapped = Transaction.fromJSON({ Version1: signedJson });
    const submit = await client.putTransaction(wrapped);
    const resultHash = (submit as any)?.hash?.toHex?.() || json.hash;
    console.log(`  ${label}: ${resultHash}`);
    return resultHash;
  };

  console.log('\n=== Submit (with 100 CSPR gas for add) ===');
  const t1 = await submit(txs[0], 'Approve WCSPR');
  const t2 = await submit(txs[1], 'Approve CSPRCAT');
  const t3 = await submit(txs[2], 'Add LP');

  console.log('\n=== Wait 10s ===');
  await new Promise(r => setTimeout(r, 10000));

  // Check positions
  console.log('\n=== LP positions after add ===');
  const pos = await mcp.callTool({
    name: 'get_liquidity_positions',
    arguments: { account_public_key: PK },
  });
  console.log(pos.content?.[0]?.text?.slice(0, 1500));

  // build_remove_liquidity
  console.log('\n=== build_remove_liquidity WCSPR/CSPRCAT (50%) ===');
  try {
    const r2: any = await mcp.callTool({
      name: 'build_remove_liquidity',
      arguments: {
        pair: WCSPR_CAT_PAIR,
        percentage: 50,
        sender_public_key: PK,
      },
    });
    const rText = r2.content?.[0]?.text ?? '';
    console.log(rText.slice(0, 1500));

    // Extract and submit
    const positions2: number[] = [];
    const re = /"hash":"[a-f0-9]{64}"/g;
    let mm;
    while ((mm = re.exec(rText)) !== null) {
      let p = mm.index;
      while (p > 0 && rText[p] !== '{') p--;
      if (p > 0) positions2.push(p);
    }
    console.log(`Found ${positions2.length} remove tx(s)`);
    if (positions2.length > 0) {
      const rExtract = (start: number) => extractTx.call(null, start);
      const removeTxs: string[] = [];
      for (const p of positions2) { const tx = rExtract(p); if (tx) removeTxs.push(tx); }

      for (let i = 0; i < removeTxs.length; i++) {
        const json = JSON.parse(removeTxs[i]);
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
        const wrapped = Transaction.fromJSON({ Version1: signedJson });
        const submit = await client.putTransaction(wrapped);
        const resultHash = (submit as any)?.hash?.toHex?.() || json.hash;
        console.log(`  Remove tx ${i + 1}: ${resultHash}`);
      }
    }
  } catch (e: any) {
    console.log('Remove error:', e.message?.slice(0, 300));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });