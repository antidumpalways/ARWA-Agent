/**
 * ParkFlow Agent — Parking Lot Revenue Simulator (one-shot).
 *
 * Simulates vehicles exiting a parking lot, converts the fiat fee
 * (USD by default) to motes, computes a SHA-256 receipt hash for
 * audit, and pushes each transaction to the deployed `RevenueEmitter`
 * contract on Casper 2.0 testnet.
 *
 * Demonstrates the RWA → blockchain bridge: a single physical-world
 * event (car exit + payment) becomes an immutable, auditable
 * on-chain record.
 *
 * Usage:
 *   npx tsx scripts/simulate-parking-revenue.ts
 *   npx tsx scripts/simulate-parking-revenue.ts --count=10
 *   npx tsx scripts/simulate-parking-revenue.ts --rate=0.10
 *   npx tsx scripts/simulate-parking-revenue.ts --hourly=5
 *
 * Env overrides:
 *   SIMULATOR_COUNT       default 5
 *   SIMULATOR_USD_PER_CSPR default 0.10
 *   SIMULATOR_HOURLY_USD  default 5.00
 *   SIMULATOR_SOURCE      default "P1 - Gate Keluar Utama"
 */
import { createHash } from 'crypto';
import { loadConfig } from '../src/config';
import { signAndSubmitDeploy, buildContractCallDeploy } from '../src/casper/signer';
import { recordEventLocal } from '../src/casper/directContractRead';

const PLAT_PREFIXES = ['B', 'D', 'F', 'H', 'L', 'N', 'T', 'AB', 'AD', 'BG', 'BK'];
const PLAT_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;

interface SimArgs {
  count: number;
  usdPerCspr: number;
  hourlyUsd: number;
  source: string;
}

function parseArgs(): SimArgs {
  const argv = process.argv.slice(2);
  const get = (key: string, fallback: string): string => {
    const a = argv.find((s) => s.startsWith(`--${key}=`));
    return a ? a.split('=')[1] : fallback;
  };
  return {
    count: Number(get('count', process.env.SIMULATOR_COUNT ?? '5')),
    usdPerCspr: Number(get('rate', process.env.SIMULATOR_USD_PER_CSPR ?? '0.10')),
    hourlyUsd: Number(get('hourly', process.env.SIMULATOR_HOURLY_USD ?? '5')),
    source: get('source', process.env.SIMULATOR_SOURCE ?? 'P1 - Gate Keluar Utama'),
  };
}

function randomPlat(): string {
  // Indonesian plate format: <region> <number> <letters>
  const prefix = PLAT_PREFIXES[Math.floor(Math.random() * PLAT_PREFIXES.length)];
  const num = String(1000 + Math.floor(Math.random() * 9000));
  const letters = Array.from({ length: 3 }, () =>
    PLAT_LETTERS[Math.floor(Math.random() * PLAT_LETTERS.length)]
  ).join('');
  return `${prefix} ${num} ${letters}`;
}

function randomDuration(): number {
  // 30 min – 6 hours
  return 30 + Math.floor(Math.random() * 330);
}

function computeCostUsd(durationMin: number, hourlyUsd: number): number {
  const hours = Math.max(1, Math.ceil(durationMin / 60));
  return Math.round(hours * hourlyUsd * 100) / 100;
}

function computeReceiptHash(plat: string, exitTime: number, costUsd: number): string {
  return createHash('sha256')
    .update(`parkflow|${plat}|${exitTime}|${costUsd.toFixed(2)}`)
    .digest('hex');
}

function usdToMotes(usd: number, usdPerCspr: number): bigint {
  // CSPR has 9 decimals (1 CSPR = 1_000_000_000 motes)
  const cspr = usd / usdPerCspr;
  return BigInt(Math.floor(cspr * 1_000_000_000));
}

interface PushResult {
  plat: string;
  durationMin: number;
  costUsd: number;
  motes: bigint;
  hash: string;
  txHash?: string;
  error?: string;
}

