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
  buildVoucherCancelXml,
  buildMinimalVoucherAlterXml,
  buildDispatchXml,
  buildSalesVoucherLinesXml,
  buildVoucherHeaderExtrasXml,
  buildRoundOffXml,
  typeOfSupplyFor,
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
  assert.match(xml, /DATE="20260817"/);
  assert.match(xml, /TAGNAME="MasterID"/);
  assert.match(xml, /TAGVALUE="8559"/);
  assert.match(xml, /REMOTEID="2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f"/);
  assert.match(xml, /<GUID>2272cb4f-b5d6-4555-bdb7-1bd747049dc5-0000216f<\/GUID>/);
  assert.match(xml, /<MASTERID>8559<\/MASTERID>/);
  assert.match(xml, /<VOUCHERNUMBER>TD1831-3-2026<\/VOUCHERNUMBER>/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<VCHSTATUSISOPTIONAL>No<\/VCHSTATUSISOPTIONAL>/);
  assert.doesNotMatch(xml, /<ALTERID>/);
});

test('minimal Alter probe XML is narration-only with MASTER ID tag', () => {
  const xml = buildMinimalVoucherAlterXml({
    companyName: 'Yash Ki Company',
    dt: '20260818',
    masterId: '8560',
    tagName: 'MASTER ID',
    narration: 'Edited from TallyDekho using Master ID 8560',
  });
  assert.match(xml, /DATE="20260818"/);
  assert.match(xml, /TAGNAME="MASTER ID"/);
  assert.match(xml, /TAGVALUE="8560"/);
  assert.match(xml, /ACTION="Alter"/);
  assert.match(xml, /<NARRATION>Edited from TallyDekho using Master ID 8560<\/NARRATION>/);
  assert.doesNotMatch(xml, /ISOPTIONAL/);
  assert.doesNotMatch(xml, /ALLINVENTORYENTRIES/);
  assert.doesNotMatch(xml, /REMOTEID=/);
});

test('proforma convert XML flips optional flags only', () => {
  const xml = buildMinimalVoucherAlterXml({
    companyName: 'Yash Ki Company',
    dt: '20260818',
    masterId: '8560',
    tagName: 'MASTER ID',
    isOptional: false,
  });
  assert.match(xml, /DATE="20260818"/);
  assert.match(xml, /TAGNAME="MASTER ID"/);
  assert.match(xml, /TAGVALUE="8560"/);
  assert.match(xml, /ACTION="Alter"/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<VCHSTATUSISOPTIONAL>No<\/VCHSTATUSISOPTIONAL>/);
  assert.doesNotMatch(xml, /<NARRATION>/);
  assert.doesNotMatch(xml, /ALLINVENTORYENTRIES/);
  assert.doesNotMatch(xml, /REMOTEID=/);
  assert.doesNotMatch(xml, /<GUID>/);
});

test('convert Alter includes narration without GUID rebuild', () => {
  const xml = buildMinimalVoucherAlterXml({
    companyName: 'Yash Ki Company',
    dt: '20260818',
    masterId: '8568',
    tagName: 'MASTER ID',
    narration: 'This is the performa invoice',
    isOptional: false,
  });
  assert.match(xml, /<NARRATION>This is the performa invoice<\/NARRATION>/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /TAGVALUE="8568"/);
  assert.doesNotMatch(xml, /REMOTEID=/);
  assert.doesNotMatch(xml, /<GUID>/);
});

