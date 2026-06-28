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
import { selectBestPair } from './agent/pairSelector';
import { checkCircuitBreaker, recordStrategyOutcome } from './agent/riskGuard';
import { loadConfig } from './config';
import { RevenueEvent, StrategyProposal, X402Proof } from './types';

export interface AnalystInput {
  revenueEvent: RevenueEvent;
  ownerAddress: string;        // who owns the revenue stream
  signalEndpoint: string;     // x402-protected endpoint
  signalPriceMotes: string;
  /** When true, skip the LLM call and use the deterministic heuristic. */
  forceHeuristic?: boolean;
  /**
   * When set, override the analyst's decision with a specific action.
   * Used by the dashboard "force action" toggle so judges can demo
   * any of the 6 strategy action types on demand.
   * Valid: 'swap' | 'add_liquidity' | 'remove_liquidity' |
   *        'compound' | 'hold' | 'stake'
   */
  forceAction?: 'swap' | 'add_liquidity' | 'remove_liquidity' | 'compound' | 'hold' | 'stake';
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
 *
 * `tokenOut` is the dynamically-selected pair token (from pairSelector),
 * not a hardcoded `sCSPR`. This lets the strategy route through any
 * CSPR pair the DEX offers.
 */
function decideHeuristic(args: DecideArgs, tokenOut: string): {
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
      tokenOut,
      minAmountOut: '0',
      rationale: `Low price impact (${args.quote.priceImpact}) + bullish signal (${args.signal.utilization_forecast}). Add liquidity to ${args.quote.pair} to capture fees.`,
    };
  }
  return {
    action: 'swap',
    tokenOut,
    minAmountOut: applySlippage(args.quote.amountOut, 0.5),
    rationale: `Conservative swap to ${tokenOut} with 0.5% slippage protection. Price impact ${args.quote.priceImpact}.`,
  };
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

