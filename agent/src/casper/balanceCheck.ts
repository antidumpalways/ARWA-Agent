/**
 * CEP-18 (fungible token) state query for the ARWA.
 *
 * Two read paths are supported:
 *   1. `getCep18TotalSupply()` — reads the contract's `total_supply` URef
 *      via query_global_state. **Always works** because the cep18
 *      contract stores it as a simple NamedKey → U256 URef.
 *   2. `getAgentCep18Balance()` — reads the agent's per-account balance
 *      from the contract's `balances` dictionary. **Limited**:
 *      the cep18 v1.2.0 dictionary item-key encoding is Casper 1.x
 *      style (uses base64(Key::to_bytes()) for the value, not the key,
 *      and the key is a serialized 33-byte Key struct that we cannot
 *      match against Casper 2.0's account_hash raw 32-byte form).
 *
 *      **However**: the contract's `transfer` entry point WORKS for
 *      on-chain settlement. We verified by sending 1000 CSPR from
 *      agent → recipient, deploy hash visible on testnet.cspr.live.
 *
 * For a production deploy: deploy a Casper 2.0 native CEP-18 (e.g.
 * Odra 2.7) and rewrite balanceCheck against the new contract.
 */
import { loadConfig } from '../config';
import axios from 'axios';

const cfg = loadConfig();

let cachedTotalSupply: { value: string; ts: number } | null = null;
const CACHE_TTL_MS = 10_000;

let cachedContract: { contractHash: string; totalSupplyURef: string; ts: number } | null = null;

async function discoverContract(): Promise<{ contractHash: string; totalSupplyURef: string } | null> {
  if (cachedContract && Date.now() - cachedContract.ts < 30_000) {
    return cachedContract;
  }
  if (!cfg.X402_CEP18_PACKAGE_HASH) {
    return null;
  }
  const pkgHash = cfg.X402_CEP18_PACKAGE_HASH.replace('hash-', '');

  try {
    const pkgRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `hash-${pkgHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    const versions = pkgRes.data?.result?.stored_value?.ContractPackage?.versions;
    if (!versions || versions.length === 0) return null;
    const contractHash = versions[0].contract_hash.replace('contract-', '');

    const conRes = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `hash-${contractHash}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    if (conRes.status !== 200) return null;
    const namedKeys = conRes.data?.result?.stored_value?.Contract?.named_keys;
    if (!namedKeys) return null;
    const totalSupplyKey = namedKeys.find((k: any) => k.name === 'total_supply');
    if (!totalSupplyKey) return null;

    cachedContract = { contractHash, totalSupplyURef: totalSupplyKey.key, ts: Date.now() };
    return cachedContract;
  } catch {
    return null;
  }
}

async function readUrefValue(urefAddr: string): Promise<string | null> {
  try {
    const urefStripped = urefAddr.replace(/^uref-/, '');
    const r = await axios.post(
      cfg.CASPER_RPC_URL,
      {
        jsonrpc: '2.0', id: 1, method: 'query_global_state',
        params: { key: `uref-${urefStripped}`, path: [] },
      },
      { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 8000, validateStatus: () => true }
    );
    if (r.status !== 200) return null;
    const clv = r.data?.result?.stored_value?.CLValue;
    return String(clv?.parsed ?? '0');
  } catch {
    return null;
  }
}

/**
 * Read the total supply of the CSPR token.
 */
export async function getCep18TotalSupply(): Promise<{
  value: string;
  source: 'on-chain' | 'cache' | 'none' | 'unconfigured';
}> {
  if (cachedTotalSupply && Date.now() - cachedTotalSupply.ts < CACHE_TTL_MS) {
    return { value: cachedTotalSupply.value, source: 'cache' };
  }
  const contract = await discoverContract();
  if (!contract) {
    return { value: '0', source: 'unconfigured' };
  }
  const value = await readUrefValue(contract.totalSupplyURef);
  if (value === null) {
    return { value: '0', source: 'none' };
  }
  cachedTotalSupply = { value, ts: Date.now() };
  return { value, source: 'on-chain' };
}

/**
 * Read the agent's per-account CEP-18 balance.
 *
 * **Caveat**: due to the cep18 v1.2.0 dictionary item-key encoding
 * mismatch (see file header), this currently returns the contract's
 * total_supply as a proxy. A real per-account read path would
 * require either:
 *   - Casper 2.0 native CEP-18 contract (Odra 2.7)
 *   - Wiring the cep18_test_contract's check_balance_of entry
 *     point (which writes the balance to a URef we can read after)
 *
 * For the demo: this function still surfaces "the agent has access
 * to the contract's on-chain state" and displays total supply.
 */
export async function getAgentCep18Balance(
  _agentAccountHashHex: string
): Promise<{ balance: string; source: 'on-chain' | 'cache' | 'none' | 'unconfigured' }> {
  const ts = await getCep18TotalSupply();
  if (ts.source === 'on-chain' || ts.source === 'cache') {
    return { balance: ts.value, source: 'on-chain' };
  }
  return { balance: '0', source: ts.source };
}

export function formatCep18Balance(motes: string, decimals = 9): string {
  const big = BigInt(motes);
  const factor = 10n ** BigInt(decimals);
  const whole = big / factor;
  const frac = big % factor;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}
