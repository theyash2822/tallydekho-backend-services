/**
 * VoucherDocument snapshot helpers.
 *
 * The expected strings here are transcribed from the real Tally Prime exports in
 * tallydekho-brain/reference/pdf-layouts/, so a regression here means our PDF
 * stops matching Tally.
 *
 * Run: node --test src/__tests__/voucher-document.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountInWords,
  indianWords,
  panFromGstin,
  stateCode,
  classifyTaxKind,
  isRoundOffLedger,
  buildItemLines,
  buildTaxLines,
  buildChargeLines,
  buildHsnSummary,
  buildTotals,
  buildDocumentMetadata,
  buildShippingBlock,
  buildCompanyBlock,
  buildPartyBlock,
} from '../utils/voucherDocument.js';
import { buildVoucherDocument } from '../routes/tally-write.js';

/** Lets buildVoucherDocument run without touching the database. */
const STOCK_CTX = {
  companyRow: { name: 'Yash Ki Company', gstin: '23ACLPP1226E1ZZ', state: 'Rajasthan' },
  printProfile: null,
  partyRow: null,
  itemMasters: new Map(),
};

test('amountInWords matches the wording in the native Tally PDFs', () => {
  // tally-native/sales invoice.pdf
  assert.equal(
    amountInWords(129437.50),
    'Indian Rupees One Lakh Twenty Nine Thousand Four Hundred Thirty Seven and Fifty paise Only'
  );
  // tally-native/PURCHASE ORDER.pdf
  assert.equal(amountInWords(39400), 'Indian Rupees Thirty Nine Thousand Four Hundred Only');
  // tally-native/Receipt_23.pdf
  assert.equal(amountInWords(30000), 'Indian Rupees Thirty Thousand Only');
  // our-app/credit note refference.pdf
  assert.equal(amountInWords(1062), 'Indian Rupees One Thousand Sixty Two Only');
  // our-app/delevery note refference.pdf
  assert.equal(amountInWords(500), 'Indian Rupees Five Hundred Only');
});

test('indianWords uses the crore/lakh scale, not millions', () => {
  assert.equal(indianWords(0), 'Zero');
  assert.equal(indianWords(31013440), 'Three Crore Ten Lakh Thirteen Thousand Four Hundred Forty');
  assert.equal(indianWords(100000), 'One Lakh');
  assert.equal(indianWords(19), 'Nineteen');
  assert.equal(indianWords(105), 'One Hundred Five');
});

test('company PAN is derived from the GSTIN', () => {
  assert.equal(panFromGstin('23ACLPP1226E1ZZ'), 'ACLPP1226E');
  assert.equal(panFromGstin('not-a-gstin'), '');
  assert.equal(panFromGstin(null), '');
});

test('state code prefers the GSTIN prefix over the state name', () => {
  assert.equal(stateCode('Rajasthan', '23ACLPP1226E1ZZ'), '23');
  assert.equal(stateCode('Rajasthan', ''), '08');
  assert.equal(stateCode('Madhya Pradesh', null), '23');
  assert.equal(stateCode('Nowhere', ''), '');
});

test('tax ledgers are classified by declared kind then by name', () => {
  assert.equal(classifyTaxKind('CGST'), 'cgst');
  assert.equal(classifyTaxKind('Output SGST @9%'), 'sgst');
  assert.equal(classifyTaxKind('IGST Payable'), 'igst');
  assert.equal(classifyTaxKind('APMC Cess'), 'cess');
  // A custom-named GST ledger is only classifiable from the declared kind.
  assert.equal(classifyTaxKind('GST real wala'), 'other');
  assert.equal(classifyTaxKind('GST real wala', 'igst'), 'igst');
});

test('round-off ledgers are recognised by name', () => {
  assert.equal(isRoundOffLedger('Rounded Off'), true);
  assert.equal(isRoundOffLedger('Round Off'), true);
  assert.equal(isRoundOffLedger('Hammali Expense'), false);
});

test('item lines fill HSN and unit from the stock master', () => {
  const masters = new Map([['manzo 100ml', { name: 'Manzo 100ML', unit: 'nos', hsn: '38089199', tax_rate: '18.0000' }]]);
  const [line] = buildItemLines({
    items: [{ itemName: 'Manzo 100ML', billedQty: 50, rate: 2500, amount: 118750, discount: 5, discountType: '%' }],
  }, masters);

  assert.equal(line.hsn, '38089199');
  assert.equal(line.unit, 'nos');
  assert.equal(line.qty, 50);
  assert.equal(line.rate, 2500);
  assert.equal(line.discount, 5);
  assert.equal(line.taxPct, 18);
});

