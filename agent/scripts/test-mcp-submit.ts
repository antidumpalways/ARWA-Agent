import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';

async function main() {
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;

  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);
  console.log('Connected to MCP');

  // Build swap
  console.log('\n--- Building swap ---');
  const buildResult = await client.callTool({
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
  if (!jsonMatch) {
    console.log('Could not extract JSON');
    process.exit(1);
  }

  const unsignedTx = JSON.parse(jsonMatch[0]);
  console.log('Unsigned tx hash:', unsignedTx.hash);
  console.log('TX size:', JSON.stringify(unsignedTx).length, 'bytes');

  // Sign locally
  console.log('\n--- Signing locally ---');
  const { blake2b } = await import('@noble/hashes/blake2b');
  const payloadBytes = Buffer.from(JSON.stringify(unsignedTx.payload));
  const hash = blake2b(payloadBytes, { dkLen: 32 });
  const signature = sk.sign(hash);
  const approval = {
    signer: pk.toHex(),
    signature: '02' + Buffer.from(signature).toString('hex'),
  };
  const signedTx = { ...unsignedTx, approvals: [approval] };
  console.log('Signed tx hash:', signedTx.hash);
  console.log('Signed TX size:', JSON.stringify(signedTx).length, 'bytes');

  // Submit via MCP
  console.log('\n--- Submitting via MCP ---');
  try {
    const submitResult = await client.callTool({
      name: 'submit_transaction',
      arguments: { signed_deploy_json: JSON.stringify(signedTx) }
    });
    const submitText = submitResult.content?.[0]?.text || '';
    console.log('Submit result:', submitText.slice(0, 500));
    
    if (submitText.includes('deploy_hash') || submitText.includes('transaction_hash')) {
      console.log('\n✓ SUCCESS!');
    }
  } catch (e: any) {
    console.log('Submit error:', e.message?.slice(0, 500));
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
