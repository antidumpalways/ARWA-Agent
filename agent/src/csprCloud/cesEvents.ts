/**
 * Casper Event Standard (CES) helpers, backed by CSPR.cloud Streaming API.
 *
 * Background:
 *   - Odra's `#[odra::event]` derive macro emits CES-compliant events
 *     on-chain. CSPR.cloud indexes them and surfaces them through the
 *     "Contract-level events" stream with `action: "emitted"`.
 *   - Each envelope's `data` contains the contract hash, the event name,
 *     and a `data` sub-object with the named fields.
 *
 * This file wraps the streaming helper (`streaming.ts#onContractCESEvents`)
 * into typed callbacks for our two contracts.
 *
 * Docs: https://docs.cspr.cloud/streaming-api/contract-level-events.md
 */
import { getRest } from './rest';
import {
  onContractCESEvents,
  subscribeWS,
  StreamEnvelope,
  StreamName,
} from './streaming';
import { loadConfig } from '../config';

// ---------- types matching the on-chain structs ----------

export interface RevenueEmittedEvent {
  amount: string;
  asset: string;          // hex
  source: string;
  timestamp: number;
  emitter: string;
  reference: string;
  deploy_hash: string;
  block_hash: string;
}

export interface StrategyExecutedEvent {
  action: string;
  pair: string;
  tx_hash: string;
  x402_proof: string;
  x402_signer: string;
  outcome: string;
  deploy_hash: string;
  block_hash: string;
}

// ---------- REST: history ----------

/**
 * Recent CES events for a given (contract, event_name) pair via REST.
 * (Useful for backfilling on agent boot.)
 */
async function getContractCESHistory(
  contractHash: string,
  eventName: string,
  page = 1,
  perPage = 25
): Promise<{ data: any[]; itemCount: number; pageCount: number }> {
  const r = await getRest().get(
    `/events/contract/${encodeURIComponent(contractHash)}/${encodeURIComponent(eventName)}`,
    { params: { page, per_page: perPage } }
  );
  return r.data;
}

export async function getRevenueEvents(
  emitterContractHash: string,
  opts: { page?: number; perPage?: number } = {}
): Promise<{ data: RevenueEmittedEvent[]; itemCount: number; pageCount: number }> {
  return getContractCESHistory(emitterContractHash, 'RevenueEmitted', opts.page, opts.perPage) as any;
}

export async function getStrategyEvents(
  vaultContractHash: string,
  opts: { page?: number; perPage?: number } = {}
): Promise<{ data: StrategyExecutedEvent[]; itemCount: number; pageCount: number }> {
  return getContractCESHistory(vaultContractHash, 'StrategyExecuted', opts.page, opts.perPage) as any;
}

// ---------- Streaming: live CES events ----------

/**
 * Internal helper that resolves a `VaultContractHash` lazily (config may be
 * loaded at different points).
 */
function requireVaultHash(): string {
  const h = loadConfig().AGENT_VAULT_CONTRACT_HASH;
  if (!h) throw new Error('AGENT_VAULT_CONTRACT_HASH not set');
  return h;
}
function requireEmitterHash(): string {
  const h = loadConfig().REVENUE_EMITTER_CONTRACT_HASH;
  if (!h) throw new Error('REVENUE_EMITTER_CONTRACT_HASH not set');
  return h;
}

/**
 * Live StrategyExecuted events from the AgentVault.
 *
 *   const stop = onStrategyExecuted((e) => console.log(e));
 *   // later: stop();
 */
export function onStrategyExecuted(
  onMessage: (e: StrategyExecutedEvent) => void
): () => void {
  try {
    return onContractCESEvents(requireVaultHash(), (name, payload, env) => {
      if (name !== 'StrategyExecuted') return;
      onMessage({
        ...payload,
        deploy_hash: env.extra?.deploy_hash ?? env.data?.deploy_hash ?? '',
        block_hash: env.extra?.block_hash ?? env.data?.block_hash ?? '',
      } as StrategyExecutedEvent);
    });
  } catch (e) {
    console.warn('[ces] onStrategyExecuted not active:', (e as Error).message);
    return () => {};
  }
}

/**
 * Live RevenueEmitted events from the RevenueEmitter contract.
 */
export function onRevenueEmitted(
  onMessage: (e: RevenueEmittedEvent) => void
): () => void {
  try {
    return onContractCESEvents(requireEmitterHash(), (name, payload, env) => {
      if (name !== 'RevenueEmitted') return;
      onMessage({
        ...payload,
        deploy_hash: env.extra?.deploy_hash ?? env.data?.deploy_hash ?? '',
        block_hash: env.extra?.block_hash ?? env.data?.block_hash ?? '',
      } as RevenueEmittedEvent);
    });
  } catch (e) {
    console.warn('[ces] onRevenueEmitted not active:', (e as Error).message);
    return () => {};
  }
}

// ---------- Catch-all: every event from a contract (debug / audit) ----------

/**
 * Subscribe to every CES event emitted by a contract (any event name).
 * Useful for an indexer or for debug UIs.
 */
export function onAnyContractEvent(
  contractHash: string,
  onMessage: (e: { name: string; payload: any; env: StreamEnvelope }) => void
): () => void {
  return onContractCESEvents(contractHash, (name, payload, env) => {
    onMessage({ name, payload, env });
  });
}

// ---------- Convenience: subscribe to a CSPR.cloud stream directly ----------

/**
 * Open a multi-stream WS subscription. Returns the cleanup. Use this if you
 * want to react to multiple event types (e.g. "Contract-level events" +
 * "Fungible token action") from a single socket.
 */
export function subscribeMultiple(
  streams: StreamName[],
  onMessage: (env: StreamEnvelope) => void
): () => void {
  const { close } = subscribeWS(streams, onMessage);
  return close;
}
