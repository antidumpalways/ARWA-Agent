// Helpers for building the X-Payment header envelope.
// Kept separate from the high-level client (which depends on casper-eip-712)
// so the envelope shape is testable in isolation.

export interface PaymentHeaderFields {
  network: string;
  payee: string;
  amount: string;
  signature: string;
  nonce: string;
  validUntil: number;
  payer: string;
}

export function buildPaymentHeaderEnvelope(f: PaymentHeaderFields): string {
  // The Casper x402 facilitator expects a colon-delimited envelope.
  // See https://github.com/make-software/casper-x402.
  return [
    f.network,
    f.payee,
    f.amount,
    f.signature,
    f.nonce,
    String(f.validUntil),
    f.payer,
  ].join(':');
}

export function parsePaymentHeader(header: string): PaymentHeaderFields {
  const [network, payee, amount, signature, nonce, validUntil, payer] =
    header.split(':');
  return {
    network,
    payee,
    amount,
    signature,
    nonce,
    validUntil: Number(validUntil),
    payer,
  };
}
