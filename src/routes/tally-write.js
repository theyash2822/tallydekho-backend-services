// Tally Write API — creates vouchers/masters in Tally via desktop proxy
// Flow: App → Backend → Desktop proxy → Tally HTTP port (9000)
// The desktop app must have the /tally-proxy endpoint running (Phase 3)

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../db/schema.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Socket service reference - injected from server.js after startup
let _socketService = null;
export function setTallyWriteSocket(s) { _socketService = s; }

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
  const { rows } = await query(
    'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
    [userId]
  );
  const device = rows[0];
  if (!device) throw new Error('No paired device found. Please pair your desktop app first.');

  const jobId = require('crypto').randomUUID();

  if (_socketService && _socketService.connectedClients) {
    const desktopSocket = _socketService.connectedClients.get('desktop_' + device.device_id);
    if (desktopSocket && desktopSocket.connected) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Tally write timeout - is Tally Prime running?'));
        }, 20000);
        desktopSocket.emit('tally:write', { jobId, xml: xmlBody }, (result) => {
          clearTimeout(timeout);
          if (result && result.status) resolve(result);
          else reject(new Error((result && result.message) || 'Tally write failed'));
        });
      });
    }
  }

  return { deviceId: device.device_id, jobId, status: 'desktop_offline', message: 'Desktop not connected. Entry saved — will push when desktop comes online.' };
};

// ── Helper: log entry to write_queue ─────────────────────────────────────────
const logWriteQueue = async (userId, companyGuid, entryType, entryLabel, amount, payload, xml) => {
  const { rows } = await query(
    `INSERT INTO write_queue (user_id, company_guid, entry_type, entry_label, amount, payload, xml, status, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
     RETURNING id`,
    [userId, companyGuid, entryType, entryLabel, amount || null, JSON.stringify(payload), xml]
  );
  return rows[0]?.id;
};

