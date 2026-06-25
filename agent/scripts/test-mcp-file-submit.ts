/**
 * Test: MCP submit_transaction accepts a JSON file path (file_deploy_input mode).
 * This is the standard pattern for build/sign/submit flow:
 *   1. build_add_liquidity → write unsigned JSON to file
 *   2. sign_deploy (would normally use local signer)
 *   3. submit_transaction with file path
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

  // Extract 3 txs
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

  // Sign all 3 and save to files
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  const filePaths: string[] = [];
  for (let i = 0; i < txs.length; i++) {
    const json = JSON.parse(txs[i]);
    // Increase gas for add_liquidity
    if (i === 2 && json.payload?.pricing_mode?.PaymentLimited) {
      json.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
    }
    // Sign via SDK with placeholder hash (forces SDK to use internal hash)
    const fakeHash = '0'.repeat(64);
    try {
      const tx = new TransactionV1(fakeHash, json.payload, []);
      tx.sign(sk);
      const signedJson = {
        hash: (tx as any).hash?.toHex?.() || fakeHash,
        payload: json.payload,
        approvals: ((tx as any).approvals || []).map((a: any) => ({
          signer: a.signer?.toHex?.() || '',
          signature: a.signature?.toString?.() || '',
        })),
      };
      const filePath = path.join('C:/Users/Acer/AppData/Local/Temp/opencode', `tx-${i}.json`);
      writeFileSync(filePath, JSON.stringify(signedJson));
      filePaths.push(filePath);
      console.log(`Wrote tx ${i + 1} to ${filePath} (${signedJson.hash.slice(0, 12)}...)`);
    } catch (e: any) {
      console.log(`Tx ${i + 1} sign error:`, e.message?.slice(0, 200));
    }
  }

  // Submit via MCP using file path
  for (let i = 0; i < filePaths.length; i++) {
    console.log(`\n=== Submit tx ${i + 1} via file path ===`);
    try {
      const r = await mcp.callTool({
        name: 'submit_transaction',
        arguments: { signed_deploy_file: filePaths[i] },
      });
      console.log((r.content?.[0]?.text ?? '').slice(0, 500));
    } catch (e: any) {
      console.log(`Error:`, e.message?.slice(0, 300));
    }
  }

  // Also try with raw JSON
  console.log('\n=== Submit tx 3 via raw JSON inline ===');
  if (filePaths.length >= 3) {
    const signedJson3 = JSON.parse(readFileSync(filePaths[2], 'utf-8'));
    try {
      const r = await mcp.callTool({
        name: 'submit_transaction',
        arguments: { signed_deploy_json: JSON.stringify(signedJson3) },
      });
      console.log((r.content?.[0]?.text ?? '').slice(0, 500));
    } catch (e: any) {
      console.log('Error:', e.message?.slice(0, 300));
    }
  }

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));