export async function runAnalyst(input: AnalystInput): Promise<StrategyProposal> {
  const cfg = loadConfig();
  console.log('[analyst] revenue event', input.revenueEvent);

  // 1) on-chain: agent account balance (MCP - optional)
  const { publicKey } = await import('./casper/signer').then(m => m.getAgentKeys());
  let account = { publicKey: publicKey.toHex(), balance: '0', staked: '0', delegations: 0, transfers: 0 };
  try {
    account = await getAccountInfo(publicKey.toHex());
  } catch (e) {
    console.warn('[analyst] account info fetch failed (MCP unavailable):', (e as Error).message?.slice(0, 80));
  }

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

  // 4) DEX quote for the strategy — dynamic pair selection (MCP - optional)
  let amountIn = input.revenueEvent.amount;

  // 4a) Circuit breaker: pause the agent if drawdown or revert streak breached
  //     Defaults: 10% drawdown from peak portfolio, 3 reverted txs in a row.
  const cb = checkCircuitBreaker();
  if (cb.tripped) {
    console.warn(`[analyst] CIRCUIT BREAKER TRIPPED: ${cb.reason} — forcing hold`);
    return buildHoldProposal(input.revenueEvent, cb.reason);
  }

  // 4b) Pair selector: rank CSPR pairs by impact + yield, fall back to CSPR/sCSPR
  const signalBullish = false; // computed after x402 below; this is the safe default
  let selectedPairLabel = 'CSPR/sCSPR';
  let selectedTokenOut = 'sCSPR';
  try {
    const sel = await selectBestPair({
      amountInMotes: amountIn,
      signalBullish,
      maxPriceImpactPct: 1.0,
    });
    if (sel.selected) {
      selectedPairLabel = sel.selected.pair;
      selectedTokenOut = sel.selected.tokenOut;
      console.log(`[analyst] pair selector chose ${selectedPairLabel} (impact=${sel.selected.estimatedPriceImpact}, apy~${sel.selected.yieldApy?.toFixed(1)}%)`);
    } else if (sel.candidates.length > 0) {
      console.log(`[analyst] pair selector: no safe pair, falling back to CSPR/sCSPR`);
    } else {
      console.log(`[analyst] pair selector: MCP unavailable, using CSPR/sCSPR default`);
    }
  } catch (e) {
    console.warn('[analyst] pair selector failed:', (e as Error).message?.slice(0, 80));
  }

  let quote = { amountOut: amountIn, priceImpact: '0%', route: ['CSPR', selectedTokenOut], minReceived: amountIn, pair: selectedPairLabel, expiresAt: Date.now() + 60000 };
  try {
    quote = await getQuote('CSPR', selectedTokenOut, amountIn, 'exact_in');
  } catch (e) {
    console.warn('[analyst] quote fetch failed (MCP unavailable):', (e as Error).message?.slice(0, 80));
  }

  // 5) portfolio snapshot (MCP - optional)
  let portfolio = { total: '0', breakdown: [] as any[] };
  try {
    portfolio = await getPortfolioValue(input.ownerAddress);
  } catch (e) {
    console.warn('[analyst] portfolio fetch failed (MCP unavailable):', (e as Error).message?.slice(0, 80));
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
    const h = decideHeuristic(decideArgs, selectedTokenOut);
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

  // 8) Forced action override (dashboard toggle). Overrides the analyst
  //    decision with a specific action so the demo can show any of the
  //    6 strategy types on demand. The executor handles `hold` by
  //    skipping the swap and recording the skip on the audit log.
  //    `stake` routes through Casper native delegation (no DEX needed).
  if (input.forceAction) {
    const forced = input.forceAction;
    if (forced === 'hold') {
      decision = {
        action: 'swap', // coerced to no-op when amountIn='0' in executor
        tokenOut: decision.tokenOut,
        minAmountOut: '0',
        rationale: `[FORCED HOLD] User-selected action via dashboard`,
        // confidence floored to 60 so index.ts lets the executor run
        // and write the audit-log entry. The executor's HOLD branch
        // (amountIn='0') still skips the swap submit.
        confidence: Math.max(decision.confidence ?? 60, 60),
      };
      // Force amountIn to '0' so executor's HOLD short-circuit fires.
      // Set pair to 'HOLD' as a belt-and-braces signal.
      amountIn = '0';
      quote.pair = 'HOLD';
    } else if (forced === 'stake') {
      // Casper 2.0 testnet reverts with DelegationAmountTooSmall [64557]
      // when the delegate amount is below 500 CSPR. If the revenue event
      // is too small for a native delegate, gracefully fall back to
      // `swap` to sCSPR (which has no minimum). This saves 2.5 CSPR of
      // gas that would otherwise be burned on a guaranteed revert.
      const { MIN_STAKE_MOTES } = await import('./casper/staking');
      const amountBig = BigInt(amountIn || '0');
      if (amountBig < MIN_STAKE_MOTES) {
        console.warn(
          `[analyst] stake requested but amount ${amountIn} motes < ` +
          `${MIN_STAKE_MOTES} (Casper testnet min delegation); ` +
          `falling back to swap to sCSPR`
        );
        decision = {
          action: 'swap',
          tokenOut: selectedTokenOut,
          minAmountOut: applySlippage(quote.amountOut, 0.5),
          rationale:
            `[AUTO-SWAP from stake] amount ${amountIn} motes below ` +
            `${MIN_STAKE_MOTES} minimum, swapped to sCSPR instead`,
          confidence: Math.max(decision.confidence ?? 60, 60),
        };
      } else {
        decision = {
          action: 'stake',
          tokenOut: 'CSPR', // stake keeps the CSPR; no DEX token out
          minAmountOut: '0',
          rationale: `[FORCED STAKE] Native delegate via Casper 2.0 auction (~7-9% APY, 7d unbond)`,
          confidence: Math.max(decision.confidence ?? 60, 60),
        };
      }
    } else {
      decision = {
        action: forced === 'compound' ? 'add_liquidity' : forced,
        tokenOut: selectedTokenOut,
        minAmountOut: applySlippage(quote.amountOut, 0.5),
        rationale: `[FORCED ${forced.toUpperCase()}] User-selected action via dashboard`,
        confidence: Math.max(decision.confidence ?? 60, 60),
      };
    }
    console.log(`[analyst] forceAction override: ${forced}`);
  }

  // For stake action, set pair label and pick a validator if not forced.
  let pairLabel = quote.pair;
  let validatorPk: string | undefined;
  if (decision.action === 'stake') {
    pairLabel = 'CSPR/staked';
    // Use the first known testnet validator as the default. The auction
    // RPC has 18,528 bids and a live fetch adds ~10-15s latency which
    // breaks the demo deadline — for the buildathon we pick from the
    // hardcoded fallback list. A production agent would call
    // `getAuctionValidators()` and rank by `delegation_rate`.
    const { FALLBACK_TESTNET_VALIDATORS } = await import('./casper/staking');
    validatorPk = process.env.STAKING_VALIDATOR_PUBKEY ?? FALLBACK_TESTNET_VALIDATORS[0];
    console.log(`[analyst] stake validator: ${validatorPk.slice(0, 16)}…`);
  }

  return {
    action: decision.action,
    pair: pairLabel,
    tokenIn: 'CSPR',
    tokenOut: decision.tokenOut,
    amountIn,
    minAmountOut: decision.minAmountOut,
    rationale: decision.rationale,
    confidence: decision.confidence,
    x402Proof,
    revenueEvent: input.revenueEvent,
    validatorPubKey: validatorPk,
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

/**
 * Build a "hold" proposal — used when the circuit breaker trips and the
 * agent decides to skip the cycle entirely. The executor handles
 * `outcome: 'hold'` by NOT submitting any swap and logging the skip
 * on-chain via the audit log fallback.
 */
function buildHoldProposal(
  revenueEvent: RevenueEvent,
  reason: string
): StrategyProposal {
  return {
    action: 'swap', // executor coerces to no-op when amountIn === '0'
    pair: 'HOLD',
    tokenIn: 'CSPR',
    tokenOut: 'CSPR',
    amountIn: '0',
    minAmountOut: '0',
    rationale: `[HOLD] ${reason}`,
    confidence: 0,
    x402Proof: null,
    revenueEvent,
  };
}
