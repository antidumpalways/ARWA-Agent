import { buildUnsignedDeploy } from '../src/mcp/csprTradeMcp';
import { readFileSync, writeFileSync } from 'fs';
import { PrivateKey, KeyAlgorithm } from 'casper-js-sdk';

const pem = readFileSync('./keys/Account 1_secret_key.pem', 'utf-8');
const sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
const pk = sk.publicKey;

buildUnsignedDeploy({
  action: 'swap',
  tokenIn: 'CSPR',
  tokenOut: 'sCSPR',
  amountIn: '1000000000',
  minAmountOut: '990000000',
  payerAddress: pk.toHex()
}).then(result => {
  // Save to file for inspection
  writeFileSync('./scripts/swap-tx.json', JSON.stringify(result, null, 2));
  console.log('Saved to swap-tx.json');
  console.log('Type:', typeof result);
  console.log('Has hash:', 'hash' in result);
  console.log('Has payload:', 'payload' in result);
  
  // Check payload structure
  const payload = result.payload as any;
  console.log('Payload keys:', Object.keys(payload || {}));
  console.log('Fields keys:', Object.keys(payload?.fields || {}));
  
  // Check target structure
  const target = payload?.fields?.target;
  console.log('Target:', JSON.stringify(target).slice(0, 200));
}).catch(e => console.error('Error:', e.message));
