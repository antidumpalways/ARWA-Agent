/**
 * Executor Agent
 *
 * Takes a StrategyProposal, builds the deploy via CSPR.trade MCP, signs
 * locally with the agent's key, submits to Casper, then logs the decision
 * to the on-chain AgentVault.
 */
import { buildUnsignedDeploy } from './mcp/csprTradeMcp';
import { logStrategyToVault } from './casper/vaultClient';
import { loadConfig } from './config';
import { ExecutionResult, StrategyProposal } from './types';
import { Deploy } from 'casper-js-sdk';

export async function runExecutor(
  proposal: StrategyProposal
): Promise<{ txHash: string; vaultResult: ExecutionResult; proposal: StrategyProposal }> {
  console.log('[executor] proposal', proposal.action, proposal.pair, proposal.amountIn);
  const cfg = loadConfig();
  const { publicKey } = await import('./casper/signer').then(m => m.getAgentKeys());

  // 1) Build unsigned deploy via CSPR.trade MCP
  const unsigned = await buildUnsignedDeploy({
    action: proposal.action === 'compound' ? 'add_liquidity' : (proposal.action as any),
    tokenIn: proposal.tokenIn,
    tokenOut: proposal.tokenOut,
    amountIn: proposal.amountIn,
    minAmountOut: proposal.minAmountOut,
    payerAddress: publicKey.toHex(),
  });

  // 2) Convert to Deploy object (casper-js-sdk v5)
  const deploy = Deploy.fromJSON(unsigned);

  // 3) Sign and submit
  const { signAndSubmitDeploy } = await import('./casper/signer');
  const { deployHash, result } = await signAndSubmitDeploy(deploy);
  console.log('[executor] strategy tx', deployHash, 'success=',
    !!(result?.execution_results?.[0]?.result?.Success ?? result?.executionResults?.[0]?.result?.Success));

  const outcome = (result?.execution_results?.[0]?.result?.Success ?? result?.executionResults?.[0]?.result?.Success) ? 'success' : 'reverted';

  // 4) Log to on-chain AgentVault. The contract wants `Address` (= Key) for
  //    the token fields, so we pass the agent's account hash. The string
  //    tokenIn/tokenOut are kept in the log too (for human-readable UI).
  const agentAddr = `account-hash-${publicKey.toHex()}`;
  const vaultResult = await logStrategyToVault({
    action: proposal.action,
    amountIn: proposal.amountIn,
    amountOut: proposal.minAmountOut,
    tokenIn: proposal.tokenIn,
    tokenOut: proposal.tokenOut,
    tokenInHex: agentAddr,
    tokenOutHex: agentAddr,
    pair: proposal.pair,
    txHash: deployHash,
    x402Proof: proposal.x402Proof?.paymentHeader ?? '',
    x402Signer: proposal.x402Proof?.settleTxHash ?? '',
    x402SignerHex: agentAddr,
    outcome,
  });
  console.log('[executor] vault log tx', vaultResult.txHash, vaultResult.outcome);

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
