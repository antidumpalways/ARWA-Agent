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
    // 1) Build unsigned deploy via CSPR.trade MCP
    const unsigned = await buildUnsignedDeploy({
      action: proposal.action === 'compound' ? 'add_liquidity' : (proposal.action as any),
      tokenIn: proposal.tokenIn,
      tokenOut: proposal.tokenOut,
      amountIn: proposal.amountIn,
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
  } catch (e: any) {
    console.log('[executor] build failed:', e.message?.slice(0, 150));
    deployHash = 'failed-' + Date.now().toString(36);
    outcome = 'failed';
  }

  // 4) Log to on-chain AgentVault (optional - may fail on Casper 2.0 testnet)
  // Use account hash (32 bytes = 64 hex chars), not public key hex
  const accountHashHex = publicKey.accountHash().toHex();
  const agentAddr = `account-hash-${accountHashHex}`;
  
  // Truncate x402 proof to fit Casper session args limit (max ~1024 chars for String)
  const x402ProofTruncated = (proposal.x402Proof?.paymentHeader ?? '').slice(0, 512);
  const x402SettleTruncated = (proposal.x402Proof?.settleTxHash ?? '').slice(0, 64);
  
  let vaultResult: ExecutionResult = { txHash: 'skipped', outcome: 'skipped' };
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
    vaultResult = { txHash: 'failed', outcome: 'skipped' };
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
