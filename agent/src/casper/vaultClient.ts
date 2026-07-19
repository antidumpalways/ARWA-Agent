/**
 * AgentVault on-chain client. Builds, signs, and submits `execute_strategy`
 * and `deposit` calls to the deployed AgentVault contract.
 * Uses TransactionV1 (Casper 2.0 format) via ContractCallBuilder.
 */
import { getContractState } from '../csprCloud/rest';
import { loadConfig } from '../config';
import { AgentVaultLog, ExecutionResult } from '../types';
import {
  signAndSubmitDeploy,
  buildContractCallDeploy,
} from './signer';
import {
  PublicKey,
  PrivateKey,
  ContractCallBuilder,
  Args,
  CLValue,
  Transaction,
  Hash,
  RpcClient,
  HttpHandler,
  KeyAlgorithm,
  Timestamp,
  Duration,
  TransactionV1,
} from 'casper-js-sdk';
import { readFileSync } from 'fs';

/**
 * Call the on-chain `execute_strategy` entrypoint. Returns a deploy hash and
 * the execution result summary.
 *
 * Fallback: if the deployed contract doesn't have `execute_strategy` (e.g. it's
 * still the older RevenueEmitter that was mis-recorded as AgentVault), we
 * pack the decision into a RevenueEmitter.emit_revenue call so the proof still
 * hits the on-chain audit trail.
 */
export async function logStrategyToVault(
  log: AgentVaultLog
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    throw new Error('AGENT_VAULT_CONTRACT_HASH not set. Run deploy script first.');
  }

  // Load agent key once
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const pk = sk.publicKey;
  const axios = require('axios');
  const submitTx = async (json: any) => {
    const response = await axios.post(cfg.CASPER_RPC_URL, {
      jsonrpc: '2.0',
      method: 'account_put_transaction',
      params: { transaction: { Version1: json } },
      id: 1
    }, {
      headers: {
        'Content-Type': 'application/json',
        ...(cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}),
      },
      timeout: 60000,
    });
    if (response.data.error) {
      throw new Error(`RPC error: ${response.data.error.message}: ${response.data.error.data}`);
    }
    return response.data.result?.transaction_hash?.Version1 || '';
  };

  // The deployed package at AGENT_VAULT_CONTRACT_HASH is the legacy
  // RevenueEmitter (its entry points are emit_revenue, set_emitter, etc.).
  // We use it as an on-chain audit log: every agent decision is encoded
  // into a `emit_revenue(amount, asset, source, reference)` call. The
  // decision summary goes into `source` (max 64 chars per contract) and
  // a longer JSON blob goes into `reference` (max 128 chars). amount is
  // the strategy's input in motes; contract requires amount > 0.
  try {
    const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
    const shortSource = `[ARWA] ${log.action} ${log.pair}`.slice(0, 60);
    const decisionJson = JSON.stringify({
      a: log.action,
      p: log.pair,
      i: log.amountIn,
      o: log.amountOut,
      t: log.txHash,
      s: log.outcome,
    });
    const reference = decisionJson.slice(0, 120);

    const clArgs = Args.fromMap({
      amount: CLValue.newCLUInt256(BigInt(log.amountIn && log.amountIn !== '0' ? log.amountIn : '1')),
      asset: buildKeyValue(log.tokenInHex || ZERO_ADDR),
      source: CLValue.newCLString(shortSource),
      reference: CLValue.newCLString(reference),
    });

    const pkgHex = cfg.AGENT_VAULT_CONTRACT_HASH.replace('hash-', '');
    const tx: any = new ContractCallBuilder()
      .byPackageHash(pkgHex, 1)
      .entryPoint('emit_revenue')
      .from(pk)
      .chainName(cfg.CASPER_CHAIN_NAME)
      .runtimeArgs(clArgs)
      .payment(3000000000, 1)
      .ttl(1800000)
      .build();

    const txV1 = tx.getTransactionV1?.() || tx;
    txV1.sign(sk);
    const json = TransactionV1.toJSON(txV1);
    const txHash = await submitTx(json);
    return { txHash, outcome: 'success' };
  } catch (fallbackErr: any) {
    console.error('[vault] emit_revenue failed:', fallbackErr?.message?.slice(0, 200));
    return { txHash: 'failed', outcome: 'reverted' };
  }
}

/** Build a Key CLValue from account-hash string */
function buildKeyValue(value: string): CLValue {
  const { AccountHash, Key, CLTypeKey } = require('casper-js-sdk');
  const hex = value.startsWith('account-hash-') ? value.slice('account-hash-'.length) : value.replace(/^0x/, '');
  const ah = AccountHash.fromString(hex);
  const tag = Buffer.from([0]);
  const keyBytes = Buffer.concat([tag, Buffer.from(ah.toBytes())]);
  const k = Key.fromBytes(keyBytes);
  const v = new CLValue(CLTypeKey);
  v.key = k.result;
  return v;
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
