/**
 * Test full add_liquidity flow on testnet:
 * 1. build_add_liquidity via MCP (returns 3 unsigned txs: 2 approvals + 1 add)
 * 2. Sign + submit each
 * 3. Verify on-chain
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

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa-lp', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // Build add_liquidity (small amount, scaled by MCP 10^9)
  const r: any = await mcp.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR',
      token_b: 'sCSPR',
      amount_a: '1',
      amount_b: '1',
      sender_public_key: '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa',
    },
  });
  const text = r.content?.[0]?.text ?? '';
  console.log('=== build_add_liquidity result ===');
  console.log(text);

  // Extract all 3 transactions (approvals + add)
  // The MCP returns text with 3 embedded JSON tx blobs. Find them by "hash" anchor.
  console.log('Raw text length:', text.length);
  console.log('First 200 chars:', text.slice(0, 200));
  // Try simpler approach: look for JSON start at each "hash" key
  const txPositions: number[] = [];
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    // Walk back to find the opening {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txPositions.push(p);
  }
  console.log('Found hash positions:', txPositions);

  const extractTx = (start: number): string | null => {
    let depth = 0;
    let inStr = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) return null;
    return text.substring(start, end + 1);
  };

  const txJsonList: string[] = [];
  for (const p of txPositions) {
    const tx = extractTx(p);
    if (tx) txJsonList.push(tx);
  }
  console.log(`Extracted ${txJsonList.length} tx JSONs`);
  if (txJsonList.length < 3) {
    console.log('Failed to extract 3 txs, aborting');
    return;
  }

  const approvals = txJsonList.slice(0, 2);
  const addLiqTx = txJsonList[2];

  console.log(`Approvals: ${approvals.length}, Add: 1`);

  // Load key
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;
  console.log('Agent:', pk.toHex().slice(0, 30) + '...');

  // Setup RPC
  const handler = new HttpHandler(RPC);
  handler.setCustomHeaders({ Authorization: API_KEY });
  const client = new RpcClient(handler);

  // Sign + submit each
  const submitTx = async (jsonStr: string, label: string) => {
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
    const resultHash = (submit as any)?.hash?.toHex?.() || (submit as any)?.transaction_hash?.toHex?.() || json.hash;
    console.log(`  ${label}: ${resultHash}`);
    return resultHash;
  };

  console.log('\n=== Submitting transactions ===');
  for (let i = 0; i < approvals.length; i++) {
    await submitTx(approvals[i], `Approve ${i + 1}`);
  }
  const addHash = await submitTx(addLiqTx, 'Add LP');

  console.log('\n=== Waiting for execution ===');
  await new Promise(r => setTimeout(r, 8000));
  try {
    const r = await client.getTransactionResult(addHash);
    console.log('Result:', JSON.stringify(r, null, 2).slice(0, 1500));
  } catch (e: any) {
    console.log('Wait error:', e.message?.slice(0, 200));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });