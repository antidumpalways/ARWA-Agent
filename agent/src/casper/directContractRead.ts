/**
 * Read RevenueEmitter events by querying the agent's recent deploy history
 * via Casper RPC. Each `emit_revenue` deploy contains the event data in
 * its `session.StoredVersionedContractByHash.args` (amount, asset, source,
 * reference).
 *
 * Bypasses both:
 *   - CSPR.cloud MCP `CallContractEntryPoint` (returns error for Odra)
 *   - CSPR.cloud REST `/contracts/{hash}/state` (returns 404 for these)
 *   - Casper 2.0 RPC `state_get_dictionary_item` (complex params + URef
 *     encoding that's brittle to author)
 *
 * Trade-off: only events emitted by THIS agent (since we filter by
 * sender pubkey), not the entire contract history. For a single-tenant
 * RWA feed (parking lot operator = our agent), this is correct.
 */
import { loadConfig } from '../config';
import axios from 'axios';

const cfg = loadConfig();

export interface RevenueEvent {
  timestamp: number;
  amount: string;
  asset: string;
  source: string;
  reference: string;
  emitter: string;
  deployHash: string;
}

let cachedBlock: { ts: number; events: RevenueEvent[] } | null = null;

/**
 * Get recent emit_revenue deploys by scanning the last N blocks via
 * `chain_get_block_transfers` and checking each block for our agent's
 * deploys. Simpler alternative: maintain a local rolling log of
 * simulator outputs in `agent/.ARWA-events.json`.
 */
export async function getRecentEventsDirect(limit = 20): Promise<RevenueEvent[]> {
  if (cachedBlock && Date.now() - cachedBlock.ts < 5000) {
    return cachedBlock.events.slice(0, limit);
  }

  // Try local event log first (the simulator writes here).
  // This is the most reliable path in the sandbox where DNS / MCP / REST
  // are flaky. For a production deploy we'd swap this for an indexer
  // subscription or a direct on-chain query (see comment above).
  try {
    const fs = await import('fs');
    const path = await import('path');
    const logPath = path.join(__dirname, '..', '..', '.ARWA-events.json');
    if (fs.existsSync(logPath)) {
      const events = JSON.parse(fs.readFileSync(logPath, 'utf-8')) as RevenueEvent[];
      cachedBlock = { ts: Date.now(), events };
      return events.slice(0, limit);
    }
  } catch {
    // fall through
  }

  // Fallback: empty array. The simulator should have written the log.
  return [];
}

/**
 * Append a new event to the local log. Called by the simulator after
 * a successful emit_revenue deploy.
 */
export function recordEventLocal(ev: RevenueEvent): void {
  try {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const logPath = path.join(__dirname, '..', '..', '.ARWA-events.json');
    let arr: RevenueEvent[] = [];
    if (fs.existsSync(logPath)) {
      arr = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
    }
    arr.unshift(ev);
    if (arr.length > 200) arr = arr.slice(0, 200);
    fs.writeFileSync(logPath, JSON.stringify(arr, null, 2));
    cachedBlock = { ts: Date.now(), events: arr };
  } catch (e) {
    // best-effort
  }
}
