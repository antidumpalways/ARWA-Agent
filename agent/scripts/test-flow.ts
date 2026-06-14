/**
 * Test full x402 flow locally without HTTP
 */
import {
  hashTypedData,
  buildDomain,
  CASPER_DOMAIN_TYPES,
} from '@casper-ecosystem/casper-eip-712';
import type { TypeDefinitions } from '@casper-ecosystem/casper-eip-712';
import { secp256k1 } from '@noble/curves/secp256k1';
import { PrivateKey, PublicKey, KeyAlgorithm } from 'casper-js-sdk';
import { readFileSync } from 'fs';
import { signEip712Digest } from '../src/x402/signEip712';
import { loadConfig } from '../src/config';

function main() {
  const cfg = loadConfig();
  
  // Load key
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  const privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const publicKey = privateKey.publicKey;
  const privBytes = privateKey.toBytes();
  
  console.log('[test] Public key:', publicKey.toHex());
  
  // Build EIP-712 domain and message (same as client)
  const assetBytes32 = '3d80df21ba4ee4d66a2a1f60c32570dd5685e4b279f6538162a5fd1314847c1e';
  const domain = buildDomain('Casper x402', '1', 'casper-test', assetBytes32);
  
  // Build from address (pubkey form)
  const uncompressed = secp256k1.getPublicKey(privBytes, false);
  const xCoord = Buffer.from(uncompressed).slice(1, 33);
  const fromAddr = '02' + xCoord.toString('hex');
  
  const toAddr = '006a0459e25d4c5721dd4b0d2af0a5750d92f97766e2e2fcb5877401753800630e';
  const now = Math.floor(Date.now() / 1000);
  const nonce = '806657202eb272fd626c512de23b14523836cd51c127dd860e22dd970e92bfc5';
  
  const message = {
    from: fromAddr,
    to: toAddr,
    value: BigInt('1000000'),
    validAfter: BigInt(now - 5),
    validBefore: BigInt(now + 600),
    nonce: nonce,
  };
  
  console.log('[test] Domain:', JSON.stringify(domain));
  console.log('[test] Message:', JSON.stringify({
    from: message.from,
    to: message.to,
    value: message.value.toString(),
    validAfter: message.validAfter.toString(),
    validBefore: message.validBefore.toString(),
    nonce: message.nonce,
  }));
  
  // Hash (client side)
  const transferWithAuthorizationTypes: TypeDefinitions = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  
  const clientDigest = hashTypedData(
    domain,
    transferWithAuthorizationTypes,
    'TransferWithAuthorization',
    message,
    { domainTypes: CASPER_DOMAIN_TYPES }
  );
  console.log('[test] Client digest:', Buffer.from(clientDigest).toString('hex'));
  
  // Sign
  const sigBytes = signEip712Digest(clientDigest, privBytes, publicKey.toHex());
  console.log('[test] Signature:', Buffer.from(sigBytes).toString('hex'));
  
  // Verify (server side) - reconstruct digest
  const serverDigest = hashTypedData(
    domain,
    transferWithAuthorizationTypes,
    'TransferWithAuthorization',
    message,
    { domainTypes: CASPER_DOMAIN_TYPES }
  );
  console.log('[test] Server digest:', Buffer.from(serverDigest).toString('hex'));
  
  if (Buffer.from(clientDigest).toString('hex') !== Buffer.from(serverDigest).toString('hex')) {
    console.log('[test] ✗ DIGEST MISMATCH!');
    return;
  }
  console.log('[test] ✓ Digests match');
  
  // Recover pubkey
  const sigAlgo = sigBytes[0];
  const r = BigInt('0x' + Buffer.from(sigBytes.slice(1, 33)).toString('hex'));
  const s = BigInt('0x' + Buffer.from(sigBytes.slice(33, 65)).toString('hex'));
  
  const expectedPubCompressed = publicKey.toHex().slice(2);
  console.log('[test] Expected pub:', expectedPubCompressed);
  
  for (let v = 0; v <= 1; v++) {
    try {
      const sig = new secp256k1.Signature(r, s);
      const pub = sig.addRecoveryBit(v).recoverPublicKey(serverDigest).toRawBytes(true);
      const recHex = Buffer.from(pub).toString('hex');
      console.log(`[test] v=${v} recovered:`, recHex);
      if (recHex === expectedPubCompressed) {
        console.log(`[test] ✓ MATCH at v=${v}`);
      } else {
        console.log(`[test] ✗ no match at v=${v}`);
      }
    } catch (e: any) {
      console.log(`[test] v=${v} error:`, e.message);
    }
  }
}

main();
