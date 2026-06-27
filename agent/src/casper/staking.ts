/**
 * Native Casper 2.0 staking — delegate CSPR to a validator.
 *
 * Three Casper-native ways to earn staking yield:
 *   1. **Validator auction bid** — operators only (not agents)
 *   2. **Native delegation**     — anyone delegates to a validator (THIS)
 *   3. **Liquid staking** (sCSPR) — covered by csprTradeMcp `build_swap`
 *
 * This module implements #2 via the SDK's `NativeDelegateBuilder`. It
 * builds a `Transaction` of type `Delegate`, signs it locally with the
 * agent's key, and submits via `account_put_transaction` RPC (the same
 * path already used for swaps and vault logs).
 *
 * Casper 2.0 chainspec unlocks the funds after the unbonding period
 * (~7 days on testnet). APY ~7-9% testnet, ~10-12% mainnet historical.
 *
 * Comparison with `build_swap → sCSPR`:
 *   - Native delegate:  higher APY (~+1-2%), 7-day unbond lock
 *   - Liquid sCSPR:     lower APY (~6-8%),   no lock (tradeable)
 *   - LP:               ~10-15% gross, IL risk, locked until remove
 */

import {
  NativeDelegateBuilder,
  NativeUndelegateBuilder,
  PublicKey,
  PrivateKey,
  KeyAlgorithm,
  RpcClient,
  HttpHandler,
} from 'casper-js-sdk';
import { readFileSync } from 'fs';
import axios from 'axios';
import { loadConfig } from '../config';
import { ExecutionResult } from '../types';

/**
 * Known active testnet validators (from `state_get_auction_info` 2026-06-27).
 * Used as fallback when the user has not configured `STAKING_VALIDATOR_PUBKEY`.
 *
 * For production, prefer reading the validator set from the auction and
 * picking by lowest `delegation_rate` (highest payout to delegators).
 */
const FALLBACK_TESTNET_VALIDATORS: string[] = [
  '01000019478b67d07c3adc460db360deef6c663ec55ba29db70b458e47022a3d81',
  '010003b919dfb5452365d62c59efbe424a604c419bb611d19df12c8355ff3a3bae',
  '0100047d1ac77bc5495dcbee707d38148d576a05d593f2e20bc272040b740df8e6',
];

/**
 * Build, sign, and submit a Casper 2.0 native delegate transaction.
 *
 * @param amountMotes CSPR amount in motes (1 CSPR = 1e9 motes)
 * @param validatorPubKeyHex optional validator pubkey; defaults to env or first fallback
 */
