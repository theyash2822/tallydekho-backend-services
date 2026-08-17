/**
 * Proforma / Sales-like voucher XML — aligned to TallyPrime optional Sales export
 * Sales_TD1531-3-2026.xml (Yash Ki Company).
 *
 * Run: node --test src/__tests__/sales-like-voucher-xml.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSalesLikeVoucherXml } from '../utils/salesLikeVoucherXml.js';

const base = {
  companyName: 'Yash Ki Company',
  vchType: 'Sales',
  dt: '20260817',
  voucherNumber: '',
  tdkRef: 'TDK-PRF-2026-0009',
  narration: '',
  partyLedger: 'Manish ai services',
  partyAmt: 27250,
  items: [{
    itemName: 'Soybean RVSM-1135',
    billedQty: 5,
    actualQty: 5,
    rate: 5000,
    amount: 25000,
    unit: 'nos',
    salesLedger: 'Sales Account GST',
    godown: 'Main Location',
  }],
  taxes: [{ ledgerName: 'CGST', taxAmount: 2250, taxableValue: 25000, taxRate: 9 }],
};

test('proforma create — Invoice view + optional status flags', () => {
  const xml = buildSalesLikeVoucherXml({ ...base, action: 'Create', isOptional: true });
  assert.match(xml, /OBJVIEW="Invoice Voucher View"/);
  assert.match(xml, /<PERSISTEDVIEW>Invoice Voucher View<\/PERSISTEDVIEW>/);
  assert.match(xml, /<VCHENTRYMODE>Item Invoice<\/VCHENTRYMODE>/);
  assert.match(xml, /<ISOPTIONAL>Yes<\/ISOPTIONAL>/);
  assert.match(xml, /<VCHSTATUSISOPTIONAL>Yes<\/VCHSTATUSISOPTIONAL>/);
  assert.match(xml, /<DIFFACTUALQTY>Yes<\/DIFFACTUALQTY>/);
  assert.match(xml, /<REFERENCE>TDK-PRF-2026-0009<\/REFERENCE>/);
  assert.match(xml, /ACTION="Create"/);
  assert.doesNotMatch(xml, /REMOTEID=/);
});

test('proforma create — qty and rate carry unit', () => {
  const xml = buildSalesLikeVoucherXml({ ...base, action: 'Create', isOptional: true });
  assert.match(xml, /<RATE>5000\/nos<\/RATE>/);
  assert.match(xml, /<BILLEDQTY> 5 nos<\/BILLEDQTY>/);
});

test('proforma convert Alter — identity + not optional', () => {
  const xml = buildSalesLikeVoucherXml({
    ...base,
    action: 'Alter',
    isOptional: false,
    voucherNumber: 'TD1531-3-2026',
    guid: '2272cb4f-b5d6-4555-bdb7-1bd747049dc5-00002162',
    masterId: '8546',
    alterId: '9647',
  });
  assert.match(xml, /ACTION="Alter"/);
  assert.match(xml, /REMOTEID="2272cb4f-b5d6-4555-bdb7-1bd747049dc5-00002162"/);
  assert.match(xml, /<GUID>2272cb4f-b5d6-4555-bdb7-1bd747049dc5-00002162<\/GUID>/);
  assert.match(xml, /<MASTERID>8546<\/MASTERID>/);
  assert.match(xml, /<ALTERID>9647<\/ALTERID>/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<VCHSTATUSISOPTIONAL>No<\/VCHSTATUSISOPTIONAL>/);
});