test('convert Alter can attach added item lines + party ledger', () => {
  const lines = buildSalesVoucherLinesXml({
    partyLedger: 'Manish ai services',
    partyAmt: 27250,
    tdkRef: 'TDK-PRF-2026-0007',
    items: [
      {
        itemName: 'Soybean RVSM-1135',
        billedQty: 5,
        actualQty: 5,
        rate: 5000,
        amount: 25000,
        unit: 'nos',
        salesLedger: 'Sales Account GST',
        godown: 'Main Location',
      },
      {
        itemName: 'Extra Bag',
        billedQty: 1,
        actualQty: 1,
        rate: 100,
        amount: 100,
        unit: 'nos',
        salesLedger: 'Sales Account GST',
        godown: 'Main Location',
      },
    ],
    taxes: [{ ledgerName: 'CGST', taxAmount: 2250, taxableValue: 25000 }],
  });
  const xml = buildMinimalVoucherAlterXml({
    companyName: 'Yash Ki Company',
    dt: '20260818',
    masterId: '8568',
    tagName: 'MASTER ID',
    narration: 'This is the performa invoice',
    isOptional: false,
    extraInnerXml: lines,
  });
  assert.match(xml, /<NARRATION>This is the performa invoice<\/NARRATION>/);
  assert.match(xml, /<STOCKITEMNAME>Soybean RVSM-1135<\/STOCKITEMNAME>/);
  assert.match(xml, /<STOCKITEMNAME>Extra Bag<\/STOCKITEMNAME>/);
  assert.match(xml, /<LEDGERNAME>Manish ai services<\/LEDGERNAME>/);
  assert.match(xml, /ACTION="Alter"/);
  assert.doesNotMatch(xml, /REMOTEID=/);
  assert.doesNotMatch(xml, /<GUID>/);
});

test('convert Alter includes dispatch / vehicle fields without inventory', () => {
  const dispatchXml = buildDispatchXml({
    dispatch_from: 'Ajmer',
    dispatch_from_state: 'Rajasthan',
    dispatch_from_pincode: '305002',
    dispatch_from_address1: 'New Bus Stand',
    ship_to: 'Alwar',
    ship_to_state: 'Rajasthan',
    ship_to_pincode: '301001',
    ship_to_address1: 'Iskon road',
    transport_mode: 'Road',
    transporter_name: 'Shiva',
    vehicle_number: 'RJ02SX1657',
    vehicle_type: 'Regular',
    transport_doc_no: '56',
    transport_doc_date: '2026-08-18',
  }, '20260818');
  const xml = buildMinimalVoucherAlterXml({
    companyName: 'Yash Ki Company',
    dt: '20260818',
    masterId: '8568',
    tagName: 'MASTER ID',
    isOptional: false,
    extraInnerXml: dispatchXml,
  });
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<BASICSHIPDOCUMENTNO>56<\/BASICSHIPDOCUMENTNO>/);
  assert.match(xml, /<BASICSHIPVESSELNO>RJ02SX1657<\/BASICSHIPVESSELNO>/);
  assert.match(xml, /<BASICFINALDESTINATION>Alwar<\/BASICFINALDESTINATION>/);
  assert.match(xml, /<TRANSPORTERNAME>Shiva<\/TRANSPORTERNAME>/);
  assert.match(xml, /<VEHICLENUMBER>RJ02SX1657<\/VEHICLENUMBER>/);
  assert.match(xml, /<CONSIGNORPLACE>Ajmer<\/CONSIGNORPLACE>/);
  assert.doesNotMatch(xml, /ALLINVENTORYENTRIES/);
});

test('header extras emit GST, reference date and terms tags', () => {
  const xml = buildVoucherHeaderExtrasXml({
    placeOfSupply: 'Rajasthan',
    partyGstin: '08AAACT2727Q1ZW',
    consigneeGstin: '08AAACT2727Q1ZX',
    referenceDate: '2026-08-18',
    paymentTerms: '30 Days',
    termsText: 'Goods once sold\nSubject to Ajmer jurisdiction',
  });
  assert.match(xml, /<PLACEOFSUPPLY>Rajasthan<\/PLACEOFSUPPLY>/);
  assert.match(xml, /<PARTYGSTIN>08AAACT2727Q1ZW<\/PARTYGSTIN>/);
  assert.match(xml, /<CONSIGNEEGSTIN>08AAACT2727Q1ZX<\/CONSIGNEEGSTIN>/);
  assert.match(xml, /<REFERENCEDATE>20260818<\/REFERENCEDATE>/);
  assert.match(xml, /<BASICDUEDATEOFPYMT>30 Days<\/BASICDUEDATEOFPYMT>/);
  assert.match(xml, /<BASICORDERTERMS>Goods once sold<\/BASICORDERTERMS>/);
  assert.match(xml, /<BASICORDERTERMS>Subject to Ajmer jurisdiction<\/BASICORDERTERMS>/);
});