export async function delegateToValidator(
  amountMotes: string,
  validatorPubKeyHex?: string
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  const target = validatorPubKeyHex
    ?? process.env.STAKING_VALIDATOR_PUBKEY
    ?? FALLBACK_TESTNET_VALIDATORS[0];

  // Load agent key
  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const agentPk = sk.publicKey;

  // Build delegate transaction via SDK
  const validatorPk = PublicKey.fromHex(target);
  const tx = new NativeDelegateBuilder()
    .from(agentPk)
    .validator(validatorPk)
    .amount(amountMotes)
    .chainName(cfg.CASPER_CHAIN_NAME)
    .payment(2_500_000_000, 1) // 2.5 CSPR gas budget
    .ttl(1_800_000)             // 30 min
    .build();

  // Sign locally
  tx.sign(sk);

  // Submit via account_put_transaction (Casper 2.0 RPC)
  const json = JSON.parse(JSON.stringify(tx));
  const submitRes = await axios.post(cfg.CASPER_RPC_URL, {
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

  if (submitRes.data.error) {
    throw new Error(`RPC error: ${submitRes.data.error.message}: ${submitRes.data.error.data}`);
  }
  const txHash = submitRes.data.result?.transaction_hash?.Version1 ?? '';

  console.log(`[staking] delegated ${amountMotes} motes to validator ${target.slice(0, 12)}… tx=${txHash}`);
  return { txHash, outcome: 'success' };
}

/**
 * Withdraw (undelegate) CSPR from a validator. Starts the 7-day unbond
 * period; after that the funds are unlocked to the agent's purse.
 */
export async function undelegateFromValidator(
  amountMotes: string,
  validatorPubKeyHex?: string
): Promise<ExecutionResult> {
  const cfg = loadConfig();
  const target = validatorPubKeyHex
    ?? process.env.STAKING_VALIDATOR_PUBKEY
    ?? FALLBACK_TESTNET_VALIDATORS[0];

  const pem = readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8');
  let sk: PrivateKey;
  try {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.ED25519);
  } catch {
    sk = PrivateKey.fromPem(pem, KeyAlgorithm.SECP256K1);
  }
  const agentPk = sk.publicKey;
  const validatorPk = PublicKey.fromHex(target);

  const tx = new NativeUndelegateBuilder()
    .from(agentPk)
    .validator(validatorPk)
    .amount(amountMotes)
    .chainName(cfg.CASPER_CHAIN_NAME)
    .payment(2_500_000_000, 1)
    .ttl(1_800_000)
    .build();

  tx.sign(sk);
  const json = JSON.parse(JSON.stringify(tx));
  const submitRes = await axios.post(cfg.CASPER_RPC_URL, {
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

  if (submitRes.data.error) {
    throw new Error(`RPC error: ${submitRes.data.error.message}: ${submitRes.data.error.data}`);
  }
  const txHash = submitRes.data.result?.transaction_hash?.Version1 ?? '';

  console.log(`[staking] undelegated ${amountMotes} motes from validator ${target.slice(0, 12)}… tx=${txHash}`);
  return { txHash, outcome: 'success' };
}

/**
 * Fetch the current validator set (delegation rate, total stake) from
 * the Casper auction. Used by the analyst to rank validators by APY.
 */
export async function getAuctionValidators(): Promise<Array<{
  publicKey: string;
  delegationRate: number;
  stakedAmount: string;
  isActive: boolean;
}>> {
  const cfg = loadConfig();
  const handler = new HttpHandler(cfg.CASPER_RPC_URL);
  handler.setCustomHeaders(
    cfg.CSPR_CLOUD_API_KEY ? { Authorization: cfg.CSPR_CLOUD_API_KEY } : {}
  );
  const client = new RpcClient(handler);
  try {
    const auction: any = await client.getLatestAuctionInfo();
    const bids = auction?.auctionState?.bids ?? [];
    return bids.slice(0, 50).map((b: any) => ({
      publicKey: b.public_key?.toHex?.() ?? String(b.public_key),
      delegationRate: Number(b.delegation_rate ?? b.delegationRate ?? 0),
      stakedAmount: String(b.staked_amount ?? b.stakedAmount ?? '0'),
      isActive: !b.inactive,
    }));
  } catch (e: any) {
    console.warn('[staking] getAuctionInfo failed:', e?.message?.slice(0, 100));
    return FALLBACK_TESTNET_VALIDATORS.map(pk => ({
      publicKey: pk,
      delegationRate: 0,
      stakedAmount: '0',
      isActive: true,
    }));
  }
}

/**
 * Estimate APY for a validator given their delegation rate and recent
 * era rewards. Rough — based on the standard Casper reward curve.
 */
export function estimateValidatorApy(delegationRateBps: number): number {
  // Casper pays a base reward per era; validator takes `delegation_rate`
  // (bps). Delegator gets `1 - delegationRateBps/10000` of the gross.
  // Testnet base reward is ~8% annualized, mainnet ~10-12% historically.
  const BASE_APY = 8.0;
  const netApy = BASE_APY * (1 - delegationRateBps / 10_000);
  return Math.max(0, netApy);
}

export { FALLBACK_TESTNET_VALIDATORS };
