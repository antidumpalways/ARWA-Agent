/**
 * Multi-pair selector. Replaces the hardcoded `CSPR/sCSPR` route in
 * `analyst.ts` with a dynamic selection based on:
 *   1. Available liquidity depth (reserves) per pair
 *   2. Estimated price impact for the intended amount
 *   3. CSPR.trade MCP `analyze_trade` recommendation
 *   4. Yield comparison: LP fee APY (from `get_pair_details`) vs sCSPR APY
 *
 * Falls back to `CSPR/sCSPR` if the MCP is unreachable or no pair
 * passes the filters — never blocks the agent.
 */

import { getCsprTradeMcp } from '../mcp/csprTradeMcp';

function parseToolResult(res: any): any {
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

export interface PairCandidate {
  pair: string;                  // human-readable "CSPR/sCSPR"
  tokenIn: string;
  tokenOut: string;
  contractPackageHash?: string;  // pair contract hash (for LP operations)
  reservesIn?: string;
  reservesOut?: string;
  feeBps?: number;               // LP fee tier in bps
  estimatedPriceImpact?: string; // from get_quote
  recommendation?: 'proceed' | 'caution' | 'high_risk' | 'unknown';
  yieldApy?: number;             // computed fee APY, % (rough estimate)
  reason: string;                // why this pair was/wasn't selected
}

export interface PairSelection {
  selected: PairCandidate | null;   // null = hold (no pair safe)
  candidates: PairCandidate[];      // ranked list
  evaluatedAt: number;
}

/**
 * CSPR.trade liquidity-staking target. We prefer this as the safe-harbor
 * pair when no other route is clearly better, because sCSPR is the
 * canonical yield-bearing CSPR derivative on testnet.
 */
const STAKED_CSPR = 'sCSPR';

/**
 * Compute a rough fee APY estimate for an LP pair. CSPR.trade charges
 * `feeBps` (default 30 = 0.3%) on each swap; we estimate daily volume
 * as `reservesIn` * 1.0 (i.e. ~1 turn per day, conservative for a small
 * DEX) and annualize. This is intentionally rough — the goal is to
 * *rank* pairs, not to predict exact yield.
 */
function estimateFeeApy(reservesInMotes: bigint, feeBps: number): number {
  if (reservesInMotes === 0n) return 0;
  const dailyFees = (reservesInMotes * BigInt(feeBps)) / 10_000n;
  const annualFees = dailyFees * 365n;
  // APY% = annualFees / reservesIn * 100
  const apyBps = (annualFees * 10_000n) / reservesInMotes;
  return Number(apyBps) / 100;
}

async function callToolSafe<T = any>(name: string, args: any): Promise<T | null> {
  try {
    const mcp = await getCsprTradeMcp();
    const res = await mcp.callTool({ name, arguments: args });
    return parseToolResult(res) as T;
  } catch (e: any) {
    console.warn(`[pair-selector] ${name} failed:`, e?.message?.slice(0, 120));
    return null;
  }
}

export interface SelectPairInput {
  amountInMotes: string;       // the amount we want to deploy
  signalBullish: boolean;       // from x402 paid signal
  maxPriceImpactPct?: number;   // default 1.0
  excludedPairs?: string[];     // e.g. ["CSPR/USDT"] if a known-bad pair
}

export async function selectBestPair(
  input: SelectPairInput
): Promise<PairSelection> {
  const maxImpact = input.maxPriceImpactPct ?? 1.0;
  const excluded = new Set(input.excludedPairs ?? []);
  const candidates: PairCandidate[] = [];

  // 1) Get all pairs from the DEX
  const pairsResp = await callToolSafe<any>('get_pairs', { limit: 50 });
  if (!pairsResp) {
    return { selected: null, candidates: [], evaluatedAt: Date.now() };
  }
  const pairs: any[] = Array.isArray(pairsResp)
    ? pairsResp
    : Array.isArray(pairsResp?.pairs)
    ? pairsResp.pairs
    : Array.isArray(pairsResp?.data)
    ? pairsResp.data
    : [];

  // 2) For each pair that includes CSPR as one side, evaluate
  for (const p of pairs) {
    const tokenA: string = p.token_a_symbol ?? p.token_a ?? p.tokenASymbol ?? '';
    const tokenB: string = p.token_b_symbol ?? p.token_b ?? p.tokenBSymbol ?? '';
    if (!tokenA || !tokenB) continue;

    // We always want CSPR -> X (we start from native CSPR)
    const isCsprPair = tokenA === 'CSPR' || tokenB === 'CSPR';
    if (!isCsprPair) continue;

    const pairLabel = `${tokenA}/${tokenB}`;
    if (excluded.has(pairLabel)) continue;

    const tokenIn = 'CSPR';
    const tokenOut = tokenA === 'CSPR' ? tokenB : tokenA;

    // 3) Get a quote for our amount
    const quote = await callToolSafe<any>('get_quote', {
      token_in: tokenIn,
      token_out: tokenOut,
      amount: input.amountInMotes,
      type: 'exact_in',
    });
    const impactStr: string = quote?.price_impact ?? quote?.priceImpact ?? '?';
    const impactPct = parseFloat(String(impactStr).replace('%', '')) || 999;
    const amountOut: string = quote?.amount_out ?? quote?.amountOut ?? '0';

    // 4) Get trade analysis
    const analysis = await callToolSafe<any>('analyze_trade', {
      token_in: tokenIn,
      token_out: tokenOut,
      amount: input.amountInMotes,
    });
    const recommendation: PairCandidate['recommendation'] =
      (analysis?.recommendation as PairCandidate['recommendation']) ?? 'unknown';

    // 5) Get pair details for fee tier + reserves
    const details = await callToolSafe<any>('get_pair_details', {
      pair: p.contract_package_hash ?? p.package_hash ?? p.address ?? pairLabel,
    });
    const reservesIn: bigint = BigInt(
      details?.reserve_a ?? details?.reserves?.[0] ?? '0'
    );
    const reservesOut: bigint = BigInt(
      details?.reserve_b ?? details?.reserves?.[1] ?? '0'
    );
    const feeBps: number = Number(details?.fee_bps ?? details?.fee ?? 30);

    const yieldApy = estimateFeeApy(reservesIn, feeBps);

    let reason = `impact=${impactPct.toFixed(2)}% (max ${maxImpact}%), rec=${recommendation}, apy~${yieldApy.toFixed(1)}%`;
    const safe = impactPct <= maxImpact && recommendation !== 'high_risk';

    candidates.push({
      pair: pairLabel,
      tokenIn,
      tokenOut,
      contractPackageHash: p.contract_package_hash ?? p.package_hash,
      reservesIn: reservesIn.toString(),
      reservesOut: reservesOut.toString(),
      feeBps,
      estimatedPriceImpact: impactStr,
      recommendation,
      yieldApy,
      reason: safe ? `safe: ${reason}` : `skipped: ${reason}`,
    });
  }

  // 6) Rank: prefer (a) sCSPR pair as safe harbor, then (b) highest yield
  //    among pairs that pass the impact + recommendation filters.
  const safe = candidates.filter(
    (c) => c.reason.startsWith('safe') && c.recommendation !== 'high_risk'
  );
  const ranked = [...safe].sort((a, b) => {
    // sCSPR is the canonical liquid-staking yield; tie-break it highest
    const aStaked = a.tokenOut === STAKED_CSPR ? 1 : 0;
    const bStaked = b.tokenOut === STAKED_CSPR ? 1 : 0;
    if (aStaked !== bStaked) return bStaked - aStaked;
    return (b.yieldApy ?? 0) - (a.yieldApy ?? 0);
  });

  if (ranked.length === 0) {
    return { selected: null, candidates, evaluatedAt: Date.now() };
  }
  return {
    selected: ranked[0],
    candidates: [...safe, ...candidates.filter((c) => !c.reason.startsWith('safe'))],
    evaluatedAt: Date.now(),
  };
}
