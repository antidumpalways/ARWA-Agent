/**
 * Full build/sign/submit workflow for add_liquidity using file_deploy_input.
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

  // Step 1: build_add_liquidity (will save files)
  const r: any = await mcp.callTool({
    name: 'build_add_liquidity',
    arguments: {
      token_a: 'WCSPR', token_b: 'CSPRCAT',
      amount_a: '1', amount_b: '1',
      sender_public_key: PK,
    },
  });
  const text = r.content?.[0]?.text ?? '';
  console.log(text);

  // Extract 3 file paths
  const fileRegex = /saved to: (\S+\.json)/g;
  const files: string[] = [];
  let m;
  while ((m = fileRegex.exec(text)) !== null) {
    files.push(m[1]);
  }
  console.log(`\nFiles to sign: ${files.length}`);
  files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));

  if (files.length < 3) {
    console.log('Not enough files');
    await mcp.close();
    return;
  }

  // Step 2: Sign each file in place (modify payment_amount on tx 3, sign, save)
  const pem = readFileSync(SECRET_KEY, 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);

  for (let i = 0; i < files.length; i++) {
    const unsignedJson = readFileSync(files[i], 'utf-8');
    const tx = JSON.parse(unsignedJson);
    if (i === 2 && tx.payload?.pricing_mode?.PaymentLimited) {
      tx.payload.pricing_mode.PaymentLimited.payment_amount = 200_000_000_000;
    }

    // Use SDK to sign
    const fakeHash = '0'.repeat(64);
    let sdkHash = '';
    try {
      const txObj = new TransactionV1(Hash.fromHex(fakeHash), tx.payload, []);
      txObj.sign(sk);
      sdkHash = (txObj as any).hash?.toHex?.() || fakeHash;
      tx.hash = sdkHash;
      tx.approvals = ((txObj as any).approvals || []).map((a: any) => ({
        signer: a.signer?.toHex?.() || '',
        signature: a.signature?.toString?.() || '',
      }));
    } catch (e: any) {
      console.log(`Sign error: ${e.message?.slice(0, 200)}`);
      continue;
    }

    // Write back to same file (now signed)
    writeFileSync(files[i], JSON.stringify(tx));
    console.log(`\nSigned tx ${i + 1}: hash=${sdkHash.slice(0, 16)}...`);
  }

  // Step 3: Submit each signed file via MCP
  for (let i = 0; i < files.length; i++) {
    console.log(`\n=== Submit tx ${i + 1} via MCP file path ===`);
    try {
      const r = await mcp.callTool({
        name: 'submit_transaction',
        arguments: { signed_deploy_file: files[i] },
      });
      const rText = r.content?.[0]?.text ?? '';
      console.log(rText.slice(0, 500));
    } catch (e: any) {
      console.log(`Error: ${e.message?.slice(0, 300)}`);
    }
  }

  await mcp.close();
}

main().catch(e => console.error('FAIL:', e.message));