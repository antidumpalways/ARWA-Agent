/**
 * Executor Agent
 *
 * Takes a StrategyProposal, builds the deploy via CSPR.trade MCP, signs
 * locally with the agent's key, submits to Casper, then logs the decision
 * to the on-chain AgentVault.
 *
 * Uses self-hosted CSPR.trade MCP for testnet (http://localhost:3001/mcp)
 * or mainnet endpoint (https://mcp.cspr.trade/mcp) for production.
 */
import { buildUnsignedDeploy } from './mcp/csprTradeMcp';
import { logStrategyToVault } from './casper/vaultClient';
import {
  depositForStrategy, recordStrategyExecution, recordYieldRealised,
  withdrawForStrategy, getCustodiedCspr, getTotalYieldRealised,
  getPositionCount,
} from './casper/vaultCustodian';
import { delegateToValidator, undelegateFromValidator } from './casper/staking';
import { recordStrategyOutcome, updatePortfolioSnapshot } from './agent/riskGuard';
import { loadConfig } from './config';
import { ExecutionResult, StrategyProposal } from './types';

export async function runExecutor(
  proposal: StrategyProposal
): Promise<{ txHash: string; vaultResult: ExecutionResult; proposal: StrategyProposal }> {
  console.log('[executor] proposal', proposal.action, proposal.pair, proposal.amountIn);
  const cfg = loadConfig();
  const { publicKey } = await import('./casper/signer').then(m => m.getAgentKeys());

  let deployHash = '';
  let outcome = 'failed';

  // Build and submit real swap via CSPR.trade MCP (self-hosted for testnet)
  try {
    // HOLD path: if the circuit breaker forced a hold, skip the swap
    // entirely. The vault log below still records the skip on-chain.
    if (proposal.amountIn === '0' || proposal.pair === 'HOLD') {
      console.log('[executor] HOLD: skipping swap, recording skip on audit log');
      deployHash = 'hold-' + Date.now().toString(36);
      outcome = 'skipped';
      throw new Error('hold-short-circuit');
    }

    // STAKE path: native Casper 2.0 delegation to a validator.
    // Uses SDK's NativeDelegateBuilder (no MCP needed).
    if (proposal.action === 'stake') {
      let validatorPk = proposal.validatorPubKey;
      // Defensive: if analyst returned undefined (or string "undefined"
      // from a JSON roundtrip), fall back to the first known validator.
      if (!validatorPk || validatorPk === 'undefined') {
        const { FALLBACK_TESTNET_VALIDATORS } = await import('./casper/staking');
        validatorPk = FALLBACK_TESTNET_VALIDATORS[0];
        console.warn('[executor] stake validatorPubKey missing, using fallback');
      }
      // Defense in depth: bail out before submitting if amount is below
      // the Casper testnet minimum (otherwise we waste 2.5 CSPR on a
      // guaranteed revert with DelegationAmountTooSmall [64557]).
      const { MIN_STAKE_MOTES } = await import('./casper/staking');
      const amountBig = BigInt(proposal.amountIn || '0');
      if (amountBig < MIN_STAKE_MOTES) {
        const msg = `stake amount ${proposal.amountIn} motes < ${MIN_STAKE_MOTES} min`;
        console.warn(`[executor] ${msg} — refusing to submit`);
        throw new Error(msg);
      }
      const result = await delegateToValidator(
        proposal.amountIn,
        validatorPk
      );
      deployHash = result.txHash;
      outcome = result.outcome === 'success' ? 'success' : 'reverted';
      console.log('[executor] stake tx', deployHash, outcome);

      // v0.8.1+: record this validator-delegate position in the new
      // AgentVault (fund custodian). Non-critical.
      if (outcome === 'success' && proposal.validatorPubKey) {
        try {
          const posTx = await recordStrategyExecution(
            'validator_delegate',
            proposal.validatorPubKey,
            proposal.amountIn,
            deployHash
          );
          console.log('[executor] vault stake position opened', posTx);
        } catch (e: any) {
          console.warn('[executor] vault stake position record failed:',
            e?.message?.slice(0, 100));
        }
      }

      throw new Error('stake-handled'); // skip the MCP path below
    }

    // CSPR.trade MCP build_swap bug: it multiplies amount by 10^9 internally,
    // treating input as already-CSPR value then converting to motes again.
    // Compensate by dividing our motes input by 10^9 so the on-chain value
    // matches the intended CSPR amount.
    const mcpAmountIn = (BigInt(proposal.amountIn) / BigInt(10 ** 9)).toString();
    console.log('[executor] amountIn scaled', proposal.amountIn, '->', mcpAmountIn, '(MCP 10^9 multiplier bug workaround)');

    // 1) Build unsigned deploy via CSPR.trade MCP
    const unsigned = await buildUnsignedDeploy({
      action: proposal.action === 'compound' ? 'add_liquidity' : (proposal.action as any),
      tokenIn: proposal.tokenIn,
      tokenOut: proposal.tokenOut,
      amountIn: mcpAmountIn,
      minAmountOut: proposal.minAmountOut,
      payerAddress: publicKey.toHex(),
    });

    // 2) Sign using SDK's TransactionV1 (SDK handles correct hash computation)
    const { signAndSubmitSwap } = await import('./casper/signer');
    const result = await signAndSubmitSwap(unsigned as Record<string, any>);

    deployHash = result.deployHash;
    const success = result.success;
    console.log('[executor] strategy tx', deployHash, 'success=', success);
    outcome = success ? 'success' : 'reverted';

    // v0.8.1+: record this position in the redesigned AgentVault
    // (fund custodian). Non-critical — if it fails, we still log
    // success in the audit log below.
    if (success && proposal.action !== 'hold') {
      try {
        const kind = proposal.action === 'stake' ? 'validator_delegate'
          : proposal.action === 'add_liquidity' ? 'lp'
          : proposal.action === 'swap' ? 'sCSPR_swap'
          : 'other';
        const target = proposal.action === 'stake' && proposal.validatorPubKey
          ? proposal.validatorPubKey
          : proposal.pair;
        const posTx = await recordStrategyExecution(
          kind, target, proposal.amountIn, deployHash
        );
        console.log('[executor] vault position opened', posTx);
      } catch (e: any) {
        console.warn('[executor] vault position record failed (non-critical):',
          e?.message?.slice(0, 100));
      }
    }
  } catch (e: any) {
    if (e?.message === 'stake-handled') {
      // success — fall through to vault log
    } else if (e?.message === 'hold-short-circuit') {
      // success — fall through to vault log
    } else {
      console.log('[executor] build failed:', e.message?.slice(0, 150));
      deployHash = 'failed-' + Date.now().toString(36);
      outcome = 'failed';
    }
  }

  // 4) Log to on-chain AgentVault (optional - may fail on Casper 2.0 testnet)
  // Use account hash (32 bytes = 64 hex chars), not public key hex
  const accountHashHex = publicKey.accountHash().toHex();
  const agentAddr = `account-hash-${accountHashHex}`;

  // 3b) Record outcome with the risk guard (drives circuit breaker state)
  try {
    recordStrategyOutcome({
      outcome: outcome === 'success' ? 'success' : outcome === 'reverted' ? 'reverted' : 'failed',
    });
    // For successful swaps, update the portfolio snapshot to the new
    // value (CSPR-out amount). This is a rough estimate — the agent
    // does not currently fetch live portfolio from CSPR.trade MCP here.
    if (outcome === 'success') {
      updatePortfolioSnapshot(proposal.minAmountOut || proposal.amountIn);
    }
  } catch (e: any) {
    console.warn('[executor] risk guard update failed (non-critical):', e?.message?.slice(0, 80));
  }
  
  // Truncate x402 proof to fit Casper session args limit (max ~1024 chars for String)
  const x402ProofTruncated = (proposal.x402Proof?.paymentHeader ?? '').slice(0, 512);
  const x402SettleTruncated = (proposal.x402Proof?.settleTxHash ?? '').slice(0, 64);
  
  let vaultResult: ExecutionResult = { txHash: 'skipped', outcome: 'reverted' };
  try {
    vaultResult = await logStrategyToVault({
      action: proposal.action,
      amountIn: proposal.amountIn,
      amountOut: proposal.minAmountOut,
      tokenIn: proposal.tokenIn,
      tokenOut: proposal.tokenOut,
      tokenInHex: agentAddr,
      tokenOutHex: agentAddr,
      pair: proposal.pair,
      txHash: deployHash,
      x402Proof: x402ProofTruncated,
      x402Signer: x402SettleTruncated,
      x402SignerHex: agentAddr,
      outcome,
    });
    console.log('[executor] vault log tx', vaultResult.txHash, vaultResult.outcome);
  } catch (e: any) {
    console.warn('[executor] vault logging failed (non-critical):', e.message?.slice(0, 120));
    vaultResult = { txHash: 'failed', outcome: 'reverted' };
  }

  return { txHash: deployHash, vaultResult, proposal };
}

if (require.main === module) {
  const sample: StrategyProposal = {
    action: 'add_liquidity',
    pair: 'CSPR/sCSPR',
    tokenIn: 'CSPR',
    tokenOut: 'sCSPR',
    amountIn: process.env.AMOUNT_IN ?? '1000000000000',
    minAmountOut: '0',
    rationale: 'manual test',
    confidence: 90,
    x402Proof: null,
    revenueEvent: {
      timestamp: 0, amount: '0', asset: '0'.repeat(64),
      source: 'manual', emitter: '0'.repeat(66), reference: 'manual',
    },
  };
  runExecutor(sample)
    .then(r => console.log('[executor] done', r.txHash))
    .catch(e => { console.error(e); process.exit(1); });
}
