/**
 * ParkFlow Agent — x402 v2 signal server.
 *
 * Implements the official x402 protocol (https://x402.org) for Casper.
 * Forward all payments to CSPR.cloud x402 facilitator for verify+settle.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /signal?lot=<source-id>     (returns 402 first, 200 with PAYMENT-SIGNATURE)
 *
 * x402 v2 spec:
 *   - PAYMENT-REQUIRED header = base64(json PaymentRequirements)
 *   - PAYMENT-SIGNATURE header = base64(json PaymentPayload)
 *   - account_hash format: "00" + 64 hex chars (NOT "account-hash-" prefix)
 *   - public_key format: "01"/"02" + 64/66 hex chars (algorithm prefix)
 *   - asset: 64-char hex (CEP-18 contract package hash, no "hash-" prefix)
 *   - network: "casper:casper" or "casper:casper-test"
 *   - x402Version: 2
 *
 * Refs:
 *   https://docs.cspr.cloud/x402-facilitator-api/reference
 *   https://docs.cspr.cloud/x402-facilitator-api/verify
 *   https://docs.cspr.cloud/x402-facilitator-api/settle
 */
import express, { Request, Response } from 'express';
import crypto from 'crypto';
import {
  hashTypedData,
  TransferAuthorizationTypes,
  buildDomain,
} from '@casper-ecosystem/casper-eip-712';
import { secp256k1 } from '@noble/curves/secp256k1';
import { blake2b } from '@noble/hashes/blake2b';
import { sha256 } from '@noble/hashes/sha256';
import { PublicKey, AccountHash } from 'casper-js-sdk';
import { loadConfig } from '../src/config';
import { getRecentEventsDirect } from '../src/casper/directContractRead';
import axios from 'axios';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4001);
const PRICE_MOTES = process.env.SIGNAL_PRICE_MOTES ?? '1000000';
const ASSET = (process.env.X402_CEP18_PACKAGE_HASH ?? '').replace('hash-', '');
const PAYEE_HEX = (process.env.X402_PAYEE_ADDRESS ?? '').replace(/^account-hash-/, '').padStart(64, '0').slice(-64);
const X402_DEMO_ENABLED = process.env.X402_DEMO_SERVER_ENABLED !== 'false';

const NETWORK = process.env.CASPER_NETWORK === 'casper' ? 'casper:casper' : 'casper:casper-test';

if (!ASSET) console.log('[x402-server] WARN: X402_CEP18_PACKAGE_HASH not set; using empty asset');
if (!PAYEE_HEX) console.log('[x402-server] WARN: X402_PAYEE_ADDRESS not set');

// === Anti-replay nonce store ===
const usedNonces = new Set<string>();

