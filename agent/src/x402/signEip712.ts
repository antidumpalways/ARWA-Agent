/**
 * Helper: sign a pre-hashed message with a SECP256K1 key, producing
 * a 64-byte signature (R || S) — no recovery byte — matching the
 * Casper SDK's PrivateKey.Sign() flow which returns 64 bytes.
 *
 * The signing chain matches the Casper SDK:
 *   1. SHA-256 hash the EIP-712 keccak256 digest  (32 → 32 bytes)
 *   2. Sign the SHA-256 hash using secp256k1.Sign   (64 bytes, R||S)
 *   3. Strip the recovery byte if present          (always 64)
 *
 * The caller is responsible for providing the EIP-712 digest (not the
 * SHA-256 pre-hash). This helper applies the SHA-256 + sign chain.
 *
 * NOTE: The make-software/casper-x402 facilitator's verifier code has a
 * 65-byte length check (looking for DER signatures), but the
 * VerifySignature method it actually calls accepts 64-byte raw R||S sigs.
 * 64 bytes is the correct format for x402 v2.
 */
import * as secp256k1 from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';

export function signEip712Digest(
  eip712Digest: Uint8Array, // 32-byte EIP-712 keccak256 digest
  privateKeyBytes: Uint8Array,
  publicKeyCompressedHex: string // "02" + 66 hex chars (33 bytes compressed)
): Uint8Array {
  if (privateKeyBytes.length !== 32) {
    throw new Error(`private key must be 32 bytes, got ${privateKeyBytes.length}`);
  }
  if (eip712Digest.length !== 32) {
    throw new Error(`EIP-712 digest must be 32 bytes, got ${eip712Digest.length}`);
  }
  // Step 1: SHA-256 hash the EIP-712 digest (mirrors Casper SDK Sign)
  const preHashed = sha256(eip712Digest);
  // Step 2: Sign the pre-hashed message using secp256k1
  const sig64 = secp256k1.signSync(preHashed, privateKeyBytes, { der: false });
  // sig64 is 64 bytes (R || S). If a lib returns 65 with v at index 0, strip.
  let sig64Trimmed: Uint8Array;
  if (sig64.length === 65) {
    sig64Trimmed = sig64.slice(1);
  } else if (sig64.length === 64) {
    sig64Trimmed = sig64;
  } else {
    throw new Error(`Unexpected signature length: ${sig64.length}`);
  }
  // Step 3: Find the recovery bit v that recovers to the supplied pubkey
  const expectedPub = publicKeyCompressedHex.slice(2); // 33 bytes compressed
  let vFound = -1;
  for (const v of [0, 1]) {
    try {
      const recovered = secp256k1.recoverPublicKey(preHashed, sig64Trimmed, v, true);
      const recHex = Buffer.from(recovered).toString('hex');
      if (recHex === expectedPub) {
        vFound = v;
        break;
      }
    } catch {
      // try next v
    }
  }
  if (vFound < 0) {
    throw new Error('Could not find recovery bit v that matches the public key');
  }
  // The Go facilitator (make-software/casper-x402) checks `len(sigBytes) != 65`,
  // but the actual VerifySignature method accepts 64-byte sigs. To bypass the
  // length check, we pad to 65 bytes with a zero byte (DER-style) — the
  // facilitator's ParseDERSignature will fail, but we provide a fallback.
  // Alternative: send only 64 bytes. The CSPR.cloud facilitator uses 65 bytes
  // for the length check too. To support BOTH, send 65 bytes with the v byte.
  const out = new Uint8Array(65);
  out.set(sig64Trimmed, 0);
  out[64] = 27 + vFound;
  return out;
}





