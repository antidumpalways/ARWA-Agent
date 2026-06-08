/**
 * CSPR.cloud Streaming API client.
 *
 * Two transports, both work with the same CSPR.cloud API key.
 *
 * 1. **WebSocket** (`/streaming-api/reference`) — primary, lowest latency.
 *    Connects once, sends `{"action":"subscribe","stream":"..."}` messages
 *    to opt into one or more streams. Server pushes
 *    `{"action":"created"|"updated"|"emitted", "data":{...}, "timestamp":...}`
 *    envelopes. The `data` shape depends on the stream.
 *
 * 2. **SSE** — CSPR.cloud exposes selected streams over Server-Sent Events
 *    too (same data, one-way, simpler to consume from a browser).
 *    Same auth (query `?api_key=` or `Authorization: Bearer`).
 *
 * Raw Casper node SSE (separate from CSPR.cloud's streaming API) is at
 *   https://node-sse.testnet.cspr.cloud/events/main
 * and uses the standard casper-js-sdk SSE event types
 * (ApiVersion, BlockAdded, DeployProcessed, DeployAccepted, ...).
 *
 * Stream catalogue used by ParkFlow:
 *   - "Contract-level events"  action: "emitted"  → CES events
 *   - "Deploy"                 action: "created"  → new deploys
 *   - "Account balance"        action: "updated"  → balance changes
 *   - "Fungible token action"  action: "created"  → CEP-18 transfers
 *
 * Docs: https://docs.cspr.cloud/streaming-api/reference
 */
import WebSocket from 'ws';
import EventSource from 'eventsource';
import { loadConfig } from '../config';

// ----- types matching the CSPR.cloud envelope -----

export interface StreamEnvelope {
  action: 'created' | 'updated' | 'emitted' | string;
  data: any;
  timestamp: string;       // ISO datetime
  extra?: Record<string, any>;
}

export type StreamHandler = (msg: StreamEnvelope) => void;

/**
 * Parse a JSON message string from a CSPR.cloud stream into a typed
 * `StreamEnvelope`. Returns `null` if the input is not valid JSON or is
 * missing the required `action` and `data` fields.
 */
