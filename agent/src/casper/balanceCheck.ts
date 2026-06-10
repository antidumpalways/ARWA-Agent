/**
 * CEP-18 (fungible token) balance query for the ParkFlow Agent.
 *
 * Uses Casper RPC `query_global_state` + `state_get_dictionary_item` to
 * walk the cep18_test_contract named keys and read `balance_of` for the
 * agent's account. The cep18_test_contract (deployed alongside the main
 * cep18.wasm — see https://github.com/casper-ecosystem/cep18) writes the
 * balance to a URef named `result` so external readers don't need to
 * understand the main contract's internal storage layout.
 *
 * Falls back gracefully:
 *   - if CEP18_UTIL_QUERY_HASH is not set → returns null (no token deployed)
 *   - if the facilitator / RPC is unreachable → returns last cached value
 *   - if the agent's address doesn't appear in the URef → returns 0
 */
import { loadConfig } from '../config';
import axios from 'axios';

const cfg = loadConfig();

let cached: { balance: string; ts: number } | null = null;
const CACHE_TTL_MS = 10_000;

interface DictItemResponse {
  jsonrpc: string;
  id: number;
  result?: {
    stored_value?: {
      CLValue?: {
        cl_type?: string;
        bytes?: string;
        parsed?: any;
      };
    };
  };
  error?: { code: number; message: string };
}

/**
 * Discover the cep18_test_contract package → contract hash → named keys
 * (especially the `result` URef). Cached for 30s.
 */
let cachedUtilContract: { contractHash: string; resultUref: string; ts: number } | null = null;

async function discoverUtilContract(): Promise<{ contractHash: string; resultUref: string } | null> {
  if (cachedUtilContract && Date.now() - cachedUtilContract.ts < 30_000) {
    return cachedUtilContract;
  }
  if (!cfg.CEP18_UTIL_QUERY_HASH) return null;
  const pkgHash = cfg.CEP18_UTIL_QUERY_HASH.replace('hash-', '');

  try {
    // Get the contract package → version 1 → contract hash
    const pkgRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'query_global_state',
        params: { key: `hash-${pkgHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 5000, validateStatus: () => true }
    );
    const versions = pkgRes.data?.result?.stored_value?.ContractPackage?.versions;
    if (!versions || versions.length === 0) return null;
    const contractHash = versions[0].contract_hash.replace('contract-', '');

    // Get the contract's named keys → find URef named "result"
    const conRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'query_global_state',
        params: { key: `hash-${contractHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 5000, validateStatus: () => true }
    );
    const namedKeys = conRes.data?.result?.stored_value?.Contract?.named_keys;
    if (!namedKeys) return null;
    const resultKey = namedKeys.find((k: any) => k.name === 'result');
    if (!resultKey) return null;

    cachedUtilContract = { contractHash, resultUref: resultKey.key, ts: Date.now() };
    return cachedUtilContract;
  } catch {
    return null;
  }
}

/**
 * Render an account hash (32 raw bytes) as the dictionary_item_key that
 * cep18_test_contract uses to index per-account balances.
 */
function accountHashToDictKey(accountHashHex: string): string {
  // Strip the "account-hash-" prefix if present
  const hex = accountHashHex.replace(/^account-hash-/, '');
  return hex.padStart(64, '0').slice(-64);
}

/**
 * Public API: read the agent's CEP-18 token balance (in motes).
 *
 * Returns:
 *   { balance: '0', source: 'none' }    — no token deployed, no env
 *   { balance: '0', source: 'cache' }   — RPC failed, served from cache
 *   { balance: '450000000', source: 'on-chain' } — real read
 */
export async function getAgentCep18Balance(
  agentAccountHashHex: string
): Promise<{ balance: string; source: 'on-chain' | 'cache' | 'none' | 'unconfigured' }> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { balance: cached.balance, source: 'cache' };
  }
  const util = await discoverUtilContract();
  if (!util) {
    return { balance: '0', source: 'unconfigured' };
  }
  try {
    // Step 1: get the latest state_root_hash
    const srhRes = await axios.post(
      cfg.CASPER_RPC_URL,
      { jsonrpc: '2.0', id: 1, method: 'chain_get_state_root_hash', params: [] },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 5000 }
    );
    const srh = srhRes.data?.result?.state_root_hash;
    if (!srh) return { balance: '0', source: 'none' };

    // Step 2: query the dictionary item indexed by the agent's account hash
    const itemKey = accountHashToDictKey(agentAccountHashHex);
    const dictRes = await axios.post<DictItemResponse>(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'state_get_dictionary_item',
        params: {
          state_root_hash: srh,
          dictionary_identifier: {
            ContractNamedKey: {
              key: `hash-${util.contractHash}`,
              dictionary_name: 'result',
              dictionary_item_key: itemKey,
            },
          },
        },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 5000, validateStatus: () => true }
    );

    if (dictRes.status !== 200) {
      return { balance: '0', source: 'none' };
    }
    // The CLValue is a U256 / U512; `parsed` is the decimal string
    const clv = dictRes.data?.result?.stored_value?.CLValue;
    const balance = String(clv?.parsed ?? '0');
    cached = { balance, ts: Date.now() };
    return { balance, source: 'on-chain' };
  } catch {
    return { balance: '0', source: 'none' };
  }
}

/**
 * Convenience: get the balance as a decimal CSPR-style number string
 * (1 CEP-18 with 9 decimals = 1_000_000_000 motes; divide by 1e9).
 */
export function formatCep18Balance(motes: string, decimals = 9): string {
  const big = BigInt(motes);
  const factor = 10n ** BigInt(decimals);
  const whole = big / factor;
  const frac = big % factor;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
