/**
 * AgentVault on-chain client. Builds, signs, and submits `execute_strategy`
 * and `deposit` calls to the deployed AgentVault contract.
 */
import { getContractState } from '../csprCloud/rest';
import { loadConfig } from '../config';
import { AgentVaultLog, ExecutionResult } from '../types';
import {
  buildContractCallDeploy,
  signAndSubmitDeploy,
  getCasperClient,
} from './signer';

/**
 * Call the on-chain `execute_strategy` entrypoint. Returns a deploy hash and
 * the execution result summary.
 */
export async function logStrategyToVault(
  log: AgentVaultLog
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    throw new Error('AGENT_VAULT_CONTRACT_HASH not set. Run deploy script first.');
  }

  // The contract expects snake_case named args of types:
  //   action, pair, tx_hash, x402_proof, outcome: String
  //   amount_in, amount_out: U256
  //   token_in, token_out, x402_signer: Address (= Key, tag 0 + 32 bytes)
  //
  // For the demo, we use the **zero address** for `token_in`/`token_out` since
  // we don't have real CEP-18 tokens deployed. The string-typed names from
  // the analyst ("CSPR", "sCSPR") are kept in `pair` for human readability.
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  const args: Record<string, { clType: string; value: any }> = {
    action:        { clType: 'string',   value: log.action },
    amount_in:     { clType: 'u256',     value: log.amountIn },
    amount_out:    { clType: 'u256',     value: log.amountOut },
    token_in:      { clType: 'key',     value: log.tokenInHex || ZERO_ADDR },
    token_out:     { clType: 'key',     value: log.tokenOutHex || ZERO_ADDR },
    pair:          { clType: 'string',   value: log.pair },
    tx_hash:       { clType: 'string',   value: log.txHash },
    x402_proof:    { clType: 'string',   value: log.x402Proof },
    x402_signer:   { clType: 'key',     value: log.x402SignerHex || ZERO_ADDR },
    outcome:       { clType: 'string',   value: log.outcome },
  };

  const deploy = buildContractCallDeploy(
    cfg.AGENT_VAULT_CONTRACT_HASH,
    'execute_strategy',
    args,
    cfg.CASPER_CHAIN_NAME
  );
  const { deployHash, result } = await signAndSubmitDeploy(deploy);
  return {
    txHash: deployHash,
    outcome: outcomeFromDeployResult(result),
    blockHash: result?.block_hash ?? result?.blockHash,
  };
}

/**
 * Deposit CSPR to the vault. Caller must attach the right amount via the
 * payment field. The contract uses `#[odra(payable)] deposit()` so passing
 * CSPR is the right shape.
 */
export async function depositToVault(amountMotes: string): Promise<ExecutionResult> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    throw new Error('AGENT_VAULT_CONTRACT_HASH not set. Run deploy script first.');
  }
  const args = {}; // deposit takes no args
  const deploy = buildContractCallDeploy(
    cfg.AGENT_VAULT_CONTRACT_HASH,
    'deposit',
    args,
    cfg.CASPER_CHAIN_NAME,
    amountMotes
  );
  const { deployHash, result } = await signAndSubmitDeploy(deploy);
  return { txHash: deployHash, outcome: outcomeFromDeployResult(result) };
}

function outcomeFromDeployResult(r: any): 'success' | 'reverted' {
  // New SDK shape varies; try several paths
  const er = r?.execution_results?.[0]?.result ?? r?.executionResults?.[0]?.result;
  if (!er) return 'reverted';
  if (er.Success || er.success) return 'success';
  if (er.Failure || er.failure) return 'reverted';
  return 'reverted';
}

/**
 * Read global reputation for an agent. Uses CSPR.cloud REST — no local node needed.
 */
export async function getVaultReputation(agent: string): Promise<number> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) return 0;
  const r = await getContractState(cfg.AGENT_VAULT_CONTRACT_HASH, ['get_reputation', agent]);
  return Number((r.state as any)?.value ?? (r.state as any) ?? 0);
}

export async function getVaultOverview(): Promise<{
  totalAssets: string;
  globalReputation: number;
  totalStrategies: number;
}> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    return { totalAssets: '0', globalReputation: 0, totalStrategies: 0 };
  }
  const [ta, gr, ts] = await Promise.all([
    getContractState(cfg.AGENT_VAULT_CONTRACT_HASH, ['get_total_assets']),
    getContractState(cfg.AGENT_VAULT_CONTRACT_HASH, ['get_global_reputation']),
    getContractState(cfg.AGENT_VAULT_CONTRACT_HASH, ['get_total_strategies']),
  ]);
  return {
    totalAssets: String((ta.state as any)?.value ?? (ta.state as any) ?? '0'),
    globalReputation: Number((gr.state as any)?.value ?? (gr.state as any) ?? 0),
    totalStrategies: Number((ts.state as any)?.value ?? (ts.state as any) ?? 0),
  };
}
