/**
 * TallyDekho — Debit Note (Purchase Return) unit tests
 *
 * Pure pieces of POST /tally/voucher/debit-note:
 *   - prepareDebitNoteLines()
 *   - buildDebitNoteXml()
 *   - isPurchaseInvoiceRow()
 *
 * Run with: node --test src/__tests__/debit-note.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDebitNoteXml, prepareDebitNoteLines } from '../routes/tally-write.js';
import { isPurchaseInvoiceRow } from '../utils/debitNoteContext.js';

const invoice = { guid: 'pi-guid-1', voucher_number: 'PI-100', party_name: 'ABC Traders' };

const makeContext = (overrides = {}) => ({
  linkedInvoice: {
    invoiceGuid: 'pi-guid-1',
    voucherNumber: 'PI-100',
    billRefName: 'PI-100',
    billRefCandidates: ['PI-100'],
    tdkRef: null,
    partyLedger: 'ABC Traders',
  },
  items: [
    {
      itemName: 'Maize 4794 TL 1KG', unit: 'nos', hsn: '1209', godown: 'Main Location', batch: 'Primary Batch',
      rate: 155, soldQty: 50, soldAmount: 7750, netTaxablePerUnit: 155, discount: 0, gstRate: 5,
      returnedSyncedQty: 0, returnedPendingQty: 0, previouslyReturnedQty: 0, remainingQty: 50,
    },
  ],
  invoicePurchaseLedgers: [{ ledgerName: 'Purchase Account GST', amount: 7750 }],
  companyPurchaseLedgers: [{ ledgerName: 'Purchase Account GST' }, { ledgerName: 'Purchase Return' }],
  defaultPurchaseLedger: 'Purchase Account GST',
  taxes: [{ ledgerName: 'GST', taxAmount: 387.5, taxRate: 5 }],
  gst: { taxableAmount: 7750, cgstAmount: 0, sgstAmount: 0, igstAmount: 0 },
  totals: { itemsTotal: 7750, purchaseLedgerTotal: 7750, salesLedgerTotal: 7750 },
  ...overrides,
});

test('prepareDebitNoteLines — accepts return and resolves purchaseLedger', () => {
  const out = prepareDebitNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 10, rate: 155 }],
    taxes: [],
    context: makeContext(),
    invoice,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.items[0].qty, 10);
  assert.equal(out.items[0].purchaseLedger, 'Purchase Account GST');
  assert.equal(out.itemsTotal, 1550);
  assert.equal(out.taxTotal, 77.5);
});

test('prepareDebitNoteLines — rejects over-return', () => {
  const out = prepareDebitNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 51 }],
    taxes: [],
    context: makeContext(),
    invoice,
  });
  assert.match(out.error, /Cannot return/);
});

test('prepareDebitNoteLines — rejects non-purchase ledger', () => {
  const out = prepareDebitNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 1, purchaseLedger: 'Seed Sale A\\C' }],
    taxes: [],
    context: makeContext(),
    invoice,
  });
  assert.match(out.error, /not a Purchase ledger/);
});

test('buildDebitNoteXml — header and GST nature', () => {
  const xml = buildDebitNoteXml({
    companyName: 'Demo Co',
    date: '2026-08-06',
    voucherNumber: '',
    reference: 'TDK-DBN-2026-0001',
    narration: 'Purchase return',
    partyLedger: 'ABC Traders',
    items: [{
      itemName: 'Maize 4794 TL 1KG', qty: 10, rate: 155, amount: 1550,
      unit: 'nos', godown: 'Main Location', batch: 'Primary Batch',
      purchaseLedger: 'Purchase Account GST',
    }],
    taxes: [{ ledgerName: 'GST', taxAmount: 77.5, taxableValue: 1550 }],
    billRefName: 'PI-100',
    partyAmount: 1627.5,
  });
  assert.match(xml, /VCHTYPE="Debit Note"/);
  assert.match(xml, /<GSTNATUREOFRETURN>02-Purchase Return<\/GSTNATUREOFRETURN>/);
  assert.match(xml, /OBJVIEW="Invoice Voucher View"/);
  assert.match(xml, /<REFERENCE>TDK-DBN-2026-0001<\/REFERENCE>/);
  // Party Dr negative
  assert.match(xml, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>[\s\S]*<LEDGERNAME>ABC Traders<\/LEDGERNAME>[\s\S]*<AMOUNT>-1627\.5<\/AMOUNT>/);
  // Inventory Cr positive
  assert.match(xml, /<STOCKITEMNAME>Maize 4794 TL 1KG<\/STOCKITEMNAME>[\s\S]*<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>[\s\S]*<AMOUNT>1550<\/AMOUNT>/);
  assert.match(xml, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
  assert.match(xml, /<NAME>PI-100<\/NAME>/);
});

test('isPurchaseInvoiceRow — accepts Purchase, rejects order / sales', () => {
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Purchase', voucher_type: 'Purchase' }), true);
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Purchase GST' }), true);
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Purchase', voucher_type: 'Purchase Order' }), true); // parent wins
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Purchase Order' }), false);
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Sales', voucher_type: 'Sales' }), false);
  assert.equal(isPurchaseInvoiceRow({ voucher_type_parent: 'Debit Note', voucher_type: 'Debit Note' }), false);
});
