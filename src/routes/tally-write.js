// Tally Write API — creates vouchers/masters in Tally via desktop proxy
// Flow: App → Backend → Desktop proxy → Tally HTTP port (9000)
// The desktop app must have the /tally-proxy endpoint running (Phase 3)

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../db/schema.js';
import { getDb } from '../db/schema.js';

const router = Router();

// ── Helper: format date YYYYMMDD ──────────────────────────────────────────────
const tallyDate = (d) => {
  if (!d) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return String(d).replace(/-/g, '').slice(0, 8);
};

// ── Helper: build XML from template ──────────────────────────────────────────
const buildXML = (template, vars) => {
  let xml = template;
  for (const [key, value] of Object.entries(vars)) {
    xml = xml.replaceAll(`$$${key}`, String(value ?? ''));
  }
  return xml;
};

// ── Helper: forward to Tally via device ──────────────────────────────────────
const forwardToTally = async (companyGuid, userId, xmlBody) => {
  // Find the paired device for this user+company
  const { rows } = await query(
    'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
    [userId]
  );
  const device = rows[0];
  if (!device) throw new Error('No paired device found');

  // Return the XML payload — desktop will pick it up and forward to Tally
  // In Phase 3, we'll add real-time forwarding via WebSocket
  return {
    deviceId: device.device_id,
    xml: xmlBody,
    status: 'pending', // Will be 'success' once desktop confirms
  };
};

// ── POST /tally/voucher/sales ─────────────────────────────────────────────────
router.post('/voucher/sales', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [], // [{ itemName, actualQty, billedQty, rate, amount, salesLedger, godown }]
    taxes = [], // [{ ledgerName, taxRate, taxAmount, taxableValue }]
    logistics = [], // [{ ledgerName, amount }]
    isOptional = false,
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const amt = parseFloat(totalAmount) || 0;

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>All Masters</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Sales" ACTION="Create">
  <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <REFERENCE>${reference || ''}</REFERENCE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>No</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${narration || ''}</NARRATION>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  // Inventory line items
  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
    <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    <RATE>${item.rate || 0}</RATE>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${item.salesLedger || 'Sales Account'}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
      <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  // Tax entries
  for (const tax of taxes) {
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${tax.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(tax.taxAmount)}</AMOUNT>
    <VATASSESSABLEVALUE>${parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  // Logistics/freight entries
  for (const lg of logistics) {
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERNAME>${lg.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
  }

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: isOptional ? 'Optional entry saved' : 'Sales invoice created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/payment ───────────────────────────────────────────────
router.post('/voucher/payment', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration,
    partyLedger, bankLedger, amount, isOptional = false,
  } = req.body;

  if (!companyGuid || !partyLedger || !bankLedger || !amount) {
    return res.status(400).json({ status: false, message: 'partyLedger, bankLedger and amount required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount);

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Payment" ACTION="Create">
  <DATE>${tallyDate(date)}</DATE>
  <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <NARRATION>${narration || ''}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${bankLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: isOptional ? 'Optional payment saved' : 'Payment created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/receipt ───────────────────────────────────────────────
router.post('/voucher/receipt', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration,
    partyLedger, bankLedger, amount, isOptional = false,
  } = req.body;

  if (!companyGuid || !partyLedger || !bankLedger || !amount) {
    return res.status(400).json({ status: false, message: 'partyLedger, bankLedger and amount required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount);

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Receipt" ACTION="Create">
  <DATE>${tallyDate(date)}</DATE>
  <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <NARRATION>${narration || ''}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${bankLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: isOptional ? 'Optional receipt saved' : 'Receipt created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/journal ───────────────────────────────────────────────
router.post('/voucher/journal', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration, reference,
    drLedger, crLedger, amount, isOptional = false,
  } = req.body;

  if (!companyGuid || !drLedger || !crLedger || !amount) {
    return res.status(400).json({ status: false, message: 'drLedger, crLedger and amount required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount);

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Journal" ACTION="Create">
  <DATE>${tallyDate(date)}</DATE>
  <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <NARRATION>${narration || ''}</NARRATION>
  <REFERENCE>${reference || ''}</REFERENCE>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${drLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${crLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: isOptional ? 'Optional journal saved' : 'Journal entry created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/contra ────────────────────────────────────────────────
router.post('/voucher/contra', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration,
    fromLedger, toLedger, amount, isOptional = false,
  } = req.body;

  if (!companyGuid || !fromLedger || !toLedger || !amount) {
    return res.status(400).json({ status: false, message: 'fromLedger, toLedger and amount required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount);

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Contra" ACTION="Create">
  <DATE>${tallyDate(date)}</DATE>
  <VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <NARRATION>${narration || ''}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${fromLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${toLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: isOptional ? 'Optional contra saved' : 'Contra entry created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/sales-order ──────────────────────────────────────────
router.post('/voucher/sales-order', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount, items = [], taxes = [], isOptional = true,
  } = req.body;

  // Sales Order is always optional by default (quotation/order)
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>All Masters</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Sales Order" ACTION="Create">
  <VOUCHERTYPENAME>Sales Order</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER>
  <REFERENCE>${reference || ''}</REFERENCE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${narration || ''}</NARRATION>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
    <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    <RATE>${item.rate || 0}</RATE>
    <ACCOUNTINGALLOCATIONS.LIST>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERNAME>${item.salesLedger || 'Sales Account'}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
      <ORDERNO>${voucherNumber || '1'}</ORDERNO>
      <ORDERDUEDATE>${dt}</ORDERDUEDATE>
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
      <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  for (const tax of taxes) {
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERNAME>${tax.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(tax.taxAmount)}</AMOUNT>
    <VATASSESSABLEVALUE>${parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  xml += `\n</VOUCHER>\n</TALLYMESSAGE>\n</REQUESTDATA>\n</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: 'Sales order created', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/master/party ──────────────────────────────────────────────────
router.post('/master/party', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName,
    name, parent = 'Sundry Debtors', address = '', state = '',
    country = 'India', gstin = '', email = '', phone = '',
    gstRegType = 'Regular', pincode = '', isBillWise = 'Yes',
  } = req.body;

  if (!companyGuid || !name) {
    return res.status(400).json({ status: false, message: 'companyGuid and name required' });
  }

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>All Masters</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER>
  <NAME>${name}</NAME>
  <PARENT>${parent}</PARENT>
  <EMAIL>${email}</EMAIL>
  <LEDGERMOBILE>${phone}</LEDGERMOBILE>
  <PRIORSTATENAME>${state}</PRIORSTATENAME>
  <PINCODE>${pincode}</PINCODE>
  <COUNTRYNAME>${country}</COUNTRYNAME>
  <GSTREGISTRATIONTYPE>${gstRegType}</GSTREGISTRATIONTYPE>
  <PARTYGSTIN>${gstin}</PARTYGSTIN>
  <LEDSTATENAME>${state}</LEDSTATENAME>
  <ISBILLWISEON>${isBillWise}</ISBILLWISEON>
  ${address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${address}</ADDRESS></ADDRESS.LIST>` : ''}
  <MAILINGNAME.LIST TYPE="String"><MAILINGNAME>${name}</MAILINGNAME></MAILINGNAME.LIST>
</LEDGER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    res.json({ status: true, message: 'Party/Ledger created in Tally', data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── GET /tally/write-status/:deviceId ────────────────────────────────────────
// Desktop polls this to get pending write requests to forward to Tally
router.get('/write-queue/:deviceId', async (req, res) => {
  // Placeholder — in Phase 3 this will serve pending write jobs to desktop
  res.json({ status: true, data: { queue: [] } });
});

export default router;
