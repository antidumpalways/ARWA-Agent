import { parsePaymentRequirements } from '../src/x402/client';

describe('x402 v2 payment requirements', () => {
  it('parses a base64-encoded PAYMENT-REQUIRED header', () => {
    const reqs = {
      scheme: 'exact' as const,
      network: 'casper:casper-test',
      payTo: '0000000000000000000000000000000000000000000000000000000000000001',
      amount: '1000000',
      asset: 'a786a295384b6f39b6d62a97e12af776642253b37167f2a6c9b9410e8c93c775',
      maxTimeoutSeconds: 600,
      extra: { name: 'ARWA', version: '1', decimals: '9', symbol: 'CSPR' },
    };
    const b64 = Buffer.from(JSON.stringify(reqs), 'utf-8').toString('base64');
    const parsed = parsePaymentRequirements(b64);
    expect(parsed).toEqual(reqs);
  });

  it('returns null for malformed base64', () => {
    expect(parsePaymentRequirements('not-base64-json!@#')).toBeNull();
  });

  it('returns null for valid base64 but invalid JSON', () => {
    const b64 = Buffer.from('not json at all', 'utf-8').toString('base64');
    expect(parsePaymentRequirements(b64)).toBeNull();
  });

  it('requires payTo and asset in account-hash format', () => {
    const reqs = {
      scheme: 'exact',
      network: 'casper:casper-test',
      payTo: '0012345678901234567890123456789012345678901234567890123456789abcd',
      amount: '5000000',
      asset: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      maxTimeoutSeconds: 300,
    };
    const b64 = Buffer.from(JSON.stringify(reqs), 'utf-8').toString('base64');
    const parsed = parsePaymentRequirements(b64);
    expect(parsed?.payTo).toBe(reqs.payTo);
    expect(parsed?.asset).toBe(reqs.asset);
  });
});
