import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('fundState cache', () => {
  let tmp: string;
  let savedCwd: string;

  beforeEach(() => {
    savedCwd = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), 'arwa-fundstate-'));
    process.env.ARWA_FUND_STATE_FILE = join(tmp, '.arwa-fund-state.json');
    jest.resetModules();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('starts with all-zero defaults', () => {
    const fs = require('../src/agent/fundState');
    const s = fs.getFundState();
    expect(s.positionsOpened).toBe(0);
    expect(s.custodianMotes).toBe('0');
    expect(s.stakeholderActiveMotes).toBe('0');
    expect(s.stakeholderDeposits).toBe(0);
  });

  it('recordStakeholderDeposit increments active + total by the deposit amount', () => {
    const fs = require('../src/agent/fundState');
    fs.recordStakeholderDeposit('100000000000');
    fs.recordStakeholderDeposit('50000000000');
    const s = fs.getFundState();
    expect(s.stakeholderDeposits).toBe(2);
    expect(s.stakeholderActiveMotes).toBe('150000000000');
    expect(s.stakeholderTotalMotes).toBe('150000000000');
  });

  it('recordCustodianDeposit accumulates AUM', () => {
    const fs = require('../src/agent/fundState');
    fs.recordCustodianDeposit('600000000000');
    fs.recordPositionOpened();
    fs.recordCustodianDeposit('250000000000');
    fs.recordPositionOpened();
    const s = fs.getFundState();
    expect(s.custodianMotes).toBe('850000000000');
    expect(s.positionsOpened).toBe(2);
  });

  it('recordYieldClaimed accumulates realised yield', () => {
    const fs = require('../src/agent/fundState');
    fs.recordYieldClaimed('7500000000');
    fs.recordYieldClaimed('2500000000');
    const s = fs.getFundState();
    expect(s.yieldRealisedMotes).toBe('10000000000');
    expect(s.positionsRealised).toBe(2);
  });

  it('recordStakeholderWithdrawal reduces active and increments withdrawn', () => {
    const fs = require('../src/agent/fundState');
    fs.recordStakeholderDeposit('100000000000');
    fs.recordStakeholderWithdrawal('30000000000');
    const s = fs.getFundState();
    expect(s.stakeholderActiveMotes).toBe('70000000000');
    expect(s.stakeholderWithdrawnMotes).toBe('30000000000');
  });

  it('recordStakeholderWithdrawal floors active at zero (no underflow)', () => {
    const fs = require('../src/agent/fundState');
    fs.recordStakeholderDeposit('10000000000');
    fs.recordStakeholderWithdrawal('50000000000');
    const s = fs.getFundState();
    expect(s.stakeholderActiveMotes).toBe('0');
  });

  it('persists across module reloads (forceReload=true)', () => {
    const fs1 = require('../src/agent/fundState');
    fs1.recordStakeholderDeposit('999000000000');
    jest.resetModules();
    const fs2 = require('../src/agent/fundState');
    const s = fs2.getFundState(true);
    expect(s.stakeholderActiveMotes).toBe('999000000000');
    expect(s.stakeholderDeposits).toBe(1);
  });

  it('resetFundState restores defaults', () => {
    const fs = require('../src/agent/fundState');
    fs.recordCustodianDeposit('500000000000');
    fs.resetFundState();
    const s = fs.getFundState(true);
    expect(s.custodianMotes).toBe('0');
    expect(s.positionsOpened).toBe(0);
  });
});
