import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const rpcUrl = process.env.CASPER_RPC_URL || 'https://node.testnet.cspr.cloud/rpc';

  // Build swap
  const mainUrl = 'http://localhost:3001/mcp';
  const mainTransport = new StreamableHTTPClientTransport(new URL(mainUrl));
  const mainClient = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await mainClient.connect(mainTransport);

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
  if (!jsonMatch) { console.log('No JSON'); process.exit(1); }
  const unsignedTx = JSON.parse(jsonMatch[0]);
  console.log('Unsigned tx hash:', unsignedTx.hash);

  // Sign locally - use the transaction HASH, not payload
  console.log('\n--- Signing locally ---');
  const { blake2b } = await import('@noble/hashes/blake2b');
  
  // Build tx body (without approvals) as JSON bytes
  const txWithoutApprovals = { hash: unsignedTx.hash, payload: unsignedTx.payload };
  const txBodyBytes = Buffer.from(JSON.stringify(txWithoutApprovals));
  const txHash = blake2b(txBodyBytes, { dkLen: 32 });
  console.log('TX hash (blake2b):', Buffer.from(txHash).toString('hex'));
  
  // Sign with SECP256K1
  const signature = sk.sign(txHash);
  // SDK format: 65 bytes = algo (1) + r (32) + s (32)  
  const algo = pk.cryptoAlg;
  const sigWithAlgo = Buffer.alloc(65);
  sigWithAlgo[0] = algo;
  sigWithAlgo.set(signature, 1);
  const sigHex = sigWithAlgo.toString('hex');
  console.log('Signature length:', sigHex.length, 'chars');
  console.log('Signer pubkey:', pk.toHex());
  
  const signedTx = {
    ...unsignedTx,
    approvals: [{ signer: pk.toHex(), signature: sigHex }]
  };

  // Try account_put_transaction with Version1 wrapping
  console.log('\n--- account_put_transaction with Version1 key ---');
  try {
    const res = await axios.post(rpcUrl, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: signedTx } },
      id: 1
    }, {
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      timeout: 60000
    });
    if (res.data.error) {
      console.log('Error:', res.data.error.message, res.data.error.data?.slice(0,300));
    } else {
      console.log('✓✓✓ SUCCESS! ✓✓✓');
      console.log(JSON.stringify(res.data.result).slice(0, 500));
    }
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
