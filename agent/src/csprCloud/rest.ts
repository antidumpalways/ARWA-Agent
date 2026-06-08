/**
 * CSPR.cloud REST API client.
 *
 * Base URLs:
 *   - Mainnet: https://api.cspr.cloud
 *   - Testnet: https://api.testnet.cspr.cloud
 *
 * Auth: `Authorization: <api_key>` (raw token, no `Bearer` prefix per CSPR.cloud docs).
 *
 * Docs: https://docs.cspr.cloud
 */
import axios, { AxiosInstance } from 'axios';
import { loadConfig } from '../config';

let client: AxiosInstance | null = null;
export function getRest(): AxiosInstance {
  if (client) return client;
  const cfg = loadConfig();
  const baseURL =
    cfg.CASPER_NETWORK === 'casper'
      ? 'https://api.cspr.cloud'
      : 'https://api.testnet.cspr.cloud';
  client = axios.create({
    baseURL,
    timeout: 15_000,
    headers: {
      Authorization: cfg.CSPR_CLOUD_API_KEY,
      'Content-Type': 'application/json',
    },
  });
  return client;
}

// ---------- types ----------

export interface AccountInfo {
  public_key: string;
  balance: string;          // motes
  staked: string;
  delegations_count: number;
  transfers_count: number;
  account_hash: string;
}

export interface DeploySummary {
  deploy_hash: string;
  block_hash: string;
  timestamp: string;
  caller_public_key: string;
  contract_hash?: string;
  entry_point?: string;
  status: 'success' | 'failed' | 'pending';
  cost?: string;
}

export interface ContractStateResult {
  contract_hash: string;
  state: Record<string, any>;
  block_hash: string;
}

export interface TokenInfo {
  contract_package_hash: string;
  symbol: string;
  decimals: number;
  total_supply: string;
  holders: number;
}

// ---------- account ----------

export async function getAccountInfo(publicKey: string): Promise<AccountInfo> {
  const r = await getRest().get<{ data: AccountInfo }>(
    `/accounts/${encodeURIComponent(publicKey)}`
  );
  return r.data.data;
}

export async function getAccountBalance(publicKey: string): Promise<string> {
  const a = await getAccountInfo(publicKey);
  return a.balance;
}

export async function getAccountDeploys(
  publicKey: string,
  page = 1,
  perPage = 25
): Promise<{ data: DeploySummary[]; itemCount: number; pageCount: number }> {
  const r = await getRest().get(
    `/accounts/${encodeURIComponent(publicKey)}/deploys`,
    { params: { page, per_page: perPage } }
  );
  return r.data;
}

// ---------- contract state ----------

/**
 * Read a path of contract state via CSPR.cloud REST. Useful for reading
 * Odra contract variables like `total_assets`, `reputation_global`, etc.
 */
export async function getContractState(
  contractHash: string,
  statePath: string[]
): Promise<ContractStateResult> {
  const r = await getRest().get<{ data: ContractStateResult }>(
    `/contracts/${encodeURIComponent(contractHash)}/state`,
    { params: { path: statePath.join(',') } }
  );
  return r.data.data;
}

/**
 * Read a CLValue (typed) by path. Returns the raw stored value (hex / number / string).
 */
export async function getContractDictValue(
  contractHash: string,
  dictName: string,
  key: string
): Promise<any> {
  const r = await getRest().get<{ data: any }>(
    `/contracts/${encodeURIComponent(contractHash)}/dict`,
    { params: { name: dictName, key } }
  );
  return r.data.data;
}

// ---------- tokens (CEP-18 / CEP-47 / CEP-95) ----------

export async function getTokenInfo(
  contractPackageHash: string
): Promise<TokenInfo> {
  const r = await getRest().get<{ data: TokenInfo }>(
    `/tokens/${encodeURIComponent(contractPackageHash)}`
  );
  return r.data.data;
}

export async function getTokenBalance(
  contractPackageHash: string,
  holderPublicKey: string
): Promise<string> {
  const r = await getRest().get<{ data: string }>(
    `/tokens/${encodeURIComponent(contractPackageHash)}/holders/${encodeURIComponent(holderPublicKey)}/balance`
  );
  return r.data.data;
}

// ---------- blocks / network ----------

export async function getLatestBlock(): Promise<{ block_hash: string; height: number; timestamp: string }> {
  const r = await getRest().get<{ data: { block_hash: string; height: number; timestamp: string } }>(
    '/blocks/latest'
  );
  return r.data.data;
}

export async function getBlockHeight(): Promise<number> {
  const b = await getLatestBlock();
  return b.height;
}

// ---------- deploys ----------

export async function getDeploy(deployHash: string): Promise<DeploySummary> {
  const r = await getRest().get<{ data: DeploySummary }>(
    `/deploys/${encodeURIComponent(deployHash)}`
  );
  return r.data.data;
}

// ---------- high-level helpers used by the Agent ----------

/**
 * Read a single Odra contract value (string, number, or hex). Throws if the
 * path is empty.
 */
export async function readContractValue(
  contractHash: string,
  ...path: string[]
): Promise<any> {
  if (path.length === 0) throw new Error('path required');
  const r = await getContractState(contractHash, path);
  return r.state;
}
