/**
 * Outstanding bills: Dr/Cr side, due date from credit period, side-vs-group mismatch.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  billSide, creditDays, dueDateOf, isSideMismatch, effectiveDueDate, DEFAULT_CREDIT_DAYS,
} from '../utils/billOutstanding.js';

const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

describe('billSide', () => {
  it('trusts the signed pending amount first (negative = Dr)', () => {
    assert.equal(billSide({ SignedPending: '-1200.50', DrCr: 'Cr' }), 'Dr');
    assert.equal(billSide({ SignedPending: '(-)10', DrCr: 'Cr' }), 'Dr');
    assert.equal(billSide({ SignedPending: '500', DrCr: 'Dr' }), 'Cr');
  });

  it('falls back to the DrCr label, then the ledger group', () => {
    assert.equal(billSide({ DrCr: 'DR' }), 'Dr');
    assert.equal(billSide({ SignedPending: '', DrCr: 'cr' }), 'Cr');
    assert.equal(billSide({ LedgerGroup: 'Sundry Debtors' }), 'Dr');
    assert.equal(billSide({ LedgerGroup: 'Sundry Creditors (Local)' }), 'Cr');
    assert.equal(billSide({ LedgerGroup: 'Bank Accounts' }), null);
  });
});

describe('due dates', () => {
  it('parses day counts only', () => {
    assert.equal(creditDays('30 Days'), 30);
    assert.equal(creditDays('45'), 45);
    assert.equal(creditDays('1 day'), 1);
    assert.equal(creditDays('30-Apr-2026'), null);
    assert.equal(creditDays(''), null);
  });

  it('keeps an explicit due date, else adds the credit period to the bill date', () => {
    assert.equal(dueDateOf('2026-04-01', '2026-04-10', '30 Days'), '2026-04-10');
    assert.equal(dueDateOf('2026-03-15', null, '30 Days'), '2026-04-14');
    assert.equal(dueDateOf('2026-03-15', null, null), null);
    assert.equal(dueDateOf(null, null, '30'), null);
  });

  it('assumes the default credit period when Tally sends no due date', () => {
    assert.equal(effectiveDueDate('2026-04-10', '2026-04-01'), '2026-04-10');
    assert.equal(effectiveDueDate(null, '2026-09-01'), addDaysIso('2026-09-01', DEFAULT_CREDIT_DAYS));
    assert.equal(effectiveDueDate(null, null), null);
  });
});

describe('cash/bank chart window', () => {
  it('ends at the FY end (or today) and stays inside the FY', async () => {
    const { seriesWindow } = await import('../modules/kpi/cashBankService.js');
    assert.deepEqual(seriesWindow('2026-09-30', '2026-04-01', '2027-03-31'), { start: '2026-09-01', end: '2026-09-30' });
    assert.deepEqual(seriesWindow('2026-09-30', '2025-04-01', '2026-03-31'), { start: '2026-03-02', end: '2026-03-31' });
    assert.deepEqual(seriesWindow('2026-04-05', '2026-04-01', '2027-03-31'), { start: '2026-04-01', end: '2026-04-05' });
    assert.deepEqual(seriesWindow('2026-09-30', null, null), { start: '2026-09-01', end: '2026-09-30' });
  });

  it('walks a past window back from today\'s balance', async () => {
    const { buildDailyBalanceSeries } = await import('../modules/kpi/cashBankService.js');
    const moves = new Map([
      ['2026-03-31', { inflow: 100, outflow: 0 }],
      ['2026-05-10', { inflow: 1000, outflow: 200 }],
    ]);
    const s = buildDailyBalanceSeries(['2026-03-30', '2026-03-31'], moves, 5000, '2026-09-30');
    assert.deepEqual(s.map((d) => d.balance), [4100, 4200]);
  });
});

describe('isSideMismatch', () => {
  it('flags bills whose side disagrees with the party group', () => {
    assert.equal(isSideMismatch('Cr', 'Sundry Debtors'), true);
    assert.equal(isSideMismatch('DR', 'Sundry Creditors'), true);
    assert.equal(isSideMismatch('Dr', 'Sundry Debtors'), false);
    assert.equal(isSideMismatch('Cr', 'Bank Accounts'), false);
    assert.equal(isSideMismatch(null, 'Sundry Debtors'), false);
  });
});

describe('markOlderYearBills', () => {
  it('flags only unlinked bills dated before the earliest synced voucher', async () => {
    const { markOlderYearBills } = await import('../modules/ar-ap/arApService.js');
    const out = markOlderYearBills([
      { billDate: '2023-03-01', voucherGuid: null },
      { billDate: '2023-03-01', voucherGuid: 'g-1' },
      { billDate: '2024-05-01', voucherGuid: null },
      { billDate: null, voucherGuid: null },
    ], '2024-04-01');
    assert.deepEqual(out.map((b) => b.olderYear), [true, false, false, false]);
    assert.equal(markOlderYearBills([{ billDate: '2020-01-01' }], null)[0].olderYear, false);
  });
});
