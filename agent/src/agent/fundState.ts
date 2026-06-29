/**
 * In-memory + on-disk fund state cache for ARWA.
 *
 * Why this exists: Casper 2.0 public RPC doesn't reliably expose Odra
 * contract state (CSPR.cloud REST returns 404 for Odra custom structs,
 * and state_get_item requires a valid state_root_hash which isn't
 * trivially fetchable). For the demo dashboard we maintain a parallel
 * local cache that is updated whenever the executor or deposit path
 * records a real on-chain event.
 *
 * State file: agent/.arwa-fund-state.json (gitignored, runtime only).
 * The file is rewritten atomically on every update so the backend can
 * restart without losing local counters.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { join } from 'path';

export interface FundState {
  // Updated by executor.ts via recordStrategyExecution
  positionsOpened: number;
  positionsRealised: number;        // yield claims
  yieldRealisedMotes: string;       // total yield claimed (u64)
  custodianMotes: string;           // current vault custodied (u64)
  // Updated by stakeholder-deposit-simulator.ts and demo-bootstrap
  stakeholderDeposits: number;       // lifetime deposit count
  stakeholderActiveMotes: string;    // current active principal
  stakeholderTotalMotes: string;     // lifetime deposited
  stakeholderWithdrawnMotes: string; // lifetime withdrawn
  lastUpdated: number;               // unix ms
}

const STATE_FILE = (() => {
  const thisDir = __dirname;
  for (const candidate of [
    join(thisDir, '..', '..', '..', '.arwa-fund-state.json'),
    join(thisDir, '..', '..', '.arwa-fund-state.json'),
    join(process.cwd(), 'agent', '.arwa-fund-state.json'),
  ]) {
    try {
      const parent = require('path').resolve(candidate, '..');
      if (existsSync(join(parent, 'package.json'))) return candidate;
    } catch {}
  }
  return join(process.cwd(), '.arwa-fund-state.json');
})();

function defaultState(): FundState {
  return {
    positionsOpened: 0,
    positionsRealised: 0,
    yieldRealisedMotes: '0',
    custodianMotes: '0',
    stakeholderDeposits: 0,
    stakeholderActiveMotes: '0',
    stakeholderTotalMotes: '0',
    stakeholderWithdrawnMotes: '0',
    lastUpdated: Date.now(),
  };
}

function load(): FundState {
  if (!existsSync(STATE_FILE)) return defaultState();
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function save(s: FundState): void {
  try {
    const tmp = STATE_FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
    renameSync(tmp, STATE_FILE);
  } catch {}
}

let cache: FundState = load();

export function getFundState(forceReload = false): FundState {
  if (forceReload) {
    cache = load();
  }
  return cache;
}

export function recordCustodianDeposit(motes: string): void {
  cache = {
    ...cache,
    custodianMotes: (BigInt(cache.custodianMotes) + BigInt(motes)).toString(),
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function recordCustodianWithdraw(motes: string): void {
  cache = {
    ...cache,
    custodianMotes: BigInt(cache.custodianMotes) > BigInt(motes)
      ? (BigInt(cache.custodianMotes) - BigInt(motes)).toString()
      : '0',
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function recordPositionOpened(): void {
  cache = {
    ...cache,
    positionsOpened: cache.positionsOpened + 1,
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function recordYieldClaimed(motes: string): void {
  cache = {
    ...cache,
    positionsRealised: cache.positionsRealised + 1,
    yieldRealisedMotes: (BigInt(cache.yieldRealisedMotes) + BigInt(motes)).toString(),
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function recordStakeholderDeposit(
  amountMotes: string,
  withdrawn: string = '0'
): void {
  cache = {
    ...cache,
    stakeholderDeposits: cache.stakeholderDeposits + 1,
    stakeholderActiveMotes: (BigInt(cache.stakeholderActiveMotes) + BigInt(amountMotes)).toString(),
    stakeholderTotalMotes: (BigInt(cache.stakeholderTotalMotes) + BigInt(amountMotes)).toString(),
    stakeholderWithdrawnMotes: (BigInt(cache.stakeholderWithdrawnMotes) + BigInt(withdrawn)).toString(),
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function recordStakeholderWithdrawal(amountMotes: string): void {
  cache = {
    ...cache,
    stakeholderActiveMotes: BigInt(cache.stakeholderActiveMotes) > BigInt(amountMotes)
      ? (BigInt(cache.stakeholderActiveMotes) - BigInt(amountMotes)).toString()
      : '0',
    stakeholderWithdrawnMotes: (BigInt(cache.stakeholderWithdrawnMotes) + BigInt(amountMotes)).toString(),
    lastUpdated: Date.now(),
  };
  save(cache);
}

export function resetFundState(): void {
  cache = defaultState();
  save(cache);
}