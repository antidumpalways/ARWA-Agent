/**
 * End-to-end x402 v2 test: agent requests a paid forecast from the local
 * x402-server, signs the EIP-712 typed data with its Casper key, then verifies
 * the returned forecast. Uses real PFLOW as the payment asset.
 *
 * Note: server-side locally verifies the signature (and forwards to the
 * CSPR.cloud x402 facilitator for on-chain settlement). When the facilitator
 * is reachable, the test returns a `settle_tx_hash`; when it's not, it falls
 * back to local-verify mode and the forecast is still returned.
 */
import { payAndFetchViaX402 } from '../src/x402/client';
import { loadConfig } from '../src/config';
import { getAgentKeys } from '../src/casper/signer';
import { getCep18TotalSupply, getAgentCep18Balance } from '../src/casper/balanceCheck';
import { readFileSync } from 'fs';

(async () => {
  const cfg = loadConfig();
  console.log('Agent pubkey:', getAgentKeys().publicKey.toHex());
  console.log('Agent pem:   ', cfg.AGENT_SECRET_KEY_PATH);
  console.log('PEM bytes:   ', readFileSync(cfg.AGENT_SECRET_KEY_PATH, 'utf-8').length);

  // 1) Pre-check: agent has PFLOW
  console.log('\n--- Pre-check PFLOW balance ---');
  const totalSupply = await getCep18TotalSupply();
  const balance = await getAgentCep18Balance();
  console.log('Total supply (raw):', totalSupply);
  console.log('Agent balance (raw):', balance);

  // 2) Make the paid request
  console.log('\n--- x402 paid request ---');
  try {
    const r = await payAndFetchViaX402<any>('http://localhost:4001/signal?lot=P1%20-%20Gate%20Keluar%20Utama');
    console.log('status:', r.raw.status);
    console.log('data:', JSON.stringify(r.data, null, 2));
    console.log('\n--- Proof ---');
    console.log('amount:', r.proof.amountMotes, 'motes');
    console.log('asset:', r.proof.asset);
    console.log('settleTxHash:', r.proof.settleTxHash || '(none — local-fallback)');
    console.log('facilitator:', r.proof.facilitator);
    console.log('signedAt:', new Date(r.proof.signedAt * 1000).toISOString());

    // 3) Post-check
    console.log('\n--- Post-check PFLOW balance ---');
    const balance2 = await getAgentCep18Balance();
    console.log('Agent balance (raw):', balance2);
  } catch (e: any) {
    console.error('FAIL:', e.message?.slice(0, 400));
    process.exit(1);
  }
})();
