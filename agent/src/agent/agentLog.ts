// Builds the on-chain `execute_strategy` argument shape from a high-level
// proposal result. Kept separate from the executor so the mapping is unit-
// testable.

import { AgentVaultLog } from '../types';

/**
 * Convert the executor's internal call to the on-chain shape expected by
 * `AgentVault::execute_strategy` in `contracts/odra/agent_vault/src/agent_vault.rs`.
 *
 * The hex strings must be 32-byte hex (with optional `01`/`02` key-prefix for
 * Casper AccountHash/PackageHash).
 */
export function buildAgentVaultLog(args: {
  action: string;
  amountIn: string;
  amountOut: string;
  tokenInHex: string;
  tokenOutHex: string;
  pair: string;
  txHash: string;
  x402Proof: string;
  x402SignerHex: string;
  outcome: string;
}): AgentVaultLog {
  return {
    action: args.action,
    amountIn: args.amountIn,
    amountOut: args.amountOut,
    tokenIn: args.tokenInHex,
    tokenOut: args.tokenOutHex,
    pair: args.pair,
    txHash: args.txHash,
    x402Proof: args.x402Proof,
    x402Signer: args.x402SignerHex,
    outcome: args.outcome,
  };
}
