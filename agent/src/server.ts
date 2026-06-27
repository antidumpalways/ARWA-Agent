/**
 * ARWA backend — bridges the static frontend to the agent runner.
 *
 * Endpoints:
 *   GET  /api/health          → { ok, network, contracts, apiKey, ws }
 *   GET  /api/state           → live vault state (read via CSPR.cloud REST)
 *   GET  /api/events          → SSE stream of vault CES events
 *   GET  /api/cycles          → in-memory cycle history
 *   POST /api/cycle           → run one full analyst → executor cycle
 *
 * State reads use CSPR.cloud REST (`/contracts/{hash}/state`) — that way we
 * don't need to run a Casper node locally and we get indexed, normalized data.
 * Live updates use the CSPR.cloud Streaming API (SSE), which surfaces Odra
 * events because they're CES-compliant out of the box.
 */
import express from 'express';
import cors from 'cors';
import { runCycle } from './index';
import { loadConfig } from './config';
import { RevenueEvent } from './types';
import { getContractState } from './csprCloud/rest';
import {
  onStrategyExecuted,
  onRevenueEmitted,
  StrategyExecutedEvent,
  RevenueEmittedEvent,
} from './csprCloud/cesEvents';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4000);
const cycleHistory: Array<{ ts: number; result: any }> = [];
const liveEvents: Array<{ kind: string; data: any; ts: number }> = [];
let liveStopFns: Array<() => void> = [];

// ---------- helpers ----------

async function readVaultView(contractHash: string, entryPoint: string): Promise<any> {
  // CSPR.cloud supports `?entry_point=` for view calls
  const r = await getContractState(contractHash, [entryPoint]);
  return r.state;
}

function eventBus(handler: (kind: string, data: any) => void) {
  return {
    onStrategy: () =>
      onStrategyExecuted((e: StrategyExecutedEvent) => handler('strategy', e)),
    onRevenue: () =>
      onRevenueEmitted((e: RevenueEmittedEvent) => handler('revenue', e)),
  };
}

function attachLiveStreams() {
  // tear down old
  liveStopFns.forEach(fn => fn());
  liveStopFns = [];
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    console.warn('[backend] AGENT_VAULT_CONTRACT_HASH not set; live events disabled');
    return;
  }
  const bus = eventBus((kind, data) => {
    liveEvents.unshift({ kind, data, ts: Date.now() });
    if (liveEvents.length > 200) liveEvents.length = 200;
  });
  liveStopFns.push(bus.onStrategy());
  if (cfg.REVENUE_EMITTER_CONTRACT_HASH) {
    liveStopFns.push(bus.onRevenue());
  }
  console.log('[backend] live CES streams attached');
}

// ---------- routes ----------

app.get('/api/health', async (_, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    network: cfg.CASPER_NETWORK,
    apiKeySet: Boolean(cfg.CSPR_CLOUD_API_KEY),
    contracts: {
      revenue_emitter: cfg.REVENUE_EMITTER_CONTRACT_HASH ?? null,
      agent_vault: cfg.AGENT_VAULT_CONTRACT_HASH ?? null,
    },
  });
});

app.get('/api/state', async (_, res) => {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    return res.json({
      totalAssets: '0',
      reputation: 0,
      totalStrategies: 0,
      vault: null,
      live: false,
      note: 'AGENT_VAULT_CONTRACT_HASH not set — deploy contracts first',
    });
  }
  try {
    // CSPR.cloud exposes view functions via /contracts/{hash}/state
    // We read three of them in parallel.
    const [totalAssets, reputation, totalStrategies] = await Promise.all([
      readVaultView(cfg.AGENT_VAULT_CONTRACT_HASH, 'get_total_assets'),
      readVaultView(cfg.AGENT_VAULT_CONTRACT_HASH, 'get_global_reputation'),
      readVaultView(cfg.AGENT_VAULT_CONTRACT_HASH, 'get_total_strategies'),
    ]);
    res.json({
      totalAssets: String(totalAssets ?? '0'),
      reputation: Number(reputation ?? 0),
      totalStrategies: Number(totalStrategies ?? 0),
      vault: cfg.AGENT_VAULT_CONTRACT_HASH,
      live: true,
    });
  } catch (e: any) {
    res.status(502).json({
      ok: false,
      error: e?.message ?? String(e),
      hint: 'Make sure CSPR_CLOUD_API_KEY is set and the contract hash is correct',
    });
  }
});

app.get('/api/events', (req, res) => {
  // SSE stream for the frontend
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const send = (kind: string, data: any) => {
    res.write(`event: ${kind}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Replay last 25
  for (const e of liveEvents.slice(0, 25)) send(e.kind, e.data);

  const bus = eventBus((kind, data) => send(kind, data));
  const stopStrategy = bus.onStrategy();
  const stopRevenue = bus.onRevenue();

  const ka = setInterval(() => res.write(': keepalive\n\n'), 20_000);

  req.on('close', () => {
    clearInterval(ka);
    stopStrategy();
    stopRevenue();
  });
});

app.get('/api/cycles', (_, res) => res.json(cycleHistory));

app.post('/api/cycle', async (req, res) => {
  try {
    const cfg = loadConfig();
    const event: RevenueEvent = req.body.revenueEvent ?? {
      timestamp: Math.floor(Date.now() / 1000),
      amount: req.body.amount ?? '1000000000000',
      asset: '0'.repeat(64),
      source: req.body.source ?? 'frontend-trigger',
      emitter: cfg.AGENT_PUBLIC_KEY ?? '0'.repeat(66),
      reference: `frontend-${Date.now()}`,
    };
    const result = await runCycle({
      revenueEvent: event,
      ownerAddress: req.body.ownerAddress ?? cfg.AGENT_PUBLIC_KEY ?? '',
      forceAction: req.body.forceAction,
    });
    cycleHistory.unshift({ ts: Date.now(), result });
    if (cycleHistory.length > 50) cycleHistory.length = 50;
    res.json({ ok: true, ...result });
  } catch (e: any) {
    console.error('[api/cycle]', e);
    res.status(500).json({ ok: false, error: e?.message ?? String(e) });
  }
});

// ---------- boot ----------

attachLiveStreams();
app.listen(PORT, () => {
  console.log(`[backend] http://localhost:${PORT}`);
  console.log(`[backend] endpoints: /api/health /api/state /api/events /api/cycle`);
});