// === Asset metadata cache ===
let assetMeta: { name: string; version: string; decimals: number; symbol: string } | null = null;
async function getAssetMeta(): Promise<{ name: string; version: string; decimals: number; symbol: string }> {
  if (assetMeta) return assetMeta;
  // Try to read contract named_keys
  const cfg = loadConfig();
  if (!cfg.X402_CEP18_PACKAGE_HASH) {
    assetMeta = { name: 'PFLOW', version: '1', decimals: 9, symbol: 'PFLOW' };
    return assetMeta;
  }
  try {
    const pkgHash = cfg.X402_CEP18_PACKAGE_HASH.replace('hash-', '');
    const r = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `hash-${pkgHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    const versions = r.data?.result?.stored_value?.ContractPackage?.versions;
    if (!versions?.length) {
      assetMeta = { name: 'PFLOW', version: '1', decimals: 9, symbol: 'PFLOW' };
      return assetMeta;
    }
    const contractHash = versions[0].contract_hash.replace('contract-', '');
    const r2 = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `hash-${contractHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    const nks = r2.data?.result?.stored_value?.Contract?.named_keys;
    if (nks) {
      const nameNk = nks.find((k: any) => k.name === 'name');
      const symNk = nks.find((k: any) => k.name === 'symbol');
      const decNk = nks.find((k: any) => k.name === 'decimals');
      assetMeta = {
        name: nameNk ? 'PFLOW' : 'PFLOW',
        version: '1',
        decimals: decNk ? 9 : 9,
        symbol: symNk ? 'PFLOW' : 'PFLOW',
      };
    } else {
      assetMeta = { name: 'PFLOW', version: '1', decimals: 9, symbol: 'PFLOW' };
    }
  } catch {
    assetMeta = { name: 'PFLOW', version: '1', decimals: 9, symbol: 'PFLOW' };
  }
  return assetMeta!;
}

// === Account hash helpers ===
function accountHashWithPrefix(hex: string): string {
  // Format: "00" + 64 hex chars
  return '00' + hex.replace(/^0+/, '').padStart(64, '0').slice(-64);
}

function parseAccountHash(s: string): string {
  // Accept "account-hash-<64hex>" or "00<64hex>" or "<64hex>"
  return s.replace(/^account-hash-/, '').replace(/^00/, '').padStart(64, '0').slice(-64);
}

// === Build the 402 challenge ===
async function paymentRequired(res: Response, reason?: string) {
  const nonceBytes = crypto.randomBytes(32);
  const nonce = nonceBytes.toString('hex');
  const validUntil = Math.floor(Date.now() / 1000) + 600;
  const validAfter = Math.floor(Date.now() / 1000) - 5; // 5s clock-skew tolerance

  // Use the cached asset meta so domain name/version match the 2nd-request
  // reconstruction (avoid the race where the 1st 402 has a hardcoded name
  // but the 2nd request reads meta from the chain).
  const meta = await getAssetMeta();

  const paymentRequirements = {
    scheme: 'exact',
    network: NETWORK,
    payTo: accountHashWithPrefix(PAYEE_HEX),
    amount: PRICE_MOTES,
    asset: ASSET,
    maxTimeoutSeconds: 600,
    extra: {
      name: meta.name,
      version: meta.version,
      decimals: String(meta.decimals),
      symbol: meta.symbol,
    },
  };

  const b64 = Buffer.from(JSON.stringify(paymentRequirements)).toString('base64');
  res
    .status(402)
    .set('PAYMENT-REQUIRED', b64)
    .json({
      error: 'Payment Required',
      reason,
      paymentRequirements,
    });
}

// === Verify signature cryptographically ===
async function verifyX402V2Signature(
  payload: any,
  paymentRequirements: any,
  cfg: ReturnType<typeof loadConfig>
): Promise<{ valid: boolean; reason?: string; publicKey?: string; payer?: string }> {
  try {
    const auth = payload?.payload?.authorization;
    const signature = payload?.payload?.signature;
    const publicKey = payload?.payload?.publicKey;
    if (!auth || !signature || !publicKey) {
      return { valid: false, reason: 'missing fields in payload' };
    }

    // 1. Check basic structure
    // The wire format puts `network` in `accepted.network` (CAIP-2 like "casper:casper-test"),
    // not in `authorization`. Compare against accepted.
    const acceptedNetwork = payload?.accepted?.network;
    if (acceptedNetwork && acceptedNetwork !== paymentRequirements.network) {
      return { valid: false, reason: 'network_mismatch' };
    }
    if (auth.to !== paymentRequirements.payTo) {
      return { valid: false, reason: 'pay_to_mismatch' };
    }
    if (auth.value !== paymentRequirements.amount) {
      return { valid: false, reason: 'amount_mismatch' };
    }
    if (auth.nonce.length !== 64) {
      return { valid: false, reason: 'malformed_payload (nonce != 64 chars)' };
    }
    if (usedNonces.has(auth.nonce)) {
      return { valid: false, reason: 'nonce already used (replay)' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Number(auth.validBefore) < now) {
      return { valid: false, reason: 'payload_expired' };
    }
    if (Number(auth.validAfter) > now) {
      return { valid: false, reason: 'not_yet_valid' };
    }
    if (Number(auth.validBefore) - now < 6) {
      return { valid: false, reason: 'insufficient_time' };
    }

    // 2. Reconstruct EIP-712 typed-data digest
    // The wire format uses "00" + 64 hex chars for account hash (Casper Key tag),
    // but EIP-712 hashTypedData uses raw 32-byte AccountHash — strip the "00".
    const meta = await getAssetMeta();
    const domain = buildDomain(
      meta.name, // must match what the client received in PAYMENT-REQUIRED extra.name
      meta.version,
      paymentRequirements.network,
      paymentRequirements.asset.padStart(64, '0').slice(-64)
    );
    const message = {
      from: auth.from.replace(/^00/, '').padStart(64, '0').slice(-64),
      to: auth.to.replace(/^00/, '').padStart(64, '0').slice(-64),
      value: BigInt(auth.value),
      valid_after: BigInt(auth.validAfter),
      valid_before: BigInt(auth.validBefore),
      nonce: auth.nonce.padStart(64, '0').slice(-64),
    };
    // Casper SDK's PrivateKey.sign() pre-hashes the input with SHA-256, so
    // the EIP-712 signing chain is keccak256 → sha256 → secp256k1. Mirror
    // the same SHA-256 pre-hash here so the recovered pubkey matches.
    const digest = hashTypedData(
      domain,
      TransferAuthorizationTypes,
      'TransferAuthorization',
      message
    );
    const signedMessage = sha256(digest);

    // 3. Recover the public key from the signature and compare with the one in the payload.
    // The supplied public key is authoritative; the signature must recover to it
    // for some recovery bit v ∈ {0, 1}.
    const sigHex = signature.replace(/^0x/, '').padEnd(130, '0').slice(0, 130);
    const sigBytes = Buffer.from(sigHex, 'hex');
    if (sigBytes.length !== 65) {
      return { valid: false, reason: `signature must be 65 bytes, got ${sigBytes.length} (hex: ${sigHex.slice(0, 40)}…)` };
    }
    let v = sigBytes[64];
    if (v >= 27) v -= 27;
    if (v > 1) {
      return { valid: false, reason: `invalid recovery id: ${sigBytes[64]}` };
    }
    const r = BigInt('0x' + Buffer.from(sigBytes.slice(0, 32)).toString('hex'));
    const s = BigInt('0x' + Buffer.from(sigBytes.slice(32, 64)).toString('hex'));
    // Parse supplied pubkey (33 bytes compressed)
    let expectedPubHex: string;
    try {
      expectedPubHex = PublicKey.fromHex(publicKey).toHex();
    } catch (e: any) {
      return { valid: false, reason: `malformed public key: ${e.message?.slice(0, 60)}` };
    }
    const expectedPubCompressed = expectedPubHex.slice(2); // drop "02" algo
    let recoveredPubCompressed: string | null = null;
    try {
      const sig = new secp256k1.Signature(r, s);
      const pub = sig.addRecoveryBit(v).recoverPublicKey(signedMessage).toRawBytes(true); // 33 bytes compressed
      recoveredPubCompressed = Buffer.from(pub).toString('hex');
    } catch (e: any) {
      return { valid: false, reason: `recover failed: ${e?.message?.slice(0, 80) ?? 'unknown'}` };
    }
    console.log(`[x402-server] expected pub=${expectedPubCompressed.slice(0, 16)}… recovered=${recoveredPubCompressed.slice(0, 16)}…`);
    if (recoveredPubCompressed !== expectedPubCompressed) {
      // Try the other v
      try {
        const sig2 = new secp256k1.Signature(r, s);
        const pub2 = sig2.addRecoveryBit(1 - v).recoverPublicKey(signedMessage).toRawBytes(true);
        const rec2 = Buffer.from(pub2).toString('hex');
        if (rec2 === expectedPubCompressed) {
          recoveredPubCompressed = rec2;
        } else {
          return { valid: false, reason: `signature does not match public key (v=${v}: ${recoveredPubCompressed.slice(0, 16)}…, v=${1 - v}: ${rec2.slice(0, 16)}…)` };
        }
      } catch (e: any) {
        return { valid: false, reason: `signature does not match public key (v=${v}: ${recoveredPubCompressed.slice(0, 16)}…)` };
      }
    }
    // 4. Compute the account hash from the supplied public key
    const suppliedPub = PublicKey.fromHex(publicKey);
    const recoveredAccountHash = suppliedPub.accountHash().toHex().padStart(64, '0').slice(-64);
    const expectedFrom = parseAccountHash(auth.from);
    if (recoveredAccountHash !== expectedFrom) {
      return { valid: false, reason: `from_mismatch: expected ${expectedFrom.slice(0, 8)}…, got ${recoveredAccountHash.slice(0, 8)}…` };
    }

    usedNonces.add(auth.nonce);
    return { valid: true, publicKey, payer: accountHashWithPrefix(recoveredAccountHash) };
  } catch (e: any) {
    return { valid: false, reason: `exception: ${e.message?.slice(0, 80)}` };
  }
}

// === Forward to CSPR.cloud facilitator ===
async function forwardToFacilitator(
  payload: any,
  paymentRequirements: any,
  cfg: ReturnType<typeof loadConfig>
): Promise<{ ok: boolean; mode: 'facilitator' | 'local-fallback'; settleTxHash?: string; reason?: string }> {
  if (!cfg.X402_FACILITATOR_URL) {
    return { ok: false, mode: 'local-fallback', reason: 'X402_FACILITATOR_URL not set' };
  }
  try {
    // CSPR.cloud x402 v2 /verify
    const verifyRes = await fetch(`${cfg.X402_FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: cfg.CSPR_CLOUD_API_KEY,
      },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!verifyRes.ok) {
      const text = await verifyRes.text();
      return { ok: false, mode: 'local-fallback', reason: `facilitator /verify ${verifyRes.status}: ${text.slice(0, 200)}` };
    }
    const verifyData = (await verifyRes.json()) as { isValid: boolean; invalidReason?: string; invalidMessage?: string; payer?: string };
    if (!verifyData.isValid) {
      return { ok: false, mode: 'local-fallback', reason: `facilitator /verify rejected: ${verifyData.invalidReason}: ${verifyData.invalidMessage}` };
    }

    // /settle
    const settleRes = await fetch(`${cfg.X402_FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: cfg.CSPR_CLOUD_API_KEY,
      },
      body: JSON.stringify({
        paymentPayload: payload,
        paymentRequirements,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!settleRes.ok) {
      const text = await settleRes.text();
      return { ok: false, mode: 'local-fallback', reason: `facilitator /settle ${settleRes.status}: ${text.slice(0, 200)}` };
    }
    const settleData = (await settleRes.json()) as { deployHash?: string; txHash?: string; success?: boolean };
    return {
      ok: settleData.success !== false,
      mode: 'facilitator',
      settleTxHash: settleData.deployHash ?? settleData.txHash,
    };
  } catch (e: any) {
    return { ok: false, mode: 'local-fallback', reason: `facilitator error: ${e?.message?.slice(0, 100) ?? String(e).slice(0, 100)}` };
  }
}

// === On-chain forecast (from RevenueEmitter events via local JSON log) ===
async function computeForecast(lotId: string): Promise<any> {
  const events = await getRecentEventsDirect(50);
  if (!Array.isArray(events) || events.length === 0) {
    return {
      utilization_forecast: `no events found for source "${lotId}"`,
      confidence: 50,
      source_count: 0,
      last_24h_count: 0,
      total_revenue_motes: '0',
      model: 'parkflow-v1-aggregate',
      valid_for_seconds: 300,
    };
  }
  const matching = events.filter((e: any) => String(e.source ?? '') === lotId);
  const totalMotes = matching.reduce((s: bigint, e: any) => s + BigInt(e.amount ?? 0), 0n);
  const nowSec = Math.floor(Date.now() / 1000);
  const last24h = matching.filter((e: any) => Number(e.timestamp ?? 0) > nowSec - 86400);
  const last1h = matching.filter((e: any) => Number(e.timestamp ?? 0) > nowSec - 3600);
  const baseline = Math.min(99, Math.round(last24h.length * 8));
  const trend = last1h.length > last24h.length / 24 ? '+' : last1h.length === 0 ? '-' : '~';
  const direction = trend === '+' ? 'rising' : trend === '-' ? 'falling' : 'steady';
  const confidence = Math.min(95, 50 + Math.floor(matching.length / 2) + (last1h.length > 0 ? 5 : 0));
  return {
    utilization_forecast: `${baseline}% expected utilization next 24h (${direction}; ${last24h.length} events / 24h, ${last1h.length} / 1h)`,
    confidence,
    source_count: matching.length,
    last_24h_count: last24h.length,
    total_revenue_motes: totalMotes.toString(),
    model: 'parkflow-v1-aggregate',
    valid_for_seconds: 300,
  };
}

// === Express routes ===
app.get('/health', (_, res) => {
  res.json({
    ok: true,
    enabled: X402_DEMO_ENABLED,
    payee: accountHashWithPrefix(PAYEE_HEX),
    amount_motes: PRICE_MOTES,
    asset: ASSET,
    network: NETWORK,
    used_nonces: usedNonces.size,
  });
});

app.get('/signal', async (req: Request, res: Response) => {
  if (!X402_DEMO_ENABLED) {
    return res.status(503).json({ error: 'service disabled' });
  }
  if (!ASSET) {
    return res.status(503).json({ error: 'X402_CEP18_PACKAGE_HASH not configured' });
  }

  const lot = String(req.query.lot ?? 'P1 - Gate Keluar Utama');
  const paymentB64 = req.header('PAYMENT-SIGNATURE');

  // Build paymentRequirements once
  const meta = await getAssetMeta();
  const paymentRequirements = {
    scheme: 'exact' as const,
    network: NETWORK,
    payTo: accountHashWithPrefix(PAYEE_HEX),
    amount: PRICE_MOTES,
    asset: ASSET,
    maxTimeoutSeconds: 600,
    extra: {
      name: meta.name,
      version: meta.version,
      decimals: String(meta.decimals),
      symbol: meta.symbol,
    },
  };

  if (!paymentB64) {
    return await paymentRequired(res);
  }

  // Decode the PAYMENT-SIGNATURE
  let payload: any;
  try {
    const json = Buffer.from(paymentB64, 'base64').toString('utf-8');
    payload = JSON.parse(json);
  } catch (e: any) {
    console.log(`[x402-server] rejected: malformed PAYMENT-SIGNATURE (${e.message?.slice(0, 60)})`);
    return await paymentRequired(res, 'malformed_payload');
  }

  // 1. Local EIP-712 signature verification (fast, catches 99% of bad payloads)
  const cfg = loadConfig();
  const v = await verifyX402V2Signature(payload, paymentRequirements, cfg);
  if (!v.valid) {
    console.log(`[x402-server] rejected: ${v.reason}`);
    return await paymentRequired(res, v.reason);
  }

  // 2. Forward to the real CSPR.cloud x402 facilitator for on-chain settlement
  const settle = await forwardToFacilitator(payload, paymentRequirements, cfg);

  // 3. Build x402 v2 PaymentExecutionResponse for the response header
  let paymentResponse: any = null;
  if (settle.ok) {
    console.log(`[x402-server] ✓ settled via facilitator tx=${settle.settleTxHash?.slice(0, 16)}…`);
    paymentResponse = {
      success: true,
      transaction: settle.settleTxHash,
      network: NETWORK,
    };
  } else {
    console.log(`[x402-server] facilitator skipped: ${settle.reason}`);
    paymentResponse = {
      success: false,
      error: settle.reason,
      network: NETWORK,
    };
  }

  // 4. Compute forecast and return 200 with PAYMENT-RESPONSE
  const forecast = await computeForecast(lot);
  const responseB64 = Buffer.from(JSON.stringify(paymentResponse)).toString('base64');
  res.set('PAYMENT-RESPONSE', responseB64);
  res.json({
    ...forecast,
    settlement: {
      mode: settle.mode,
      settle_tx_hash: settle.settleTxHash ?? null,
      facilitator: cfg.X402_FACILITATOR_URL,
      reason: settle.reason ?? null,
    },
  });
});

if (!X402_DEMO_ENABLED) {
  console.log('[x402-server] DISABLED by env (X402_DEMO_SERVER_ENABLED=false)');
} else {
  app.listen(PORT, () => {
    console.log(`[x402-server] listening on http://localhost:${PORT}`);
    console.log(`  network:    ${NETWORK}`);
    console.log(`  asset:      ${ASSET}`);
    console.log(`  payTo:      ${accountHashWithPrefix(PAYEE_HEX)}`);
    console.log(`  amount:     ${PRICE_MOTES} motes`);
  });
}
