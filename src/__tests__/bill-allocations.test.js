/**
 * Bill allocations: AllVoucher.xml keys (Billallocations/Billname/BillAmount) and Tally-native keys.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractBillAllocations, firstBillAllocation } from '../utils/billAllocations.js';

describe('extractBillAllocations', () => {
  it('reads AllVoucher.xml exploded allocations (single object and array)', () => {
    const r = {
      AllLedgerEntries: [
        {
          LEDGERNAME: 'Sharma Traders',
          ISPARTYLEDGER: 'Yes',
          Billallocations: [
            { Billname: 'INV-1', Billdate: '20260401', BillAmount: '(-)1000.00', BILLTYPE: 'Agst Ref' },
            { Billname: 'INV-2', BillAmount: '-500', BILLTYPE: 'Agst Ref' },
          ],
        },
        { LEDGERNAME: 'Bank', Billallocations: { Billname: 'X-1', BILLTYPE: 'New Ref', BillAmount: '1500' } },
        { LEDGERNAME: 'Cash' },
      ],
    };
    const out = extractBillAllocations(r);
    assert.equal(out.length, 3);
    assert.deepEqual(out[0], {
      ledger: 'Sharma Traders', name: 'INV-1', type: 'Agst Ref', amount: -1000, date: '20260401', isParty: true,
    });
    assert.equal(out[1].amount, -500);
    assert.equal(out[2].ledger, 'Bank');
  });

  it('reads Tally-native BILLALLOCATIONS with NAME/AMOUNT and drops duplicates and blanks', () => {
    const r = {
      ALLLEDGERENTRIES: {
        LEDGERNAME: 'Gupta & Co',
        BILLALLOCATIONS: [
          { NAME: 'S-9', BILLTYPE: 'New Ref', AMOUNT: '2500' },
          { NAME: 'S-9', BILLTYPE: 'New Ref', AMOUNT: '2500' },
          { NAME: '', BILLTYPE: 'On Account', AMOUNT: '10' },
        ],
      },
    };
    const out = extractBillAllocations(r);
    assert.equal(out.length, 1);
    assert.equal(out[0].name, 'S-9');
    assert.equal(out[0].amount, 2500);
  });

  it('returns nothing for stubs without ledger entries', () => {
    assert.deepEqual(extractBillAllocations({ GUID: 'g' }), []);
    assert.deepEqual(extractBillAllocations(null), []);
  });
});

describe('firstBillAllocation', () => {
  it('prefers the party ledger line', () => {
    const r = {
      AllLedgerEntries: [
        { LEDGERNAME: 'Bank', Billallocations: { Billname: 'B-1', BILLTYPE: 'New Ref', BillAmount: '10' } },
        { LEDGERNAME: 'Party', ISPARTYLEDGER: 'Yes', Billallocations: { Billname: 'P-1', BILLTYPE: 'Agst Ref', BillAmount: '(-)10' } },
      ],
    };
    assert.deepEqual(firstBillAllocation(r), { bill_ref_name: 'P-1', bill_type: 'Agst Ref', bill_allocated_amount: -10 });
  });

  it('is null when no allocation has a type', () => {
    assert.equal(firstBillAllocation({ AllLedgerEntries: [{ LEDGERNAME: 'A', Billallocations: { Billname: 'Z' } }] }), null);
  });
});
