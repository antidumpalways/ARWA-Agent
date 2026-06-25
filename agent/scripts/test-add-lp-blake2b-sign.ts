/**
 * Sign the file directly using blake2b hash of canonical payload + ECDSA.
 * Then submit via MCP submit_transaction with signed_deploy_json (string).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync, writeFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import { blake2b } from '@noble/hashes/blake2b';
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

  const fileRegex = /saved to: (\S+\.json)/g;
  const files: string[] = [];
  let m;
  while ((m = fileRegex.exec(text)) !== null) {
    files.push(m[1]);
  }

  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  for (let i = 0; i < files.length; i++) {
    const tx = JSON.parse(readFileSync(files[i], 'utf-8'));
    if (i === 2 && tx.payload?.pricing_mode?.PaymentLimited) {
      tx.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
    }

    // Compute hash manually: blake2b over canonical JSON payload
    const payloadStr = JSON.stringify(tx.payload);
    const hashBytes = blake2b(new TextEncoder().encode(payloadStr), { dkLen: 32 });
    const hashHex = Buffer.from(hashBytes).toString('hex');

    console.log(`Tx ${i + 1}: MCP hash = ${tx.hash.slice(0, 16)}...`);
    console.log(`         manual = ${hashHex.slice(0, 16)}...`);
    if (hashHex !== tx.hash) {
      console.log('  HASH DIFFERS — cannot sign with manual hash');
      continue;
    }

    // Sign with private key (sign blake2b hash directly)
    const sigBytes = (sk as any).signRaw?.(hashBytes) || (sk as any).sign?.(hashBytes);
    const sigHex = '02' + Buffer.from(sigBytes).toString('hex');

    // Update tx with hash + approval
    tx.hash = hashHex;
    tx.approvals = [{
      signer: PK,
      signature: sigHex,
    }];

    // Submit via MCP
    const jsonStr = JSON.stringify(tx);
    try {
      const r = await mcp.callTool({
        name: 'submit_transaction',
        arguments: { signed_deploy_json: jsonStr },
      });
      const rText = r.content?.[0]?.text ?? '';
      console.log(`  Result: ${rText.slice(0, 400)}`);
    } catch (e: any) {
      console.log(`  Error: ${e.message?.slice(0, 300)}`);
    }
  }

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));