test('item lines sum per-line taxes into taxPct', () => {
  const [line] = buildItemLines({
    items: [{
      itemName: 'Green Gold 500ML', billedQty: 1, rate: 900, amount: 900,
      lineTaxes: [
        { ledgerName: 'CGST', taxRate: 9, taxAmount: 81, kind: 'cgst' },
        { ledgerName: 'SGST', taxRate: 9, taxAmount: 81, kind: 'sgst' },
      ],
    }],
  });

  assert.equal(line.taxPct, 18);
  assert.equal(line.taxAmount, 162);
  assert.deepEqual(line.lineTaxes.map((t) => t.kind), ['cgst', 'sgst']);
});

test('tax lines carry the cgst/sgst/igst split', () => {
  const lines = buildTaxLines({
    taxes: [
      { ledgerName: 'CGST', taxRate: 9, taxAmount: 4500, taxableValue: 50000 },
      { ledgerName: 'SGST', taxRate: 9, taxAmount: 4500, taxableValue: 50000 },
    ],
  });

  assert.equal(lines[0].cgst, 4500);
  assert.equal(lines[0].sgst, 0);
  assert.equal(lines[1].sgst, 4500);
});

test('round-off is split out of the logistics charges', () => {
  const { charges, roundOff, roundOffLabel } = buildChargeLines({
    logistics: [
      { ledgerName: 'Packing Material Expenses', amount: 2000, taxes: [{ ledgerName: 'CGST', taxRate: 9, taxAmount: 180 }] },
      { ledgerName: 'Rounded Off', amount: 140, taxes: [] },
    ],
  });

  assert.equal(charges.length, 1);
  assert.equal(charges[0].description, 'Packing Material Expenses');
  assert.equal(charges[0].taxes[0].kind, 'cgst');
  assert.equal(roundOff, 140);
  assert.equal(roundOffLabel, 'Rounded Off');
});

test('totals include the tax split, taxable value and charge taxes', () => {
  const payload = {
    items: [{ itemName: 'BYJU 10% 10ml', billedQty: 1000, rate: 100, amount: 75000, taxableValue: 75000 }],
    taxes: [
      { ledgerName: 'CGST', taxRate: 9, taxAmount: 6750, taxableValue: 75000 },
      { ledgerName: 'SGST', taxRate: 9, taxAmount: 6750, taxableValue: 75000 },
    ],
    logistics: [
      { ledgerName: 'Packing Material Expenses', amount: 2000, taxes: [
        { ledgerName: 'CGST', taxRate: 9, taxAmount: 180 },
        { ledgerName: 'SGST', taxRate: 9, taxAmount: 180 },
      ] },
      { ledgerName: 'Rounded Off', amount: 140, taxes: [] },
    ],
  };
  const items = buildItemLines(payload);
  const taxLines = buildTaxLines(payload);
  const { charges, roundOff } = buildChargeLines(payload);
  const totals = buildTotals(payload, { total_amount: 91000 }, items, taxLines, charges, roundOff);

  assert.equal(totals.taxableAmount, 75000);
  assert.equal(totals.cgstTotal, 6930);
  assert.equal(totals.sgstTotal, 6930);
  assert.equal(totals.igstTotal, 0);
  assert.equal(totals.chargeTotal, 2000);
  assert.equal(totals.roundOff, 140);
  assert.equal(totals.grandTotal, 91000);
  assert.equal(totals.totalQty, 1000);
});

test('HSN summary apportions voucher tax across HSN groups', () => {
  const items = buildItemLines({
    items: [
      { itemName: 'A', hsn: '3808', billedQty: 1, rate: 100, amount: 100, taxableValue: 100 },
      { itemName: 'B', hsn: '3101', billedQty: 1, rate: 300, amount: 300, taxableValue: 300 },
    ],
  });
  const taxLines = buildTaxLines({ taxes: [{ ledgerName: 'IGST', taxRate: 18, taxAmount: 72, taxableValue: 400 }] });
  const summary = buildHsnSummary(items, taxLines);

  assert.equal(summary.length, 2);
  assert.equal(summary[0].hsn, '3808');
  assert.equal(summary[0].igst, 18);
  assert.equal(summary[1].igst, 54);
  assert.equal(summary[0].totalTax + summary[1].totalTax, 72);
});

test('metadata exposes every label the Tally header grid prints', () => {
  const meta = buildDocumentMetadata({
    date: '2026-08-10',
    vendorInvoiceNo: '678',
    vendorInvoiceDate: '2026-08-09',
    linked_invoice: { voucherNumber: 'TD1231-3-2026', date: '2026-08-10' },
    dispatch_details: {
      transport_doc_no: 'DOC1234',
      dispatched_through: 'Mark courier service',
      ship_to: 'Gays',
      ship_to_state: 'Madhya Pradesh',
      vehicle_number: 'Rj02sx2025',
      terms_of_delivery: 'In one week',
      mode_of_payment: 'Cash',
    },
  }, { tdk_reference_no: 'TDK-DN-2026-0003' });

  assert.equal(meta.dispatchDocNo, 'DOC1234');
  assert.equal(meta.dispatchedThrough, 'Mark courier service');
  assert.equal(meta.destination, 'Gays');
  assert.equal(meta.motorVehicleNo, 'Rj02sx2025');
  assert.equal(meta.termsOfDelivery, 'In one week');
  assert.equal(meta.paymentTerms, 'Cash');
  assert.equal(meta.placeOfSupply, 'Madhya Pradesh');
  assert.equal(meta.supplierInvoiceNo, '678');
  assert.equal(meta.originalInvoiceNo, 'TD1231-3-2026');
  assert.equal(meta.referenceNo, 'TDK-DN-2026-0003');
  // Labels Tally always prints, even blank.
  assert.ok('billOfLadingNo' in meta);
  assert.ok('buyersOrderNo' in meta);
  assert.ok('deliveryNoteNo' in meta);
});

