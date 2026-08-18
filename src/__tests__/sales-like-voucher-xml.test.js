/**
 * Proforma / Sales-like voucher XML — aligned to TallyPrime optional Sales export
 * Sales_TD1531-3-2026.xml (Yash Ki Company).
 *
 * Run: node --test src/__tests__/sales-like-voucher-xml.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSalesLikeVoucherXml,
  tallyVoucherGuidFromMasterId,
  tallyMasterIdFromVoucherGuid,
} from '../utils/salesLikeVoucherXml.js';

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

test('Tally GUID is companyGuid + 8-char hex MASTERID', () => {
  const company = '2272cb4f-b5d6-4555-bdb7-1bd747049dc5';
  const guid = tallyVoucherGuidFromMasterId(company, '8559');
  assert.equal(guid, '2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f');
  assert.equal(tallyMasterIdFromVoucherGuid(company, guid), '8559');
  assert.equal(tallyVoucherGuidFromMasterId(company, '0'), '');
});

test('proforma convert Alter — identity + not optional, no ALTERID', () => {
  const xml = buildSalesLikeVoucherXml({
    ...base,
    action: 'Alter',
    isOptional: false,
    voucherNumber: 'TD1831-3-2026',
    guid: '2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f',
    masterId: '8559',
    alterId: '9653',
  });
  assert.match(xml, /ACTION="Alter"/);
  assert.match(xml, /REMOTEID="2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f"/);
  assert.match(xml, /<GUID>2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f<\/GUID>/);
  assert.match(xml, /<MASTERID>8559<\/MASTERID>/);
  assert.match(xml, /<VOUCHERNUMBER>TD1831-3-2026<\/VOUCHERNUMBER>/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<VCHSTATUSISOPTIONAL>No<\/VCHSTATUSISOPTIONAL>/);
  assert.doesNotMatch(xml, /<ALTERID>/);
});
