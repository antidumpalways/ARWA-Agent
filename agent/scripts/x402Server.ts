/**
 * Tiny x402-protected signal server for the hackathon demo.
 *
 * Listens on PORT, exposes:
 *   GET /signal?lot=parking-42   → 402 + payment requirements (1st request)
 *                                    200 + JSON signal (with X-Payment header)
 *
 * For a real deployment, integrate the official @x402-foundation/x402
 * middleware (https://github.com/x402-foundation/x402) with a Casper
 * facilitator. This is a minimal hand-rolled version to show the protocol.
 *
 * Run with: npm run x402-server
 */
import express from 'express';
import crypto from 'crypto';

const app = express();
app.use(express.json());

const PORT = Number(process.env.PORT ?? 4001);
const PRICE_MOTES = process.env.SIGNAL_PRICE_MOTES ?? '1000000';
// The `asset` is the EIP-712 `verifyingContract` in the domain. It must be
// either 20 bytes (40 hex) or 33 bytes (66 hex). The demo's default is the
// zero Address (= zero hash with an Account tag byte = 33 bytes).
const ASSET = process.env.X402_CEP18_PACKAGE_HASH ?? '0'.repeat(66);
const PAYEE = process.env.X402_PAYEE_ADDRESS ?? '0'.repeat(66);

// very small proof validator for demo
function validatePayment(header: string | undefined): boolean {
  if (!header) return false;
  const parts = header.split(':');
  if (parts.length < 7) return false;
  const [, payee, amount, sig, nonce, validUntil, payer] = parts;
  if (payee !== PAYEE) return false;
  if (amount !== PRICE_MOTES) return false;
  if (Number(validUntil) < Math.floor(Date.now() / 1000)) return false;
  if (!sig || sig.length < 32) return false;
  if (!nonce || nonce.length < 8) return false;
  if (!payer || payer.length < 10) return false;
  return true;
}

function paymentRequired(res: express.Response) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const validUntil = Math.floor(Date.now() / 1000) + 600;
  res.status(402)
    .set('X-Payment-Address', PAYEE)
    .set('X-Payment-Amount', PRICE_MOTES)
    .set('X-Payment-Network', process.env.CASPER_NETWORK ?? 'casper-test')
    .set('X-Payment-Asset', ASSET)
    .set('X-Payment-Nonce', nonce)
    .set('X-Payment-Valid-Until', String(validUntil))
    .json({
      error: 'Payment Required',
      paymentRequirements: {
        address: PAYEE,
        amount: PRICE_MOTES,
        asset: ASSET,
        nonce,
        validUntil,
        scheme: 'exact',
      },
    });
}

app.get('/signal', (req, res) => {
  const lot = String(req.query.lot ?? 'unknown');
  const payment = req.header('X-Payment') || req.header('x-payment');
  if (!validatePayment(payment)) {
    return paymentRequired(res);
  }
  // synthetic but reproducible signal
  const hour = new Date().getUTCHours();
  const baseUtil = 60 + (hour % 12) * 2;
  const noise = Math.floor(Math.random() * 10) - 5;
  res.json({
    lot,
    utilization_forecast: `${baseUtil + noise}% expected utilization next 24h`,
    confidence: Math.min(99, 70 + Math.floor(Math.random() * 25)),
    price_motes: PRICE_MOTES,
    valid_for_seconds: 300,
    model: 'parkflow-v1-demo',
  });
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`[x402-server] listening on http://localhost:${PORT}`);
  console.log(`  signal price: ${PRICE_MOTES} motes`);
  console.log(`  payee: ${PAYEE}`);
});
