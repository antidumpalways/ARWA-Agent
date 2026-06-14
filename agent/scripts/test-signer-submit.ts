import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';

async function main() {
  // Load key
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;

  // Connect to signer MCP
  const signerUrl = 'http://localhost:3002/mcp';
  console.log('Connecting to signer MCP:', signerUrl);
  
  const transport = new StreamableHTTPClientTransport(new URL(signerUrl));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  
  await client.connect(transport);
  console.log('Connected!');
  
  // Step 1: Build unsigned swap
  console.log('\n--- Step 1: Build unsigned swap ---');
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
  
  const buildText = buildResult.content?.[0]?.text || '';
  const jsonMatch = buildText.match(/\{[\s\S]*"hash"[\s\S]*"payload"[\s\S]*\}/);
  
  if (!jsonMatch) {
    console.log('Could not extract transaction JSON');
    process.exit(1);
  }
  
  const unsignedTx = JSON.parse(jsonMatch[0]);
  console.log('Unsigned tx hash:', unsignedTx.hash);
  console.log('Approvals:', unsignedTx.approvals?.length || 0);
  
  // Step 2: Try to submit unsigned tx to signer MCP
  // Maybe it signs internally?
  console.log('\n--- Step 2: Submit to signer MCP ---');
  try {
    const submitResult = await client.callTool({
      name: 'submit_transaction',
      arguments: {
        signed_deploy_json: unsignedTx
      }
    });
    
    const submitText = submitResult.content?.[0]?.text || '';
    console.log('Submit result:', submitText.slice(0, 500));
    
    // Check if it was signed and submitted
    if (submitText.includes('deploy_hash') || submitText.includes('transaction_hash')) {
      console.log('\n✓ Transaction submitted successfully!');
      const hashMatch = submitText.match(/(?:deploy_hash|transaction_hash)["\s:]+([a-f0-9]{64})/i);
      if (hashMatch) {
        console.log('Transaction hash:', hashMatch[1]);
      }
    } else if (submitText.includes('error') || submitText.includes('Error')) {
      console.log('\n✗ Submission failed');
    }
  } catch (e: any) {
    console.log('Submit error:', e.message);
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
