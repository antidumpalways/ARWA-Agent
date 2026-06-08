// Slippage math extracted from `analyst.ts#applySlippage` so it can be tested
// without booting the full agent.

/**
 * Subtract `pct` percent from `amount` (given as decimal string of motes).
 *
 * Uses BigInt internally to avoid precision loss on large amounts.
 * Example: applySlippage("1000000", 0.5) -> "995000" (0.5% off 1M).
 */
export function applySlippage(amount: string, pct: number): string {
  const v = BigInt(amount);
  const bps = BigInt(Math.floor(pct * 100));
  return ((v * (10_000n - bps)) / 10_000n).toString();
}
