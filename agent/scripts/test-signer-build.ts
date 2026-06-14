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
  
  // Try build_swap on signer MCP - maybe it auto-signs?
  console.log('\n--- Testing build_swap on signer MCP ---');
  try {
    const result = await client.callTool({
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
    
    const text = result.content?.[0]?.text || '';
    console.log('Result (first 1000 chars):', text.slice(0, 1000));
    
    // Check if it contains approvals (signed)
    if (text.includes('approvals') && !text.includes('"approvals":[]')) {
      console.log('\n✓ Transaction appears to be SIGNED (has approvals)');
    } else {
      console.log('\n✗ Transaction appears to be UNSIGNED (no approvals)');
    }
    
    // Try to extract and check the JSON
    const jsonMatch = text.match(/\{[\s\S]*"hash"[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const txJson = JSON.parse(jsonMatch[0]);
        console.log('\nTransaction hash:', txJson.hash);
        console.log('Approvals count:', txJson.approvals?.length || 0);
        if (txJson.approvals?.length > 0) {
          console.log('First approval signer:', txJson.approvals[0].signer);
        }
      } catch (e) {
        console.log('Could not parse JSON');
      }
    }
  } catch (e: any) {
    console.log('Error:', e.message);
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
