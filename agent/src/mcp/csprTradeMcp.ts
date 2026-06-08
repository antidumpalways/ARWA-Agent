/**
 * Real MCP client for CSPR.trade DEX.
 *
 * Connects to https://mcp.cspr.trade/mcp and exposes high-level helpers for
 * quoting, building swaps, providing liquidity, etc.
 *
 * Docs: https://mcp.cspr.trade
 * SDK option: npm i @make-software/cspr-trade-mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../config';
import { Quote } from '../types';

let cached: Client | null = null;
let initPromise: Promise<Client> | null = null;

export async function getCsprTradeMcp(): Promise<Client> {
  if (cached) return cached;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = loadConfig();
    const transport = new StreamableHTTPClientTransport(new URL(cfg.CSPR_TRADE_MCP_URL));
    const client = new Client(
      { name: 'parkflow-executor', version: '0.2.0' },
      { capabilities: {} }
    );
    await client.connect(transport);
    cached = client;
    return client;
  })();
  return initPromise;
}

export async function getQuote(
  tokenIn: string,
  tokenOut: string,
  amount: string,
  type: 'exact_in' | 'exact_out' = 'exact_in'
): Promise<Quote> {
  const client = await getCsprTradeMcp();
  const res = await client.callTool({
    name: 'get_quote',
    arguments: { token_in: tokenIn, token_out: tokenOut, amount, type },
  });
  const parsed = parseResult(res);
  return {
    amountIn: parsed.amount_in ?? amount,
    amountOut: parsed.amount_out ?? '0',
    priceImpact: parsed.price_impact ?? '0%',
    route: parsed.route ? String(parsed.route).split('→').map(s => s.trim()) : [tokenIn, tokenOut],
    minReceived: parsed.min_received ?? parsed.amount_out ?? '0',
    pair: `${tokenIn}/${tokenOut}`,
    expiresAt: Date.now() + 60_000,
  };
}

export async function getPortfolioValue(address: string): Promise<{
  total: string;
  breakdown: Array<{ asset: string; amount: string; valueUsd: string }>;
}> {
  const client = await getCsprTradeMcp();
  const res = await client.callTool({
    name: 'get_portfolio_value',
    arguments: { address },
  });
  return parseResult(res);
}

/**
 * Build an unsigned Casper deploy for a swap or LP action. The deploy is
 * returned as a JSON object; the caller (executor) must sign and submit it.
 */
export async function buildUnsignedDeploy(params: {
  action: 'swap' | 'add_liquidity' | 'remove_liquidity';
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  payerAddress: string;
}): Promise<Record<string, unknown>> {
  const client = await getCsprTradeMcp();
  const res = await client.callTool({
    name: 'build_' + params.action,
    arguments: {
      token_in: params.tokenIn,
      token_out: params.tokenOut,
      amount_in: params.amountIn,
      min_amount_out: params.minAmountOut,
      payer: params.payerAddress,
      slippage_tolerance_bps: 50,
    },
  });
  return parseResult(res);
}

function parseResult(res: any): any {
  if (res?.structuredContent) return res.structuredContent;
  if (Array.isArray(res?.content)) {
    for (const c of res.content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        try { return JSON.parse(c.text); } catch { return c.text; }
      }
    }
  }
  return res;
}
