/**
 * Analyst Agent
 *
 * Gathers on-chain + off-chain data, pays for a premium signal via x402,
 * reasons about the best strategy (LLM-first with heuristic fallback),
 * and produces a StrategyProposal.
 */
import { getAccountInfo, getRecentRevenueEvents } from './mcp/casperMcp';
import { getQuote, getPortfolioValue } from './mcp/csprTradeMcp';
import { payAndFetchViaX402 } from './x402/client';
import { decideStrategyWithLLM, LLMContext } from './agent/llmStrategy';
import { applySlippage } from './agent/slippage';
import { getVaultOverview } from './casper/vaultClient';
import { loadConfig } from './config';
import { RevenueEvent, StrategyProposal, X402Proof } from './types';

export interface AnalystInput {
  revenueEvent: RevenueEvent;
  ownerAddress: string;        // who owns the revenue stream
  signalEndpoint: string;     // x402-protected endpoint
  signalPriceMotes: string;
  /** When true, skip the LLM call and use the deterministic heuristic. */
  forceHeuristic?: boolean;
}

interface DecideArgs {
  quote: { amountOut: string; priceImpact: string; pair: string };
  account: { balance: string };
  portfolio: { total: string };
  signal: { utilization_forecast: string; confidence: number };
  revenueEvent: RevenueEvent;
  vaultOverview: { totalAssets: string; globalReputation: number; totalStrategies: number };
}

/**
 * Deterministic fallback strategy (matches the LLM fallback in
 * `agent/llmStrategy.ts#heuristicDecision`). Used when no LLM is configured
 * or `forceHeuristic` is true.
 */
function decideHeuristic(args: DecideArgs): {
  action: StrategyProposal['action'];
  tokenOut: string;
  minAmountOut: string;
  rationale: string;
} {
  const piPct = parseFloat(args.quote.priceImpact.replace('%', '')) || 0;
  const signalBullish = /higher|up|\+\d+%/i.test(args.signal.utilization_forecast);
  if (piPct < 1 && signalBullish) {
    return {
      action: 'add_liquidity',
      tokenOut: 'sCSPR',
      minAmountOut: '0',
      rationale: `Low price impact (${args.quote.priceImpact}) + bullish signal (${args.signal.utilization_forecast}). Add liquidity to capture fees.`,
    };
  }
  return {
    action: 'swap',
    tokenOut: 'sCSPR',
    minAmountOut: applySlippage(args.quote.amountOut, 0.5),
    rationale: `Conservative swap to sCSPR with 0.5% slippage protection. Price impact ${args.quote.priceImpact}.`,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export async function runAnalyst(input: AnalystInput): Promise<StrategyProposal> {
  const cfg = loadConfig();
  console.log('[analyst] revenue event', input.revenueEvent);

  // 1) on-chain: agent account balance
  const { publicKey } = await import('./casper/signer').then(m => m.getAgentKeys());
  const account = await getAccountInfo(publicKey.toHex());

  // 2) on-chain: live AgentVault state (read via CSPR.cloud REST, no local node needed)
  let vaultOverview = { totalAssets: '0', globalReputation: 0, totalStrategies: 0 };
  if (cfg.AGENT_VAULT_CONTRACT_HASH) {
    try {
      vaultOverview = await getVaultOverview();
    } catch (e) {
      console.warn('[analyst] vault overview fetch failed', e);
    }
  } else {
    console.log('[analyst] AGENT_VAULT_CONTRACT_HASH not set — vault state will be zero');
  }

  // 3) recent revenue history (helps decide urgency)
  let recent: unknown[] = [];
  if (cfg.REVENUE_EMITTER_CONTRACT_HASH) {
    try {
      recent = await getRecentRevenueEvents(cfg.REVENUE_EMITTER_CONTRACT_HASH, 20);
    } catch (e) {
      console.warn('[analyst] recent events fetch failed', e);
    }
  }
  if (recent.length > 0) {
    console.log(`[analyst] fetched ${recent.length} recent revenue events`);
  }

  // 4) DEX quote for the strategy
  const amountIn = input.revenueEvent.amount;
  const quote = await getQuote('CSPR', 'sCSPR', amountIn, 'exact_in');

  // 5) portfolio snapshot
  let portfolio = { total: '0', breakdown: [] as any[] };
  try {
    portfolio = await getPortfolioValue(input.ownerAddress);
  } catch (e) {
    console.warn('[analyst] portfolio fetch failed', e);
  }

  // 6) pay for premium signal via x402
  const paid = await payAndFetchViaX402<{ utilization_forecast: string; confidence: number }>(
    input.signalEndpoint,
    { paymentAmountOverride: input.signalPriceMotes }
  );
  const x402Proof: X402Proof = paid.proof;
  console.log(
    `[analyst] x402 signal: ${paid.data.utilization_forecast} (${paid.data.confidence ?? '?'}%)`
  );

  // 7) reason about the strategy
  const decideArgs: DecideArgs = {
    quote,
    account,
    portfolio,
    signal: paid.data,
    revenueEvent: input.revenueEvent,
    vaultOverview,
  };

  let decision: {
    action: StrategyProposal['action'];
    tokenOut: string;
    minAmountOut: string;
    rationale: string;
    confidence: number;
  };

  if (input.forceHeuristic || !process.env.LLM_API_KEY) {
    const h = decideHeuristic(decideArgs);
    decision = {
      ...h,
      confidence: clamp(paid.data.confidence ?? 0, 0, 100),
    };
  } else {
    // LLM-first path. Falls back to deterministic heuristic if the LLM
    // call fails or returns malformed JSON.
    const llmCtx: LLMContext = {
      account,
      quote: {
        amountOut: quote.amountOut,
        priceImpact: quote.priceImpact,
        pair: quote.pair,
        expiresAt: quote.expiresAt,
      },
      signal: paid.data,
      portfolio,
      revenueEvent: input.revenueEvent,
    };
    const llmResult = await decideStrategyWithLLM(llmCtx, amountIn);
    decision = {
      action: llmResult.action,
      tokenOut: llmResult.tokenOut,
      minAmountOut: llmResult.minAmountOut,
      rationale: `[LLM] ${llmResult.rationale}`,
      confidence: llmResult.confidence,
    };
  }

  return {
    action: decision.action,
    pair: quote.pair,
    tokenIn: 'CSPR',
    tokenOut: decision.tokenOut,
    amountIn,
    minAmountOut: decision.minAmountOut,
    rationale: decision.rationale,
    confidence: decision.confidence,
    x402Proof,
    revenueEvent: input.revenueEvent,
  };
}

// CLI entry
if (require.main === module) {
  const cfg = loadConfig();
  runAnalyst({
    revenueEvent: {
      timestamp: Math.floor(Date.now() / 1000),
      amount: process.env.REVENUE_AMOUNT_MOTES ?? '1000000000000', // 1000 CSPR
      asset: '0'.repeat(64),
      source: process.env.REVENUE_SOURCE ?? 'parking-lot-demo',
      emitter: process.env.REVENUE_EMITTER ?? '0'.repeat(66),
      reference: process.env.REVENUE_REFERENCE ?? 'demo-ref-001',
    },
    ownerAddress: cfg.AGENT_PUBLIC_KEY ?? '',
    signalEndpoint: cfg.X402_SIGNAL_ENDPOINT,
    signalPriceMotes: '1000000', // 0.001 CSPR
  })
    .then(p => { console.log('[analyst] proposal', JSON.stringify(p, null, 2)); })
    .catch(e => { console.error('[analyst] failed', e); process.exit(1); });
}
