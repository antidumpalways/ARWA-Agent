/**
 * Integration test for `runCycle` in `src/index.ts`.
 *
 * We mock the external dependencies (MCP, x402, Casper client) and assert
 * the wiring is correct: data flows Analyst → Executor and the cycle
 * returns the expected shape.
 */
import { runCycle } from '../src/index';
import { StrategyProposal, X402Proof } from '../src/types';

// Mock all external dependencies
jest.mock('../src/mcp/casperMcp');
jest.mock('../src/mcp/csprTradeMcp');
jest.mock('../src/x402/client');
jest.mock('../src/casper/signer');
jest.mock('../src/casper/vaultClient');
jest.mock('../src/agent/llmStrategy');
jest.mock('../src/executor');

import * as casperMcp from '../src/mcp/casperMcp';
import * as csprTradeMcp from '../src/mcp/csprTradeMcp';
import * as x402client from '../src/x402/client';
import * as signer from '../src/casper/signer';
import * as vaultClient from '../src/casper/vaultClient';
import * as llmStrategy from '../src/agent/llmStrategy';
import * as executor from '../src/executor';

const mockedGetAccountInfo = casperMcp.getAccountInfo as jest.Mock;
const mockedGetRecentRevenueEvents = casperMcp.getRecentRevenueEvents as jest.Mock;
const mockedGetQuote = csprTradeMcp.getQuote as jest.Mock;
const mockedGetPortfolioValue = csprTradeMcp.getPortfolioValue as jest.Mock;
const mockedPayAndFetch = x402client.payAndFetchViaX402 as jest.Mock;
const mockedGetVaultOverview = vaultClient.getVaultOverview as jest.Mock;
const mockedGetAgentKeys = signer.getAgentKeys as jest.Mock;
const mockedLogStrategy = vaultClient.logStrategyToVault as jest.Mock;
const mockedDecideStrategyWithLLM = llmStrategy.decideStrategyWithLLM as jest.Mock;
const mockedRunExecutor = executor.runExecutor as jest.Mock;

const SAMPLE_PROOF: X402Proof = {
  paymentHeader: 'casper-test:01abc:1000000:sig:nonce:1700000000:01pub',
  settleTxHash: '0xsettle',
  facilitator: 'https://x402-facilitator.cspr.cloud',
  amountMotes: '1000000',
  asset: 'hash-asset',
  signedAt: 1700000000,
};

const SAMPLE_PROPOSAL: Omit<StrategyProposal, 'x402Proof' | 'revenueEvent'> = {
  action: 'add_liquidity',
  pair: 'CSPR/sCSPR',
  tokenIn: 'CSPR',
  tokenOut: 'sCSPR',
  amountIn: '1000000000000',
  minAmountOut: '0',
  rationale: 'Low price impact + bullish signal',
  confidence: 87,
};

describe('runCycle integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockedGetAgentKeys.mockReturnValue({
      privateKey: {} as any,
      publicKey: { toHex: () => '01agent-pk-hex' } as any,
      algorithm: 1 as any,
    });

    mockedGetRecentRevenueEvents.mockResolvedValue([]);
    
    mockedGetAccountInfo.mockResolvedValue({
      publicKey: '01agent-pk-hex',
      balance: '5000000000000',
      staked: '0',
      delegations: 0,
      transfers: 0,
    });

    mockedGetQuote.mockResolvedValue({
      amountIn: '1000000000000',
      amountOut: '990000000000',
      priceImpact: '0.4%',
      route: ['CSPR', 'sCSPR'],
      minReceived: '985050000000',
      pair: 'CSPR/sCSPR',
      expiresAt: Date.now() + 60_000,
    });

    mockedGetPortfolioValue.mockResolvedValue({
      total: '12000000000000',
      breakdown: [],
    });

    mockedGetVaultOverview.mockResolvedValue({
      totalAssets: '12000000000000',
      globalReputation: 47,
      totalStrategies: 12,
    });

    mockedPayAndFetch.mockResolvedValue({
      data: { utilization_forecast: '+12% next 24h', confidence: 87 },
      proof: SAMPLE_PROOF,
      raw: {} as any,
    });

    // Default to heuristic path (no LLM_API_KEY in test env)
    delete process.env.LLM_API_KEY;
    mockedDecideStrategyWithLLM.mockResolvedValue(SAMPLE_PROPOSAL);

    mockedLogStrategy.mockResolvedValue({
      txHash: '0xvault-tx',
      outcome: 'success',
    });

    mockedRunExecutor.mockResolvedValue({
      txHash: '0xstrategy-tx',
      vaultResult: { txHash: '0xvault-tx', outcome: 'success' },
      proposal: SAMPLE_PROPOSAL as any,
    });
  });

  it('runs a full cycle Analyst → Executor and returns a structured result', async () => {
    const result = await runCycle({
      revenueEvent: {
        timestamp: 1735689600,
        amount: '1000000000000',
        asset: '0'.repeat(64),
        source: 'parking-lot-frontend',
        emitter: '0'.repeat(66),
        reference: 'cycle-test-001',
      },
      ownerAddress: '01agent-pk-hex',
    });

    expect(result.proposal).toBeDefined();
    expect(result.proposal.action).toBe('add_liquidity');
    expect(result.proposal.tokenIn).toBe('CSPR');
    expect(result.proposal.tokenOut).toBe('sCSPR');
    expect(result.proposal.x402Proof).toBe(SAMPLE_PROOF);

    expect(result.execution).toBeDefined();
    expect(result.execution!.txHash).toBe('0xstrategy-tx');
    expect(result.execution!.vaultResult.txHash).toBe('0xvault-tx');

    // Verify the order of calls
    expect(mockedGetAgentKeys).toHaveBeenCalled();
    expect(mockedGetAccountInfo).toHaveBeenCalledWith('01agent-pk-hex');
    expect(mockedGetQuote).toHaveBeenCalledWith('CSPR', 'sCSPR', '1000000000000', 'exact_in');
    expect(mockedPayAndFetch).toHaveBeenCalled();
    expect(mockedRunExecutor).toHaveBeenCalled();
  });

  it('passes through low-confidence → skips execution', async () => {
    // Force the LLM path so the mocked value is used (the heuristic ignores
    // the mock and computes its own confidence from the signal).
    process.env.LLM_API_KEY = 'test-key';
    mockedDecideStrategyWithLLM.mockResolvedValue({
      ...SAMPLE_PROPOSAL,
      confidence: 30, // below the 50 threshold
    });

    const result = await runCycle({
      revenueEvent: {
        timestamp: 1735689600,
        amount: '1000000000000',
        asset: '0'.repeat(64),
        source: 'parking-lot-frontend',
        emitter: '0'.repeat(66),
        reference: 'cycle-test-002',
      },
      ownerAddress: '01agent-pk-hex',
    });

    expect(result.proposal).toBeDefined();
    expect(result.execution).toBeNull(); // skipped
    expect(mockedRunExecutor).not.toHaveBeenCalled();
  });

  it('propagates x402 payment error', async () => {
    mockedPayAndFetch.mockRejectedValue(new Error('x402 402 from server'));

    await expect(
      runCycle({
        revenueEvent: {
          timestamp: 1735689600,
          amount: '1000000000000',
          asset: '0'.repeat(64),
          source: 'parking-lot-frontend',
          emitter: '0'.repeat(66),
          reference: 'cycle-test-003',
        },
        ownerAddress: '01agent-pk-hex',
      })
    ).rejects.toThrow(/x402/);
  });
});


