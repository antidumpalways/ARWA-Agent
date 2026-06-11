/**
 * x402 v2 client for Casper.
 *
 * Flow (against any x402 v2 server):
 *   1. GET <paid-endpoint>
 *   2. Server returns 402 + header PAYMENT-REQUIRED = base64(json PaymentRequirements)
 *   3. Decode base64 → parse requirements (scheme, network, payTo, asset, amount, extra)
 *   4. Build EIP-712 typed data TransferAuthorization matching server's `extra`
 *   5. Hash via @casper-ecosystem/casper-eip-712
 *   6. Sign with the agent's PrivateKey (casper-js-sdk v5)
 *   7. Build PaymentPayload and base64-encode → PAYMENT-SIGNATURE header
 *   8. Replay with the header
 *   9. Server validates, forwards to CSPR.cloud x402 facilitator for on-chain settle
 *
 * x402 v2 spec:
 *   - account hash format: "00" + 64 hex chars
 *   - public key format: "01" or "02" + 64/66 hex chars (algorithm prefix)
 *   - signature: 65 bytes EIP-712 (130 hex chars)
 *   - nonce: 32 bytes (64 hex chars)
 *   - network: "casper:casper" or "casper:casper-test" (CAIP-2)
 *   - asset: 64-char hex (CEP-18 contract package hash, no "hash-" prefix)
 *   - x402Version: 2
 *   - scheme: "exact"
 *
 * Refs:
 *   https://docs.cspr.cloud/x402-facilitator-api/reference
 *   https://docs.cspr.cloud/x402-facilitator-api/verify
 */
import axios, { AxiosResponse } from 'axios';
import { readFileSync } from 'fs';
import {
  hashTypedData,
  TransferAuthorizationTypes,
  buildDomain,
  toHex,
} from '@casper-ecosystem/casper-eip-712';
import { PrivateKey, KeyAlgorithm, PublicKey } from 'casper-js-sdk';
import { loadConfig } from '../config';
import { X402Proof } from '../types';
import { getAgentKeys } from '../casper/signer';
import { signEip712Digest } from './signEip712';

export interface PaymentRequirementsV2 {
  scheme: 'exact';
  network: string;            // "casper:casper-test"
  payTo: string;              // "00" + 64 hex chars
  amount: string;             // decimal string of base units
  asset: string;              // 64-char hex (no "hash-" prefix)
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    decimals?: string;
    symbol?: string;
  };
}

export interface PaymentPayloadV2 {
  x402Version: 2;
  resource: { url: string };
  accepted: PaymentRequirementsV2;
  payload: {
    signature: string;        // 130 hex chars
    publicKey: string;        // with algo prefix
    authorization: {
      from: string;           // "00" + 64 hex
      to: string;             // "00" + 64 hex
      value: string;          // decimal string
      validAfter: string;     // unix seconds
      validBefore: string;    // unix seconds
      nonce: string;          // 64 hex chars
    };
  };
}

export interface X402Response<T = any> {
  data: T;
  proof: X402Proof;
  raw: AxiosResponse;
}

function parsePaymentRequiredHeader(b64: string): PaymentRequirementsV2 | null {
  try {
    const json = Buffer.from(b64, 'base64').toString('utf-8');
    return JSON.parse(json) as PaymentRequirementsV2;
  } catch {
    return null;
  }
}

function encodePaymentPayload(payload: PaymentPayloadV2): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

/**
 * Attempt to fetch a paid resource. Handles 402 detection, EIP-712 v2 signing,
 * and proof extraction. If the endpoint doesn't return 402, returns the data
 * with a null proof (free endpoint).
 */
