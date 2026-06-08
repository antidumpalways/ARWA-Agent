import { applySlippage } from '../src/agent/slippage';
import { buildAgentVaultLog } from '../src/agent/agentLog';

describe('slippage math', () => {
  it('subtracts 50 bps (0.5%)', () => {
    // 1,000,000 -> 995,000
    expect(applySlippage('1000000', 0.5)).toBe('995000');
  });

  it('subtracts 100 bps (1%)', () => {
    // 2,000,000 -> 1,980,000
    expect(applySlippage('2000000', 1)).toBe('1980000');
  });

  it('handles zero slippage', () => {
    expect(applySlippage('12345', 0)).toBe('12345');
  });

  it('handles very small amounts', () => {
    expect(applySlippage('100', 5)).toBe('95');
  });
});

describe('buildAgentVaultLog', () => {
  it('serializes a CSPR/sCSPR swap into the on-chain log shape', () => {
    const log = buildAgentVaultLog({
      action: 'swap',
      amountIn: '1000000000000',
      amountOut: '950000000000',
      tokenInHex: '01' + '0'.repeat(64),
      tokenOutHex: '01' + '0'.repeat(64),
      pair: 'CSPR/sCSPR',
      txHash: '0xdeadbeef',
      x402Proof: 'casper:01abc:1000000:sig:nonce:1700000000:01pub',
      x402SignerHex: '02' + '0'.repeat(64),
      outcome: 'success',
    });
    expect(log.action).toBe('swap');
    expect(log.tokenIn).toBe('01' + '0'.repeat(64));
    expect(log.tokenOut).toBe('01' + '0'.repeat(64));
    expect(log.outcome).toBe('success');
    expect(log.x402Proof).toContain('casper:');
  });

  it('preserves the x402 proof as-is', () => {
    const proof = 'casper-test:hash-abc:1000000:ed25519sig:nonce:1700000000:01pub';
    const log = buildAgentVaultLog({
      action: 'add_liquidity',
      amountIn: '500000000000',
      amountOut: '0',
      tokenInHex: '01' + '0'.repeat(64),
      tokenOutHex: '01' + '0'.repeat(64),
      pair: 'CSPR/sCSPR',
      txHash: '0xfeed',
      x402Proof: proof,
      x402SignerHex: '',
      outcome: 'success',
    });
    expect(log.x402Proof).toBe(proof);
    expect(log.x402Signer).toBe('');
  });
});
