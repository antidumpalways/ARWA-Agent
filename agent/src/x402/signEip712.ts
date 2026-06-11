/**
 * Helper: sign a pre-hashed message with a SECP256K1 key, producing
 * a 65-byte signature (r || s || v) as required by x402 v2.
 *
 * The caller is responsible for any pre-hashing (e.g. SHA-256 of the EIP-712
 * keccak256 digest to mirror Casper SDK sign()).
 */
import * as secp256k1 from '@noble/secp256k1';

export function signEip712Digest(
  signedMessage: Uint8Array, // already pre-hashed 32 bytes
  privateKeyBytes: Uint8Array,
  publicKeyCompressedHex: string // "02" + 66 hex chars
): Uint8Array {
  if (privateKeyBytes.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKeyBytes.length}`);
  }
  const sig = secp256k1.signSync(signedMessage, privateKeyBytes, { der: false });
  const r = sig.slice(0, 32);
  const s = sig.slice(32, 64);
  const expectedPub = publicKeyCompressedHex.slice(2);
  for (const v of [0, 1]) {
    try {
      const recovered = secp256k1.recoverPublicKey(signedMessage, sig.slice(0, 64), v, true);
      const recHex = Buffer.from(recovered).toString('hex');
      if (recHex === expectedPub) {
        const out = new Uint8Array(65);
        out.set(r, 0);
        out.set(s, 32);
        out[64] = 27 + v;
        return out;
      }
    } catch {
      // try next v
    }
  }
  throw new Error('Could not find recovery bit v that matches the public key');
}


