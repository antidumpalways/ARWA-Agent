/**
 * Risk guard — circuit breaker for the ARWA agent.
 *
 * Two trip conditions, both configurable via env:
 *
 *  1. **Drawdown**: portfolio value drops > `MAX_DRAWDOWN_PCT` (default 10%)
 *     from the rolling peak. Snapshot is updated after every successful
 *     cycle.
 *  2. **Revert streak**: `MAX_REVERT_STREAK` (default 3) consecutive
 *     strategies reverted on-chain. Resets on first success.
 *
 * State is persisted to `agent/.arwa-risk.json` so the guard survives
 * process restarts. The file is gitignored.
 *
 * When tripped, `checkCircuitBreaker()` returns a `CircuitBreakerState`
 * with `tripped: true` and a human-readable `reason`. The analyst then
 * short-circuits to a "hold" proposal — no swap, no LP, just an audit
 * log entry on-chain.
 *
 * Usage:
 *   - Call `checkCircuitBreaker()` at the top of `runAnalyst()`.
 *   - Call `recordStrategyOutcome({ outcome: 'success' | 'reverted' })`
 *     after every executor run.
 *   - Call `updatePortfolioSnapshot(valueMotes)` after every successful
 *     swap (for drawdown tracking).
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

export interface CircuitBreakerState {
  tripped: boolean;
  reason: string;
  drawdownPct: number;
  revertStreak: number;
  peakMotes: string;
  lastValueMotes: string;
}

interface RiskState {
  peakMotes: string;            // rolling peak portfolio value
  lastValueMotes: string;       // last observed portfolio value
  revertStreak: number;         // current consecutive-revert count
  trippedUntil: number;         // unix ms until which the breaker is held open
  totalStrategies: number;      // lifetime counter
  totalSuccesses: number;       // lifetime counter
  totalReverts: number;         // lifetime counter
}

const DEFAULT_STATE: RiskState = {
  peakMotes: '0',
  lastValueMotes: '0',
  revertStreak: 0,
  trippedUntil: 0,
  totalStrategies: 0,
  totalSuccesses: 0,
  totalReverts: 0,
};

// State file lives next to the agent package regardless of CWD.
// Walk up from this file's location until we find a sibling `package.json`,
// or fall back to `<cwd>/.arwa-risk.json` (covers the common case where the
// process was launched from inside the agent directory).
const STATE_PATH = (() => {
  try {
    // node_modules layout puts riskGuard.ts at:
    //   <root>/agent/src/agent/riskGuard.ts (dev)
    //   <root>/agent/dist/agent/riskGuard.js (prod)
    // Resolve from this file's directory upward.
    const thisDir = __dirname;
    for (const candidate of [
      join(thisDir, '..', '..', '..', '.arwa-risk.json'),  // src/ -> agent/
      join(thisDir, '..', '..', '.arwa-risk.json'),         // dist/ -> agent/
      join(process.cwd(), '.arwa-risk.json'),
    ]) {
      const parent = resolve(candidate);
      if (existsSync(resolve(parent, '..', 'package.json'))) {
        return parent;
      }
    }
  } catch {}
  return join(process.cwd(), '.arwa-risk.json');
})();

/**
 * Trip-cooldown: once the breaker trips, hold it open for this long
 * even if conditions normalize. Prevents flapping.
 */
const TRIP_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

function loadState(): RiskState {
  if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function saveState(s: RiskState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn('[risk] failed to persist state:', e?.message?.slice(0, 100));
  }
}

function getMaxDrawdownPct(): number {
  const v = parseFloat(process.env.ARWA_MAX_DRAWDOWN_PCT ?? '10');
  return Number.isFinite(v) && v > 0 ? v : 10;
}

