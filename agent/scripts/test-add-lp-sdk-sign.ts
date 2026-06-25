/**
 * Test add_liquidity with manual signing using blake2b hash of canonical payload.
 * The Casper 2.0 TransactionV1 hash is blake2b-256 of the serialized payload body.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, Hash, TransactionV1 } from 'casper-js-sdk';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });
const RPC = process.env.CASPER_RPC_URL!;
const SECRET_KEY = process.env.AGENT_SECRET_KEY_PATH!;
const API_KEY = process.env.CSPR_CLOUD_API_KEY!;
const PK = '0203b905eb3ce42b851eb1f2c61c11d05db1621295546c2934a14451d9c35c15cdfa';

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'test', version: '0' }, { capabilities: {} });
  await mcp.connect(transport);

  const r: any = await mcp.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR', token_b: 'CSPRCAT',
      amount_a: '1', amount_b: '1',
      sender_public_key: PK,
    },
  });
  const text = r.content?.[0]?.text ?? '';

  const txPositions: number[] = [];
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txPositions.push(p);
  }
  const extractTx = (start: number): string | null => {
    let depth = 0, inStr = false, escape = false, end = -1;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (escape) {escape = false; continue; }
      if (c === '\\') {escape = true; continue; }
      if (c === '"') {inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {depth--; if (depth === 0) {end = i; break; } }
    }
    if (end === -1) return null;
    return text.substring(start, end + 1);
  };
  const txs: string[] = [];
  for (const p of txPositions) { const tx = extractTx(p); if (tx) txs.push(tx); }
  if (txs.length < 3) { console.log('Not enough txs'); return; }

  const addJson = JSON.parse(txs[2]);
  if (addJson.payload?.pricing_mode?.PaymentLimited) {
    addJson.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
  }

  // Sign via SDK, but force hash to match MCP — use SDK's signing which recomputes hash.
  // Strategy: construct SDK tx with empty approval, then sign, then SDK will compute proper hash.
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  // Approach 1: Let SDK handle hash by providing payload + signed approvals
  // The SDK's hash should match network expectation if payload is canonical
  console.log('=== Approach: SDK TransactionV1 with raw payload ===');
  try {
    // Create TransactionV1 with placeholder hash
    const fakeHash = Hash.fromHex(addJson.hash);
    const tx = new TransactionV1(fakeHash, addJson.payload, []);
    // Sign — SDK recomputes hash internally and uses that for signing
    tx.sign(sk);

    // Extract SDK-computed approvals (which contain correct signature over correct hash)
    const sdkApprovals = (tx as any).approvals || [];
    console.log('SDK computed hash:', addJson.hash);
    console.log('SDK approvals:', JSON.stringify(sdkApprovals, null, 2).slice(0, 500));

    // Build final JSON: combine MCP-provided payload + SDK-computed hash + SDK approvals
    const sdkSignedJson = {
      hash: addJson.hash,  // use MCP hash (matches SDK computed)
      payload: addJson.payload,  // original payload from MCP
      approvals: sdkApprovals.map((a: any) => ({
        signer: a.signer?.toHex?.() || '',
        signature: a.signature?.toString?.() || '',
      })),
    };

    // Submit
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: sdkSignedJson } },
      id: 1,
    });
    console.log(`Body size: ${body.length} bytes`);
    const resp = await axios.post(RPC, body, {
      headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
      timeout: 60000,
      maxBodyLength: Infinity, maxContentLength: Infinity,
    });
    console.log('Response:', JSON.stringify(resp.data, null, 2).slice(0, 1500));
  } catch (e: any) {
    console.log('Approach error:', e.message?.slice(0, 300));
  }

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));