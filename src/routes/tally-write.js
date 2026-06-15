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
  // No device paired — queue it anyway; will push when device pairs
  if (!device) return { status: 'desktop_offline', message: 'No paired desktop. Entry saved — will push when desktop connects.' };

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
  // Use 'processing' status so retryOfflineEntries won't grab this entry
  // while forwardToTally is still in flight (prevents duplicate sends).
  // Status will be updated to 'success', 'desktop_offline', or 'failed' after the attempt.
  const { rows } = await query(
    `INSERT INTO write_queue (user_id, company_guid, entry_type, entry_label, amount, payload, xml, status, attempt_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', 0, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
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
      `UPDATE write_queue SET status = CASE WHEN $2 ILIKE '%Desktop not connected%' OR $2 ILIKE '%desktop_offline%' OR $2 ILIKE '%not reachable%' THEN 'desktop_offline' ELSE 'failed' END,
       error_message = $2, attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, String(error)]
    );
  } else if (result?.status === 'desktop_offline' || (result?.message || '').includes('not connected')) {
    await query(
      `UPDATE write_queue SET status = 'desktop_offline', error_message = $2,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.message || 'Desktop offline']
    );
  } else if (result?.status === false) {
    // Tally rejected the entry (LINEERROR or other Tally-side failure) — mark as failed, NOT success.
    // This was the silent failure bug: Tally rejections were being marked 'success'.
    await query(
      `UPDATE write_queue SET status = 'failed', error_message = $2,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.message || 'Tally rejected the entry']
    );
  } else {
    await query(
      `UPDATE write_queue SET status = 'success', tally_voucher_number = $2, tally_id = $3,
       error_message = NULL, attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.voucherNumber || null, result?.tallyId || null]
    );
  }
};

// ── TDK Reference Generator ────────────────────────────────────────────────────
async function generateTDKReference(companyGuid, isOptional, voucherTypeCode = 'SAL') {
  const prefix = isOptional ? `OPT-${voucherTypeCode}` : voucherTypeCode;
  const year = new Date().getFullYear();
  const { rows } = await query(
    `INSERT INTO tdk_reference_counters (company_guid, voucher_prefix, fiscal_year, last_seq)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_guid, voucher_prefix, fiscal_year)
     DO UPDATE SET last_seq = tdk_reference_counters.last_seq + 1
     RETURNING last_seq`,
    [companyGuid, prefix, year]
  );
  const seq = rows[0].last_seq;
  return `TDK-${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

// ── POST /tally/voucher/sales ─────────────────────────────────────────────
router.post('/voucher/sales', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [], // [{ itemName, actualQty, billedQty, rate, amount, salesLedger, godown }]
    taxes = [], // [{ ledgerName, taxRate, taxAmount, taxableValue }]
    logistics = [], // [{ ledgerName, amount }]
    isOptional = false,
    voucherType = 'Sales GST',
    original_entry_type = 'regular',
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const amt = parseFloat(totalAmount) || 0;
  const vchType = voucherType || 'Sales GST';

  // Generate TDK reference
  const tdkRef = await generateTDKReference(companyGuid, isOptional).catch(() => null);

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
  <REFERENCE>${tdkRef || reference || ''}</REFERENCE>
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

  // Create app_voucher lifecycle record
  if (queueId && tdkRef) {
    await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type, tally_sync_status, books_impact_status, party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'sales_invoice',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9)`,
      [companyGuid, req.user.userId, queueId, tdkRef, original_entry_type, partyLedger, amt, date ? new Date(date) : null, JSON.stringify(req.body)]
    ).catch(e => console.error('[app_vouchers] insert failed:', e.message));
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(queueId, result, null);
    const offline = result?.status === 'desktop_offline';
    res.json({ status: true, queued: offline, queueId, tdkReferenceNo: tdkRef, message: offline ? 'Entry saved. Will push to Tally when desktop connects.' : (isOptional ? 'Optional entry saved' : 'Sales invoice created'), data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
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
  // Skip <PARENT> if empty or 'Primary' — Tally auto-assigns to root. Sending 'Primary' causes
  // "Godown does not exist" error if the user's Tally doesn't have a godown named 'Primary'.
  const effectiveParent = (parentGodown && parentGodown.toLowerCase() !== 'primary') ? parentGodown : '';
  const parentXml = effectiveParent ? `<PARENT>${effectiveParent}</PARENT>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><GODOWN NAME="${name}" ACTION="Create"><NAME>${name}</NAME>${parentXml}${addressXml}</GODOWN></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
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
  const { companyGuid, companyName, name, groupName, category = '', unit = 'Nos', openingQty = 0, openingRate = 0, hsnCode = '', igstRate = 0, cgstRate = 0, sgstRate = 0 } = req.body;
  if (!companyGuid || !name) return res.status(400).json({ status: false, message: 'name required' });
  if (!groupName) return res.status(400).json({ status: false, message: 'groupName required — select a stock group from your Tally groups' });
  const openVal = parseFloat(openingQty) * parseFloat(openingRate);
  const gstAppl = (igstRate > 0 || cgstRate > 0) ? 'Applicable' : 'Not Applicable';
  const openXml = openingQty > 0 ? `<OPENINGBALANCE>${openingQty} ${unit}</OPENINGBALANCE><OPENINGRATE>${openingRate} /${unit}</OPENINGRATE><OPENINGVALUE>${openVal}</OPENINGVALUE>` : '';
  const _today = new Date(); const _appFrom = `${_today.getFullYear()}${String(_today.getMonth()+1).padStart(2,'0')}${String(_today.getDate()).padStart(2,'0')}`;
  const gstXml = hsnCode ? `<GSTAPPLICABLE>${gstAppl}</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>${_appFrom}</APPLICABLEFROM><HSNCODE>${hsnCode}</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>Any State</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${igstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${cgstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${sgstRate}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM ACTION="Create"><NAME>${name}</NAME><PARENT>${groupName}</PARENT>${category?`<CATEGORY>${category}</CATEGORY>`:''}<BASEUNITS>${unit}</BASEUNITS>${openXml}${gstXml}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'item', name, null, req.body, xml).catch(() => null);
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); await updateWriteQueue(qId, r, null); const off = r?.status === 'desktop_offline'; res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock item created in Tally', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { updateWriteQueue(qId, null, e.message); res.status(500).json({ status: false, message: e.message }); }
});

// POST /tally/master/stock-item-alter — Stock Item Master Alteration (NOT a voucher)
// Used for editing: name, HSN, unit, reorder level, GST rate, etc.
router.post('/master/stock-item-alter', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, existingName, changes = {} } = req.body;
  if (!companyGuid || !existingName) return res.status(400).json({ status: false, message: 'existingName required' });

  // Build only the fields being changed.
  // IMPORTANT: hsnCode + taxRate MUST be merged into ONE <GSTDETAILS.LIST> block.
  // Two separate GSTDETAILS.LIST in the same STOCKITEM Alter causes Tally to
  // throw "Duplicate Entry!" because it treats the second block as a new record.
  let fieldsXml = '';
  if (changes.name)         fieldsXml += `<NAME>${changes.name}</NAME>`;
  if (changes.unit)         fieldsXml += `<BASEUNITS>${changes.unit}</BASEUNITS>`;
  if (changes.reorderLevel !== undefined) fieldsXml += `<REORDERLEVEL>${changes.reorderLevel}</REORDERLEVEL>`;
  if (changes.groupName)    fieldsXml += `<PARENT>${changes.groupName}</PARENT>`;
  // Merge hsnCode + taxRate into a single GSTDETAILS.LIST.
  // Use today's date as APPLICABLEFROM so Tally adds a new effective rule
  // that overrides the old one (hardcoded 20170701 gets ignored by Tally if already exists).
  if (changes.hsnCode || changes.taxRate !== undefined) {
    const hsn  = changes.hsnCode || '';
    const rate = changes.taxRate !== undefined ? parseFloat(changes.taxRate) : null;
    // Format today as YYYYMMDD for Tally
    const today = new Date();
    const applicableFrom = `${today.getFullYear()}${String(today.getMonth()+1).padStart(2,'0')}${String(today.getDate()).padStart(2,'0')}`;
    const rateXml = rate !== null
      ? `<STATEWISEDETAILS.LIST><STATENAME>Any State</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${rate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${rate/2}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${rate/2}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST>`
      : '';
    const hsnXml = hsn ? `<HSNCODE>${hsn}</HSNCODE>` : '';
    fieldsXml += `<GSTDETAILS.LIST><APPLICABLEFROM>${applicableFrom}</APPLICABLEFROM>${hsnXml}<TAXABILITY>Taxable</TAXABILITY>${rateXml}</GSTDETAILS.LIST>`;
  }

  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM ACTION="Alter" NAME="${existingName}">${fieldsXml}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'alter_stock_item', existingName, null, req.body, xml).catch(() => null);
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    if (r?.status === false) {
      // Tally rejected (LINEERROR) — return error so mobile shows failure, not fake success
      return res.status(422).json({ status: false, queued: false, queueId: qId, message: r?.message || 'Tally rejected the update. Check stock item name and fields.' });
    }
    const off = r?.status === 'desktop_offline';
    res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock item updated in Tally' });
  } catch(e) {
    await updateWriteQueue(qId, null, e.message);
    res.json({ status: true, queued: true, queueId: qId, message: 'Saved. Will push to Tally when desktop connects.' });
  }
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

  // Stock Journal XML — correct Tally Prime structure for godown transfers.
  // Uses INVENTORYENTRIESOUT.LIST (outward) + INVENTORYENTRIESIN.LIST (inward)
  // NOT ALLINVENTORYENTRIES.LIST which causes "No Entries in Voucher" rejection.
  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Stock Journal" ACTION="Create"><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><VOUCHERNUMBER>${voucherNumber || ''}</VOUCHERNUMBER><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${narration || ''}</NARRATION>`;

  for (const item of items) {
    const qty = parseFloat(item.qty) || 1;
    // Outward: stock leaves source godown
    xml += `<INVENTORYENTRIESOUT.LIST>`;
    xml += `<STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>`;
    xml += `<ACTUALQTY>-${qty}</ACTUALQTY><BILLEDQTY>-${qty}</BILLEDQTY>`;
    xml += `<RATE>0</RATE><AMOUNT>0</AMOUNT>`;
    xml += `<BATCHALLOCATIONS.LIST>`;
    xml += `<GODOWNNAME>${fromGodown}</GODOWNNAME>`;
    xml += `<ACTUALQTY>-${qty}</ACTUALQTY><BILLEDQTY>-${qty}</BILLEDQTY>`;
    xml += `<AMOUNT>0</AMOUNT>`;
    xml += `</BATCHALLOCATIONS.LIST>`;
    xml += `</INVENTORYENTRIESOUT.LIST>`;
    // Inward: stock enters destination godown
    xml += `<INVENTORYENTRIESIN.LIST>`;
    xml += `<STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>`;
    xml += `<ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY>`;
    xml += `<RATE>0</RATE><AMOUNT>0</AMOUNT>`;
    xml += `<BATCHALLOCATIONS.LIST>`;
    xml += `<GODOWNNAME>${toGodown}</GODOWNNAME>`;
    xml += `<ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY>`;
    xml += `<AMOUNT>0</AMOUNT>`;
    xml += `</BATCHALLOCATIONS.LIST>`;
    xml += `</INVENTORYENTRIESIN.LIST>`;
  }

  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

  // Compute transfer value = sum of (qty × rate) for all items
  const transferValue = items.reduce((sum, item) => sum + (parseFloat(item.qty) || 0) * (parseFloat(item.rate) || 0), 0);
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_transfer', `${fromGodown} → ${toGodown}`, transferValue || null, req.body, xml).catch(() => null);
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    const off = r?.status === 'desktop_offline';
    res.json({ status: true, queued: off, queueId: qId, message: off ? 'Saved. Will push when desktop connects.' : 'Stock transfer created in Tally', data: r });
  } catch(e) {
    // Timeout or Tally error — still mark as queued for retry
    await updateWriteQueue(qId, null, e.message);
    res.json({ status: true, queued: true, queueId: qId, message: 'Saved. Will push to Tally when desktop connects.' });
  }
});

// POST /tally/voucher/stock-adjustment
// Creates a Stock Journal in Tally for reason-based quantity adjustments.
// Reasons: Damage, Shortage, Expired, Lost → outward (reduces stock)
//          Excess → inward (increases stock)
//          Correction + direction(Add/Reduce) → inward or outward
router.post('/voucher/stock-adjustment', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName,
    stockGuid, stockName,
    warehouse,
    adjustmentQty,
    adjustmentReason,
    adjustmentDirection,  // 'Add' | 'Reduce' — only for Correction
    qtyBefore,
    note,
    date,
  } = req.body;

  if (!companyGuid || !stockName || !adjustmentQty || !adjustmentReason) {
    return res.status(400).json({ status: false, message: 'stockName, adjustmentQty, adjustmentReason required' });
  }

  // ── Determine direction ─────────────────────────────────────────────────────
  const REDUCE_REASONS = ['Damage', 'Shortage', 'Expired', 'Lost'];
  const INCREASE_REASONS = ['Excess'];

  let isIncrease = false;
  if (REDUCE_REASONS.includes(adjustmentReason)) {
    isIncrease = false;
  } else if (INCREASE_REASONS.includes(adjustmentReason)) {
    isIncrease = true;
  } else if (adjustmentReason === 'Correction') {
    isIncrease = adjustmentDirection === 'Add';
  } else {
    return res.status(400).json({ status: false, message: 'Invalid adjustmentReason' });
  }

  const qty     = Math.abs(parseFloat(adjustmentQty));
  const qtyChange = isIncrease ? qty : -qty;
  const qtyAfter  = parseFloat(qtyBefore || 0) + qtyChange;
  const godown    = warehouse || 'Main Location';
  const dt        = tallyDate(date);
  const narration = `${adjustmentReason}${adjustmentDirection ? ' - ' + adjustmentDirection : ''}${note ? ' | ' + note : ''}`;

  // ── Build Physical Stock XML ──────────────────────────────────────────────
  // Physical Stock sets the ABSOLUTE final quantity in a godown.
  // Tally does not require both IN/OUT to balance — it simply overrides the physical count.
  // qtyAfter = qtyBefore + qtyChange (computed above)
  const absQty = Math.max(0, qtyAfter); // never negative

  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Physical Stock" ACTION="Create"><VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE><ISOPTIONAL>No</ISOPTIONAL><NARRATION>${narration}</NARRATION><ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${stockName}</STOCKITEMNAME><ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY><RATE>0</RATE><AMOUNT>0</AMOUNT><BATCHALLOCATIONS.LIST><GODOWNNAME>${godown}</GODOWNNAME><ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY><AMOUNT>0</AMOUNT></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  // ── Log to write_queue ───────────────────────────────────────────────────────
  const label = `${adjustmentReason}: ${stockName} (${isIncrease ? '+' : '-'}${qty} @ ${godown})`;
  // Compute adjustment value from rate if available
  const adjValue = qty * (parseFloat(req.body.rate) || 0);
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_adjustment', label, adjValue || null, req.body, xml).catch(() => null);

  // ── Save audit record to stock_adjustments ───────────────────────────────────
  const { rows: adjRows } = await query(`
    INSERT INTO stock_adjustments
      (company_guid, user_id, stock_guid, stock_name, warehouse, adjustment_reason,
       adjustment_direction, qty_before, adjustment_qty, qty_change, qty_after, note, status, write_queue_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13)
    RETURNING id
  `, [
    companyGuid, req.user.userId,
    stockGuid || stockName, stockName, godown,
    adjustmentReason, adjustmentDirection || null,
    parseFloat(qtyBefore || 0), qty, qtyChange, qtyAfter,
    note || null, qId || null,
  ]).catch(() => ({ rows: [{}] }));
  const adjustmentId = adjRows[0]?.id || null;

  // ── Forward to Tally ─────────────────────────────────────────────────────────
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    // Update adjustment status
    if (adjustmentId) {
      const newStatus = (r?.status === 'desktop_offline' || (r?.message || '').includes('offline')) ? 'QUEUED' : 'PUSHED_TO_TALLY';
      await query(`UPDATE stock_adjustments SET status=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`, [newStatus, adjustmentId]).catch(() => {});
    }
    const off = r?.status === 'desktop_offline';
    res.json({
      status: true, queued: off, queueId: qId, adjustmentId,
      message: off ? 'Saved. Will push to Tally when desktop connects.' : 'Stock adjustment created in Tally',
      data: r, voucherNumber: r?.voucherNumber || null,
    });
  } catch(e) {
    await updateWriteQueue(qId, null, e.message);
    if (adjustmentId) {
      await query(`UPDATE stock_adjustments SET status='FAILED', error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`, [e.message, adjustmentId]).catch(() => {});
    }
    // Still return 200 — adjustment is saved, will retry
    res.json({
      status: true, queued: true, queueId: qId, adjustmentId,
      message: 'Saved. Will push to Tally when desktop connects.',
    });
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

    // Mark as processing first to prevent retryOfflineEntries from racing
    await query(`UPDATE write_queue SET status='processing', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [id]);
    const result = await forwardToTally(entry.company_guid, req.user.userId, entry.xml);
    await updateWriteQueue(id, result, null);
    const offline = result?.status === 'desktop_offline';
    if (result?.status === false) {
      return res.status(422).json({ status: false, message: result?.message || 'Tally rejected the entry' });
    }
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
// Retry a single write_queue entry by id (used by /my-entries/:id/retry)
export async function retrySingleEntry(entryId, userId) {
  try {
    const { rows } = await query(`SELECT * FROM write_queue WHERE id=$1 AND user_id=$2`, [entryId, userId]);
    const entry = rows[0];
    if (!entry || !entry.xml) return { success: false, message: 'Entry not found or no XML' };
    if (entry.status === 'success') return { success: true, alreadySuccess: true, message: 'Already pushed to Tally' };
    // Mark as processing so retryOfflineEntries won't race
    await query(`UPDATE write_queue SET status='processing', error_message=NULL, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [entryId]);
    const result = await forwardToTally(entry.company_guid, userId, entry.xml);
    await updateWriteQueue(entryId, result, null);
    const offline = result?.status === 'desktop_offline';
    return {
      success: true,
      queued: offline,
      message: offline
        ? 'Desktop offline. Entry queued.'
        : result?.status === false
          ? `Tally rejected: ${result.message}`
          : 'Successfully pushed to Tally',
    };
  } catch (err) {
    await updateWriteQueue(entryId, null, err.message).catch(() => {});
    return { success: false, message: err.message };
  }
}

