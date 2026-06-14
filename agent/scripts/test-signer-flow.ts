import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';

async function main() {
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;

  // Connect to main MCP for build
  const mainUrl = 'http://localhost:3001/mcp';
  console.log('Building on main MCP:', mainUrl);
  
  const mainTransport = new StreamableHTTPClientTransport(new URL(mainUrl));
  const mainClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await mainClient.connect(mainTransport);

  // Build swap
  const buildResult = await mainClient.callTool({
    name: 'build_swap',
    arguments: {
      token_in: 'CSPR',
      token_out: 'sCSPR',
      amount: '1000000000',
      type: 'exact_in',
      min_amount_out: '990000000',
      sender_public_key: pk.toHex(),
      slippage_tolerance_bps: 50
    }
  });

  const text = buildResult.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*"hash"[\s\S]*"payload"[\s\S]*\}/);
  if (!jsonMatch) { console.log('No JSON found'); process.exit(1); }

  const unsignedTx = JSON.parse(jsonMatch[0]);
  console.log('Unsigned tx hash:', unsignedTx.hash);

  // Connect to signer MCP for submit
  const signerUrl = 'http://localhost:3002/mcp';
  console.log('Submitting to signer MCP:', signerUrl);
  
  const signerTransport = new StreamableHTTPClientTransport(new URL(signerUrl));
  const signerClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await signerClient.connect(signerTransport);

  // Try submit unsigned tx - signer mode might auto-sign
  console.log('\n--- Attempt 1: Submit unsigned tx to signer MCP ---');
  try {
    const result = await signerClient.callTool({
      name: 'submit_transaction',
      arguments: { signed_deploy_json: JSON.stringify(unsignedTx) }
    });
    console.log('Result:', result.content?.[0]?.text?.slice(0, 500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  // Sign locally and try again
  console.log('\n--- Attempt 2: Sign locally, submit to signer MCP ---');
  const { blake2b } = await import('@noble/hashes/blake2b');
  const payloadBytes = Buffer.from(JSON.stringify(unsignedTx.payload));
  const hash = blake2b(payloadBytes, { dkLen: 32 });
  const signature = sk.sign(hash);
  const signedTx = {
    ...unsignedTx,
    approvals: [{ signer: pk.toHex(), signature: '02' + Buffer.from(signature).toString('hex') }]
  };

  try {
    const result = await signerClient.callTool({
      name: 'submit_transaction',
      arguments: { signed_deploy_json: JSON.stringify(signedTx) }
    });
    console.log('Result:', result.content?.[0]?.text?.slice(0, 500));
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
