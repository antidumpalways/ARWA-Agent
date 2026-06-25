/**
 * Try add_liquidity on different testnet pairs to find one with smaller tx size.
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

async function extractAddTx(text: string): Promise<{ signedTx: string; size: number } | null> {
  const txPositions: number[] = [];
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) txPositions.push(p);
  }
  if (txPositions.length < 3) return null;
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
  // Approve tx 1, 2 and add LP tx 3
  const approve1 = extractTx(txPositions[0])!;
  const approve2 = extractTx(txPositions[1])!;
  const addLP = extractTx(txPositions[2])!;
  // Sign all
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const signAndBump = (jsonStr: string, gasAmount?: number): string => {
    const json = JSON.parse(jsonStr);
    if (gasAmount && json.payload?.pricing_mode?.PaymentLimited) {
      json.payload.pricing_mode.PaymentLimited.payment_amount = gasAmount;
    }
    const tx = new TransactionV1(Hash.fromHex(json.hash), json.payload, []);
    tx.sign(sk);
    const ap = tx.approvals?.[0];
    return JSON.stringify({
      ...json,
      approvals: [{
        signer: ap?.signer?.toHex?.() || '',
        signature: ap?.signature?.toString?.() || '',
      }],
    });
  };
  const signedA1 = signAndBump(approve1, 5_000_000_000);
  const signedA2 = signAndBump(approve2, 5_000_000_000);
  const signedAdd = signAndBump(addLP, 200_000_000_000);
  return { signedTx: signedAdd, size: signedAdd.length };
}

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // Get all pairs
  const pairs: any = await mcp.callTool({ name: 'get_pairs', arguments: { limit: 100 } });
  const text = pairs.content?.[0]?.text ?? '';
  // Parse pairs
  const pairBlocks = text.split('"contractPackageHash"').slice(1);
  const pairList: { hash: string; tokens: string }[] = [];
  for (const blk of pairBlocks) {
    const m = blk.match(/^:\s*"([a-f0-9]{64})"/);
    if (!m) continue;
    const symbols = [...blk.matchAll(/"symbol":\s*"([A-Z]+)"/g)].map(x => x[1]);
    if (symbols.length === 2) {
      pairList.push({ hash: m[1], tokens: symbols.join('/') });
    }
  }
  console.log(`Found ${pairList.length} pairs`);

  // Try each pair (limit to first 5)
  for (const p of pairList.slice(0, 8)) {
    const [tA, tB] = p.tokens.split('/');
    try {
      const r: any = await mcp.callTool({
        name: 'build_add_liquidity',
        arguments: {
          token_a: tA, token_b: tB,
          amount_a: '1', amount_b: '1',
          sender_public_key: PK,
        },
      });
      const txText = r.content?.[0]?.text ?? '';
      if (txText.includes('Error') || !txText.includes('Transaction JSON')) continue;
      const result = await extractAddTx(txText);
      if (result) {
        const under = result.size < 100_000 ? '✓ FIT' : '✗ TOO BIG';
        console.log(`${under}  ${p.tokens} (${p.hash.slice(0, 8)}...): tx=${result.size} bytes`);
      }
    } catch (e: any) {
      console.log(`SKIP ${p.tokens}: ${e.message?.slice(0, 100)}`);
    }
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });