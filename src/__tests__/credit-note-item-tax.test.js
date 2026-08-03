/**
 * Per-item tax geometry builders for Credit Notes.
 * Run: node --test src/__tests__/credit-note-item-tax.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildItemTaxesFromSalesPayload,
  buildItemTaxesFromLedgerOrder,
  geometryHasAttributedTax,
  mergeItemTaxGeometry,
} from '../utils/creditNoteItemTax.js';

const td1031Payload = () => ({
  items: [
    { itemName: 'Item A', amount: 10000, billedQty: 10 },
    { itemName: 'Item B', amount: 10000, billedQty: 10 },
    { itemName: 'Item C', amount: 10000, billedQty: 10 },
  ],
  taxes: [
    { ledgerName: 'GST', taxRate: 5, taxAmount: 500, taxableValue: 10000 },
    { ledgerName: 'GST', taxRate: 18, taxAmount: 1800, taxableValue: 10000 },
    { ledgerName: 'Vat Tax 5%', taxRate: 9, taxAmount: 900, taxableValue: 10000 },
  ],
  logistics: [
    {
      ledgerName: 'Packing Charges',
      amount: 5000,
      taxes: [{ ledgerName: 'GST', taxRate: 18, taxAmount: 900, taxableValue: 5000 }],
    },
  ],
});

test('buildItemTaxesFromSalesPayload — zips flat taxes 1:1 and isolates packing GST', () => {
  const inventory = [
    { itemName: 'Item A', soldAmount: 10000, soldQty: 10 },
    { itemName: 'Item B', soldAmount: 10000, soldQty: 10 },
    { itemName: 'Item C', soldAmount: 10000, soldQty: 10 },
  ];
  const geo = buildItemTaxesFromSalesPayload(td1031Payload(), inventory);
  assert.equal(geometryHasAttributedTax(geo), true);
  assert.equal(geo.items[0].gstRate, 5);
  assert.equal(geo.items[1].gstRate, 18);
  assert.equal(geo.items[2].gstRate, 9);
  assert.equal(geo.chargeTaxes.length, 1);
  assert.equal(geo.chargeTaxes[0].taxAmount, 900);
  assert.equal(geo.chargeTaxes[0].source, 'logistics');
});

test('buildItemTaxesFromLedgerOrder — tax before packing = goods; after = charge', () => {
  const ledgerRows = [
    { ledger_name: 'Party', amount: 35900 },
    { ledger_name: 'Sales', amount: 30000 },
    { ledger_name: 'GST', amount: 500 },
    { ledger_name: 'GST', amount: 1800 },
    { ledger_name: 'Vat Tax 5%', amount: 900 },
    { ledger_name: 'Packing Charges', amount: 5000 },
    { ledger_name: 'GST', amount: 900 },
  ];
  const inventory = [
    { itemName: 'Item A', soldAmount: 10000, soldQty: 10 },
    { itemName: 'Item B', soldAmount: 10000, soldQty: 10 },
    { itemName: 'Item C', soldAmount: 10000, soldQty: 10 },
  ];
  const geo = buildItemTaxesFromLedgerOrder({
    ledgerRows,
    inventoryItems: inventory,
    partyName: 'Party',
    salesLedgerNames: ['Sales'],
  });
  assert.equal(geometryHasAttributedTax(geo), true);
  assert.equal(geo.items[0].taxEntries[0].taxAmount, 500);
  assert.equal(geo.items[0].gstRate, 5);
  assert.equal(geo.items[1].gstRate, 18);
  assert.equal(geo.items[2].gstRate, 9);
  assert.equal(geo.chargeTaxes.length, 1);
  assert.equal(geo.chargeTaxes[0].taxAmount, 900);
});

test('mergeItemTaxGeometry — stamps gstRate + taxEntries onto context items', () => {
  const items = [
    { itemName: 'Item A', soldQty: 10, soldAmount: 10000, gstRate: null },
    { itemName: 'Item B', soldQty: 10, soldAmount: 10000, gstRate: null },
    { itemName: 'Item C', soldQty: 10, soldAmount: 10000, gstRate: null },
  ];
  const geo = buildItemTaxesFromSalesPayload(td1031Payload(), items);
  const merged = mergeItemTaxGeometry(items, geo);
  assert.equal(merged[0].gstRate, 5);
  assert.equal(merged[1].gstRate, 18);
  assert.equal(merged[2].gstRate, 9);
  assert.equal(merged[0].taxEntries.length, 1);
});
