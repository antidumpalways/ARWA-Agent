import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm, TransactionV1, Approval, Hash, PublicKey } from 'casper-js-sdk';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
  const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const pk = sk.publicKey;
  const apiKey = process.env.CSPR_CLOUD_API_KEY;
  const rpcUrl = process.env.CASPER_RPC_URL || 'https://node.testnet.cspr.cloud/rpc';

  // Build swap via MCP
  const transport = new StreamableHTTPClientTransport(new URL('http://localhost:3001/mcp'));
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport);

  const buildResult = await client.callTool({
    name: 'build_swap',
    arguments: {
      token_in: 'CSPR', token_out: 'sCSPR', amount: '1000000000',
      type: 'exact_in', min_amount_out: '990000000',
      sender_public_key: pk.toHex(), slippage_tolerance_bps: 50
    }
  });

  const text = buildResult.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*"hash"[\s\S]*"payload"[\s\S]*\}/);
  if (!jsonMatch) { console.log('No JSON'); process.exit(1); }
  const txJson = JSON.parse(jsonMatch[0]);
  console.log('TX hash from MCP:', txJson.hash);

  // Create TransactionV1 manually for signing only
  const txHash = Hash.fromHex(txJson.hash);
  const tx = new TransactionV1(txHash, txJson.payload, []);
  
  console.log('Signing with SDK...');
  tx.sign(sk);
  console.log('Signed!');
  
  // Get the signature from the SDK-signed transaction
  const sdkApproval = tx.approvals?.[0];
  const signerHex = sdkApproval?.signer?.toHex?.() || sdkApproval?.signer?.toString?.() || '';
  const sigHex = sdkApproval?.signature?.toString?.() || '';
  console.log('Signer:', signerHex);
  console.log('Sig length:', sigHex.length);
  
  // Build final JSON - original JSON + SDK's approval
  const signedJson = {
    ...txJson,
    approvals: [{ signer: signerHex, signature: sigHex }]
  };

  // Submit via RPC
  try {
    const res = await axios.post(rpcUrl, {
      jsonrpc: '2.0', method: 'account_put_transaction',
      params: { transaction: { Version1: signedJson } },
      id: 1
    }, {
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      timeout: 60000
    });
    
    if (res.data.error) {
      console.log('RPC error:', res.data.error.message);
      console.log('Data:', res.data.error.data?.slice(0, 300));
    } else {
      console.log('✓✓✓ SWAP SUBMITTED SUCCESSFULLY! ✓✓✓');
      console.log(JSON.stringify(res.data.result).slice(0, 500));
    }
  } catch (e: any) {
    console.log('Error:', e.message?.slice(0, 300));
  }

  process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
