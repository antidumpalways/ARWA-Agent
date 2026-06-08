/**
 * Direct CSPR.cloud x402 Facilitator client.
 *
 * Use this when you want to settle a payment without going through a paid
 * HTTP resource (e.g. when the AgentVault wants to verify a payment was
 * settled before logging the strategy).
 *
 * Docs: https://docs.cspr.cloud/x402-facilitator-api/
 */
import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config';

let client: AxiosInstance | null = null;
function getClient(): AxiosInstance {
  if (client) return client;
  const cfg = loadConfig();
  client = axios.create({
    baseURL: cfg.X402_FACILITATOR_URL,
    timeout: 30_000,
    headers: {
      Authorization: cfg.CSPR_CLOUD_API_KEY,
      'Content-Type': 'application/json',
    },
  });
  return client;
}

export interface VerifyRequest {
  paymentHeader: string;     // X-Payment value
  paymentRequirements: {
    address: string;
    amount: string;
    asset: string;
    nonce: string;
    validUntil: number;
    scheme: 'exact';
  };
}

export interface VerifyResponse {
  valid: boolean;
  payer?: string;
  reason?: string;
}

export interface SettleRequest extends VerifyRequest {}

export interface SettleResponse {
  settled: boolean;
  deployHash: string;
  payer?: string;
  reason?: string;
}

export async function verify(req: VerifyRequest): Promise<VerifyResponse> {
  const r = await getClient().post<VerifyResponse>('/verify', req);
  return r.data;
}

export async function settle(req: SettleRequest): Promise<SettleResponse> {
  const r = await getClient().post<SettleResponse>('/settle', req);
  return r.data;
}

/**
 * High-level helper: parse a `X-Payment` header returned by the server (it's
 * the same `network:payee:amount:sig:nonce:validUntil:payer` format the
 * `x402/client.ts` produces) and submit it to the CSPR.cloud facilitator.
 */
export async function verifyAndSettle(
  paymentHeader: string,
  paymentRequirements: VerifyRequest['paymentRequirements']
): Promise<SettleResponse> {
  // Try verify first (cheap, dry-run)
  const v = await verify({ paymentHeader, paymentRequirements });
  if (!v.valid) {
    return { settled: false, deployHash: '', reason: v.reason ?? 'verify failed' };
  }
  return settle({ paymentHeader, paymentRequirements });
}
