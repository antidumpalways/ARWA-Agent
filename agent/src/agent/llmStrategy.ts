// LLM-based strategy reasoning. Drop-in replacement for the deterministic
// `decideStrategy` heuristic in `analyst.ts`.
//
// The function is a thin wrapper around an LLM API (Claude or OpenAI-compatible)
// that takes the same context (account balance, quote, signal, portfolio,
// revenue event) and returns a structured StrategyProposal.
//
// The wrapper:
//   * Builds a small JSON prompt
//   * Sends it to the LLM (Anthropic Messages API or OpenAI Chat Completions)
//   * Parses the JSON reply into a StrategyProposal
//   * Falls back to a deterministic heuristic if the LLM call fails or
//     returns malformed JSON
//
// Configuration via env:
//   LLM_PROVIDER=anthropic  (default) or "openai"
//   LLM_API_KEY=sk-...        (required when LLM_PROVIDER=anthropic/openai)
//   LLM_MODEL=claude-haiku-4-5   (anthropic) or gpt-4o-mini (openai)

import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config';
import { StrategyProposal, Quote, RevenueEvent } from '../types';

export interface LLMContext {
  account: { balance: string };
  quote: Pick<Quote, 'amountOut' | 'priceImpact' | 'pair' | 'expiresAt'>;
  signal: { utilization_forecast: string; confidence: number };
  portfolio: { total: string };
  revenueEvent: RevenueEvent;
}

interface LLMStrategyOutput {
  action: 'swap' | 'add_liquidity' | 'remove_liquidity' | 'compound' | 'hold';
  pair: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  rationale: string;
  confidence: number;
}

const SYSTEM_PROMPT = `You are an autonomous DeFi strategist for the ARWA
Agent on Casper. Given a revenue event, an x402-paid utilization signal, an
on-chain DEX quote, and the current portfolio, output a single JSON
strategy decision. Output ONLY valid JSON matching the schema below. No
prose. Prefer add_liquidity when the signal is bullish AND price impact is
under 1%. Prefer swap with 0.5% slippage otherwise. Use "hold" only if you
lack confidence (< 50).

Schema:
{
  "action": "swap" | "add_liquidity" | "remove_liquidity" | "compound" | "hold",
  "pair": "CSPR/sCSPR",
  "token_in": "CSPR",
  "token_out": "sCSPR",
  "amount_in": "<decimal motes>",
  "min_amount_out": "<decimal motes>",
  "rationale": "<= 280 chars",
  "confidence": <0-100>
}`;

/**
 * Build the request to the configured LLM provider.
 */
async function callLLM(
  http: AxiosInstance,
  ctx: LLMContext
): Promise<LLMStrategyOutput | null> {
  const cfg = loadConfig();
  const provider = (process.env.LLM_PROVIDER ?? 'anthropic').toLowerCase();
  const apiKey = process.env.LLM_API_KEY ?? '';

  const userPrompt = JSON.stringify({
    account_balance_motes: ctx.account.balance,
    dex_quote: ctx.quote,
    utilization_signal: ctx.signal,
    portfolio_total: ctx.portfolio.total,
    revenue_event: ctx.revenueEvent,
  });

  if (provider === 'openai') {
    if (!apiKey) return null;
    const res = await http.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      },
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15_000 }
    );
    const text = res.data?.choices?.[0]?.message?.content;
    if (!text) return null;
    return JSON.parse(text) as LLMStrategyOutput;
  }

  // Anthropic Messages API
  if (!apiKey) return null;
  const res = await http.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: process.env.LLM_MODEL ?? 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      timeout: 15_000,
    }
  );
  // Anthropic returns content blocks; extract the first text block.
  const text = (res.data?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
  if (!text) return null;
  // Anthropic may wrap JSON in ```json fences — strip them.
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned) as LLMStrategyOutput;
}

/**
 * Deterministic fallback used when the LLM is unavailable, the API key is
 * missing, or the response fails to parse. Matches the original heuristic
 * in `analyst.ts#decideStrategy` so the agent never blocks on a missing LLM.
 */
function heuristicDecision(
  ctx: LLMContext,
  revenueAmountMotes: string
): LLMStrategyOutput {
  const piPct = parseFloat(ctx.quote.priceImpact.replace('%', '')) || 0;
  const signalBullish = /higher|up|\+\d+%/i.test(ctx.signal.utilization_forecast);
  if (piPct < 1 && signalBullish) {
    return {
      action: 'add_liquidity',
      pair: ctx.quote.pair,
      token_in: 'CSPR',
      token_out: 'sCSPR',
      amount_in: revenueAmountMotes,
      min_amount_out: '0',
      rationale: `Low price impact (${ctx.quote.priceImpact}) + bullish signal (${ctx.signal.utilization_forecast}). Add liquidity to capture fees.`,
      confidence: Math.max(60, ctx.signal.confidence ?? 70),
    };
  }
  const bps = 50n; // 0.5%
  const amountOut = BigInt(ctx.quote.amountOut || '0');
  const minOut = ((amountOut * (10_000n - bps)) / 10_000n).toString();
  return {
    action: 'swap',
    pair: ctx.quote.pair,
    token_in: 'CSPR',
    token_out: 'sCSPR',
    amount_in: revenueAmountMotes,
    min_amount_out: minOut,
    rationale: `Conservative swap to sCSPR with 0.5% slippage protection. Price impact ${ctx.quote.priceImpact}.`,
    confidence: Math.max(50, (ctx.signal.confidence ?? 60) - 10),
  };
}

/**
 * Decide a strategy. Tries the LLM first; falls back to the deterministic
 * heuristic. Returns a `StrategyProposal`-shaped object (minus the
 * `x402Proof` and `revenueEvent` fields, which the caller fills in).
 */
export async function decideStrategyWithLLM(
  ctx: LLMContext,
  revenueAmountMotes: string
): Promise<Omit<StrategyProposal, 'x402Proof' | 'revenueEvent'>> {
  const http = axios.create({ timeout: 15_000 });
  let out: LLMStrategyOutput | null = null;
  try {
    out = await callLLM(http, ctx);
  } catch (e) {
    // fall through to heuristic
  }
  if (!out) {
    out = heuristicDecision(ctx, revenueAmountMotes);
  }
  return {
    action: out.action === 'hold' ? 'swap' : (out.action as StrategyProposal['action']),
    pair: out.pair,
    tokenIn: out.token_in,
    tokenOut: out.token_out,
    amountIn: out.amount_in,
    minAmountOut: out.min_amount_out,
    rationale: out.rationale,
    confidence: out.confidence,
  };
}