export async function payAndFetchViaX402<T = any>(
  endpoint: string,
  options: {
    method?: 'GET' | 'POST';
    body?: any;
    privateKeyPath?: string;
    paymentAmountOverride?: string;
  } = {}
): Promise<X402Response<T>> {
  const cfg = loadConfig();
  const method = options.method ?? 'GET';
  const pkPath = options.privateKeyPath ?? cfg.AGENT_SECRET_KEY_PATH;

  // 1) initial request
  const initial = await axios.request({
    method,
    url: endpoint,
    data: options.body,
    validateStatus: () => true,
    timeout: 10_000,
  });
  if (initial.status !== 402) {
    return { data: initial.data as T, proof: null as any, raw: initial };
  }

  // 2) parse 402 headers (x402 v2: PAYMENT-REQUIRED = base64 json)
  const headerB64 =
    (initial.headers['payment-required'] as string | undefined) ??
    (initial.headers['PAYMENT-REQUIRED'] as string | undefined);
  let reqs = headerB64 ? parsePaymentRequiredHeader(headerB64) : null;
  if (!reqs) {
    throw new Error('402 returned but no parseable PAYMENT-REQUIRED header');
  }
  if (options.paymentAmountOverride) {
    reqs = { ...reqs, amount: options.paymentAmountOverride };
  }

  // 3) build EIP-712 typed data
  // Make sure AGENT_PUBLIC_KEY is populated (getAgentKeys() reads PEM and caches it)
  const { publicKey: agentPubKey } = getAgentKeys();
  // Account hash is 32 raw bytes; the "00" prefix in x402 wire format is a Casper
  // Key tag (Key::Account) that EIP-712 hashTypedData does NOT want.
  const agentAccountHashBytes32 = agentPubKey.accountHash().toHex().padStart(64, '0').slice(-64);
  const agentAccountHashV2 = '00' + agentAccountHashBytes32; // for wire format

  // Strip any prefix from server-supplied payTo and asset
  const payToBytes32 = (reqs.payTo ?? '').replace(/^account-hash-/, '').replace(/^00/, '').padStart(64, '0').slice(-64);
  const payToV2 = '00' + payToBytes32; // for wire format
  const assetBare = (reqs.asset ?? '').replace(/^hash-/, '');
  const assetBytes32 = assetBare.padStart(64, '0').slice(-64);

  // Use the server's `extra` (name, version) to build the EIP-712 domain
  const domainName = reqs.extra?.name ?? 'Caspar x402';
  const domainVersion = reqs.extra?.version ?? '1';

  const domain = buildDomain(
    domainName,
    domainVersion,
    reqs.network,
    assetBytes32
  );
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 5; // 5s clock-skew tolerance
  const validBefore = now + (reqs.maxTimeoutSeconds ?? 600);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const nonceHex = Buffer.from(nonce).toString('hex');

  // EIP-712 message uses raw 32-byte AccountHash (no "00" tag)
  const message = {
    from: agentAccountHashBytes32,
    to: payToBytes32,
    value: BigInt(reqs.amount),
    valid_after: BigInt(validAfter),
    valid_before: BigInt(validBefore),
    nonce: nonceHex,
  };

  // 4) hash the typed data → 32-byte keccak256 digest.
  //    We sign the EIP-712 digest directly (standard EIP-712 chain: keccak256
  //    → secp256k1). The Casper SDK's PrivateKey.sign() auto-pre-hashes with
  //    SHA-256, but we use noble/secp256k1 directly in signEip712Digest, so
  //    we have full control. Standard EIP-712 matches the CSPR.cloud x402
  //    facilitator's expected signing chain.
  const digest = hashTypedData(
    domain,
    TransferAuthorizationTypes,
    'TransferAuthorization',
    message
  );
  const signingInput = digest;

  // 5) sign with our private key — produce 65-byte sig (r||s||v) using Noble
  //    (Casper's PrivateKey.sign() returns only 64 raw bytes without recovery)
  const pem = readFileSync(pkPath, 'utf-8');
  let privateKey: PrivateKey;
  let algo: KeyAlgorithm;
  try {
    privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    algo = KeyAlgorithm.SECP256K1;
  } catch {
    privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    algo = KeyAlgorithm.ED25519;
  }
  if (algo !== KeyAlgorithm.SECP256K1) {
    throw new Error('x402 v2 on Casper currently requires a SECP256K1 key');
  }
  const privBytes = privateKey.toBytes(); // 32 raw bytes
  const sigBytes = signEip712Digest(signingInput, privBytes, agentPubKey.toHex());
  // x402 v2 expects a 130-char hex string (no "0x" prefix).
  const signature = Buffer.from(sigBytes).toString('hex');

  // 6) build the v2 payment payload
  const payload: PaymentPayloadV2 = {
    x402Version: 2,
    resource: { url: endpoint },
    accepted: reqs,
    payload: {
      signature,
      publicKey: agentPubKey.toHex(),
      authorization: {
        from: agentAccountHashV2,
        to: payToV2,
        value: reqs.amount,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce: nonceHex,
      },
    },
  };
  const paymentHeader = encodePaymentPayload(payload);

  // 7) retry with proof
  const final = await axios.request({
    method,
    url: endpoint,
    data: options.body,
    headers: { 'PAYMENT-SIGNATURE': paymentHeader },
    validateStatus: () => true,
    timeout: 15_000,
  });
  if (final.status >= 400) {
    throw new Error(
      `x402 paid request failed: ${final.status} ${JSON.stringify(final.data).slice(0, 200)}`
    );
  }

  // 8) extract settle deploy hash from response header (x402 v2: PAYMENT-RESPONSE)
  const responseB64 = (final.headers['payment-response'] as string | undefined) ?? '';
  let settleTxHash = '';
  if (responseB64) {
    try {
      const r = JSON.parse(Buffer.from(responseB64, 'base64').toString('utf-8'));
      settleTxHash = r.transaction ?? r.deployHash ?? r.txHash ?? '';
    } catch {}
  }

  const proof: X402Proof = {
    paymentHeader,
    settleTxHash,
    facilitator: cfg.X402_FACILITATOR_URL,
    amountMotes: reqs.amount,
    asset: 'hash-' + assetBytes32,
    signedAt: now,
  };

  return { data: final.data as T, proof, raw: final };
}

export const parsePaymentRequirements = parsePaymentRequiredHeader;
