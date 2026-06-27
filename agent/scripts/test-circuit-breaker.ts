/**
 * Smoke test for riskGuard circuit breaker behavior.
 * Verifies: state persistence, drawdown detection, revert-streak detection,
 * cooldown. Run from the agent/ dir:
 *   npx tsx scripts/test-circuit-breaker.ts
 */
import {
  checkCircuitBreaker,
  recordStrategyOutcome,
  updatePortfolioSnapshot,
  resetCircuitBreaker,
} from '../src/agent/riskGuard';

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ok  : ${msg}`);
  }
}

console.log('=== Risk guard circuit breaker test ===\n');

// 1. Fresh state
resetCircuitBreaker();
let s = checkCircuitBreaker();
assert(!s.tripped, 'fresh state: not tripped');
assert(s.reason === 'ok', 'fresh state: reason=ok');

// 2. Single success — no trip
recordStrategyOutcome({ outcome: 'success' });
s = checkCircuitBreaker();
assert(!s.tripped, '1 success: not tripped');
assert(s.revertStreak === 0, '1 success: revertStreak=0');

// 3. Two reverts — still not tripped (default threshold is 3)
recordStrategyOutcome({ outcome: 'reverted' });
recordStrategyOutcome({ outcome: 'reverted' });
s = checkCircuitBreaker();
assert(!s.tripped, '2 reverts: not tripped yet');
assert(s.revertStreak === 2, `2 reverts: revertStreak=2 (got ${s.revertStreak})`);

// 4. Third revert — should trip (reason becomes "cooldown active"
//    once the auto-trip cooldown kicks in; the underlying trigger
//    was the revert streak).
recordStrategyOutcome({ outcome: 'reverted' });
s = checkCircuitBreaker();
assert(s.tripped, '3 reverts: tripped');
assert(/streak|cooldown/.test(s.reason), `3 reverts: reason mentions streak or cooldown (got: ${s.reason})`);

// 5. Reset — should clear
resetCircuitBreaker();
s = checkCircuitBreaker();
assert(!s.tripped, 'reset: not tripped');
assert(s.revertStreak === 0, 'reset: revertStreak=0');

// 6. Drawdown detection: set peak then drop
resetCircuitBreaker();
updatePortfolioSnapshot('1000');
s = checkCircuitBreaker();
assert(!s.tripped, 'peak 1000: not tripped');
updatePortfolioSnapshot('500'); // 50% drawdown, threshold default 10%
s = checkCircuitBreaker();
assert(s.tripped, '50% drawdown: tripped');
assert(/drawdown/.test(s.reason), `drawdown reason: ${s.reason}`);

// 7. Reset + small drawdown (within threshold)
resetCircuitBreaker();
// Need to set peak then drop in sequence: first snapshot establishes the peak,
// second drops it. State needs to be clean.
resetCircuitBreaker();
updatePortfolioSnapshot('1000'); // peak=1000, last=1000
s = checkCircuitBreaker();
// Manually drop to 950 by re-writing state... simplest: just call twice
// with explicit peak semantics via a tiny shim
resetCircuitBreaker();
updatePortfolioSnapshot('1000');
// Hack: write state directly so lastValue=950 < peak=1000
import { writeFileSync } from 'fs';
import { join } from 'path';
const statePath = join(process.cwd(), '.arwa-risk.json');
writeFileSync(statePath, JSON.stringify({
  peakMotes: '1000',
  lastValueMotes: '950',
  revertStreak: 0,
  trippedUntil: 0,
  totalStrategies: 0,
  totalSuccesses: 0,
  totalReverts: 0,
}, null, 2));
s = checkCircuitBreaker();
assert(!s.tripped, '5% drawdown (950 from peak 1000): not tripped');

// 8. Small move to new high (no drawdown)
updatePortfolioSnapshot('1100'); // new peak
updatePortfolioSnapshot('1080'); // ~1.8% drawdown from peak
s = checkCircuitBreaker();
assert(!s.tripped, 'small drawdown from new peak: not tripped');

console.log('\n=== Done ===');
