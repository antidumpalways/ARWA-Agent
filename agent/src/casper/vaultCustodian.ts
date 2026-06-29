/**
 * Fund custodian client for the redesigned AgentVault (v0.8.1+).
 *
 * Wraps the 4 new entry points:
 *   - deposit_for_strategy(amount, source)
 *   - record_strategy_execution(kind, target, amount, opened_tx)
 *   - record_yield_realised(position_id, yield_amount, source_tx)
 *   - withdraw_for_strategy(amount, reason)
 *
 * Plus the read-side views:
 *   - get_custodied_cspr, get_total_custodied,
 *     get_total_yield_realised, get_position_count, get_position
 *
 * The AgentVault package hash is loaded from `ARWA_AGENT_VAULT_CONTRACT_HASH`
 * in .env. This is separate from `AGENT_VAULT_CONTRACT_HASH` which points
 * to the legacy RevenueEmitter package still used as the audit log.
 *
 * The actual CSPR transfers (in/out of the vault) happen via separate
 * native Transfer txs at the executor — this module only updates the
 * on-chain accounting to match.
 */
import { readFileSync } from 'fs';
import {
  ContractCallBuilder, Args, CLValue,
  PrivateKey, KeyAlgorithm,
} from 'casper-js-sdk';
import axios from 'axios';
import { loadConfig } from '../config';

const GAS_MOTES = '3000000000'; // 3 CSPR for entry-point calls

function pemKey(): PrivateKey {
  const cfg = loadConfig();
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  try { return PrivateKey.fromPem(pem, KeyAlgorithm.ED25519); }
  catch { return PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1); }
}

function pkgHex(): string {
  const cfg = loadConfig();
  const v = cfg.ARWA_AGENT_VAULT_CONTRACT_HASH;
  if (!v) {
    throw new Error(
      'ARWA_AGENT_VAULT_CONTRACT_HASH not set. Run deploy.ts first ' +
      'to deploy the redesigned AgentVault (v0.8.1+ fund custodian).'
    );
  }
  return v.replace('hash-', '');
}

async function callEntryPoint(
  entryPoint: string,
  argsMap: Record<string, CLValue>
): Promise<string> {
  const cfg = loadConfig();
  const sk = pemKey();
  const args = Args.fromMap(argsMap);

  const tx: any = new ContractCallBuilder()
    .byPackageHash(pkgHex(), 1)
    .entryPoint(entryPoint)
    .from(sk.publicKey)
    .chainName(cfg.CASPER_CHAIN_NAME)
    .runtimeArgs(args)
    .payment(Number(GAS_MOTES), 1)
    .ttl(1800000)
    .build();
  tx.sign(sk);

  const json = JSON.parse(JSON.stringify(tx));
  const r = await axios.post(cfg.CASPER_RPC_URL, {
    jsonrpc: '2.0',
    method: 'account_put_transaction',
    params: { transaction: { Version1: json } },
    id: 1,
  }, {
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}),
    },
    timeout: 60_000,
  });

  if (r.data.error) {
    throw new Error(`vault call ${entryPoint}: ${r.data.error.message}`);
  }
  return r.data.result?.transaction_hash?.Version1 ?? '';
}

/**
 * Record that the agent has moved `amount` CSPR into the vault for
 * active management. Returns the deploy hash.
 */
export async function depositForStrategy(
  amountMotes: string,
  source: string
): Promise<string> {
  return callEntryPoint('deposit_for_strategy', {
    amount: CLValue.newCLUInt256(BigInt(amountMotes)),
    source: CLValue.newCLString(source),
  });
}

/**
 * Record a new active position. Called after the agent executes a
 * delegate/LP/etc. tx on behalf of the vault.
 */
export async function recordStrategyExecution(
  kind: string,           // "validator_delegate" | "lp" | "sCSPR_swap"
  target: string,         // validator pubkey hex | pair address
  amountMotes: string,
  openedTx: string
): Promise<string> {
  return callEntryPoint('record_strategy_execution', {
    kind:      CLValue.newCLString(kind),
    target:    CLValue.newCLString(target),
    amount:    CLValue.newCLUInt256(BigInt(amountMotes)),
    opened_tx: CLValue.newCLString(openedTx),
  });
}

/**
 * Record realised yield from a position. Called when the agent claims
 * staking rewards or LP fees.
 */
export async function recordYieldRealised(
  positionId: number,
  yieldAmountMotes: string,
  sourceTx: string
): Promise<string> {
  return callEntryPoint('record_yield_realised', {
    position_id: CLValue.newCLUint64(BigInt(positionId)),
    yield_amount: CLValue.newCLUInt256(BigInt(yieldAmountMotes)),
    source_tx:    CLValue.newCLString(sourceTx),
  });
}

/**
 * Withdraw CSPR from the vault (e.g. close a position).
 */
export async function withdrawForStrategy(
  amountMotes: string,
  reason: string
): Promise<string> {
  return callEntryPoint('withdraw_for_strategy', {
    amount: CLValue.newCLUInt256(BigInt(amountMotes)),
    reason: CLValue.newCLString(reason),
  });
}

/**
 * Read-side: custodied CSPR (current amount held by vault) in motes.
 * Returns "0" on error so callers can gracefully degrade.
 */
export async function getCustodiedCspr(): Promise<string> {
  const cfg = loadConfig();
  const v = cfg.ARWA_AGENT_VAULT_CONTRACT_HASH;
  if (!v) return '0';
  try {
    const r = await axios.post(cfg.CASPER_RPC_URL, {
      jsonrpc: '2.0', id: 1,
      method: 'state_get_item',
      params: {
        state_root_hash: '0000000000000000000000000000000000000000000000000000000000000000',
        key: v,
        path: ['custodied_cspr'],
      },
    }, {
      headers: cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {},
      timeout: 15_000,
    });
    // CLValue bytes; return raw string for now (frontend formats).
    return r.data?.result?.stored_value?.CLValue?.parsed ?? '0';
  } catch {
    return '0';
  }
}

/** Cumulative yield realised by the vault, in motes. */
export async function getTotalYieldRealised(): Promise<string> {
  const cfg = loadConfig();
  const v = cfg.ARWA_AGENT_VAULT_CONTRACT_HASH;
  if (!v) return '0';
  try {
    const r = await axios.post(cfg.CASPER_RPC_URL, {
      jsonrpc: '2.0', id: 1,
      method: 'state_get_item',
      params: {
        state_root_hash: '0000000000000000000000000000000000000000000000000000000000000000000',
        key: v,
        path: ['total_yield_realised'],
      },
    }, {
      headers: cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {},
      timeout: 15_000,
    });
    return r.data?.result?.stored_value?.CLValue?.parsed ?? '0';
  } catch {
    return '0';
  }
}

/** Number of active + closed positions tracked by the vault. */
export async function getPositionCount(): Promise<number> {
  const cfg = loadConfig();
  const v = cfg.ARWA_AGENT_VAULT_CONTRACT_HASH;
  if (!v) return 0;
  try {
    const r = await axios.post(cfg.CASPER_RPC_URL, {
      jsonrpc: '2.0', id: 1,
      method: 'state_get_item',
      params: {
        state_root_hash: '0000000000000000000000000000000000000000000000000000000000000000000',
        key: v,
        path: ['position_count'],
      },
    }, {
      headers: cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {},
      timeout: 15_000,
    });
    return Number(r.data?.result?.stored_value?.CLValue?.parsed ?? 0);
  } catch {
    return 0;
  }
}