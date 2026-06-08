import { parsePaymentRequirements } from '../src/x402/client';
import { buildPaymentHeaderEnvelope, parsePaymentHeader } from '../src/x402/header';

describe('x402 payment header', () => {
  it('builds and parses a 7-field colon-delimited envelope', () => {
    const env = buildPaymentHeaderEnvelope({
      network: 'casper-test',
      payee: '01abc',
      amount: '1000000',
      signature: 'ed25519-sig-xyz',
      nonce: 'deadbeef',
      validUntil: 1735689600,
      payer: '01pub',
    });
    expect(env.split(':').length).toBe(7);

    const parsed = parsePaymentHeader(env);
    expect(parsed.network).toBe('casper-test');
    expect(parsed.payee).toBe('01abc');
    expect(parsed.amount).toBe('1000000');
    expect(parsed.signature).toBe('ed25519-sig-xyz');
    expect(parsed.nonce).toBe('deadbeef');
    expect(parsed.validUntil).toBe(1735689600);
    expect(parsed.payer).toBe('01pub');
  });

  it('parses 402 headers from a real-ish server', () => {
    const headers = {
      'x-payment-address': '01abc',
      'x-payment-amount': '5000000',
      'x-payment-network': 'casper',
      'x-payment-asset': 'hash-abcdef',
      'x-payment-nonce': 'cafebabe',
      'x-payment-valid-until': '1735689600',
    };
    const req = parsePaymentRequirements(headers);
    expect(req).toEqual({
      address: '01abc',
      amount: '5000000',
      network: 'casper',
      asset: 'hash-abcdef',
      nonce: 'cafebabe',
      validUntil: 1735689600,
      scheme: 'exact',
    });
  });

  it('returns null when required headers are missing', () => {
    expect(parsePaymentRequirements({ 'x-payment-address': '01abc' })).toBeNull();
    expect(parsePaymentRequirements({})).toBeNull();
  });
});
