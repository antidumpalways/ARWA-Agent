/**
 * Helper: sign a pre-hashed message with a SECP256K1 key, producing
 * a 65-byte signature (algo || r || s) as required by x402 v2.
 *
 * The caller is responsible for any pre-hashing (e.g. SHA-256 of the EIP-712
 * keccak256 digest to mirror Casper SDK sign()).
 */
import { secp256k1 } from '@noble/curves/secp256k1';

export function signEip712Digest(
  signedMessage: Uint8Array, // already pre-hashed 32 bytes
  privateKeyBytes: Uint8Array,
  publicKeyCompressedHex: string // "01" or "02" + 64/66 hex chars
): Uint8Array {
  if (privateKeyBytes.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKeyBytes.length}`);
  }
  const sig = secp256k1.sign(signedMessage, privateKeyBytes);
  
  // Casper signature format for x402: [algo_byte] + [64_raw_sig_bytes (r||s)]
  const out = new Uint8Array(65);
  const algo = parseInt(publicKeyCompressedHex.slice(0, 2), 16);
  out[0] = algo;
  const compactSig = sig.toCompactRawBytes(); // 64 bytes: r(32) + s(32)
  out.set(compactSig, 1);
  
  return out;
}


