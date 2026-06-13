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
  CASPER_DOMAIN_TYPES,
  toHex,
} from '@casper-ecosystem/casper-eip-712';
import { PrivateKey, KeyAlgorithm, PublicKey } from 'casper-js-sdk';
import { secp256k1 } from '@noble/curves/secp256k1';
import { loadConfig } from '../config';
import { X402Proof } from '../types';
import { getAgentKeys } from '../casper/signer';
import { signEip712Digest } from './signEip712';
import type { TypeDefinitions } from '@casper-ecosystem/casper-eip-712';

/**
 * Build the 33-byte Casper EIP-712 address from a PublicKey.
 * For SECP256K1: `0x02` + 32-byte x-coord of the pubkey (decompressed).
 * For ED25519:   `0x01` + 32-byte pubkey.
 * Matches the Go `eip712.NewAddressFromHex` Address type (33 bytes).
 */
function buildCasperAddressFromPublicKey(pub: PublicKey, priv: PrivateKey): string {
  const algo = pub.cryptoAlg; // KeyAlgorithm.ED25519=1, SECP256K1=2
  if (algo === KeyAlgorithm.ED25519) {
    // 0x01 + 32-byte ED25519 pubkey
    const pubBytes = Buffer.from(pub.bytes());
    return '01' + pubBytes.toString('hex');
  }
  // SECP256K1: decompress and take the x-coord (32 bytes)
  const privBytes = priv.toBytes();
  const uncompressed = secp256k1.getPublicKey(privBytes, false); // 65 bytes: 04 || x || y
  const xCoord = Buffer.from(uncompressed).slice(1, 33);
  return '02' + xCoord.toString('hex');
}

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
  const { publicKey: agentPubKey, privateKey: agentPrivKey } = getAgentKeys();
  // The Go reference client (make-software/casper-x402) uses a 33-byte address:
  //   1-byte algo tag + 32-byte key.
  // For SECP256K1: algo=0x02 + 32-byte x-coord of the pubkey (NOT the 33-byte
  // compressed form with parity byte). For ED25519: algo=0x01 + 32-byte pubkey.
  // The wire format (PAYMENT-REQUIRED.authorization.from) uses the AccountHash
  // with "00" prefix (33 bytes), but the EIP-712 message uses the pubkey-form
  // address (33 bytes with algo tag).
  const agentAccountHashBytes32 = agentPubKey.accountHash().toHex().padStart(64, '0').slice(-64);
  const agentAccountHashV2 = '00' + agentAccountHashBytes32; // for wire format
  // Build the 33-byte pubkey address for the EIP-712 message:
  const agentPub33 = buildCasperAddressFromPublicKey(agentPubKey, agentPrivKey);

  // Strip any prefix from server-supplied payTo and asset
  const payToBytes32 = (reqs.payTo ?? '').replace(/^account-hash-/, '').replace(/^00/, '').padStart(64, '0').slice(-64);
  const payToV2 = '00' + payToBytes32; // for wire format
  const assetBare = (reqs.asset ?? '').replace(/^hash-/, '');
  const assetBytes32 = assetBare.padStart(64, '0').slice(-64);

  // Use the server's `extra` (name, version) to build the EIP-712 domain
  // Network format: Go client uses "casper-test" (no "casper:" CAIP-2 prefix)
  // in the EIP-712 domain. The wire format uses "casper:casper-test".
  const networkForDomain = reqs.network.replace(/^casper:/, '');

  // Provide EIP-712 domain according to CSPR.cloud / casper-x402 spec:
  // name: from extra.name or "Casper x402"
  // version: from extra.version or "1"
  // salt: keccak256(networkForDomain + contractPackageHash)
  const domainName = reqs.extra?.name ?? 'Casper x402';
  const domainVersion = reqs.extra?.version ?? '1';
  const domain = buildDomain(
    domainName,
    domainVersion,
    networkForDomain,
    assetBytes32
  );
  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 5; // 5s clock-skew tolerance
  const validBefore = now + (reqs.maxTimeoutSeconds ?? 600);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const nonceHex = Buffer.from(nonce).toString('hex');

  // EIP-712 message (per make-software/casper-x402 spec):
  //   - `from` and `to` are the 33-byte public keys (with algo prefix) — `address` type
  //   - `validAfter`/`validBefore` are uint256 (not uint64)
  //   - `nonce` is bytes32
  //   - `value` is uint256
  // Field names use camelCase (not snake_case). Integer values must be `bigint`
  // for the TS lib to encode them as uint256 correctly.
  const message = {
    // The Go client/facilitator use the PUBKEY-FORM address for the EIP-712
    // message's `from` field (algo + 32-byte x-coord for SECP256K1, or
    // algo + 32-byte pubkey for ED25519). The wire format
    // `authorization.from` uses the account-hash form (`00` + 32-byte hash).
    // Both are 33 bytes but differ in the first byte.
    from: agentPub33,              // 33-byte pubkey-form address (1 algo + 32 key)
    to: payToV2,                  // 33-byte "00" + 32-byte account hash (payee)
    value: BigInt(reqs.amount),   // bigint
    validAfter: BigInt(validAfter),
    validBefore: BigInt(validBefore),
    nonce: nonceHex,              // bytes32 = 64 hex chars
  };
  console.log(`[x402-client] domain:`, JSON.stringify({
    name: domain.name, version: domain.version, chain_name: domain.chain_name,
    contract_package_hash: domain.contract_package_hash,
  }));
  console.log(`[x402-client] EIP-712 message:`, JSON.stringify({
    from: message.from, to: message.to, value: message.value.toString(),
    validAfter: message.validAfter.toString(), validBefore: message.validBefore.toString(),
    nonce: message.nonce,
  }));

  // 4) hash the typed data → 32-byte keccak256 digest.
  //    The official make-software/casper-x402 facilitator (Go) uses a CUSTOM
  //    type definition with these fields:
  //      TransferWithAuthorization { from, to, value, validAfter, validBefore, nonce }
  //    Field types differ from the casper-eip-712 TS lib's TransferAuthorization:
  //      - `from`/`to` are `address` (33 bytes with algo tag, not 32-byte bytes32)
  //      - `validAfter`/`validBefore` are `uint256` (not `uint64`)
  //      - field names are camelCase (not snake_case)
  //      - primary type is `"TransferWithAuthorization"` (capital W)
  //    See: https://github.com/make-software/casper-x402/blob/master/x402/mechanisms/casper/exact/client/scheme.go
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
  const digest = hashTypedData(
    domain,
    transferWithAuthorizationTypes,
    'TransferWithAuthorization',
    message,
    { domainTypes: CASPER_DOMAIN_TYPES }
  );
  console.log(`[x402-client] digest: ${Buffer.from(digest).toString('hex')}`);
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