export async function retryOfflineEntries(userId, companyGuid) {
  try {
    // companyGuid may be null when called on desktop reconnect — fetch ALL pending for this user
    // Only retry 'desktop_offline' and 'failed' entries.
    // Do NOT include 'pending' or 'processing' — those are actively being forwarded
    // and picking them up here would cause duplicate entries in Tally.
    const { rows } = companyGuid
      ? await query(
          `SELECT * FROM write_queue WHERE user_id=$1 AND company_guid=$2 AND status IN ('desktop_offline','failed') AND attempt_count < 5 ORDER BY created_at ASC LIMIT 20`,
          [userId, companyGuid]
        )
      : await query(
          `SELECT * FROM write_queue WHERE user_id=$1 AND status IN ('desktop_offline','failed') AND attempt_count < 5 ORDER BY created_at ASC LIMIT 20`,
          [userId]
        );
    if (!rows.length) return;
    console.log(`[write_queue] auto-retry: ${rows.length} entries for user ${userId}`);
    for (const entry of rows) {
      if (!entry.xml) continue;
      try {
        await query(`UPDATE write_queue SET status='processing', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [entry.id]);
        const result = await forwardToTally(entry.company_guid, userId, entry.xml);
        await updateWriteQueue(entry.id, result, null);
        // Update stock_adjustment status if linked
        if (entry.entry_type === 'stock_adjustment' && result?.status !== 'desktop_offline') {
          const newStatus = (result?.status === 'desktop_offline') ? 'QUEUED' : 'PUSHED_TO_TALLY';
          await query(`UPDATE stock_adjustments SET status=$1, tally_voucher_number=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE write_queue_id=$3`, [newStatus, result?.voucherNumber || null, entry.id]).catch(() => {});
        }
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

// ── V2 Write-back Lifecycle ──────────────────────────────────────────────────
// Status lifecycle: draft → submitted → queued → processing → posted | failed
// Maps to existing: pending=queued, success=posted, failed=failed, desktop_offline=queued

// GET /write-queue/status/:id — get lifecycle status for a write-queue entry
router.get('/write-queue/status/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await query(
      `SELECT id, entry_type, entry_label, amount, status, tally_voucher_number, tally_id,
              error_message, attempt_count, created_at, updated_at,
              CASE status
                WHEN 'pending'         THEN 'queued'
                WHEN 'success'         THEN 'posted'
                WHEN 'desktop_offline' THEN 'queued'
                WHEN 'failed'          THEN 'failed'
                ELSE status
              END as v2_status
       FROM write_queue WHERE id = $1 AND user_id = $2`,
      [id, req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ status: false, error: { code: 'NOT_FOUND' } });
    res.json({ status: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ status: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /write-queue/history?companyGuid=&status= — full write-back audit trail
router.get('/write-queue/history', authMiddleware, async (req, res) => {
  const { companyGuid, status, limit = 50, offset = 0 } = req.query;
  const companyGuidVal = companyGuid || req.user.companyGuid;
  try {
    let q = `SELECT id, entry_type, entry_label, amount, status, tally_voucher_number,
                    error_message, attempt_count, created_at, updated_at,
                    CASE status
                      WHEN 'pending'         THEN 'queued'
                      WHEN 'success'         THEN 'posted'
                      WHEN 'desktop_offline' THEN 'queued'
                      WHEN 'failed'          THEN 'failed'
                      ELSE status
                    END as v2_status
             FROM write_queue WHERE user_id = $1 AND company_guid = $2`;
    const params = [req.user.userId, companyGuidVal];
    if (status) { q += ` AND status = $${params.length + 1}`; params.push(status); }
    q += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await query(q, params);
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── POST /tally/master/bank ─────────────────────────────────────────────────────────────────────
router.post('/master/bank', authMiddleware, async (req, res) => {
  const { companyGuid, bankName, accountNumber, ifsc, accountType, openingBalance } = req.body;
  if (!companyGuid || !bankName)
    return res.status(400).json({ status: false, message: 'companyGuid and bankName required' });

  const ledgerName = bankName.trim();
  const parentGroup = accountType === 'OD' || accountType === 'CC'
    ? 'Bank OD A/c'
    : 'Bank Accounts';
  const openBal = parseFloat(openingBalance) || 0;

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER NAME="${ledgerName}" ACTION="Create">
  <NAME>${ledgerName}</NAME>
  <PARENT>${parentGroup}</PARENT>
  <OPENINGBALANCE>${openBal > 0 ? openBal.toFixed(2) + ' Dr' : Math.abs(openBal).toFixed(2) + ' Cr'}</OPENINGBALANCE>
  ${ifsc ? `<IFSCODE>${ifsc}</IFSCODE>` : ''}
  ${accountNumber ? `<BANKACNO>${accountNumber}</BANKACNO>` : ''}
  <ISDEFAULTLEDGER>No</ISDEFAULTLEDGER>
</LEDGER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const payload = { companyGuid, bankName, accountNumber, ifsc, accountType, openingBalance };
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'bank', ledgerName, openBal, payload, xml);
  let result;
  try {
    result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(queueId, result, null);
    return res.json({ status: true, data: { message: 'Bank ledger created in Tally', bankName: ledgerName, queueId, tallyResult: result } });
  } catch (err) {
    await updateWriteQueue(queueId, null, err.message);
    // Still return 200 - entry is queued for when desktop comes online
    return res.json({ status: true, data: { message: 'Bank ledger queued - will push when Tally is online', bankName: ledgerName, queueId, error: err.message } });
  }
});

// GET /tally/master/bank — fetch saved bank accounts for a company
router.get('/master/bank', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const { rows } = await query(`
      SELECT id, payload, status, created_at
      FROM write_queue
      WHERE user_id=$1 AND company_guid=$2 AND operation='bank'
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.userId, companyGuid]);
    const accounts = rows.map(r => ({
      id: r.id.toString(),
      ...r.payload,
      status: r.status,
      createdAt: r.created_at,
    }));
    res.json({ status: true, data: accounts });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// BARCODE TALLY SYNC — Phase 1 (Part Number) + Phase 2 (Alias)
// UDF intentionally skipped (requires TDL/TCP — future phase).
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const escXml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');

/**
 * Push a single barcode to TallyPrime via desktop connector.
 * syncTarget: 'tally_part_number' | 'tally_alias'
 * Returns the forwardToTally result object or null if no push needed.
 */
export async function pushBarcodeToTally({ companyGuid, userId, stockGuid, stockName, barcode, syncTarget, companyName }) {
  if (!syncTarget || syncTarget === 'app_only') return null;

  // Read existing sku from stocks table so we can preserve it in Tally
  // stocks.sku = PartNumber / OnlyAlias synced from Tally's StockItem XML
  const { rows: [stockRow] } = await query(
    'SELECT sku FROM stocks WHERE guid=$1 AND company_guid=$2',
    [stockGuid, companyGuid]
  ).catch(() => ({ rows: [{}] }));
  const existingSku = stockRow?.sku || '';

  const eName     = escXml(stockName);
  const eBc       = escXml(barcode);
  const eCompany  = escXml(companyName);
  const eExisting = escXml(existingSku);

  const wrap = (inner) =>
    `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>` +
    `<BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME>` +
    `<STATICVARIABLES><SVCURRENTCOMPANY>${eCompany}</SVCURRENTCOMPANY></STATICVARIABLES>` +
    `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">` +
    `<STOCKITEM NAME="${eName}" ACTION="Alter">${inner}</STOCKITEM>` +
    `</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  let xml;
  if (syncTarget === 'tally_part_number') {
    // MAILINGNAME.LIST = Part Number field in Tally
    // Preserve existing sku (if it's different from the barcode being pushed)
    const existLine = (eExisting && eExisting !== eBc)
      ? `<MAILINGNAME>${eExisting}</MAILINGNAME>` : '';
    xml = wrap(`<MAILINGNAME.LIST TYPE="String">${existLine}<MAILINGNAME>${eBc}</MAILINGNAME></MAILINGNAME.LIST>`);

  } else if (syncTarget === 'tally_alias') {
    // NAME.LIST = Alias. First entry MUST be primary stock item name.
    // Preserve existing sku alias (if different from name and barcode).
    const existLine = (eExisting && eExisting !== eName && eExisting !== eBc)
      ? `<NAME>${eExisting}</NAME>` : '';
    xml = wrap(`<NAME.LIST TYPE="String"><NAME>${eName}</NAME>${existLine}<NAME>${eBc}</NAME></NAME.LIST>`);

  } else {
    return null;
  }

  const queueId = await logWriteQueue(
    userId, companyGuid, 'barcode_sync',
    `${stockName} → ${barcode} (${syncTarget})`,
    null, { stockGuid, stockName, barcode, syncTarget }, xml
  ).catch(() => null);

  let result;
  try {
    result = await forwardToTally(companyGuid, userId, xml);
  } catch (err) {
    result = { status: 'failed', message: err.message };
  }
  await updateWriteQueue(queueId, result, null);
  return result;
}

export default router;
