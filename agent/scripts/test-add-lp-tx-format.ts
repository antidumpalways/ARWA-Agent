/**
 * Test add_liquidity with proper Session tx handling.
 * Session tx must use TransactionV1.fromJSON (not from raw json) or use the
 * newer SDK API.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, Hash, TransactionV1, Transaction } from 'casper-js-sdk';
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
  const mcp = new Client({ name: 'arwa', version: '0.0.1' }, { capabilities: {} });
  await mcp.connect(transport);

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

  // Extract 3 txs
  const hashRegex = /"hash":"[a-f0-9]{64}"/g;
  const positions: number[] = [];
  let m;
  while ((m = hashRegex.exec(text)) !== null) {
    let p = m.index;
    while (p > 0 && text[p] !== '{') p--;
    if (p > 0) positions.push(p);
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
  for (const p of positions) { const tx = extractTx(p); if (tx) txs.push(tx); }
  if (txs.length < 3) { console.log('Not enough txs'); return; }

  const addTx = JSON.parse(txs[2]);
  if (addTx.payload?.pricing_mode?.PaymentLimited) {
    addTx.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
  }
  txs[2] = JSON.stringify(addTx);

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  // Sign add LP with proper Session handling
  const addJson = JSON.parse(txs[2]);
  const txHash = Hash.fromHex(addJson.hash);

  // Try multiple approaches
  console.log('Approach 1: TransactionV1 + Transaction.fromTransactionV1');
  try {
    const tx = new TransactionV1(txHash, addJson.payload, []);
    tx.sign(sk);
    const approval = tx.approvals?.[0];
    const signedJson = {
      ...addJson,
      approvals: [{
        signer: approval?.signer?.toHex?.() || '',
        signature: approval?.signature?.toString?.() || '',
      }],
    };
    const wrapped = Transaction.fromTransactionV1(tx);
    const resp = await axios.post(RPC, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: signedJson } },
      id: 1
    }, {
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: API_KEY } : {}),
      },
      timeout: 60000,
    });
    if (resp.data.error) {
      console.log('  RPC error:', resp.data.error.message);
    } else {
      const resultHash = resp.data.result?.transaction_hash?.Version1 || resp.data.result?.transaction_hash;
      console.log('  Success:', resultHash);
    }
  } catch (e: any) {
    console.log('  Approach 1 fail:', e.message?.slice(0, 200));
  }

  // Approach 2: send with just Version1 wrapper (not Transaction wrapper)
  console.log('\nApproach 2: raw Version1 only');
  try {
    const tx = new TransactionV1(txHash, addJson.payload, []);
    tx.sign(sk);
    const approval = tx.approvals?.[0];
    const signedJson = {
      ...addJson,
      approvals: [{
        signer: approval?.signer?.toHex?.() || '',
        signature: approval?.signature?.toString?.() || '',
      }],
    };
    const resp = await axios.post(RPC, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: signedJson } },
      id: 1
    }, {
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: API_KEY } : {}),
      },
      timeout: 60000,
    });
    if (resp.data.error) {
      console.log('  RPC error:', resp.data.error.message);
    } else {
      const resultHash = resp.data.result?.transaction_hash?.Version1 || resp.data.result?.transaction_hash;
      console.log('  Success:', resultHash);
    }
  } catch (e: any) {
    console.log('  Approach 2 fail:', e.message?.slice(0, 200));
  }

  // Approach 3: account_put_deploy (legacy) for Deploy
  console.log('\nApproach 3: account_put_deploy (legacy Deploy)');
  try {
    const tx = new TransactionV1(txHash, addJson.payload, []);
    tx.sign(sk);
    const approval = tx.approvals?.[0];
    const signedJson = {
      ...addJson,
      approvals: [{
        signer: approval?.signer?.toHex?.() || '',
        signature: approval?.signature?.toString?.() || '',
      }],
    };
    // Use Version1 with transactionV1 type wrapped
    const resp = await axios.post(RPC, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: signedJson },  // No Version1 wrapper
      id: 1
    }, {
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: API_KEY } : {}),
      },
      timeout: 60000,
    });
    if (resp.data.error) {
      console.log('  RPC error:', resp.data.error.message);
    } else {
      const resultHash = resp.data.result?.transaction_hash?.Version1 || resp.data.result?.transaction_hash;
      console.log('  Success:', resultHash);
    }
  } catch (e: any) {
    console.log('  Approach 3 fail:', e.message?.slice(0, 200));
  }

  await mcp.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });