/**
 * ARWA — live end-to-end demo.
 *
 * Bypasses CSPR.cloud REST (DNS-flaky in sandbox) and uses the Casper RPC
 * directly. Exercises:
 *   1. x402 client → local x402 server on :4001 (returns 402 with quote)
 *   2. Sign the x402 payment with the agent key (EIP-712-like Casper shape)
 *   3. POST with X-PAYMENT header → server returns signal
 *   4. Use a simple deterministic strategy (no LLM_API_KEY)
 *   5. Build + sign + submit execute_strategy to deployed AgentVault
 *   6. Poll Casper RPC for the deploy result
 *   7. Print explorer URL
 *
 * Usage:
 *   npx tsx scripts/demo-cycle.ts
 */
import { loadConfig } from '../src/config';
import { getAgentKeys, signAndSubmitDeploy, buildContractCallDeploy, getCasperClient } from '../src/casper/signer';
import { payAndFetchViaX402 } from '../src/x402/client';
import axios from 'axios';

interface DemoDecision {
  action: 'swap' | 'add_liquidity' | 'compound';
  pair: string;
  amountIn: string;
  amountOut: string;
  outcome: string;
  confidence: number;
}

function heuristicDecision(signal: any, amountIn: string): DemoDecision {
  const isBuy = (signal?.signal ?? 'buy') === 'buy';
  const confidence = Math.min(95, Math.max(55, signal?.confidence ?? 75));
  return {
    action: isBuy ? 'add_liquidity' : 'swap',
    pair: 'CSPR-sCSPR',
    amountIn,
    amountOut: isBuy ? amountIn : amountIn,
    outcome: isBuy ? 'liquidity_added' : 'swapped',
    confidence,
  };
}

async function main() {
  const cfg = loadConfig();
  console.log('═══ ARWA — live end-to-end demo ═══\n');
  console.log('Network:    ', cfg.CASPER_NETWORK);
  console.log('RPC:        ', cfg.CASPER_RPC_URL);
  console.log('AgentVault: ', cfg.AGENT_VAULT_CONTRACT_HASH);

  if (!cfg.AGENT_VAULT_CONTRACT_HASH) {
    throw new Error('AGENT_VAULT_CONTRACT_HASH not set in .env');
  }

  const { publicKey } = getAgentKeys();
  console.log('Agent key:  ', publicKey.toHex(), '\n');

  // Step 1+2+3: x402 round-trip
  console.log('── Step 1: x402 client → server on :4001');
  const x402Url = 'http://127.0.0.1:4001/signal?lot=parking-42';
  let signal: any = null;
  try {
    const resp = await payAndFetchViaX402<any>(x402Url);
    signal = resp.data?.signal ?? resp.data;
    console.log('  ✓ x402 server responded with signal');
    console.log('    body:', JSON.stringify(resp.data).slice(0, 200));
    if (resp.proof) {
      console.log('    proof:', JSON.stringify(resp.proof).slice(0, 200));
    }
    console.log('');
  } catch (e: any) {
    console.log('  ✗ x402 round-trip failed:', e.message);
    console.log('  (continuing with synthetic signal)\n');
    signal = { signal: 'buy', confidence: 78, price: 0.81, source: 'fallback' };
  }

  // Step 4: decide strategy
  console.log('── Step 2: strategy decision (heuristic, no LLM_API_KEY set)');
  const amountIn = '11000000000'; // 11 CSPR
  const decision = heuristicDecision(signal, amountIn);
  console.log('  ✓', JSON.stringify(decision, null, 2), '\n');
  if (decision.confidence < 50) {
    console.log('  ✗ confidence too low, aborting');
    return;
  }

  // Step 5: build + sign + submit execute_strategy
  console.log('── Step 3: submit execute_strategy to AgentVault');
  const ZERO_ADDR = `account-hash-${'0'.repeat(64)}`;
  const args: Record<string, { clType: string; value: any }> = {
    action:        { clType: 'string', value: decision.action },
    amount_in:     { clType: 'u256',   value: decision.amountIn },
    amount_out:    { clType: 'u256',   value: decision.amountOut },
    token_in:      { clType: 'key',    value: ZERO_ADDR },
    token_out:     { clType: 'key',    value: ZERO_ADDR },
    pair:          { clType: 'string', value: decision.pair },
    tx_hash:       { clType: 'string', value: 'demo-' + Date.now() },
    x402_proof:    { clType: 'string', value: signal?.source ?? 'demo' },
    x402_signer:   { clType: 'key',    value: ZERO_ADDR },
    outcome:       { clType: 'string', value: decision.outcome },
  };

  const deploy = buildContractCallDeploy(
    cfg.AGENT_VAULT_CONTRACT_HASH,
    'execute_strategy',
    args,
    cfg.CASPER_CHAIN_NAME
  );
  const { deployHash } = await signAndSubmitDeploy(deploy);

  // Query on-chain execution status via Casper RPC

  // Query on-chain execution status via Casper RPC. Casper 2.0 wraps the
  // result in `execution_info.execution_result.Version2` with a top-level
  // `error_message` (null = success, non-null = failure).
  console.log('  ✓ deploy hash:', deployHash);
  let success = false;
  let err: any = null;
  for (let i = 0; i < 30; i++) {
    try {
      const r: any = await axios.post(cfg.CASPER_RPC_URL, {
        jsonrpc: '2.0', id: 1, method: 'info_get_deploy',
        params: { deploy_hash: deployHash }
      }, { headers: { Authorization: cfg.CSPR_CLOUD_API_KEY }, timeout: 5000 });
      const ei = r?.data?.result?.execution_info;
      if (ei) {
        const v2 = ei.execution_result?.Version2 ?? ei.execution_result;
        const errorMessage = v2?.error_message;
        if (errorMessage === null || typeof errorMessage === 'string') {
          success = errorMessage === null;
          err = errorMessage;
          break;
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('  ✓ outcome:', success ? 'SUCCESS ✓' : `REVERTED ✗ (${err})`, '\n');

  console.log('═══ Demo complete ═══');
  console.log(`View on explorer: https://testnet.cspr.live/deploy/${deployHash ?? 'unknown'}`);
}

main().catch((e) => {
  console.error('Demo crashed:', e);
  process.exit(1);
});