// ── Helper: update write_queue after Tally response ───────────────────────────
const updateWriteQueue = async (id, result, error) => {
  if (!id) return;
  if (error) {
    await query(
      `UPDATE write_queue SET status = CASE WHEN error_message ILIKE '%Desktop not connected%' OR error_message ILIKE '%desktop_offline%' THEN 'desktop_offline' ELSE 'failed' END,
       error_message = $2, attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, error]
    );
  } else if (result?.status === 'desktop_offline' || (result?.message || '').includes('not connected')) {
    await query(
      `UPDATE write_queue SET status = 'desktop_offline', error_message = $2,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.message || 'Desktop offline']
    );
  } else {
    await query(
      `UPDATE write_queue SET status = 'success', tally_voucher_number = $2, tally_id = $3,
       error_message = NULL, attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.voucherNumber || null, result?.tallyId || null]
    );
  }
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
    voucherType = 'Sales GST',
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const amt = parseFloat(totalAmount) || 0;
  const vchType = voucherType || 'Sales GST';

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${vchType}" ACTION="Create">
  <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
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
      <LEDGERNAME>${item.salesLedger || 'Sales Account GST'}</LEDGERNAME>
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

  const label = `${partyLedger}${voucherNumber ? ' #' + voucherNumber : ''}`;
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'sales', label, amt, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(queueId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId, message: offline ? 'Entry saved. Will push to Tally when desktop connects.' : (isOptional ? 'Optional entry saved' : 'Sales invoice created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(queueId, null, e.message);
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'payment', `${partyLedger} -> ${bankLedger}`, amt, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional payment saved' : 'Payment created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'receipt', `${partyLedger} -> ${bankLedger}`, parseFloat(amount)||0, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional receipt saved' : 'Receipt created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'journal', narration || `${drLedger} / ${crLedger}`, amt, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional journal saved' : 'Journal entry created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'contra', `${fromLedger} -> ${toLedger}`, parseFloat(amount)||0, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional contra saved' : 'Contra entry created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
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
  <REPORTNAME>Vouchers</REPORTNAME>
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
      <LEDGERNAME>${item.salesLedger || 'Sales Account GST'}</LEDGERNAME>
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'sales_order', partyLedger, amt, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : 'Sales order created', data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'party', name, null, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : 'Party/Ledger created in Tally', data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── GET /tally/write-status/:deviceId ────────────────────────────────────────
// Desktop polls this to get pending write requests to forward to Tally
router.get('/write-queue/:deviceId', async (req, res) => {
  // Placeholder — in Phase 3 this will serve pending write jobs to desktop
  res.json({ status: true, data: { queue: [] } });
});


// GET /tally/report/:type - Request report from Tally via desktop
// type: profit-loss | balance-sheet | trial-balance | day-book | stock-summary | bills-receivable | bills-payable
router.post('/report', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, reportType, fromDate, toDate } = req.body;
  if (!companyGuid || !reportType) return res.status(400).json({ status: false, message: 'companyGuid and reportType required' });

  const reportMap = {
    'profit-loss':      'Profit and Loss',
    'balance-sheet':    'Balance Sheet',
    'trial-balance':    'Trial Balance',
    'day-book':         'Daybook',
    'stock-summary':    'Stock Summary',
    'bills-receivable': 'Bills Receivable',
    'bills-payable':    'Bills Payable',
  };

  const tallyReport = reportMap[reportType];
  if (!tallyReport) return res.status(400).json({ status: false, message: `Unknown report type: ${reportType}` });

  const fd = fromDate ? fromDate.split('-').reverse().join('-') : '01-04-2024';
  const td = toDate ? toDate.split('-').reverse().join('-') : '31-03-2025';

  // This is an export request — desktop will call Tally and return data
  const requestPayload = {
    type: 'report',
    reportName: tallyReport,
    companyName,
    fromDate: fd,
    toDate: td,
  };

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, JSON.stringify(requestPayload));
    res.json({ status: true, message: `${tallyReport} report requested`, data: result });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /tally/master/warehouse - Create Godown/Warehouse in Tally
router.post('/master/warehouse', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, name, parentGodown = '', address = '' } = req.body;
  if (!companyGuid || !name) return res.status(400).json({ status: false, message: 'companyGuid and name required' });
  const addressXml = address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${address}</ADDRESS></ADDRESS.LIST>` : '';
  const parentXml = parentGodown ? `<PARENT>${parentGodown}</PARENT>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><GODOWN ACTION="Create"><NAME>${name}</NAME>${parentXml}${addressXml}</GODOWN></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'warehouse', name, null, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : 'Warehouse created in Tally', data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});


// POST /tally/voucher/purchase-order
router.post('/voucher/purchase-order', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, date, voucherNumber, reference, narration, partyLedger, totalAmount, items = [], taxes = [], isOptional = true } = req.body;
  if (!companyGuid || !partyLedger) return res.status(400).json({ status: false, message: 'partyLedger required' });
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Purchase Order" ACTION="Create"><VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><REFERENCE>${reference||''}</REFERENCE><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration||''}</NARRATION><PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME><LEDGERENTRIES.LIST><REMOVEZEROENTRIES>No</REMOVEZEROENTRIES><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><LEDGERNAME>${partyLedger}</LEDGERNAME><AMOUNT>${amt}</AMOUNT></LEDGERENTRIES.LIST>`;
  for (const item of items) {
    const ia = parseFloat(item.amount)||0;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY><RATE>${item.rate||0}</RATE><ACCOUNTINGALLOCATIONS.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${item.purchaseLedger||'Purchase Account GST'}</LEDGERNAME><AMOUNT>${-ia}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${item.godown||'Main Location'}</GODOWNNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  for (const tax of taxes) { xml += `<LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${tax.ledgerName}</LEDGERNAME><AMOUNT>${-parseFloat(tax.taxAmount)}</AMOUNT><VATASSESSABLEVALUE>${-parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE></LEDGERENTRIES.LIST>`; }
  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'purchase_order', partyLedger, parseFloat(totalAmount)||0, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Purchase order created', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

// POST /tally/voucher/purchase
router.post('/voucher/purchase', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, date, voucherNumber, reference, narration, partyLedger, totalAmount, items = [], taxes = [], isOptional = false, voucherType = 'Purchase GST' } = req.body;
  if (!companyGuid || !partyLedger) return res.status(400).json({ status: false, message: 'partyLedger required' });
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  const vchType = voucherType || 'Purchase GST';
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${vchType}" ACTION="Create"><VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><REFERENCE>${reference||''}</REFERENCE><ISINVOICE>Yes</ISINVOICE><ISCANCELLED>No</ISCANCELLED><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration||''}</NARRATION><PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME><LEDGERENTRIES.LIST><REMOVEZEROENTRIES>No</REMOVEZEROENTRIES><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><LEDGERNAME>${partyLedger}</LEDGERNAME><AMOUNT>${amt}</AMOUNT></LEDGERENTRIES.LIST>`;
  for (const item of items) {
    const ia = parseFloat(item.amount)||0;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY><RATE>${item.rate||0}</RATE><ACCOUNTINGALLOCATIONS.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${item.purchaseLedger||'Purchase Account GST'}</LEDGERNAME><AMOUNT>${-ia}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${item.godown||'Main Location'}</GODOWNNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  for (const tax of taxes) { xml += `<LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${tax.ledgerName}</LEDGERNAME><AMOUNT>${-parseFloat(tax.taxAmount)}</AMOUNT><VATASSESSABLEVALUE>${-parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE></LEDGERENTRIES.LIST>`; }
  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'purchase', partyLedger, parseFloat(totalAmount)||0, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional purchase saved' : 'Purchase invoice created'), data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});


router.post('/voucher/credit-note', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, date, voucherNumber, reference, narration, partyLedger, totalAmount, items = [], taxes = [], isOptional = false } = req.body;
  if (!companyGuid || !partyLedger) return res.status(400).json({ status: false, message: 'partyLedger required' });
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Credit Note" ACTION="Create"><VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><REFERENCE>${reference||''}</REFERENCE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration||''}</NARRATION><PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME><LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><LEDGERNAME>${partyLedger}</LEDGERNAME><AMOUNT>${amt}</AMOUNT></LEDGERENTRIES.LIST>`;
  for (const item of items) {
    const ia = parseFloat(item.amount)||0;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY><RATE>${item.rate||0}</RATE><ACCOUNTINGALLOCATIONS.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${item.returnLedger||'Sales Return'}</LEDGERNAME><AMOUNT>${-ia}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${item.godown||'Main Location'}</GODOWNNAME><AMOUNT>${-ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  for (const tax of taxes) { xml += `<LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><LEDGERNAME>${tax.ledgerName}</LEDGERNAME><AMOUNT>${-parseFloat(tax.taxAmount)}</AMOUNT><VATASSESSABLEVALUE>${-parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE></LEDGERENTRIES.LIST>`; }
  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'credit_note', partyLedger, parseFloat(totalAmount)||0, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Credit note created', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

router.post('/voucher/debit-note', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, date, voucherNumber, reference, narration, partyLedger, totalAmount, items = [], taxes = [], isOptional = false } = req.body;
  if (!companyGuid || !partyLedger) return res.status(400).json({ status: false, message: 'partyLedger required' });
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Debit Note" ACTION="Create"><VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><REFERENCE>${reference||''}</REFERENCE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration||''}</NARRATION><PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME><LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER><LEDGERNAME>${partyLedger}</LEDGERNAME><AMOUNT>${-amt}</AMOUNT></LEDGERENTRIES.LIST>`;
  for (const item of items) {
    const ia = parseFloat(item.amount)||0;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY><RATE>${item.rate||0}</RATE><ACCOUNTINGALLOCATIONS.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><LEDGERNAME>${item.returnLedger||'Purchase Return'}</LEDGERNAME><AMOUNT>${ia}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${item.godown||'Main Location'}</GODOWNNAME><AMOUNT>${ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  for (const tax of taxes) { xml += `<LEDGERENTRIES.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><LEDGERNAME>${tax.ledgerName}</LEDGERNAME><AMOUNT>${parseFloat(tax.taxAmount)}</AMOUNT><VATASSESSABLEVALUE>${parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE></LEDGERENTRIES.LIST>`; }
  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'debit_note', partyLedger, parseFloat(totalAmount)||0, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Debit note created', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

router.post('/voucher/delivery-note', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, date, voucherNumber, reference, narration, partyLedger, items = [], isOptional = false } = req.body;
  if (!companyGuid || !partyLedger) return res.status(400).json({ status: false, message: 'partyLedger required' });
  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Delivery Note" ACTION="Create"><VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><REFERENCE>${reference||''}</REFERENCE><ISINVOICE>Yes</ISINVOICE><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration||''}</NARRATION><PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>`;
  for (const item of items) {
    const ia = parseFloat(item.amount)||0;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY><RATE>${item.rate||0}</RATE><ACCOUNTINGALLOCATIONS.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><LEDGERNAME>${item.salesLedger||'Sales Account'}</LEDGERNAME><AMOUNT>${ia}</AMOUNT></ACCOUNTINGALLOCATIONS.LIST><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${item.godown||'Main Location'}</GODOWNNAME><TRACKINGNUMBER>${item.trackingNumber||''}</TRACKINGNUMBER><AMOUNT>${ia}</AMOUNT><ACTUALQTY>${item.actualQty||1}</ACTUALQTY><BILLEDQTY>${item.billedQty||1}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }
  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'delivery_note', partyLedger, null, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Delivery note created', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

router.post('/voucher/cancel', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, voucherGuid, voucherType, voucherNumber, date } = req.body;
  if (!companyGuid || !voucherGuid) return res.status(400).json({ status: false, message: 'voucherGuid required' });
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${voucherType}" ACTION="Cancel"><DATE>${tallyDate(date)}</DATE><VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><GUID>${voucherGuid}</GUID></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); res.json({ status: true, message: 'Voucher cancelled in Tally', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { res.status(500).json({ status: false, message: e.message }); }
});

router.post('/master/stock-item', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, name, groupName = 'Primary', category = '', unit = 'Nos', openingQty = 0, openingRate = 0, hsnCode = '', igstRate = 0, cgstRate = 0, sgstRate = 0 } = req.body;
  if (!companyGuid || !name) return res.status(400).json({ status: false, message: 'name required' });
  const openVal = parseFloat(openingQty) * parseFloat(openingRate);
  const gstAppl = (igstRate > 0 || cgstRate > 0) ? 'Applicable' : 'Not Applicable';
  const openXml = openingQty > 0 ? `<OPENINGBALANCE>${openingQty} ${unit}</OPENINGBALANCE><OPENINGRATE>${openingRate} /${unit}</OPENINGRATE><OPENINGVALUE>${openVal}</OPENINGVALUE>` : '';
  const gstXml = hsnCode ? `<GSTAPPLICABLE>${gstAppl}</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM><HSNCODE>${hsnCode}</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>Any State</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${igstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${cgstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${sgstRate}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM ACTION="Create"><NAME>${name}</NAME><PARENT>${groupName}</PARENT>${category?`<CATEGORY>${category}</CATEGORY>`:''}<BASEUNITS>${unit}</BASEUNITS>${openXml}${gstXml}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'item', name, null, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock item created in Tally', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

// POST /tally/voucher/stock-transfer
router.post('/voucher/stock-transfer', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration,
    fromGodown, toGodown,
    items = [],
    isOptional = false,
  } = req.body;
  if (!companyGuid || !fromGodown || !toGodown) {
    return res.status(400).json({ status: false, message: 'fromGodown and toGodown required' });
  }
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';

  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Stock Journal" ACTION="Create"><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration || ''}</NARRATION>`;

  for (const item of items) {
    const qty = parseFloat(item.qty) || 1;
    const rate = parseFloat(item.rate) || 0;
    const amt = parseFloat(item.amount) || qty * rate;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY><RATE>${rate}</RATE><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${fromGodown}</GODOWNNAME><AMOUNT>${amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }

  for (const item of items) {
    const qty = parseFloat(item.qty) || 1;
    const rate = parseFloat(item.rate) || 0;
    const amt = parseFloat(item.amount) || qty * rate;
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${-amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY><RATE>${rate}</RATE><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${toGodown}</GODOWNNAME><AMOUNT>${-amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }

  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_transfer', `${fromGodown} → ${toGodown}`, null, req.body, xml).catch(() => null);
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    const off = r?.status === 'desktop_offline';
    res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock transfer created', data: r, voucherNumber: r?.voucherNumber || null });
  } catch(e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /tally/voucher/stock-adjustment
router.post('/voucher/stock-adjustment', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, narration,
    godown,
    items = [],
    isOptional = false,
  } = req.body;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';

  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Physical Stock" ACTION="Create"><VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration || ''}</NARRATION>`;

  for (const item of items) {
    const qty = parseFloat(item.adjustedQty) || 0;
    const rate = parseFloat(item.rate) || 0;
    const amt = parseFloat(item.amount) || Math.abs(qty * rate);
    xml += `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${item.itemName}</STOCKITEMNAME><AMOUNT>${-amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY><RATE>${rate}</RATE><BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><GODOWNNAME>${godown || item.godown || 'Main Location'}</GODOWNNAME><AMOUNT>${-amt}</AMOUNT><ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`;
  }

  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_adjustment', godown || 'Stock Adjustment', null, req.body, xml).catch(() => null);
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    const off = r?.status === 'desktop_offline';
    res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock adjustment created', data: r, voucherNumber: r?.voucherNumber || null });
  } catch(e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── GET /tally/audit-trail — fetch write queue for a company ─────────────────
router.get('/audit-trail', authMiddleware, async (req, res) => {
  const { companyGuid, status, limit = 50, offset = 0 } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const conditions = ['company_guid = $1', 'user_id = $2'];
    const params = [companyGuid, req.user.userId];
    if (status) { conditions.push(`status = $${params.length + 1}`); params.push(status); }
    const { rows } = await query(
      `SELECT id, entry_type, entry_label, amount, status, tally_voucher_number, tally_id, error_message, attempt_count, created_at, updated_at, source
       FROM write_queue WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), parseInt(offset)]
    );
    const { rows: countRows } = await query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as success_count,
       SUM(CASE WHEN status='desktop_offline' THEN 1 ELSE 0 END) as offline_count,
       SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed_count,
       SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending_count
       FROM write_queue WHERE company_guid = $1 AND user_id = $2`,
      [companyGuid, req.user.userId]
    );
    res.json({ status: true, data: { entries: rows, stats: countRows[0] } });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/audit-trail/:id/retry — manually retry one entry ──────────────
router.post('/audit-trail/:id/retry', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query(
      'SELECT * FROM write_queue WHERE id = $1 AND user_id = $2',
      [id, req.user.userId]
    );
    const entry = rows[0];
    if (!entry) return res.status(404).json({ status: false, message: 'Entry not found' });
    if (entry.status === 'success') return res.json({ status: true, message: 'Already pushed to Tally', alreadySuccess: true });
    if (!entry.xml) return res.status(400).json({ status: false, message: 'No XML stored for retry' });

    await query(`UPDATE write_queue SET status='pending', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [id]);
    const result = await forwardToTally(entry.company_guid, req.user.userId, entry.xml);
    await updateWriteQueue(id, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({
      status: true,
      queued: offline,
      message: offline ? 'Desktop still offline. Entry is queued.' : 'Successfully pushed to Tally',
      voucherNumber: result?.voucherNumber || null,
    });
  } catch (e) {
    await updateWriteQueue(id, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── Auto-retry: called when desktop comes online ───────────────────────────────
export async function retryOfflineEntries(userId, companyGuid) {
  try {
    const { rows } = await query(
      `SELECT * FROM write_queue WHERE user_id=$1 AND company_guid=$2 AND status IN ('desktop_offline','pending','failed') AND attempt_count < 5 ORDER BY created_at ASC LIMIT 20`,
      [userId, companyGuid]
    );
    if (!rows.length) return;
    console.log(`[write_queue] auto-retry: ${rows.length} entries for user ${userId}`);
    for (const entry of rows) {
      if (!entry.xml) continue;
      try {
        await query(`UPDATE write_queue SET status='pending', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [entry.id]);
        const result = await forwardToTally(companyGuid, userId, entry.xml);
        await updateWriteQueue(entry.id, result, null);
        console.log(`[write_queue] entry ${entry.id} (${entry.entry_type}: ${entry.entry_label}) → ${result?.status || 'done'}`);
      } catch (err) {
        await updateWriteQueue(entry.id, null, err.message);
        console.error(`[write_queue] entry ${entry.id} retry failed: ${err.message}`);
      }
    }
  } catch (e) {
    console.error('[write_queue] retryOfflineEntries error:', e.message);
  }
}

export default router;
