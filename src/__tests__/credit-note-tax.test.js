/**
 * Credit Note GST reversal unit tests (pure calc module).
 * Run: node --test src/__tests__/credit-note-tax.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calcCreditNoteReturn,
  buildTaxGeometry,
  RETURN_TAX_WITH_GST,
  RETURN_TAX_WITHOUT_GST,
} from '../utils/creditNoteTax.js';

const local18Context = () => ({
  items: [{
    itemName: 'Product A',
    soldQty: 10,
    soldAmount: 10000,
    rate: 1000,
    netTaxablePerUnit: 1000,
    discount: 0,
    gstRate: 18,
    remainingQty: 10,
  }],
  taxes: [
    { ledgerName: 'CGST', taxAmount: 900, taxRate: 9 },
    { ledgerName: 'SGST', taxAmount: 900, taxRate: 9 },
  ],
  gst: { taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, igstAmount: 0 },
  totals: { itemsTotal: 10000, salesLedgerTotal: 10000 },
});

test('buildTaxGeometry — WITH_GST local and item_rate when gstRate present', () => {
  const g = buildTaxGeometry(local18Context());
  assert.equal(g.returnTaxMode, RETURN_TAX_WITH_GST);
  assert.equal(g.allocationMode, 'item_rate');
  assert.equal(g.isInterstate, false);
});

test('buildTaxGeometry — WITHOUT_GST when invoice has no tax', () => {
  const g = buildTaxGeometry({
    items: [{ itemName: 'Exempt', soldQty: 5, soldAmount: 500, rate: 100, gstRate: null }],
    taxes: [],
    gst: null,
    totals: { itemsTotal: 500 },
  });
  assert.equal(g.returnTaxMode, RETURN_TAX_WITHOUT_GST);
  assert.equal(g.allocationMode, 'none');
});

test('buildTaxGeometry — rates without tax ledgers fall back to proportional via gst details', () => {
  const g = buildTaxGeometry({
    items: [{ itemName: 'Product A', soldQty: 10, soldAmount: 10000, rate: 1000, gstRate: 18 }],
    taxes: [],
    gst: { taxableAmount: 10000, cgstAmount: 900, sgstAmount: 900, igstAmount: 0 },
    totals: { itemsTotal: 10000 },
  });
  assert.equal(g.returnTaxMode, RETURN_TAX_WITH_GST);
  assert.equal(g.allocationMode, 'proportional');
  assert.equal(g.fallbackUsed, true);
});

test('calcCreditNoteReturn — local 18% return of 2 units', () => {
  const out = calcCreditNoteReturn({
    context: local18Context(),
    returnLines: [{ itemName: 'Product A', qty: 2 }],
  });
  assert.equal(out.itemsTotal, 2000);
  assert.equal(out.taxTotal, 360);
  assert.equal(out.totalAmount, 2360);
  const cgst = out.taxes.find(t => /cgst/i.test(t.ledgerName));
  const sgst = out.taxes.find(t => /sgst/i.test(t.ledgerName));
  assert.equal(cgst.taxAmount, 180);
  assert.equal(sgst.taxAmount, 180);
  assert.equal(out.summary.returnedItemValue, 2000);
  assert.equal(out.summary.gstReversal, 360);
  assert.equal(out.summary.totalCustomerCredit, 2360);
  assert.equal(out.items[0].lineTaxes.length, 2);
});

test('calcCreditNoteReturn — discount uses net taxable per unit', () => {
  const out = calcCreditNoteReturn({
    context: {
      items: [{
        itemName: 'Product A',
        soldQty: 10,
        soldAmount: 9000,
        rate: 1000,
        netTaxablePerUnit: 900,
        discount: 1000,
        gstRate: 18,
        remainingQty: 10,
      }],
      taxes: [
        { ledgerName: 'CGST', taxAmount: 810, taxRate: 9 },
        { ledgerName: 'SGST', taxAmount: 810, taxRate: 9 },
      ],
      gst: { taxableAmount: 9000, cgstAmount: 810, sgstAmount: 810, igstAmount: 0 },
      totals: { itemsTotal: 9000, salesLedgerTotal: 9000 },
    },
    returnLines: [{ itemName: 'Product A', qty: 2 }],
  });
  assert.equal(out.itemsTotal, 1800);
  assert.equal(out.taxTotal, 324);
  assert.equal(out.totalAmount, 2124);
});

test('calcCreditNoteReturn — interstate IGST', () => {
  const out = calcCreditNoteReturn({
    context: {
      items: [{
        itemName: 'Product A',
        soldQty: 10,
        soldAmount: 10000,
        rate: 1000,
        netTaxablePerUnit: 1000,
        gstRate: 18,
        remainingQty: 10,
      }],
      taxes: [{ ledgerName: 'IGST', taxAmount: 1800, taxRate: 18 }],
      gst: { taxableAmount: 10000, cgstAmount: 0, sgstAmount: 0, igstAmount: 1800 },
      totals: { itemsTotal: 10000 },
    },
    returnLines: [{ itemName: 'Product A', qty: 2 }],
  });
  assert.equal(out.isInterstate, true);
  assert.equal(out.itemsTotal, 2000);
  assert.equal(out.taxTotal, 360);
  assert.equal(out.taxes[0].ledgerName, 'IGST');
  assert.equal(out.taxes[0].taxAmount, 360);
});

test('calcCreditNoteReturn — exempt invents no GST', () => {
  const out = calcCreditNoteReturn({
    context: {
      items: [{
        itemName: 'Exempt Seed',
        soldQty: 10,
        soldAmount: 5000,
        rate: 500,
        netTaxablePerUnit: 500,
        gstRate: null,
        remainingQty: 10,
      }],
      taxes: [],
      gst: null,
      totals: { itemsTotal: 5000 },
    },
    returnLines: [{ itemName: 'Exempt Seed', qty: 2 }],
  });
  assert.equal(out.returnTaxMode, RETURN_TAX_WITHOUT_GST);
  assert.equal(out.itemsTotal, 1000);
  assert.equal(out.taxTotal, 0);
  assert.equal(out.taxes.length, 0);
  assert.equal(out.totalAmount, 1000);
});

test('calcCreditNoteReturn — proportional fallback when mixed rates missing', () => {
  const out = calcCreditNoteReturn({
    context: {
      items: [
        {
          itemName: 'Item 5pct', soldQty: 10, soldAmount: 5000, rate: 500,
          netTaxablePerUnit: 500, gstRate: null, remainingQty: 10,
        },
        {
          itemName: 'Item 18pct', soldQty: 10, soldAmount: 5000, rate: 500,
          netTaxablePerUnit: 500, gstRate: null, remainingQty: 10,
        },
      ],
      taxes: [
        { ledgerName: 'CGST', taxAmount: 575, taxRate: 5.75 },
        { ledgerName: 'SGST', taxAmount: 575, taxRate: 5.75 },
      ],
      gst: { taxableAmount: 10000, cgstAmount: 575, sgstAmount: 575, igstAmount: 0 },
      totals: { itemsTotal: 10000, salesLedgerTotal: 10000 },
    },
    returnLines: [{ itemName: 'Item 5pct', qty: 10 }],
  });
  assert.equal(out.allocationMode, 'proportional');
  assert.equal(out.fallbackUsed, true);
  assert.equal(out.itemsTotal, 5000);
  // Half of original tax total (575+575=1150) → 575
  assert.equal(out.taxTotal, 575);
});
