/**
 * MCP client for CSPR.trade DEX (mainnet only).
 *
 * CSPR.trade MCP standalone endpoint: https://mcp.cspr.trade/mcp
 * This endpoint provides build_swap, get_quote, and other trading tools.
 *
 * Note: CSPR.cloud MCP (testnet & mainnet) only has read-only DEX tools
 * (get_swaps, get_dexes, get_ft_dex_rates) but NOT build_swap.
 * For real on-chain swaps, use mainnet with CSPR.trade MCP.
 *
 * Docs: https://mcp.cspr.trade
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
    // CSPR.trade MCP standalone (mainnet only, no auth required)
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
  const toolName = params.action === 'swap' ? 'build_swap' : `build_${params.action}`;
  const res = await client.callTool({
    name: toolName,
    arguments: {
      token_in: params.tokenIn,
      token_out: params.tokenOut,
      amount: params.amountIn,
      type: 'exact_in',
      min_amount_out: params.minAmountOut,
      sender_public_key: params.payerAddress,
      slippage_tolerance_bps: 50,
    },
  });
  const parsed = parseResult(res);
  // Check if MCP returned an error
  if (typeof parsed === 'string') {
    throw new Error(`CSPR.trade MCP error: ${parsed}`);
  }
  if (parsed?.error) {
    throw new Error(`CSPR.trade MCP error: ${parsed.error}`);
  }
  return parsed;
}

/**
 * Submit a signed transaction via MCP submit_transaction tool.
 */
export async function submitViaMcp(signedTxJson: Record<string, any>): Promise<{ deployHash: string; result: any }> {
  const client = await getCsprTradeMcp();
  
  // Send as JSON string (MCP expects string, not object)
  const res = await client.callTool({
    name: 'submit_transaction',
    arguments: {
      signed_deploy_json: JSON.stringify(signedTxJson),
    },
  });
  
  const parsed = parseResult(res);
  
  if (parsed?.error) {
    throw new Error(`MCP submit error: ${parsed.error}`);
  }
  
  // Extract deploy hash from result
  const deployHash = parsed?.deploy_hash || parsed?.transaction_hash || parsed?.hash || '';
  
  return {
    deployHash,
    result: parsed,
  };
}

function parseResult(res: any): any {
  if (res?.structuredContent) return res.structuredContent;
  if (Array.isArray(res?.content)) {
    for (const c of res.content) {
      if (c.type === 'text' && typeof c.text === 'string') {
        // Try to parse as JSON first
        try { return JSON.parse(c.text); } catch {}
        
        // If not JSON, check if it contains an error
        if (c.text.includes('Validation error') || c.text.includes('error:')) {
          return { error: c.text };
        }
        
        // Extract JSON from text (e.g., "Swap transaction JSON:\n{...}")
        const jsonMatch = c.text.match(/\{[\s\S]*"hash"[\s\S]*"payload"[\s\S]*\}/);
        if (jsonMatch) {
          try { return JSON.parse(jsonMatch[0]); } catch {}
        }
        
        // Return raw text if nothing else works
        return c.text;
      }
    }
  }
  return res;
}
