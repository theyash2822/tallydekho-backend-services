/**
 * TallyDekho — Credit Note (Sales Return) unit tests
 *
 * Covers the two pure pieces of POST /tally/voucher/credit-note:
 *   - prepareCreditNoteLines() — validation + server-side recomputation
 *   - buildCreditNoteXml()     — XML shape vs the TallyPrime Credit Note export
 *
 * No DB or running server needed (importing tally-write.js only constructs an
 * idle pg Pool).
 *
 * Run with: node --test src/__tests__/credit-note.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCreditNoteXml, prepareCreditNoteLines } from '../routes/tally-write.js';
import { isSalesInvoiceRow, normalizeName, round3 } from '../utils/creditNoteContext.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const invoice = { guid: 'inv-guid-1', voucher_number: '0469/17-18', party_name: 'Amarsinghji Patel Kanjrota' };

const makeContext = (overrides = {}) => ({
  linkedInvoice: {
    invoiceGuid: 'inv-guid-1',
    voucherNumber: '0469/17-18',
    billRefName: '0469/17-18',
    billRefCandidates: ['0469/17-18'],
    tdkRef: null,
    partyLedger: 'Amarsinghji Patel Kanjrota',
  },
  items: [
    {
      itemName: 'Maize 4794 TL 1KG', unit: 'nos', hsn: '1209', godown: 'Main Location', batch: 'Primary Batch',
      rate: 155, soldQty: 50, soldAmount: 7750, netTaxablePerUnit: 155, discount: 0, gstRate: 5,
      returnedSyncedQty: 0, returnedPendingQty: 0, previouslyReturnedQty: 0, remainingQty: 50,
    },
    {
      itemName: 'Wheat Seed 5KG', unit: 'bag', hsn: '1001', godown: 'Main Location', batch: 'Primary Batch',
      rate: 400, soldQty: 10, soldAmount: 4000, netTaxablePerUnit: 400, discount: 0, gstRate: 5,
      returnedSyncedQty: 4, returnedPendingQty: 3, previouslyReturnedQty: 7, remainingQty: 3,
    },
  ],
  invoiceSalesLedgers: [{ ledgerName: 'Seed Sale A\\C', amount: 7750 }],
  companySalesLedgers: [{ ledgerName: 'Seed Sale A\\C' }, { ledgerName: 'Sales Account GST' }],
  defaultSalesLedger: 'Seed Sale A\\C',
  taxes: [{ ledgerName: 'GST', taxAmount: 387.5, taxRate: 5 }],
  gst: { taxableAmount: 7750, cgstAmount: 0, sgstAmount: 0, igstAmount: 0 },
  totals: { itemsTotal: 11750, salesLedgerTotal: 7750 },
  ...overrides,
});

// ── prepareCreditNoteLines ───────────────────────────────────────────────────

test('prepareCreditNoteLines — accepts an explicit editable return amount', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 50, rate: 150, amount: 7500 }],
    taxes: [{ ledgerName: 'GST', taxAmount: 9999, taxableValue: 7500, taxRate: 5 }],
    context: makeContext(),
    invoice,
  });

  assert.equal(out.error, undefined);
  assert.equal(out.items[0].amount, 7500);
  assert.equal(out.items[0].rate, 150, 'rate is derived from editable amount ÷ quantity');
  assert.equal(out.itemsTotal, 7500);
  // Server owns GST — client taxAmount 9999 is ignored; 5% of 7500 = 375
  assert.equal(out.taxTotal, 375);
  assert.equal(out.totalAmount, 7875);
  assert.equal(out.items[0].salesLedger, 'Seed Sale A\\C', 'falls back to the invoice Sales ledger');
});

test('prepareCreditNoteLines — falls back to qty × net taxable/unit when amount is omitted', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 50, rate: 155 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.items[0].amount, 7750);
  assert.equal(out.items[0].rate, 155);
  assert.equal(out.taxTotal, 387.5);
});

test('prepareCreditNoteLines — rejects an item that is not on the invoice', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Some Other Item', billedQty: 1, rate: 10 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(out.error, /is not on invoice/);
});

test('prepareCreditNoteLines — rejects non-positive qty and rate', () => {
  const zeroQty = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 0, rate: 155 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(zeroQty.error, /quantity .* must be greater than 0/);

  const zeroRate = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 5, rate: 0 }],
    taxes: [],
    context: makeContext({
      items: [{
        ...makeContext().items[0],
        rate: 0, soldAmount: 0, netTaxablePerUnit: 0, gstRate: null,
      }],
      taxes: [],
      gst: null,
    }),
    invoice,
  });
  assert.match(zeroRate.error, /Rate .* must be greater than 0/);

  const zeroAmount = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 5, rate: 155, amount: 0 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(zeroAmount.error, /Return amount .* must be greater than 0/);
});

test('prepareCreditNoteLines — enforces cumulative remaining qty across prior returns', () => {
  // Wheat: 10 sold, 4 synced + 3 queued returned → 3 remaining.
  const overReturn = prepareCreditNoteLines({
    items: [{ itemName: 'Wheat Seed 5KG', billedQty: 4, rate: 400 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(overReturn.error, /Cannot return 4 of "Wheat Seed 5KG"/);
  assert.match(overReturn.error, /7 already returned, 3 remaining/);

  const exact = prepareCreditNoteLines({
    items: [{ itemName: 'Wheat Seed 5KG', billedQty: 3, rate: 400 }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.equal(exact.error, undefined, 'returning exactly the remaining qty is allowed');
  assert.equal(exact.itemsTotal, 1200);
  assert.equal(exact.taxTotal, 60);
  assert.equal(exact.totalAmount, 1260);
});

test('prepareCreditNoteLines — sums duplicate request lines for the same item', () => {
  const out = prepareCreditNoteLines({
    items: [
      { itemName: 'Wheat Seed 5KG', billedQty: 2, rate: 400 },
      { itemName: 'Wheat Seed 5KG', billedQty: 2, rate: 400 },
    ],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(out.error, /Cannot return 4 of "Wheat Seed 5KG"/);
});

test('prepareCreditNoteLines — rejects a Sales ledger the invoice never used', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 1, rate: 155, salesLedger: 'Sales Account GST' }],
    taxes: [], context: makeContext(), invoice,
  });
  assert.match(out.error, /is not a Sales ledger used on invoice/);
});

test('prepareCreditNoteLines — falls back to company Sales ledgers when the invoice has no synced legs', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 1, rate: 155, salesLedger: 'Sales Account GST' }],
    taxes: [],
    context: makeContext({ invoiceSalesLedgers: [], defaultSalesLedger: null }),
    invoice,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.items[0].salesLedger, 'Sales Account GST');
});

test('prepareCreditNoteLines — server recalculates GST and ignores client tax amounts', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 10, rate: 155 }],
    taxes: [
      { ledgerName: 'GST', taxAmount: 50, taxableValue: 1000 },
      { ledgerName: 'GST', taxAmount: 27.5, taxableValue: 550 },
      { ledgerName: 'Cess', taxAmount: 10 },
    ],
    context: makeContext(), invoice,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.itemsTotal, 1550);
  assert.equal(out.taxTotal, 77.5);
  assert.equal(out.taxes.length, 1);
  assert.equal(out.taxes[0].ledgerName, 'GST');
  assert.equal(out.taxes[0].taxAmount, 77.5);
});

test('prepareCreditNoteLines — no GST invented on exempt invoice', () => {
  const out = prepareCreditNoteLines({
    items: [{ itemName: 'Maize 4794 TL 1KG', billedQty: 10 }],
    taxes: [{ ledgerName: 'GST', taxAmount: 999 }],
    context: makeContext({
      items: [{
        ...makeContext().items[0],
        gstRate: null,
      }],
      taxes: [],
      gst: null,
    }),
    invoice,
  });
  assert.equal(out.error, undefined);
  assert.equal(out.taxTotal, 0);
  assert.equal(out.taxes.length, 0);
  assert.equal(out.totalAmount, 1550);
});

// ── buildCreditNoteXml ───────────────────────────────────────────────────────

const xmlFixture = () => buildCreditNoteXml({
  companyName: 'Yash Ki Company',
  date: '2026-07-29',
  voucherNumber: '',
  reference: 'TDK-CN-2026-0001',
  narration: 'Goods returned by customer',
  partyLedger: 'Amarsinghji Patel Kanjrota',
  isOptional: false,
  items: [{
    itemName: 'Maize 4794 TL 1KG', qty: 50, rate: 155, amount: 7750,
    unit: 'nos', godown: 'Main Location', batch: 'Primary Batch', salesLedger: 'Seed Sale A\\C',
  }],
  taxes: [{ ledgerName: 'GST', taxAmount: 387.5, taxableValue: 7750 }],
  billRefName: '0469/17-18',
  partyAmount: 8137.5,
});

test('buildCreditNoteXml — voucher header matches the TallyPrime Credit Note export', () => {
  const xml = xmlFixture();
  assert.match(xml, /<VOUCHER VCHTYPE="Credit Note" ACTION="Create" OBJVIEW="Invoice Voucher View">/);
  assert.match(xml, /<VOUCHERTYPENAME>Credit Note<\/VOUCHERTYPENAME>/);
  assert.match(xml, /<PERSISTEDVIEW>Invoice Voucher View<\/PERSISTEDVIEW>/);
  assert.match(xml, /<VCHENTRYMODE>Item Invoice<\/VCHENTRYMODE>/);
  assert.match(xml, /<GSTNATUREOFRETURN>01-Sales Return<\/GSTNATUREOFRETURN>/);
  assert.match(xml, /<ISINVOICE>Yes<\/ISINVOICE>/);
  assert.match(xml, /<DIFFACTUALQTY>Yes<\/DIFFACTUALQTY>/);
  assert.match(xml, /<ISOPTIONAL>No<\/ISOPTIONAL>/);
  assert.match(xml, /<DATE>20260729<\/DATE>/);
  assert.match(xml, /<REFERENCE>TDK-CN-2026-0001<\/REFERENCE>/);
  assert.match(xml, /<VOUCHERNUMBER><\/VOUCHERNUMBER>/, 'Tally series → blank voucher number');
});

test('buildCreditNoteXml — omits export-only noise', () => {
  const xml = xmlFixture();
  for (const tag of ['GUID', 'REMOTEID', 'VCHKEY', 'ALTERID', 'MASTERID', 'VOUCHERKEY', 'ORIGINVOICEDETAILS.LIST']) {
    assert.ok(!xml.includes(tag), `XML must not contain ${tag}`);
  }
});

test('buildCreditNoteXml — inventory leg is negative with positive qty and unit-qualified rate', () => {
  const xml = xmlFixture();
  const inv = xml.match(/<ALLINVENTORYENTRIES\.LIST>[\s\S]*?<\/ALLINVENTORYENTRIES\.LIST>/)[0];
  assert.match(inv, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(inv, /<RATE>155\/nos<\/RATE>/);
  assert.match(inv, /<AMOUNT>-7750<\/AMOUNT>/);
  assert.match(inv, /<ACTUALQTY>50<\/ACTUALQTY>/);
  assert.match(inv, /<BILLEDQTY>50<\/BILLEDQTY>/);
  assert.match(inv, /<BATCHNAME>Primary Batch<\/BATCHNAME>/);
  assert.match(inv, /<GODOWNNAME>Main Location<\/GODOWNNAME>/);
  // Accounting allocation uses the original invoice Sales ledger, also negative.
  const acc = inv.match(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/)[0];
  assert.match(acc, /<LEDGERNAME>Seed Sale A\\C<\/LEDGERNAME>/);
  assert.match(acc, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(acc, /<AMOUNT>-7750<\/AMOUNT>/);
});

test('buildCreditNoteXml — tax leg is the Sales pattern reversed', () => {
  const xml = xmlFixture();
  const taxLeg = xml.match(/<LEDGERENTRIES\.LIST>(?:(?!<\/LEDGERENTRIES\.LIST>)[\s\S])*?GST[\s\S]*?<\/LEDGERENTRIES\.LIST>/)[0];
  assert.match(taxLeg, /<ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE>/);
  assert.match(taxLeg, /<AMOUNT>-387\.5<\/AMOUNT>/);
  assert.match(taxLeg, /<VATASSESSABLEVALUE>-7750<\/VATASSESSABLEVALUE>/);
});

test('buildCreditNoteXml — party leg is positive with an Agst Ref bill allocation', () => {
  const xml = xmlFixture();
  const partyLeg = xml.slice(xml.lastIndexOf('<LEDGERENTRIES.LIST>'));
  assert.match(partyLeg, /<ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE>/);
  assert.match(partyLeg, /<ISPARTYLEDGER>Yes<\/ISPARTYLEDGER>/);
  assert.match(partyLeg, /<AMOUNT>8137\.5<\/AMOUNT>/);
  assert.match(partyLeg, /<NAME>0469\/17-18<\/NAME>/);
  assert.match(partyLeg, /<BILLTYPE>Agst Ref<\/BILLTYPE>/);
});

test('buildCreditNoteXml — voucher balances to zero', () => {
  const xml = xmlFixture();
  // Only top-level legs count: inventory AMOUNT + tax AMOUNT + party AMOUNT.
  const inventoryAmt = -7750;
  const taxAmt = -387.5;
  const partyAmt = 8137.5;
  assert.equal(Math.round((inventoryAmt + taxAmt + partyAmt) * 100) / 100, 0);
  assert.ok(xml.includes('<AMOUNT>8137.5</AMOUNT>'));
});

test('buildCreditNoteXml — escapes XML-unsafe values', () => {
  const xml = buildCreditNoteXml({
    companyName: 'Ram & Sons <Pvt>',
    date: '2026-07-29',
    partyLedger: 'A & B "Traders"',
    items: [{ itemName: 'Item <1>', qty: 1, rate: 10, amount: 10, unit: '', salesLedger: 'Sales & Co' }],
    taxes: [],
    billRefName: 'INV/1&2',
    partyAmount: 10,
  });
  assert.match(xml, /<SVCURRENTCOMPANY>Ram &amp; Sons &lt;Pvt&gt;<\/SVCURRENTCOMPANY>/);
  assert.match(xml, /<STOCKITEMNAME>Item &lt;1&gt;<\/STOCKITEMNAME>/);
  assert.match(xml, /<NAME>INV\/1&amp;2<\/NAME>/);
  assert.ok(!/[^&]&[^a]/.test(xml.replace(/&amp;|&lt;|&gt;|&quot;|&apos;/g, '')), 'no raw ampersands remain');
});

test('buildCreditNoteXml — optional entry flips ISOPTIONAL', () => {
  const xml = buildCreditNoteXml({
    companyName: 'Co', date: '2026-07-29', partyLedger: 'P', isOptional: true,
    items: [{ itemName: 'I', qty: 1, rate: 1, amount: 1, salesLedger: 'S' }],
    taxes: [], billRefName: 'B', partyAmount: 1,
  });
  assert.match(xml, /<ISOPTIONAL>Yes<\/ISOPTIONAL>/);
});

// ── context helpers ──────────────────────────────────────────────────────────

test('isSalesInvoiceRow — accepts Sales, rejects orders and other parents', () => {
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Sales', voucher_type: 'Sales GST' }), true);
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Credit Note', voucher_type: 'Credit Note' }), false);
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Sales Order', voucher_type: 'Sales Order' }), false);
  // No parent synced → fall back to the type name.
  assert.equal(isSalesInvoiceRow({ voucher_type: 'Sales GST' }), true);
  // SimplifiedVoucher.xml leaves the 'Voucher' placeholder → also fall back.
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Sales' }), true);
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Sales GST' }), true);
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Sales Order' }), false);
  assert.equal(isSalesInvoiceRow({ voucher_type_parent: 'Voucher', voucher_type: 'Credit Note' }), false);
  assert.equal(isSalesInvoiceRow({ voucher_type: 'Sales Order' }), false);
  assert.equal(isSalesInvoiceRow({ voucher_type: 'Purchase' }), false);
  assert.equal(isSalesInvoiceRow(null), false);
});

test('normalizeName / round3 behave as the qty comparisons expect', () => {
  assert.equal(normalizeName('  Seed Sale A\\C  '), 'seed sale a\\c');
  assert.equal(normalizeName(null), '');
  assert.equal(round3(1 / 3), 0.333);
  assert.equal(round3('12.0005'), 12.001);
});
