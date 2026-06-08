/**
 * ParkFlow Agent — main orchestration.
 *
 * RevenueEvent → Analyst (MCP + x402) → StrategyProposal → Executor
 * (build deploy via MCP, sign, submit, log to AgentVault) → emit cycle result.
 */
import { runAnalyst } from './analyst';
import { runExecutor } from './executor';
import { loadConfig } from './config';
import { RevenueEvent } from './types';

export async function runCycle(input: {
  revenueEvent: RevenueEvent;
  ownerAddress: string;
}): Promise<{ proposal: any; execution: any }> {
  const cfg = loadConfig();
  console.log('[cycle] start');

  const proposal = await runAnalyst({
    revenueEvent: input.revenueEvent,
    ownerAddress: input.ownerAddress,
    signalEndpoint: cfg.X402_SIGNAL_ENDPOINT,
    signalPriceMotes: '1000000',
  });

  if (proposal.confidence < 50) {
    console.log('[cycle] low confidence, skipping execution');
    return { proposal, execution: null };
  }

  const execution = await runExecutor(proposal);
  console.log('[cycle] done');
  return { proposal, execution };
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