function getMaxRevertStreak(): number {
  const v = parseInt(process.env.ARWA_MAX_REVERT_STREAK ?? '3', 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}

/**
 * Inspect the current circuit-breaker state. Pure read — does not
 * modify the persisted state. Safe to call from anywhere.
 */
export function checkCircuitBreaker(): CircuitBreakerState {
  const s = loadState();
  const now = Date.now();

  // Cooldown overrides: if we're inside a manual trip window, hold
  if (s.trippedUntil > now) {
    const remainMin = Math.ceil((s.trippedUntil - now) / 60_000);
    return {
      tripped: true,
      reason: `cooldown active (${remainMin}m remaining)`,
      drawdownPct: computeDrawdownPct(s),
      revertStreak: s.revertStreak,
      peakMotes: s.peakMotes,
      lastValueMotes: s.lastValueMotes,
    };
  }

  const drawdownPct = computeDrawdownPct(s);
  const maxDd = getMaxDrawdownPct();
  const maxStreak = getMaxRevertStreak();

  if (drawdownPct > maxDd) {
    return {
      tripped: true,
      reason: `drawdown ${drawdownPct.toFixed(2)}% > ${maxDd}% from peak ${s.peakMotes} motes`,
      drawdownPct,
      revertStreak: s.revertStreak,
      peakMotes: s.peakMotes,
      lastValueMotes: s.lastValueMotes,
    };
  }

  if (s.revertStreak >= maxStreak) {
    return {
      tripped: true,
      reason: `revert streak ${s.revertStreak} >= ${maxStreak} consecutive failures`,
      drawdownPct,
      revertStreak: s.revertStreak,
      peakMotes: s.peakMotes,
      lastValueMotes: s.lastValueMotes,
    };
  }

  return {
    tripped: false,
    reason: 'ok',
    drawdownPct,
    revertStreak: s.revertStreak,
    peakMotes: s.peakMotes,
    lastValueMotes: s.lastValueMotes,
  };
}

function computeDrawdownPct(s: RiskState): number {
  const peak = BigInt(s.peakMotes || '0');
  const last = BigInt(s.lastValueMotes || '0');
  if (peak === 0n) return 0;
  if (last >= peak) return 0;
  // drawdown% = (peak - last) / peak * 100
  return Number(((peak - last) * 10_000n) / peak) / 100;
}

/**
 * Record the outcome of a strategy execution. Updates the revert
 * streak (resets on success) and lifetime counters.
 */
export function recordStrategyOutcome(outcome: {
  outcome: 'success' | 'reverted' | 'failed';
}): void {
  const s = loadState();
  s.totalStrategies += 1;
  if (outcome.outcome === 'success') {
    s.totalSuccesses += 1;
    s.revertStreak = 0;
  } else {
    s.totalReverts += 1;
    s.revertStreak += 1;
    // Auto-trip: if we just hit the streak, open the breaker for cooldown
    const maxStreak = getMaxRevertStreak();
    if (s.revertStreak >= maxStreak) {
      s.trippedUntil = Date.now() + TRIP_COOLDOWN_MS;
      console.warn(
        `[risk] auto-tripping breaker: revert streak ${s.revertStreak}, cooldown ${TRIP_COOLDOWN_MS / 60_000}m`
      );
    }
  }
  saveState(s);
}

/**
 * Record a portfolio value snapshot. Updates the rolling peak if this
 * is a new high. Used to compute drawdown on subsequent reads.
 */
export function updatePortfolioSnapshot(valueMotes: string): void {
  const s = loadState();
  const v = BigInt(valueMotes || '0');
  const peak = BigInt(s.peakMotes || '0');
  s.lastValueMotes = v.toString();
  if (v > peak) s.peakMotes = v.toString();
  saveState(s);
}

/**
 * Manually reset the breaker (e.g. operator override after a fix).
 * Use sparingly — the cooldown exists for a reason.
 */
export function resetCircuitBreaker(): void {
  const s = loadState();
  s.trippedUntil = 0;
  s.revertStreak = 0;
  saveState(s);
}
