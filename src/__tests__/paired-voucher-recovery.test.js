import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planPairedVoucher } from '../routes/tally-write.js';

// Regression cover for the 2026-08-21 finding: a Sales invoice whose first Tally push was
// deferred posted via retryOfflineEntries with its paired Receipt silently dropped.
// planPairedVoucher is what the recovery path uses to decide a paired voucher is still owed.

test('sales with collect_payment owes a receipt', () => {
  const plan = planPairedVoucher('sales', {
    date: '2026-08-21',
    companyName: 'Acme',
    partyLedger: 'Manish ai services',
    collect_payment: { mode: 'neft', amount: 35405900, ledgerName: 'IDFC FIRST Bank' },
  });
  assert.equal(plan.childType, 'receipt');
  assert.equal(plan.bankLedger, 'IDFC FIRST Bank');
  assert.equal(plan.amount, 35405900);
  assert.equal(plan.paymentMethod, 'neft');
  // No instrument and no reference in the payload — must stay null rather than become {}
  assert.equal(plan.instrument, null);
});

test('purchase with make_payment owes a payment', () => {
  const plan = planPairedVoucher('purchase', {
    make_payment: { mode: 'cheque', amount: 5000, ledgerName: 'SBI', reference: '004521' },
  });
  assert.equal(plan.childType, 'payment');
  assert.deepEqual(plan.instrument, { instrumentNo: '004521' });
  assert.equal(plan.reference, '004521');
});

test('accepts a JSON string payload as stored in write_queue', () => {
  const plan = planPairedVoucher('sales', JSON.stringify({
    collect_payment: { amount: '1043870', ledgerName: 'Cash' },
  }));
  assert.equal(plan.childType, 'receipt');
  assert.equal(plan.amount, 1043870);
});

test('optional parent produces an optional child', () => {
  const plan = planPairedVoucher('sales', {
    isOptional: true,
    collect_payment: { amount: 100, ledgerName: 'Cash' },
  });
  assert.equal(plan.isOptional, true);
});

test('owes nothing when Collect Payment Now was not used', () => {
  assert.equal(planPairedVoucher('sales', { items: [] }), null);
  assert.equal(planPairedVoucher('sales', {}), null);
  assert.equal(planPairedVoucher('sales', null), null);
});

test('owes nothing on a zero, negative or unparsable amount', () => {
  assert.equal(planPairedVoucher('sales', { collect_payment: { amount: 0, ledgerName: 'Cash' } }), null);
  assert.equal(planPairedVoucher('sales', { collect_payment: { amount: -5, ledgerName: 'Cash' } }), null);
  assert.equal(planPairedVoucher('sales', { collect_payment: { amount: 'abc', ledgerName: 'Cash' } }), null);
});

test('owes nothing when the bank/cash ledger is missing', () => {
  assert.equal(planPairedVoucher('sales', { collect_payment: { amount: 500 } }), null);
});

test('does not cross-wire the two payment directions', () => {
  // A sales payload must not be satisfied by make_payment, nor purchase by collect_payment.
  assert.equal(planPairedVoucher('sales', { make_payment: { amount: 500, ledgerName: 'Cash' } }), null);
  assert.equal(planPairedVoucher('purchase', { collect_payment: { amount: 500, ledgerName: 'Cash' } }), null);
});

test('entry types without a paired voucher are ignored', () => {
  for (const t of ['receipt', 'payment', 'journal', 'contra', 'stock_transfer', 'proforma', 'credit_note']) {
    assert.equal(
      planPairedVoucher(t, { collect_payment: { amount: 500, ledgerName: 'Cash' } }),
      null,
      `${t} must not spawn a paired voucher`
    );
  }
});

test('malformed JSON payload owes nothing (does not throw)', () => {
  assert.equal(planPairedVoucher('sales', '{not-json'), null);
});

test('lowercase cash/neft mode still plans a receipt (mode only affects bank alloc)', () => {
  const cash = planPairedVoucher('sales', {
    collect_payment: { mode: 'cash', amount: 100, ledgerName: 'Cash' },
  });
  const neft = planPairedVoucher('sales', {
    collect_payment: { mode: 'neft', amount: 200, ledgerName: 'IDFC FIRST Bank' },
  });
  assert.equal(cash.childType, 'receipt');
  assert.equal(cash.paymentMethod, 'cash');
  assert.equal(neft.childType, 'receipt');
  assert.equal(neft.paymentMethod, 'neft');
});
