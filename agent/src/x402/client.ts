/**
 * x402 client for Casper.
 *
 * Flow (against CSPR.cloud x402 facilitator):
 *   1. GET <paid-endpoint>
 *   2. Server returns 402 + headers: X-Payment-Address, X-Payment-Amount,
 *      X-Payment-Network, X-Payment-Asset, X-Payment-Nonce, X-Payment-ValidUntil
 *   3. Build the Casper-native EIP-712 typed data (TransferAuthorization)
 *   4. Hash the typed data via @casper-ecosystem/casper-eip-712
 *   5. Sign the hash with the agent's PrivateKey (casper-js-sdk v5)
 *   6. Build the `X-Payment` header with the signature
 *   7. Replay the request with the header
 *   8. Server forwards to CSPR.cloud facilitator for settlement
 *
 * Facilitator docs: https://docs.cspr.cloud/x402-facilitator-api/
 * Signing spec:     https://github.com/casper-ecosystem/casper-eip-712
 */
import axios, { AxiosResponse } from 'axios';
import { readFileSync } from 'fs';
import {
  hashTypedData,
  TransferAuthorizationTypes,
  buildDomain,
  toHex,
  fromHex,
} from '@casper-ecosystem/casper-eip-712';
import { PrivateKey, KeyAlgorithm, PublicKey, AccountHash } from 'casper-js-sdk';
import { loadConfig } from '../config';
import { X402Proof } from '../types';
import { buildPaymentHeaderEnvelope } from './header';
export { buildPaymentHeaderEnvelope, parsePaymentHeader } from './header';

export interface PaymentRequirements {
  address: string;        // 0x... hex (account hash)
  amount: string;         // motes (or token units)
  network: string;        // e.g. "casper" or "casper-test"
  asset: string;          // CEP-18 contract package hash
  nonce: string;
  validUntil: number;     // unix seconds
  scheme: 'exact';
}

export interface X402Response<T = any> {
  data: T;
  proof: X402Proof;
  raw: AxiosResponse;
}

/**
 * Attempt to fetch a paid resource. Handles 402 detection, EIP-712 signing,
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

  // 2) parse 402 headers
  const reqs = parsePaymentRequirements(initial.headers);
  if (!reqs) {
    throw new Error('402 returned but no parseable PaymentRequirements headers');
  }
  if (options.paymentAmountOverride) reqs.amount = options.paymentAmountOverride;

  // 3) build domain + message. `TransferAuthorization` expects `from`/`to`/
  //    `nonce` as **bytes32** (32 raw bytes, no prefix), so we use the agent's
  //    AccountHash (32 bytes), not the PublicKey (33 bytes with algo tag).
  const agentAccountHash = cfg.AGENT_PUBLIC_KEY
    ? PublicKey.fromHex(cfg.AGENT_PUBLIC_KEY).accountHash().toHex().replace(/^account-hash-/, '')
    : '0'.repeat(64);
  // The `to` field is whatever the server told us (`address` may be prefixed).
  // Strip the prefix so we have raw 32 bytes.
  const toBare = (reqs.address ?? '').replace(/^account-hash-/, '').replace(/^hash-/, '');
  const assetBare = (reqs.asset ?? '').replace(/^account-hash-/, '').replace(/^hash-/, '');
  // Pad/truncate to exactly 32 bytes for `bytes32`.
  const toBytes32 = toBare.padEnd(64, '0').slice(-64);
  const assetBytes32 = assetBare.padEnd(64, '0').slice(-64);

  const domain = buildDomain(
    'Caspar x402',
    '1',
    cfg.CASPER_NETWORK === 'casper' ? 'casper' : 'casper-test',
    assetBytes32
  );
  const message = {
    from: agentAccountHash,
    to: toBytes32,
    value: BigInt(reqs.amount),
    valid_after: 0n,
    valid_before: BigInt(reqs.validUntil),
    nonce: reqs.nonce.padEnd(64, '0').slice(-64),
  };

  // 4) hash the typed data
  const digest = hashTypedData(
    domain,
    TransferAuthorizationTypes,
    'TransferAuthorization',
    message
  );

  // 5) sign with our private key
  const pem = readFileSync(pkPath, 'utf-8');
  let privateKey: PrivateKey;
  try {
    privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    privateKey = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const sigBytes = privateKey.sign(digest);
  const signature = toHex(sigBytes);

  // 6) build the X-Payment header. The Casper x402 facilitator expects a
  //    colon-delimited envelope — see https://github.com/make-software/casper-x402.
  const paymentHeader = buildPaymentHeaderEnvelope({
    network: cfg.CASPER_NETWORK,
    payee: reqs.address,
    amount: reqs.amount,
    signature,
    nonce: reqs.nonce,
    validUntil: reqs.validUntil,
    payer: cfg.AGENT_PUBLIC_KEY ?? '',
  });

  // 7) retry with proof
  const final = await axios.request({
    method,
    url: endpoint,
    data: options.body,
    headers: { 'X-Payment': paymentHeader },
    validateStatus: () => true,
    timeout: 15_000,
  });
  if (final.status >= 400) {
    throw new Error(
      `x402 paid request failed: ${final.status} ${JSON.stringify(final.data).slice(0, 200)}`
    );
  }

  // 8) extract settle deploy hash from response header
  const settleTxHash =
    (final.headers['x-payment-settle'] as string | undefined) ?? '';

  const proof: X402Proof = {
    paymentHeader,
    settleTxHash,
    facilitator: cfg.X402_FACILITATOR_URL,
    amountMotes: reqs.amount,
    asset: reqs.asset,
    signedAt: Math.floor(Date.now() / 1000),
  };

  return { data: final.data as T, proof, raw: final };
}

function parsePaymentRequirementsInternal(
  headers: Record<string, any>
): PaymentRequirements | null {
  const address = headers['x-payment-address'];
  const amount = headers['x-payment-amount'];
  const network = headers['x-payment-network'] ?? 'casper';
  const asset = headers['x-payment-asset'];
  const nonce = headers['x-payment-nonce'];
  const validUntil = headers['x-payment-valid-until'];
  if (!address || !amount || !asset || !nonce) return null;
  return {
    address: String(address),
    amount: String(amount),
    network: String(network),
    asset: String(asset),
    nonce: String(nonce),
    validUntil: Number(validUntil ?? Math.floor(Date.now() / 1000) + 600),
    scheme: 'exact',
  };
}

/** Exported for tests. Same logic as the internal call. */
export const parsePaymentRequirements = parsePaymentRequirementsInternal;

// Suppress unused import warning when `fromHex` is not directly referenced
void fromHex;
