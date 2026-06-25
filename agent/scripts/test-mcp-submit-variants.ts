/**
 * Try submit_transaction variants explicitly.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync } from 'fs';
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
      if (c === '\\') {escape =true; continue; }
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

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  // Try submit tx 3 with explicit error handling
  console.log('=== Test submit_transaction with various arg names ===');
  const addJson = JSON.parse(txs[2]);
  if (addJson.payload?.pricing_mode?.PaymentLimited) {
    addJson.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
  }
  const fakeHash = '0'.repeat(64);
  const tx = new TransactionV1(Hash.fromHex(fakeHash), addJson.payload, []);
  tx.sign(sk);
  const sdkHash = (tx as any).hash?.toHex?.() || fakeHash;
  const signedJson = {
    hash: sdkHash,
    payload: addJson.payload,
    approvals: ((tx as any).approvals || []).map((a: any) => ({
      signer: a.signer?.toHex?.() || '',
      signature: a.signature?.toString?.() || '',
    })),
  };
  const jsonStr = JSON.stringify(signedJson);
  console.log(`Body size: ${jsonStr.length} bytes, hash: ${sdkHash.slice(0, 12)}...`);

  // Try different arg names
  const argVariants = [
    { signed_deploy_json: jsonStr },
    { deploy_json: jsonStr },
    { tx_json: jsonStr },
    { signed_tx_json: jsonStr },
    { signed_transaction: jsonStr },
    { json: jsonStr },
    { deploy: jsonStr },
  ];
  for (const args of argVariants) {
    const argName = Object.keys(args)[0];
    try {
      const r: any = await mcp.callTool({ name: 'submit_transaction', arguments: args });
      const rText = r.content?.[0]?.text ?? '';
      console.log(`  ${argName}: ${rText.slice(0, 200)}`);
    } catch (e: any) {
      console.log(`  ${argName} error: ${e.message?.slice(0, 200)}`);
    }
  }

  // Now check submit_transaction schema
  console.log('\n=== submit_transaction schema ===');
  const tools = await mcp.listTools();
  const submit = tools.tools.find(t => t.name === 'submit_transaction');
  console.log(JSON.stringify(submit?.inputSchema, null, 2));

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));