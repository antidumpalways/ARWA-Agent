import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  // Load key
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;

  // Connect to main MCP
  const mainUrl = 'http://localhost:3001/mcp';
  console.log('Connecting to main MCP:', mainUrl);
  
  const transport = new StreamableHTTPClientTransport(new URL(mainUrl));
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
  
  // Step 2: Sign locally
  console.log('\n--- Step 2: Sign locally ---');
  const { blake2b } = await import('@noble/hashes/blake2b');
  
  // Compute blake2b hash of the payload
  const payloadBytes = Buffer.from(JSON.stringify(unsignedTx.payload));
  const hash = blake2b(payloadBytes, { dkLen: 32 });
  
  // Sign the hash
  const signature = sk.sign(hash);
  
  // Build approval
  const approval = {
    signer: pk.toHex(),
    signature: '02' + Buffer.from(signature).toString('hex'),
  };
  
  // Add approval to transaction
  const signedTx = { ...unsignedTx };
  signedTx.approvals = [...(signedTx.approvals || []), approval];
  
  console.log('Signed tx hash:', signedTx.hash);
  console.log('Approvals:', signedTx.approvals.length);
  console.log('Signer:', signedTx.approvals[0].signer);
  
  // Step 3: Submit via RPC
  console.log('\n--- Step 3: Submit via RPC ---');
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const rpcUrl = process.env.CASPER_RPC_URL || 'https://node.testnet.cspr.cloud/rpc';
  
  try {
    const response = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: {
        transaction: {
          Deploy: signedTx  // Wrap in Deploy key
        }
      },
      id: 1,
    }, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: apiKey,
      },
      timeout: 30000,
    });
    
    if (response.data.error) {
      console.log('RPC error:', response.data.error.message);
      console.log('Error data:', JSON.stringify(response.data.error.data, null, 2));
    } else {
      console.log('SUCCESS!');
      console.log('Result:', JSON.stringify(response.data.result, null, 2));
    }
  } catch (e: any) {
    console.log('Submit error:', e.message);
    if (e.response?.data) {
      console.log('Response:', JSON.stringify(e.response.data, null, 2));
    }
  }
  
  process.exit(0);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
