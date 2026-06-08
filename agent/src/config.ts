import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  // Network
  CASPER_NETWORK: z.enum(['casper-test', 'casper']).default('casper-test'),
  CASPER_RPC_URL: z.string().url().default('https://node.testnet.cspr.cloud/rpc'),
  CASPER_CHAIN_NAME: z.string().default('casper-test'),
  // Optional direct Casper node SSE (raw, not CSPR.cloud streaming API)
  CASPER_NODE_SSE_URL: z.string().url().optional(),

  // Keys (paths; never commit keys themselves)
  AGENT_SECRET_KEY_PATH: z.string().default('./keys/agent.pem'),
  AGENT_PUBLIC_KEY: z.string().optional(), // filled after first read of PEM

  // Deployed contracts (filled by deploy script)
  AGENT_VAULT_CONTRACT_HASH: z.string().optional(),
  REVENUE_EMITTER_CONTRACT_HASH: z.string().optional(),

  // CSPR.cloud
  CSPR_CLOUD_API_KEY: z.string().min(1),
  CSPR_CLOUD_MCP_URL: z.string().url().default('https://mcp.testnet.cspr.cloud/mcp'),

  // CSPR.trade MCP
  CSPR_TRADE_MCP_URL: z.string().url().default('https://mcp.cspr.trade/mcp'),

  // x402
  X402_FACILITATOR_URL: z.string().url().default('https://x402-facilitator.cspr.cloud'),
  X402_SIGNAL_ENDPOINT: z.string().url().default('https://signals.parkflow.example.com/utilization'),
  X402_CEP18_PACKAGE_HASH: z.string().optional(),
  X402_CEP18_ASSET_NAME: z.string().default('USDC').optional(),

  // Server
  PORT: z.coerce.number().int().positive().default(4000),
});

export type Config = z.infer<typeof EnvSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('[config] Invalid environment:', parsed.error.format());
    throw new Error('Invalid environment configuration');
  }
  cached = parsed.data;
  return cached;
}
