/**
 * Test x402 signature sign/recover locally
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { PrivateKey, PublicKey, KeyAlgorithm } from 'casper-js-sdk';
import { readFileSync } from 'fs';
import { signEip712Digest } from '../src/x402/signEip712';

function main() {
  const cfg = {
    pkPath: process.env.AGENT_SECRET_KEY_PATH ?? 'keys/Account 1_secret_key.pem',
  };

  // Load key
  const pem = readFileSync(cfg.pkPath, 'utf-8');
  const privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  const publicKey = privateKey.publicKey;
  console.log('[test] Public key:', publicKey.toHex());

  // Hardcoded digest (32 bytes)
  const digest = new Uint8Array(32);
  for (let i = 0; i < 32; i++) digest[i] = i;
  console.log('[test] Digest:', Buffer.from(digest).toString('hex'));

  // Sign
  const privBytes = privateKey.toBytes();
  const sigBytes = signEip712Digest(digest, privBytes, publicKey.toHex());
  console.log('[test] Signature (65 bytes):', Buffer.from(sigBytes).toString('hex'));
  console.log('[test] Signature length:', sigBytes.length);

  // Parse signature
  const sigAlgo = sigBytes[0];
  const r = BigInt('0x' + Buffer.from(sigBytes.slice(1, 33)).toString('hex'));
  const s = BigInt('0x' + Buffer.from(sigBytes.slice(33, 65)).toString('hex'));
  console.log('[test] sigAlgo:', sigAlgo);
  console.log('[test] r:', r.toString(16).padStart(64, '0'));
  console.log('[test] s:', s.toString(16).padStart(64, '0'));

  // Try to recover
  const expectedPubHex = publicKey.toHex();
  const expectedPubCompressed = expectedPubHex.slice(2); // drop "02" algo
  console.log('[test] Expected pub (compressed):', expectedPubCompressed);

  for (let v = 0; v <= 1; v++) {
    try {
      const sig = new secp256k1.Signature(r, s);
      const pub = sig.addRecoveryBit(v).recoverPublicKey(digest).toRawBytes(true);
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

  // Also try direct sign with @noble/curves
  console.log('\n--- Direct sign test ---');
  const directSig = secp256k1.sign(digest, privBytes);
  console.log('[test] Direct sig r:', directSig.r.toString(16).padStart(64, '0'));
  console.log('[test] Direct sig s:', directSig.s.toString(16).padStart(64, '0'));
  console.log('[test] Direct sig recovery:', directSig.recovery);
  
  const directPub = directSig.recoverPublicKey(digest).toRawBytes(true);
  console.log('[test] Direct recovered pub:', Buffer.from(directPub).toString('hex'));
}

main();
