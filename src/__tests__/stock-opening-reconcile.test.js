import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ingest = readFileSync(new URL('../controllers/ingestProcessor.js', import.meta.url), 'utf8');
const reconcile = readFileSync(new URL('../utils/ingestPostReconcile.js', import.meta.url), 'utf8');
const complete = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');

describe('stock opening + voucher_type post-ingest reconcile', () => {
  it('SOURCE GUARD: complete hook calls opening reconcile and voucher_type backfill', () => {
    assert.match(complete, /reconcileStockOpeningsFromTransactions/);
    assert.match(complete, /backfillStockMovementVoucherTypes/);
    assert.doesNotMatch(
      complete,
      /if \(!voucherCount\) voucherCount = s\.vouchers/
    );
  });

  it('SOURCE GUARD: opening is summed from Opening Balance txs, not closing', () => {
    assert.match(reconcile, /voucher_type = 'Opening Balance'/);
    assert.match(reconcile, /SET opening_qty = src\.qty/);
    assert.match(reconcile, /opening_rate = src\.rate/);
    assert.match(reconcile, /opening_value = src\.value/);
    assert.doesNotMatch(reconcile, /opening_qty === 0/);
    assert.doesNotMatch(reconcile, /s\.closing_qty/);
  });

  it('SOURCE GUARD: movement voucher_type copies parent voucher only', () => {
    assert.match(reconcile, /SET voucher_type = v\.voucher_type/);
    assert.match(reconcile, /st\.voucher_guid = v\.guid/);
    assert.doesNotMatch(reconcile, /qty < 0/);
  });

  it('SOURCE GUARD: ingest processors call opening reconcile after masters/opening', () => {
    assert.match(ingest, /opening reconcile after stocks/);
    assert.match(ingest, /opening reconcile after StockOpening/);
  });
});