test('shipping block is null when no dispatch details were captured', () => {
  assert.equal(buildShippingBlock({}, { name: 'X' }), null);
  const ship = buildShippingBlock({
    dispatch_details: { ship_to: 'Jabalpur', ship_to_address1: 'Dhakanbari', ship_to_state: 'Madhya Pradesh' },
  }, { name: 'Alamsingh', gstin: '23AIGPK8030Q1ZZ' });
  assert.equal(ship.address, 'Dhakanbari, Jabalpur');
  assert.equal(ship.stateCode, '23');
});

test('company block prefers synced values and falls back to the print profile', () => {
  const synced = buildCompanyBlock(
    { name: 'Yash Ki Company', gstin: '23ACLPP1226E1ZZ', state: 'Rajasthan', email: 'a@b.com' },
    {},
    { gstin: '09OTHER0000A1Z1', jurisdiction: 'SARDARPUR' }
  );
  assert.equal(synced.gstin, '23ACLPP1226E1ZZ');
  assert.equal(synced.pan, 'ACLPP1226E');
  assert.equal(synced.email, 'a@b.com');
  assert.equal(synced.jurisdiction, 'SARDARPUR');

  const fallback = buildCompanyBlock(
    { name: 'Yash Ki Company', gstin: null, state: 'Rajasthan' },
    {},
    { gstin: '23ACLPP1226E1ZZ' }
  );
  assert.equal(fallback.gstin, '23ACLPP1226E1ZZ');
  assert.equal(fallback.pan, 'ACLPP1226E');
});

test('stock transfer prints one Source and one Destination line per item', async () => {
  const doc = await buildVoucherDocument({
    company_guid: 'c1',
    voucher_type: 'stock_transfer',
    voucher_date: '2026-08-19',
    total_amount: 4000,
    tdk_reference_no: 'TDK-STJ-2026-0001',
    payload: {
      fromGodown: 'Main Location',
      toGodown: 'Jabalpur Store',
      items: [{ itemName: 'Maize', qty: 4, unit: 'kg', rate: 1000, fromGodown: 'Main Location' }],
    },
  }, STOCK_CTX);

  assert.equal(doc.layout.family, 'stock');
  assert.equal(doc.tallyVoucherType, 'Stock Journal');
  const out = doc.items.filter((i) => i.direction === 'out');
  const into = doc.items.filter((i) => i.direction === 'in');
  assert.equal(out.length, 1);
  assert.equal(into.length, 1);
  assert.equal(out[0].godown, 'Main Location');
  assert.equal(into[0].godown, 'Jabalpur Store');
  assert.equal(out[0].amount, 4000);
  assert.equal(doc.metadata.sourceGodown, 'Main Location');
  assert.equal(doc.metadata.destinationGodown, 'Jabalpur Store');
});

test('physical stock prints a single undirected counted line', async () => {
  const doc = await buildVoucherDocument({
    company_guid: 'c1',
    voucher_type: 'stock_adjustment',
    voucher_date: '2026-08-19',
    total_amount: 0,
    tdk_reference_no: 'TDK-PHY-2026-0001',
    payload: {
      stockName: 'Maize',
      warehouse: 'Main Location',
      unit: 'kg',
      qtyBefore: 10,
      adjustmentQty: 2,
      isIncrease: true,
      adjustmentReason: 'Damage',
    },
  }, STOCK_CTX);

  assert.equal(doc.tallyVoucherType, 'Physical Stock');
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].direction, undefined);
  assert.equal(doc.items[0].qty, 12);
  assert.equal(doc.items[0].godown, 'Main Location');
  assert.equal(doc.metadata.adjustmentReason, 'Damage');
});

test('party block reads the columns that actually exist on ledgers', () => {
  const party = buildPartyBlock({
    name: 'Manish ai services',
    gstin: '08EDTPK9881C1Z1',
    address: 'Jaipur',
    phone: '9999999999',
    state_name: 'Rajasthan',
  });
  assert.equal(party.name, 'Manish ai services');
  assert.equal(party.address, 'Jaipur');
  assert.equal(party.stateCode, '08');
  assert.equal(party.pan, 'EDTPK9881C');
});
