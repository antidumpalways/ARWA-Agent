/**
 * Manual signing: compute blake2b(payload) hash, then sign with ECDSA.
 * This avoids SDK's wrong canonical serialization.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import { blake2b } from '@noble/hashes/blake2b';
import { secp256k1 } from '@noble/curves/secp256k1';
import { utf8ToBytes, bytesToHex } from '@noble/hashes/utils';
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
      if (escape) {escape =false; continue; }
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
  if (txs.length < 3) { console.log('Found only', txs.length, 'txs'); console.log('First 1000 chars of text:', text.slice(0, 1000)); return; }

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  // Sign each tx using blake2b over canonical payload
  for (let i = 0; i < txs.length; i++) {
    const json = JSON.parse(txs[i]);
    if (i === 2 && json.payload?.pricing_mode?.PaymentLimited) {
      json.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
    }

    // Compute hash via blake2b over canonical payload JSON
    // The canonical form is the SDK's TypedJSON serialization, NOT plain JSON.stringify
    // But we can try plain JSON.stringify first to see if network accepts
    const payloadStr = JSON.stringify(json.payload);
    const payloadBytes = new TextEncoder().encode(payloadStr);
    const hash = blake2b(payloadBytes, { dkLen: 32 });
    const hashHex = bytesToHex(hash);
    console.log(`Tx ${i + 1}: MCP hash = ${json.hash.slice(0, 16)}..., manual hash = ${hashHex.slice(0, 16)}...`);

    if (hashHex === json.hash) {
      console.log('  Hash MATCHES!');
    } else {
      console.log('  Hash DIFFERS');
    }

    // Sign with private key
    if (hashHex === json.hash) {
      // Sign the blake2b hash
      const signature = sk.sign(hash);
      // Format: 0x02 prefix for SECP256K1, then r || s
      const sigHex = '02' + Buffer.from(signature).toString('hex');
      json.approvals = [{
        signer: PK,
        signature: sigHex,
      }];
      const body = JSON.stringify({
        jsonrpc: '2.0',
        method: 'account_put_transaction',
        params: { transaction: { Version1: json } },
        id: 1,
      });
      console.log(`  Body size: ${body.length}`);
      try {
        const resp = await axios.post(RPC, body, {
          headers: { 'Content-Type': 'application/json', Authorization: API_KEY },
          timeout: 60000,
          maxBodyLength: Infinity, maxContentLength: Infinity,
        });
        console.log('  Response:', JSON.stringify(resp.data, null, 2).slice(0, 800));
      } catch (e: any) {
        console.log('  Submit error:', e.message?.slice(0, 200));
      }
    }
  }

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));