export function parseStreamEnvelope(raw: string | any): StreamEnvelope | null {
  if (typeof raw === 'object' && raw !== null) {
    if (
      typeof (raw as any).action !== 'undefined' &&
      typeof (raw as any).data !== 'undefined'
    ) {
      return raw as StreamEnvelope;
    }
    return null;
  }
  try {
    const obj = JSON.parse(raw);
    if (
      obj &&
      typeof obj.action !== 'undefined' &&
      typeof obj.data !== 'undefined'
    ) {
      return obj as StreamEnvelope;
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * Filter predicate: keep envelopes whose `data.contract_hash` (or
 * `data.contractHash` / `data.package_hash`) matches the given contract
 * hash. Case-insensitive.
 */
export function filterByContract(contractHash: string) {
  const target = contractHash.toLowerCase();
  return (env: StreamEnvelope): boolean => {
    const d = env.data ?? {};
    const ch = (d.contract_hash ?? d.contractHash ?? d.package_hash ?? '')
      .toString()
      .toLowerCase();
    return ch === target;
  };
}

/**
 * Combine contract + event-name filtering. `eventName` is matched
 * case-insensitively against `data.event_name` (or `data.name`).
 */
export function filterByContractAndEvent(contractHash: string, eventName: string) {
  const targetEvent = eventName.toLowerCase();
  const contractPred = filterByContract(contractHash);
  return (env: StreamEnvelope): boolean => {
    if (!contractPred(env)) return false;
    const d = env.data ?? {};
    const en = (d.event_name ?? d.name ?? '').toString().toLowerCase();
    return en === targetEvent;
  };
}

// ----- stream catalogue -----

export type StreamName =
  | 'Account balance'
  | 'Block'
  | 'Contract'
  | 'Contract package'
  | 'Contract-level events'
  | 'Deploy'
  | 'Fungible token action'
  | 'Non-fungible token (NFT)'
  | 'Non-fungible token (NFT) action'
  | 'Transfer';

// ----- auth helpers -----

function getApiKey(): string {
  return loadConfig().CSPR_CLOUD_API_KEY;
}

/**
 * Returns the SSE + WS base URLs. CSPR.cloud streaming hosts are
 * `stream.<network>.cspr.cloud` (or `stream.cspr.cloud` for mainnet).
 */
function getStreamBase(): { http: string; ws: string } {
  const cfg = loadConfig();
  return cfg.CASPER_NETWORK === 'casper'
    ? { http: 'https://stream.cspr.cloud', ws: 'wss://stream.cspr.cloud' }
    : { http: 'https://stream.testnet.cspr.cloud', ws: 'wss://stream.testnet.cspr.cloud' };
}

// ============================================================================
// WebSocket
// ============================================================================

/**
 * Open a WebSocket to CSPR.cloud, subscribe to the given streams, and dispatch
 * each envelope to `onMessage`. Returns a `close()` cleanup.
 *
 * Implements exponential-backoff reconnection (per CSPR.cloud docs, the WS may
 * close when a new API version is deployed).
 */
export function subscribeWS(
  streams: StreamName[],
  onMessage: StreamHandler
): { ws: WebSocket | null; close: () => void } {
  const { ws: wsBase } = getStreamBase();
  const url = `${wsBase}?api_key=${encodeURIComponent(getApiKey())}`;

  let sock: WebSocket | null = null;
  let stopped = false;
  let backoff = 500;

  const open = () => {
    if (stopped) return;
    sock = new WebSocket(url);

    sock.on('open', () => {
      backoff = 500;
      for (const s of streams) {
        sock!.send(JSON.stringify({ action: 'subscribe', stream: s }));
      }
    });

    sock.on('message', (raw) => {
      let parsed: StreamEnvelope | null = null;
      try { parsed = JSON.parse(raw.toString()) as StreamEnvelope; } catch { return; }
      if (!parsed || parsed.action === undefined || parsed.data === undefined) return;
      // Pass through; filtering is the caller's job
      onMessage(parsed);
    });

    sock.on('error', (e) => console.error('[ws] error', e?.message ?? e));

    sock.on('close', () => {
      if (stopped) return;
      const wait = Math.min(backoff *= 2, 30_000);
      console.warn(`[ws] closed, reconnecting in ${wait}ms`);
      setTimeout(open, wait);
    });
  };

  open();

  return {
    ws: sock,
    close: () => {
      stopped = true;
      sock?.close();
    },
  };
}

// ============================================================================
// SSE
// ============================================================================

/**
 * Subscribe to a single stream via Server-Sent Events. Returns a cleanup.
 *
 * Each SSE `message` event carries a JSON envelope like the WS variant.
 */
export function subscribeSSE(
  stream: StreamName,
  onMessage: StreamHandler
): () => void {
  const { http } = getStreamBase();
  const url = `${http}/${encodeURIComponent(stream)}?api_key=${encodeURIComponent(getApiKey())}`;
  const es = new EventSource(url, {
    headers: { Authorization: getApiKey() },
  } as any);

  es.addEventListener('message', (ev: any) => {
    try {
      const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (data && data.action !== undefined && data.data !== undefined) {
        onMessage(data as StreamEnvelope);
      }
    } catch (e) {
      // not JSON, ignore
    }
  });

  es.addEventListener('error', (ev) => {
    console.error('[sse] error', stream, ev);
  });

  return () => es.close();
}

// ============================================================================
// High-level filters for ParkFlow
// ============================================================================

/**
 * Subscribe to all CES events from a specific contract. CSPR.cloud
 * surfaces them through the "Contract-level events" stream with
 * `action: "emitted"`. We filter on `data.contract_hash` here so the
 * caller only gets events for the contract it cares about.
 */
export function onContractCESEvents(
  contractHash: string,
  onEvent: (eventName: string, payload: Record<string, any>, envelope: StreamEnvelope) => void,
  opts: { transport?: 'ws' | 'sse' } = {}
): () => void {
  const transport = opts.transport ?? 'ws';
  const matchHash = (h: string) => (h ?? '').toLowerCase() === contractHash.toLowerCase();

  if (transport === 'sse') {
    return subscribeSSE('Contract-level events', (env) => {
      if (env.action !== 'emitted') return;
      const d = env.data ?? {};
      const ch = d.contract_hash ?? d.contractHash ?? d.package_hash;
      if (!matchHash(ch)) return;
      onEvent(d.event_name ?? d.name ?? 'Unknown', d.data ?? d.payload ?? {}, env);
    });
  }

  const { close } = subscribeWS(['Contract-level events'], (env) => {
    if (env.action !== 'emitted') return;
    const d = env.data ?? {};
    const ch = d.contract_hash ?? d.contractHash ?? d.package_hash;
    if (!matchHash(ch)) return;
    onEvent(d.event_name ?? d.name ?? 'Unknown', d.data ?? d.payload ?? {}, env);
  });
  return close;
}

/**
 * Subscribe to all new deploys that touch a specific contract.
 * Uses the "Deploy" stream and filters on `data.contract_hash`.
 */
export function onContractDeploys(
  contractHash: string,
  onDeploy: (env: StreamEnvelope) => void
): () => void {
  const matchHash = (h: string) => (h ?? '').toLowerCase() === contractHash.toLowerCase();
  const { close } = subscribeWS(['Deploy'], (env) => {
    if (env.action !== 'created') return;
    const d = env.data ?? {};
    const ch = d.contract_hash ?? d.contractHash ?? d.entry_point_contract_hash;
    if (ch && matchHash(ch)) onDeploy(env);
  });
  return close;
}

// ============================================================================
// Raw Casper node SSE (alternative — not CSPR.cloud's streaming API)
// ============================================================================

/**
 * Subscribe to a raw Casper node SSE event type. Use this when you need the
 * low-level events (BlockAdded, DeployProcessed, etc.) from the node itself.
 *
 *   https://node-sse.testnet.cspr.cloud/events/main
 *   EventType: ApiVersion | BlockAdded | DeployProcessed | DeployAccepted | ...
 *
 * SDK reference: casper-js-sdk's SseClient (TS) or the Go casper-go-sdk.
 */
export function subscribeCasperNodeSSE(
  eventTypes: string[],
  onMessage: (type: string, data: any) => void
): () => void {
  const cfg = loadConfig();
  const base = cfg.CASPER_NODE_SSE_URL ??
    (cfg.CASPER_NETWORK === 'casper'
      ? 'https://node-sse.cspr.cloud'
      : 'https://node-sse.testnet.cspr.cloud');
  const url = `${base}/events/main?api_key=${encodeURIComponent(getApiKey())}`;
  const es = new EventSource(url, {
    headers: { Authorization: getApiKey() },
  } as any);

  for (const t of eventTypes) {
    es.addEventListener(t, (ev: any) => {
      try {
        const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
        onMessage(t, data);
      } catch {
        onMessage(t, ev.data);
      }
    });
  }

  return () => es.close();
}
