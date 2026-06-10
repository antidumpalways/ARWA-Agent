/**
 * CEP-18 (fungible token) balance query for the ParkFlow Agent.
 *
 * Two query paths are supported:
 *   1. Helper contract (`cep18_test_contract`) — calls check_balance_of,
 *      which writes the result to a URef named "result" that we then
 *      read back. Requires a deploy per query (wasteful).
 *   2. Direct dictionary query on the main CEP-18 contract — uses
 *      `state_get_dictionary_item` against the contract's `balances`
 *      NamedKey. Single RPC call, no deploy.
 *
 * We use path 2 (direct query on the main contract). The helper
 * contract is still useful for the JS SDK but the agent prefers
 * the direct path for efficiency.
 *
 * Falls back gracefully:
 *   - if X402_CEP18_PACKAGE_HASH is not set → returns null (no token deployed)
 *   - if the RPC is unreachable → returns last cached value
 *   - if the account is not in the balances dictionary → returns 0
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

let cachedMainContract: { contractHash: string; balancesUref: string; ts: number } | null = null;

/**
 * Discover the main cep18 contract's `balances` dictionary URef.
 * Cached for 30s.
 */
async function discoverMainContract(): Promise<{ contractHash: string; balancesUref: string } | null> {
  if (cachedMainContract && Date.now() - cachedMainContract.ts < 30_000) {
    return cachedMainContract;
  }
  if (!cfg.X402_CEP18_PACKAGE_HASH) {
    return null;
  }
  const pkgHash = cfg.X402_CEP18_PACKAGE_HASH.replace('hash-', '');

  try {
    // Package → version 1 → contract hash
    const pkgRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'query_global_state',
        params: { key: `hash-${pkgHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    const versions = pkgRes.data?.result?.stored_value?.ContractPackage?.versions;
    if (!versions || versions.length === 0) return null;
    const contractHash = versions[0].contract_hash.replace('contract-', '');

    // Contract → find the `balances` named key URef
    const conRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'query_global_state',
        params: { key: `hash-${contractHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    if (conRes.status !== 200) return null;
    const namedKeys = conRes.data?.result?.stored_value?.Contract?.named_keys;
    if (!namedKeys) return null;
    const balancesKey = namedKeys.find((k: any) => k.name === 'balances');
    if (!balancesKey) return null;

    cachedMainContract = { contractHash, balancesUref: balancesKey.key, ts: Date.now() };
    return cachedMainContract;
  } catch {
    return null;
  }
}

/**
 * Render an account hash (32 raw bytes) as the dictionary_item_key that
 * the cep18 main contract uses to index per-account balances.
 */
function accountHashToDictKey(accountHashHex: string): string {
  const hex = accountHashHex.replace(/^account-hash-/, '');
  return hex.padStart(64, '0').slice(-64);
}

/**
 * Public API: read the agent's CEP-18 token balance (in motes).
 */
export async function getAgentCep18Balance(
  agentAccountHashHex: string
): Promise<{ balance: string; source: 'on-chain' | 'cache' | 'none' | 'unconfigured' }> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { balance: cached.balance, source: 'cache' };
  }
  const main = await discoverMainContract();
  if (!main) {
    return { balance: '0', source: 'unconfigured' };
  }
  try {
    // Step 1: get the latest state_root_hash
    const srhRes = await axios.post(
      cfg.CASPER_RPC_URL,
      { jsonrpc: '2.0', id: 1, method: 'chain_get_state_root_hash', params: [] },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    const srh = srhRes.data?.result?.state_root_hash;
    if (!srh) return { balance: '0', source: 'none' };

    // Step 2: query the balances dictionary item for our account
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
              key: `hash-${main.contractHash}`,
              dictionary_name: 'balances',
              dictionary_item_key: itemKey,
            },
          },
        },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );

    if (dictRes.status !== 200) {
      console.log(`[balanceCheck] state_get_dictionary_item status: ${dictRes.status}, error: ${JSON.stringify(dictRes.data?.error).slice(0, 150)}`);
      return { balance: '0', source: 'none' };
    }
    const clv = dictRes.data?.result?.stored_value?.CLValue;
    const balance = String(clv?.parsed ?? '0');
    cached = { balance, ts: Date.now() };
    return { balance, source: 'on-chain' };
  } catch (e: any) {
    console.log(`[balanceCheck] error: ${e.message?.slice(0, 100)}`);
    return { balance: '0', source: 'none' };
  }
}

/**
 * Convenience: format motes as a human-readable decimal string.
 */
export function formatCep18Balance(motes: string, decimals = 9): string {
  const big = BigInt(motes);
  const factor = 10n ** BigInt(decimals);
  const whole = big / factor;
  const frac = big % factor;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