test('header extras stay empty when nothing is known', () => {
  assert.equal(buildVoucherHeaderExtrasXml({}), '');
  assert.equal(buildVoucherHeaderExtrasXml({ termsText: '\n  \n' }), '');
});

test('round-off ledger is debited when negative, credited when positive', () => {
  const up = buildRoundOffXml({ ledgerName: 'Round Off', amount: 0.4 });
  assert.match(up, /<LEDGERNAME>Round Off<\/LEDGERNAME>/);
  assert.match(up, /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
  const down = buildRoundOffXml({ ledgerName: 'Round Off', amount: -0.4 });
  assert.match(down, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.equal(buildRoundOffXml({ ledgerName: 'Round Off', amount: 0 }), '');
  assert.equal(buildRoundOffXml({ amount: 5 }), '');
});

test('type of supply follows the stock master instead of always saying Goods', () => {
  assert.equal(typeOfSupplyFor({ typeOfSupply: 'Services' }), 'Services');
  assert.equal(typeOfSupplyFor({ type_of_supply: 'services' }), 'Services');
  assert.equal(typeOfSupplyFor({ typeOfSupply: 'Goods' }), 'Goods');
  // Unknown must stay Goods: that is what Tally assumes for a stock item, and it
  // is the behaviour every already-posted voucher was written with.
  assert.equal(typeOfSupplyFor({}), 'Goods');
  assert.equal(typeOfSupplyFor({ typeOfSupply: '' }), 'Goods');

  const svc = buildSalesLikeVoucherXml({
    ...base,
    action: 'Create',
    isOptional: false,
    items: [{ ...base.items[0], typeOfSupply: 'Services' }],
  });
  assert.match(svc, /<GSTOVRDNTYPEOFSUPPLY>Services<\/GSTOVRDNTYPEOFSUPPLY>/);
  const goods = buildSalesLikeVoucherXml({ ...base, action: 'Create', isOptional: false });
  assert.match(goods, /<GSTOVRDNTYPEOFSUPPLY>Goods<\/GSTOVRDNTYPEOFSUPPLY>/);
});

test('sales lines carry HSN and line discount', () => {
  const xml = buildSalesLikeVoucherXml({
    ...base,
    action: 'Create',
    isOptional: false,
    items: [{ ...base.items[0], hsn: '1201', discount: 5 }],
  });
  assert.match(xml, /<HSNCODE>1201<\/HSNCODE>/);
  assert.match(xml, /<DISCOUNT>5<\/DISCOUNT>/);
});

test('dispatch builder can emit the e-Way Bill block alone', () => {
  const args = [{
    dispatch_from: 'Ajmer',
    ship_to: 'Alwar',
    transport_doc_no: '56',
    vehicle_number: 'RJ02SX1657',
  }, '20260818'];
  const ewbOnly = buildDispatchXml(...args, { ewbOnly: true });
  assert.match(ewbOnly, /<EWAYBILLDETAILS.LIST>/);
  assert.doesNotMatch(ewbOnly, /<BASICSHIPDOCUMENTNO>/);
  assert.match(buildDispatchXml(...args), /<BASICSHIPDOCUMENTNO>56<\/BASICSHIPDOCUMENTNO>/);
});

test('convert cancel XML identifies stray Create by MasterID', () => {
  const xml = buildVoucherCancelXml({
    companyName: 'Yash Ki Company',
    vchType: 'Sales',
    dt: '20260818',
    masterId: '8561',
    guid: '2272cb4f-b5d6-4555-bdb7-1bd747049dc5-00002171',
    voucherNumber: 'TD1931-3-2026',
  });
  assert.match(xml, /ACTION="Cancel"/);
  assert.match(xml, /TAGNAME="MasterID"/);
  assert.match(xml, /TAGVALUE="8561"/);
  assert.match(xml, /DATE="20260818"/);
});
