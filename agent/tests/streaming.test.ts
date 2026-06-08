import {
  StreamEnvelope,
  parseStreamEnvelope,
  filterByContract,
  filterByContractAndEvent,
} from '../src/csprCloud/streaming';

const sampleEnvelope: StreamEnvelope = {
  action: 'emitted',
  data: {
    contract_hash: 'hash-abc',
    event_name: 'StrategyExecuted',
    data: { action: 'swap', pair: 'CSPR/sCSPR' },
  },
  timestamp: '2026-06-07T10:00:00Z',
  extra: { deploy_hash: '0xdeploy' },
};

describe('CSPR.cloud streaming envelope', () => {
  it('parses a well-formed envelope', () => {
    const json = JSON.stringify(sampleEnvelope);
    const parsed = parseStreamEnvelope(json);
    expect(parsed).toEqual(sampleEnvelope);
  });

  it('returns null for malformed JSON', () => {
    expect(parseStreamEnvelope('not json')).toBeNull();
  });

  it('returns null for an envelope missing required fields', () => {
    expect(parseStreamEnvelope(JSON.stringify({ action: 'created' }))).toBeNull();
  });

  it('filterByContract keeps only events for the given contract', () => {
    const other: StreamEnvelope = {
      ...sampleEnvelope,
      data: { ...sampleEnvelope.data, contract_hash: 'hash-other' },
    };
    const out = [sampleEnvelope, other].filter(filterByContract('hash-abc'));
    expect(out.length).toBe(1);
    expect(out[0].data.contract_hash).toBe('hash-abc');
  });

  it('filterByContract is case-insensitive', () => {
    const upper: StreamEnvelope = {
      ...sampleEnvelope,
      data: { ...sampleEnvelope.data, contract_hash: 'HASH-ABC' },
    };
    expect(filterByContract('hash-abc')(upper)).toBe(true);
  });

  it('filterByContractAndEvent narrows further', () => {
    const otherEvent: StreamEnvelope = {
      ...sampleEnvelope,
      data: { ...sampleEnvelope.data, event_name: 'RevenueEmitted' },
    };
    const out = [sampleEnvelope, otherEvent].filter(
      filterByContractAndEvent('hash-abc', 'StrategyExecuted')
    );
    expect(out.length).toBe(1);
  });
});
