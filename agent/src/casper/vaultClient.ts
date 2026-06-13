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
 */
export async function logStrategyToVault(
  log: AgentVaultLog
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    throw new Error('AGENT_VAULT_CONTRACT_HASH not set. Run deploy script first.');
  }

  try {
    // Load agent key
    const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
    let sk: PrivateKey;
    try {
      sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
    } catch {
      sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
    }
    const pk = sk.publicKey;

    // Build args
    const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
    const clArgs = Args.fromMap({
      action: CLValue.newCLString(log.action),
      amount_in: CLValue.newCLUInt256(BigInt(log.amountIn)),
      amount_out: CLValue.newCLUInt256(BigInt(log.amountOut || '0')),
      token_in: buildKeyValue(log.tokenInHex || ZERO_ADDR),
      token_out: buildKeyValue(log.tokenOutHex || ZERO_ADDR),
      pair: CLValue.newCLString(log.pair),
      tx_hash: CLValue.newCLString(log.txHash),
      x402_proof: CLValue.newCLString(log.x402Proof),
      x402_signer: buildKeyValue(log.x402SignerHex || ZERO_ADDR),
      outcome: CLValue.newCLString(log.outcome),
    });

    // Build TransactionV1 via ContractCallBuilder (Casper 2.0 format)
    const pkgHex = cfg.AGENT_VAULT_CONTRACT_HASH.replace('hash-', '');
    const tx: any = new ContractCallBuilder()
      .byPackageHash(pkgHex, 1)  // Use package hash with version 1
      .entryPoint('execute_strategy')
      .from(pk)
      .chainName(cfg.CASPER_CHAIN_NAME)
      .runtimeArgs(clArgs)
      .payment(3000000000, 1)  // 3 CSPR, gas price 1
      .ttl(1800000)  // 30 minutes in milliseconds
      .build();  // Returns Transaction wrapper

    // Get TransactionV1 from the wrapper
    const txV1 = tx.getTransactionV1?.() || tx;
    
    // Sign
    txV1.sign(sk);
    
    // Build JSON for submission
    const json = TransactionV1.toJSON(txV1);
    
    // Submit via RPC
    const axios = require('axios');
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

    const txHash = response.data.result?.transaction_hash?.Version1 || '';
    
    return {
      txHash,
      outcome: 'success',
    };
  } catch (error: any) {
    console.error('[vault] execute_strategy failed:', error.message);
    return {
      txHash: 'failed',
      outcome: 'failed',
      blockHash: undefined,
    };
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
