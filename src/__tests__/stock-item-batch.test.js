/**
 * Create Item batch/expiry: opening stock goes into the named batch with Tally's expiry format.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStockItemBatch } from '../routes/tally-write.js';

describe('parseStockItemBatch', () => {
  it('is off when neither batch nor expiry is given', () => {
    assert.deepEqual(parseStockItemBatch('', ''), { on: false, name: '', expiryIso: null, expiryXml: '' });
  });

  it('builds the Tally expiry period from an ISO date', () => {
    const b = parseStockItemBatch(' B-101 ', '2027-03-05');
    assert.equal(b.on, true);
    assert.equal(b.name, 'B-101');
    assert.equal(b.expiryIso, '2027-03-05');
    assert.equal(b.expiryXml, '<EXPIRYPERIOD P="5-Mar-2027">5-Mar-2027</EXPIRYPERIOD>');
  });

  it('falls back to Primary Batch when only expiry is given', () => {
    assert.equal(parseStockItemBatch('', '2027-01-31').name, 'Primary Batch');
  });

  it('rejects impossible or non-ISO dates and very long names', () => {
    assert.ok(parseStockItemBatch('B1', '2027-02-30').error);
    assert.ok(parseStockItemBatch('B1', '31/01/2027').error);
    assert.ok(parseStockItemBatch('x'.repeat(101), '').error);
  });
});