async function pushEvent(
  cfg: ReturnType<typeof loadConfig>,
  amount: bigint,
  source: string,
  reference: string
): Promise<{ txHash?: string; error?: string }> {
  try {
    const args: Record<string, { clType: string; value: any }> = {
      amount: { clType: 'u256', value: amount.toString() },
      asset: { clType: 'key', value: ZERO_ADDR },
      source: { clType: 'string', value: source },
      reference: { clType: 'string', value: reference },
    };
    const deploy = buildContractCallDeploy(
      cfg.REVENUE_EMITTER_CONTRACT_HASH!,
      'emit_revenue',
      args,
      cfg.CASPER_CHAIN_NAME
    );
    const { deployHash } = await signAndSubmitDeploy(deploy);
    return { txHash: deployHash };
  } catch (e: any) {
    return { error: e?.message?.slice(0, 200) ?? String(e).slice(0, 200) };
  }
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const cfg = loadConfig();
  const args = parseArgs();

  if (!cfg.REVENUE_EMITTER_CONTRACT_HASH) {
    throw new Error('REVENUE_EMITTER_CONTRACT_HASH not set in .env. Run `npm run deploy` first.');
  }

  console.log('═══ ParkFlow Simulator — Parking Lot Revenue ═══\n');
  console.log(`Contract:    ${cfg.REVENUE_EMITTER_CONTRACT_HASH}`);
  console.log(`Network:     ${cfg.CASPER_NETWORK}`);
  console.log(`Events:      ${args.count}`);
  console.log(`Source:      "${args.source}"`);
  console.log(`Rate:        1 CSPR = $${args.usdPerCspr.toFixed(2)}`);
  console.log(`Hourly fee:  $${args.hourlyUsd.toFixed(2)} / hour\n`);

  const results: PushResult[] = [];
  const start = Date.now();
  const exitTimeBase = Math.floor(Date.now() / 1000);

  for (let i = 0; i < args.count; i++) {
    const plat = randomPlat();
    const durationMin = randomDuration();
    const costUsd = computeCostUsd(durationMin, args.hourlyUsd);
    const motes = usdToMotes(costUsd, args.usdPerCspr);
    const exitTime = exitTimeBase + i * 30;
    const hash = computeReceiptHash(plat, exitTime, costUsd);

    console.log(
      `[${String(i + 1).padStart(2, '0')}/${args.count}] ${plat}  ${durationMin}min  ` +
        `$${costUsd.toFixed(2)}  →  ${motes.toString().padStart(15, ' ')} motes  ` +
        `ref=${hash.slice(0, 16)}…`
    );

    const res = await pushEvent(cfg, motes, args.source, hash);
    if (res.txHash) {
      console.log(`             ✓ tx: ${res.txHash}`);
      results.push({ plat, durationMin, costUsd, motes, hash, txHash: res.txHash });
      // Record for the x402 server (and the agent cycle) to read locally.
      recordEventLocal({
        timestamp: exitTime,
        amount: motes.toString(),
        asset: ZERO_ADDR,
        source: args.source,
        reference: hash,
        emitter: cfg.AGENT_PUBLIC_KEY ?? 'agent',
        deployHash: res.txHash,
      });
    } else {
      console.log(`             ✗ ${res.error}`);
      results.push({ plat, durationMin, costUsd, motes, hash, error: res.error });
    }

    if (i < args.count - 1) {
      // Casper 2.0 testnet: same-block deploys from the same sender are
      // rejected. 8s spacing is safe.
      await sleep(8000);
    }
  }

  const ok = results.filter((r) => r.txHash).length;
  const totalUsd = results.reduce((s, r) => s + r.costUsd, 0);
  const totalMotes = results.reduce((s, r) => s + r.motes, 0n);
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  console.log(`\n═══ Done in ${elapsed}s ═══`);
  console.log(`Success:    ${ok} / ${args.count}`);
  console.log(`Total fiat: $${totalUsd.toFixed(2)}`);
  console.log(`Total CSPR: ${(Number(totalMotes) / 1e9).toFixed(6)} CSPR`);

  const explorer = cfg.REVENUE_EMITTER_CONTRACT_HASH.replace('hash-', '');
  console.log(`\nVerify on explorer:`);
  console.log(`  https://testnet.cspr.live/contract/${explorer}`);
  if (results.length > 0 && results[0].txHash) {
    console.log(`  first tx: https://testnet.cspr.live/deploy/${results[0].txHash}`);
  }

  if (ok < args.count) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Simulator crashed:', e);
  process.exit(2);
});
