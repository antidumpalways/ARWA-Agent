/**
 * Use CSPR.trade MCP submit_transaction tool directly — it may handle Session txs
 * properly without RPC size limits.
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

async function main() {
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

  // build_add_liquidity
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

  // Sign all 3 with our key
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const signedTxs: string[] = [];
  for (let i = 0; i < txs.length; i++) {
    const json = JSON.parse(txs[i]);
    if (i === 2 && json.payload?.pricing_mode?.PaymentLimited) {
      json.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
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
    signedTxs.push(JSON.stringify(signedJson));
  }
  console.log('Signed 3 txs, sizes:', signedTxs.map(t => t.length));

  // Submit via MCP submit_transaction
  console.log('\n=== Submitting via MCP submit_transaction ===');
  for (let i = 0; i < signedTxs.length; i++) {
    try {
      const r = await mcp.callTool({
        name: 'submit_transaction',
        arguments: { signed_deploy_json: signedTxs[i] },
      });
      const rText = r.content?.[0]?.text ?? '';
      console.log(`\nTx ${i + 1} (size=${signedTxs[i].length}):`);
      console.log(rText.slice(0, 600));
    } catch (e: any) {
      console.log(`\nTx ${i + 1} (size=${signedTxs[i].length}) error:`, e.message?.slice(0, 300));
    }
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });