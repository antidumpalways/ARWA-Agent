/**
 * ARWA — main orchestration.
 *
 * RevenueEvent → Analyst (MCP + x402) → StrategyProposal → Executor
 * (build deploy via MCP, sign, submit, log to AgentVault) → emit cycle result.
 */
import { runAnalyst } from './analyst';
import { runExecutor } from './executor';
import { loadConfig } from './config';
import { RevenueEvent } from './types';
import { getAgentCep18Balance, formatCep18Balance } from './casper/balanceCheck';
import { getAgentKeys } from './casper/signer';

export async function runCycle(input: {
  revenueEvent: RevenueEvent;
  ownerAddress: string;
}): Promise<{ proposal: any; execution: any; tokenBalance?: { balance: string; source: string; display: string } }> {
  const cfg = loadConfig();
  console.log('[cycle] start');

  // Read the agent's CEP-18 token balance (if a CEP-18 is configured).
  // Best-effort: if no token deployed or RPC fails, we still run the cycle.
  let tokenBalance: { balance: string; source: string; display: string } | undefined;
  try {
    const { publicKey } = getAgentKeys();
    const accountHash = publicKey.accountHash().toHex();
    const r = await getAgentCep18Balance(accountHash);
    const display = r.balance === '0' ? '0' : formatCep18Balance(r.balance, 9);
    tokenBalance = { balance: r.balance, source: r.source, display };
    console.log(`[cycle] CEP-18 balance: ${display} (${r.source})`);
  } catch (e: any) {
    console.log(`[cycle] CEP-18 balance check skipped: ${e.message?.slice(0, 60)}`);
  }

  const proposal = await runAnalyst({
    revenueEvent: input.revenueEvent,
    ownerAddress: input.ownerAddress,
    signalEndpoint: cfg.X402_SIGNAL_ENDPOINT,
    signalPriceMotes: '1000000',
  });

  if (proposal.confidence < 50) {
    console.log('[cycle] low confidence, skipping execution');
    return { proposal, execution: null, tokenBalance };
  }

  const execution = await runExecutor(proposal);
  console.log('[cycle] done');
  return { proposal, execution, tokenBalance };
}

if (require.main === module) {
  const cfg = loadConfig();
  runCycle({
    revenueEvent: {
      timestamp: Math.floor(Date.now() / 1000),
      amount: process.env.REVENUE_AMOUNT_MOTES ?? '1000000000000',
      asset: '0'.repeat(64),
      source: process.env.REVENUE_SOURCE ?? 'parking-lot-demo',
      emitter: cfg.AGENT_PUBLIC_KEY ?? '0'.repeat(66),
      reference: `cycle-${Date.now()}`,
    },
    ownerAddress: cfg.AGENT_PUBLIC_KEY ?? '',
  })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
