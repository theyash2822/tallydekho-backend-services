// Tally Write API — creates vouchers/masters in Tally via desktop proxy
// Flow: App → Backend → Desktop proxy → Tally HTTP port (9000)
// The desktop app must have the /tally-proxy endpoint running (Phase 3)

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../db/schema.js';
import { generateIRN } from '../utils/irnGenerator.js';
import { generateEWB } from '../utils/ewbGenerator.js';
import {
  resolveCreditNoteContext,
  normalizeName,
  num as toNum,
  round2 as r2,
  round3 as r3,
  QTY_EPSILON,
} from '../utils/creditNoteContext.js';
import { calcCreditNoteReturn } from '../utils/creditNoteTax.js';
import { persistVoucherLineTaxes } from '../utils/creditNoteItemTax.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Socket service reference - injected from server.js after startup
let _socketService = null;
export function setTallyWriteSocket(s) { _socketService = s; }

/** Ask desktop to pull newly created voucher(s) via SingleVoucher.xml (REFERENCE + number). */
async function requestDesktopSyncAfterWrite({ userId, companyGuid, companyName, tdkRef, tallyIds = [], extra = {} }) {
  if (!_socketService?.connectedClients) return;
  try {
    const { rows: devRows } = await query(
      'SELECT device_id FROM devices WHERE user_id=$1 AND paired=TRUE ORDER BY last_seen DESC LIMIT 1',
      [userId]
    );
    if (!devRows[0]?.device_id) return;
    const ds = _socketService.connectedClients.get('desktop_' + devRows[0].device_id);
    if (!ds?.connected) return;
    const ids = (Array.isArray(tallyIds) ? tallyIds : []).map(String).filter(Boolean);
    ds.emit('sync:request', {
      reason: 'voucher_created',
      tdkRef,
      companyGuid,
      companyName,
      tallyIds: ids,
      ...extra,
    });
    console.log(`[sync:request] Triggered desktop sync after tally:write for ${tdkRef} (tallyIds: ${ids.join(',') || 'none — full sync'})`);
  } catch (syncErr) {
    console.warn('[sync:request] Could not trigger desktop sync:', syncErr.message);
  }
}

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

// ── Helper: escape XML special characters ────────────────────────────────────
const escapeXml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

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
    const raw = typeof result?.data === 'string' ? result.data : '';
    const detail = raw ? ` | tally: ${raw.replace(/\s+/g, ' ').slice(0, 1200)}` : '';
    const errMsg = `${result?.message || 'Tally rejected the entry'}${detail}`.slice(0, 1800);
    await query(
      `UPDATE write_queue SET status = 'failed', error_message = $2,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, errMsg]
    );
    await query(
      `UPDATE app_vouchers
          SET tally_sync_status   = 'failed',
              books_impact_status = 'not_posted',
              sync_error          = $2,
              updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE write_queue_id = $1`,
      [id, String(errMsg).slice(0, 500)]
    ).catch(() => {});
  } else if (
    // Defense: empty Tally create (CREATED=0 / LASTVCHID=0) must never become Posted.
    // Desktop now rejects these, but older desktops may still return status:true.
    (typeof result?.created === 'number' && result.created === 0 && !(result.altered > 0))
    || String(result?.tallyId || '') === '0'
  ) {
    const errMsg = result?.message || 'Tally did not create the voucher (empty import result)';
    await query(
      `UPDATE write_queue SET status = 'failed', error_message = $2, tally_id = NULL,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, errMsg]
    );
    await query(
      `UPDATE app_vouchers
          SET tally_sync_status   = 'failed',
              books_impact_status = 'not_posted',
              sync_error          = $2,
              tally_voucher_no    = NULL,
              updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE write_queue_id = $1`,
      [id, String(errMsg).slice(0, 500)]
    ).catch(() => {});
  } else {
    let resolvedVoucherNumber = result?.voucherNumber || null;
    const tallyId = result?.tallyId || null;

    // When Tally Series is used, import ack often returns LASTVCHID only (no VOUCHERNUMBER).
    // Backfill number from vouchers table via TDK narration/reference anchor when available.
    if (!resolvedVoucherNumber) {
      try {
        const { rows: avLookup } = await query(
          `SELECT company_guid, tdk_reference_no FROM app_vouchers WHERE write_queue_id = $1 LIMIT 1`,
          [id]
        );
        const tdkRef = avLookup[0]?.tdk_reference_no;
        const companyGuid = avLookup[0]?.company_guid;
        if (tdkRef && companyGuid) {
          const { rows: vRows } = await query(
            `SELECT voucher_number FROM vouchers
              WHERE company_guid = $1
                AND (
                  narration ILIKE '%' || $2 || '%'
                  OR COALESCE(reference,'') ILIKE '%' || $2 || '%'
                )
                AND COALESCE(is_cancelled, false) = false
              ORDER BY date DESC NULLS LAST, alter_id DESC NULLS LAST
              LIMIT 1`,
            [companyGuid, tdkRef]
          );
          if (vRows[0]?.voucher_number) resolvedVoucherNumber = String(vRows[0].voucher_number);
        }
      } catch (e) {
        console.warn('[app_vouchers] voucher number backfill lookup failed:', e.message);
      }
    }

    await query(
      `UPDATE write_queue SET status = 'success', tally_voucher_number = $2, tally_id = $3,
       error_message = NULL, attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, resolvedVoucherNumber || null, tallyId]
    );

    // Always mark app_vouchers posted on successful Tally write (number may arrive later via sync).
    const avResult = await query(`
      UPDATE app_vouchers
      SET tally_voucher_no      = COALESCE($1, tally_voucher_no),
          tally_sync_status     = 'synced',
          books_impact_status   = 'posted',
          updated_at            = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE write_queue_id = $2
      RETURNING company_guid, tdk_reference_no, tally_voucher_no
    `, [resolvedVoucherNumber || null, id]).catch(e => { console.error('[app_vouchers sync]', e.message); return { rows: [] }; });
    const avRows = avResult?.rows ?? [];
    const emitNo = resolvedVoucherNumber || avRows[0]?.tally_voucher_no || null;
    if (avRows.length > 0 && emitNo) {
      const { company_guid, tdk_reference_no } = avRows[0];
      _socketService?.emitVoucherSynced?.(company_guid, tdk_reference_no, emitNo);
    }

    if (resolvedVoucherNumber) {
      // Auto-IRN: if e_invoice_mode = 'auto' and e_invoice_applicable = 'applicable_configured', trigger IRN
      setImmediate(async () => {
        try {
          // Get companyGuid and userId from write_queue entry
          const { rows: wqRows } = await query(
            `SELECT user_id, company_guid FROM write_queue WHERE id = $1`, [id]
          ).catch(() => ({ rows: [] }));
          if (!wqRows[0]) return;
          const { user_id: userId, company_guid: companyGuid } = wqRows[0];

          // Check if auto-IRN is configured for this company
          const { rows: cfgRows } = await query(
            `SELECT e_invoice_applicable, e_invoice_mode FROM company_compliance_config WHERE company_guid = $1`,
            [companyGuid]
          ).catch(() => ({ rows: [] }));
          const cfg = cfgRows[0];
          if (cfg?.e_invoice_applicable !== 'applicable_configured' || cfg?.e_invoice_mode !== 'auto') return;

          // Get voucherGuid for this write_queue entry
          const { rows: vRows } = await query(
            `SELECT guid FROM vouchers WHERE company_guid = $1 AND voucher_number = $2`,
            [companyGuid, resolvedVoucherNumber]
          ).catch(() => ({ rows: [] }));
          if (!vRows[0]?.guid) return;

          const { rows: userRows } = await query(
            `SELECT integration_settings FROM users WHERE id = $1`, [userId]
          ).catch(() => ({ rows: [] }));
          const einvoiceCreds = userRows[0]?.integration_settings?.einvoice;
          if (!einvoiceCreds?.gstin || !einvoiceCreds?.username) return;

          const { rows: coRows } = await query(
            `SELECT gstin, name FROM companies WHERE guid = $1`, [companyGuid]
          ).catch(() => ({ rows: [] }));
          const { rows: voucherRows } = await query(
            `SELECT * FROM vouchers WHERE guid = $1`, [vRows[0].guid]
          ).catch(() => ({ rows: [] }));

          if (einvoiceCreds?.gstin && coRows[0] && voucherRows[0]) {
            console.log(`[auto-IRN] Triggering for ${resolvedVoucherNumber}`);
            await generateIRN(companyGuid, voucherRows[0], coRows[0], einvoiceCreds);
            console.log(`[auto-IRN] Success for ${resolvedVoucherNumber}`);
            await query(
              `UPDATE app_vouchers SET e_invoice_status = 'generated', updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_guid = $1 AND tally_voucher_no = $2`,
              [companyGuid, resolvedVoucherNumber]
            ).catch(() => {});
          }
        } catch (autoErr) {
          console.error(`[auto-IRN] Failed for ${resolvedVoucherNumber}:`, autoErr.message);
        }
      });

      // Auto-EWB: if e_way_bill_mode = 'auto' and e_way_bill_applicable = 'applicable_configured'
      setImmediate(async () => {
        try {
          // Get companyGuid and userId from write_queue entry
          const { rows: wqRowsEWB } = await query(
            `SELECT user_id, company_guid FROM write_queue WHERE id = $1`, [id]
          ).catch(() => ({ rows: [] }));
          if (!wqRowsEWB[0]) return;
          const { user_id: userId, company_guid: companyGuid } = wqRowsEWB[0];

          // Check if auto-EWB is configured for this company
          const { rows: ewbCfgRows } = await query(
            `SELECT e_way_bill_applicable, e_way_bill_mode FROM company_compliance_config WHERE company_guid = $1`,
            [companyGuid]
          ).catch(() => ({ rows: [] }));
          const ewbCfg = ewbCfgRows[0];
          if (ewbCfg?.e_way_bill_applicable !== 'applicable_configured' || ewbCfg?.e_way_bill_mode !== 'auto') return;

          // Load voucher + dispatch details from app_vouchers payload
          const { rows: vRowsEWB } = await query(
            `SELECT v.*, av.payload as av_payload
             FROM vouchers v
             LEFT JOIN app_vouchers av ON av.tally_voucher_no = v.voucher_number AND av.company_guid = v.company_guid
             WHERE v.company_guid = $1 AND v.voucher_number = $2`,
            [companyGuid, resolvedVoucherNumber]
          ).catch(() => ({ rows: [] }));
          if (!vRowsEWB[0]) return;

          const dispatchDetails = vRowsEWB[0].av_payload?.dispatch_details;
          if (!dispatchDetails?.dispatch_from || !dispatchDetails?.ship_to) return;

          const { rows: coRowsEWB }   = await query(`SELECT * FROM companies WHERE guid = $1`, [companyGuid]).catch(() => ({ rows: [] }));
          const { rows: ewbUserRows } = await query(`SELECT integration_settings FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] }));
          const ewbCreds = ewbUserRows[0]?.integration_settings?.ewaybill || {};

          await generateEWB(companyGuid, vRowsEWB[0], coRowsEWB[0], ewbCreds, dispatchDetails);
          console.log(`[auto-EWB] Success for ${resolvedVoucherNumber}`);
        } catch (ewbErr) {
          console.error(`[auto-EWB] Failed for ${resolvedVoucherNumber}:`, ewbErr.message);
        }
      });
    }
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

// ── TallyDekho Series Invoice Number Generator ────────────────────────────────
// Returns formatted invoice number e.g. TD/SAL/26-27/00001
// Used when numbering_policy = 'tallydekho_series'
async function generateTDSeriesNumber(companyGuid, voucherTypeCode = 'SAL') {
  const now = new Date();
  const month = now.getMonth() + 1;
  const curYear = now.getFullYear();
  const startYear = month >= 4 ? curYear : curYear - 1; // April = start of Indian FY
  const fiscalShort = `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
  const prefix = `TDINV-${voucherTypeCode}`;
  const { rows } = await query(
    `INSERT INTO tdk_reference_counters (company_guid, voucher_prefix, fiscal_year, last_seq)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (company_guid, voucher_prefix, fiscal_year)
     DO UPDATE SET last_seq = tdk_reference_counters.last_seq + 1
     RETURNING last_seq`,
    [companyGuid, prefix, startYear]
  );
  const seq = rows[0].last_seq;
  return `TD/${voucherTypeCode}/${fiscalShort}/${String(seq).padStart(5, '0')}`;
}

// ── createReceiptForInvoice ── helper that pairs a Receipt voucher with a Sales Invoice
// when Collect Payment Now is enabled. Builds its own Receipt XML, logs to write_queue,
// creates a child app_voucher row linked via parent_invoice_uuid, and forwards to Tally.
async function createReceiptForInvoice({
  companyGuid, companyName, userId, date,
  partyLedger, bankLedger, amount, parentInvoiceUuid, parentTdkRef,
  isOptional = false, reference,
  parentCreatedAt = null,   // 2026-07-01 R4: share timestamp with parent Sales invoice
                            // so audit-trail sort keeps Invoice → Receipt sequence.
}) {
  if (!companyGuid || !partyLedger || !bankLedger || !(parseFloat(amount) > 0)) {
    throw new Error('createReceiptForInvoice: missing required fields');
  }
  const amt = parseFloat(amount);
  const isOpt = isOptional ? 'Yes' : 'No';
  const rcpTdkRef = await generateTDKReference(companyGuid, isOptional, 'RCP');
  // Keep narration user/business-friendly (no TDK ids). Receipt reconciliation uses
  // BILLALLOCATIONS.LIST (Agst Ref → parent SAL ref) instead.
  const narration = 'Receipt against invoice';

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
  <NARRATION>${narration}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <REFERENCE>${reference || rcpTdkRef || ''}</REFERENCE>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
    <BILLALLOCATIONS.LIST>
      <NAME>${parentTdkRef}</NAME>
      <BILLTYPE>Agst Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${amt}</AMOUNT>
    </BILLALLOCATIONS.LIST>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${bankLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger} ← ${bankLedger} (linked: ${parentTdkRef})`;
  const payload = { companyGuid, companyName, date, partyLedger, bankLedger, amount: amt, isOptional, reference, parentInvoiceUuid, parentTdkRef, narration };
  const qId = await logWriteQueue(userId, companyGuid, 'receipt', label, amt, payload, xml).catch(() => null);

  // Create child app_voucher (linked to invoice via parent_invoice_uuid).
  // 2026-07-01 R4: explicitly set created_at to match the parent Sales invoice's timestamp
  // when provided. This keeps the pair's audit-trail sort stable (Invoice → Receipt within
  // pair via av.id ASC tiebreak). Fallback to DB default (EXTRACT(EPOCH FROM NOW())) when
  // parent timestamp isn't passed — preserves prior behavior for legacy callers.
  let receiptUuid = null;
  if (qId) {
    const createdAtSql = parentCreatedAt
      ? `$11::bigint`
      : `EXTRACT(EPOCH FROM NOW())::bigint`;
    const insertParams = [companyGuid, userId, qId, rcpTdkRef, isOptional ? 'optional' : 'regular',
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(payload), parentInvoiceUuid];
    if (parentCreatedAt) insertParams.push(parentCreatedAt);
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload, parent_invoice_uuid, created_at)
       VALUES ($1,$2,$3,'receipt',$4,$5,$5,'queued','not_posted','tally_prime_series',$6,$7,$8,$9,$10, ${createdAtSql})
       RETURNING invoice_uuid`,
      insertParams
    ).catch(e => { console.error('[receipt-app_voucher] insert failed:', e.message); return { rows: [] }; });
    receiptUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    return { ok: true, queued: offline, queueId: qId, tdkRef: rcpTdkRef, receiptUuid, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null };
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    // Phase E: Tally rejects BILLALLOCATIONS.LIST when the customer ledger has
    // "Maintain bill-by-bill = No". Detect common phrasings so the surface error is actionable.
    const msg = String(e.message || '');
    const isBillWise = /bill[- ]?wise|bill[- ]?by[- ]?bill|maintain bill/i.test(msg);
    if (isBillWise) {
      console.error(`[receipt-pair] Tally rejected receipt for ${parentTdkRef} — customer ledger likely has 'Maintain bill-by-bill = No'. Enable it in Tally and retry.`);
      // Mark receipt app_voucher as needs_manual_reconciliation
      if (receiptUuid) {
        try {
          await query(
            `UPDATE app_vouchers SET tally_sync_status='needs_manual_reconciliation', sync_error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
              WHERE invoice_uuid=$2`,
            [`Tally rejected receipt: customer ledger missing 'Maintain bill-by-bill'. ${msg}`.slice(0, 500), receiptUuid]
          );
        } catch {}
      }
    } else {
      console.error(`[receipt-pair] Failed for ${parentTdkRef}:`, msg);
    }
    return { ok: false, error: msg, queueId: qId, tdkRef: rcpTdkRef, receiptUuid, billWiseError: isBillWise };
  }
}

// ── createPaymentForInvoice ── pairs a Payment voucher with a Purchase Invoice
// when Make Payment Now is enabled (mirror of createReceiptForInvoice).
async function createPaymentForInvoice({
  companyGuid, companyName, userId, date,
  partyLedger, bankLedger, amount, parentInvoiceUuid, parentTdkRef,
  isOptional = false, reference,
  parentCreatedAt = null,
}) {
  if (!companyGuid || !partyLedger || !bankLedger || !(parseFloat(amount) > 0)) {
    throw new Error('createPaymentForInvoice: missing required fields');
  }
  const amt = parseFloat(amount);
  const isOpt = isOptional ? 'Yes' : 'No';
  const payTdkRef = await generateTDKReference(companyGuid, isOptional, 'PAY');
  // Keep narration user/business-friendly (no TDK ids). Payment reconciliation uses
  // BILLALLOCATIONS (Agst Ref) and/or unique (party+date+amount) matching.
  const narration = 'Payment against invoice';

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
  <NARRATION>${narration}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <REFERENCE>${reference || payTdkRef || ''}</REFERENCE>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
    <BILLALLOCATIONS.LIST>
      <NAME>${parentTdkRef}</NAME>
      <BILLTYPE>Agst Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${-amt}</AMOUNT>
    </BILLALLOCATIONS.LIST>
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

  const label = `${partyLedger} → ${bankLedger} (linked: ${parentTdkRef})`;
  const payload = {
    companyGuid, companyName, date, partyLedger, bankLedger, ledgerAccount: bankLedger,
    amount: amt, isOptional, reference, parentInvoiceUuid, parentTdkRef, narration,
    paymentMethod: 'Bank', billAllocations: [{ billRefName: parentTdkRef, billType: 'Agst Ref', amount: amt }],
  };
  const qId = await logWriteQueue(userId, companyGuid, 'payment', label, amt, payload, xml).catch(() => null);

  let paymentUuid = null;
  if (qId) {
    const createdAtSql = parentCreatedAt ? `$11::bigint` : `EXTRACT(EPOCH FROM NOW())::bigint`;
    const insertParams = [companyGuid, userId, qId, payTdkRef, isOptional ? 'optional' : 'regular',
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(payload), parentInvoiceUuid];
    if (parentCreatedAt) insertParams.push(parentCreatedAt);
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload, parent_invoice_uuid, created_at)
       VALUES ($1,$2,$3,'payment',$4,$5,$5,'queued','not_posted','tally_prime_series',$6,$7,$8,$9,$10, ${createdAtSql})
       RETURNING invoice_uuid`,
      insertParams
    ).catch(e => { console.error('[payment-app_voucher] insert failed:', e.message); return { rows: [] }; });
    paymentUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    return { ok: true, queued: offline, queueId: qId, tdkRef: payTdkRef, paymentUuid, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null };
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    const msg = String(e.message || '');
    const isBillWise = /bill[- ]?wise|bill[- ]?by[- ]?bill|maintain bill/i.test(msg);
    if (isBillWise && paymentUuid) {
      try {
        await query(
          `UPDATE app_vouchers SET tally_sync_status='needs_manual_reconciliation', sync_error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE invoice_uuid=$2`,
          [`Tally rejected payment: party ledger missing 'Maintain bill-by-bill'. ${msg}`.slice(0, 500), paymentUuid]
        );
      } catch {}
    }
    return { ok: false, error: msg, queueId: qId, tdkRef: payTdkRef, paymentUuid, billWiseError: isBillWise };
  }
}

// ── POST /tally/voucher/sales ───────────────────────────────────
router.post('/voucher/sales', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [], // [{ itemName, actualQty, billedQty, rate, amount, salesLedger, godown }]
    taxes = [], // [{ ledgerName, taxRate, taxAmount, taxableValue }]
    logistics = [], // [{ ledgerName, amount, taxes: [{ledgerName, taxRate, taxAmount}] }]
    isOptional = false,
    voucherType = 'Sales GST',
    original_entry_type = 'regular',
    collect_payment = null,
    dispatch_details = null,
    numbering_policy = 'tally_prime_series', // 'tally_prime_series' | 'tallydekho_series'
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const amt = parseFloat(totalAmount) || 0;
  const vchType = voucherType || 'Sales GST';

  // Double-submit guard: identical Sales Invoice creates within 2 minutes return the
  // existing app_voucher instead of minting another TDK ref and Tally voucher.
  // Fingerprint = party + date + amount + item names/qty/rate (order-insensitive).
  const itemFingerprint = (list) => JSON.stringify(
    [...(list || [])]
      .map(i => ({
        n: String(i.itemName || i.name || '').trim().toLowerCase(),
        q: Number(i.billedQty ?? i.actualQty ?? i.qty ?? 0),
        r: Number(i.rate ?? 0),
        a: Number(i.amount ?? 0),
      }))
      .sort((a, b) => a.n.localeCompare(b.n) || a.q - b.q)
  );
  const thisFp = itemFingerprint(items);
  try {
    const { rows: recent } = await query(
      `SELECT id, tdk_reference_no, invoice_uuid, tally_voucher_no, tally_sync_status,
              books_impact_status, payload, write_queue_id, created_at
         FROM app_vouchers
        WHERE company_guid = $1
          AND voucher_type = 'sales_invoice'
          AND user_id = $2
          AND LOWER(TRIM(COALESCE(party_name,''))) = LOWER(TRIM($3))
          AND ABS(COALESCE(total_amount,0) - $4::numeric) < 0.02
          AND voucher_date = $5::date
          AND created_at > EXTRACT(EPOCH FROM NOW())::BIGINT - 120
        ORDER BY id DESC
        LIMIT 5`,
      [companyGuid, req.user.userId, partyLedger, amt, date || null]
    );
    const dup = recent.find(r => itemFingerprint(r.payload?.items) === thisFp);
    if (dup) {
      console.warn(`[sales] duplicate submit suppressed → ${dup.tdk_reference_no} (wq ${dup.write_queue_id})`);
      return res.json({
        status: true,
        queued: dup.tally_sync_status === 'queued' || dup.books_impact_status === 'not_posted',
        queueId: dup.write_queue_id,
        tdkReferenceNo: dup.tdk_reference_no,
        invoiceUuid: dup.invoice_uuid,
        invoiceNumber: dup.tally_voucher_no || null,
        numberingPolicy: numbering_policy,
        duplicate: true,
        message: 'Same invoice was already submitted — returning the existing entry',
        voucherNumber: dup.tally_voucher_no || null,
        data: { status: true, voucherNumber: dup.tally_voucher_no || null },
      });
    }
  } catch (dupErr) {
    console.warn('[sales] duplicate check skipped:', dupErr.message);
  }

  // Collect Payment Now: the payment is recorded as a SEPARATE Receipt voucher (created
  // after this invoice posts). The Sales Invoice itself is always a clean party debit for
  // the full invoice amount — no Cash/Bank leg here. This gives proper party ledger trail
  // (invoice + receipt both show under the customer in Tally).
  const payAmt = collect_payment?.ledgerName && parseFloat(collect_payment.amount) > 0
    ? parseFloat(collect_payment.amount)
    : 0;
  const partyNetAmt = amt; // party always debited for the full invoice amount

  // Narration — clean. Dispatch/EWB data goes in EWAYBILLDETAILS.LIST, not here.
  const fullNarration = narration || '';

  // ── Dispatch / EWB XML fragments ─────────────────────────────────────────
  // Helper: YYYYMMDD format for TallyPrime date fields
  const toTallyDate = (d) => d ? String(d).replace(/-/g, '') : '';

  let topLevelDispatchXml = '';
  let ewbDetailsXml = '';
  if (dispatch_details) {
    const dd = dispatch_details;
    // Transport mode: TallyPrime top-level = simple word; TRANSPORTDETAILS.LIST = coded
    const modeSimpleMap = { road: 'Road', rail: 'Rail', air: 'Air', ship: 'Ship', 'not_applicable': '', 'not applicable': '' };
    const modeCodeMap   = { road: '1 - Road', rail: '2 - Rail', air: '3 - Air', ship: '4 - Ship' };
    const modeKey        = (dd.transport_mode || '').toLowerCase().replace(' ', '_');
    const tallySimpleMode = modeSimpleMap[modeKey] ?? dd.transport_mode ?? '';
    const tallyCodedMode  = modeCodeMap[modeKey] ?? '';
    // Vehicle type: TallyPrime expects coded string
    const vtKey = (dd.vehicle_type || '').toLowerCase();
    const tallyVehicleType = vtKey.includes('over') ? 'O - Over Dimensional Cargo (ODC)'
                           : vtKey === 'regular'     ? 'R - Regular'
                           : dd.vehicle_type         || '';

    // 1. Top-level VOUCHER fields (go right after <NARRATION>)
    const dispatchDate = toTallyDate(dd.transport_doc_date || date); // fallback to invoice date if no transport doc date
    topLevelDispatchXml = [
      dispatchDate          ? `  <BILLOFLADINGDATE>${dispatchDate}</BILLOFLADINGDATE>` : '',
      tallySimpleMode       ? `  <BASICSHIPPEDBY>${tallySimpleMode}</BASICSHIPPEDBY>` : '',
      dd.transport_doc_no   ? `  <BASICSHIPDOCUMENTNO>${dd.transport_doc_no}</BASICSHIPDOCUMENTNO>` : '',
      dd.ship_to            ? `  <BASICFINALDESTINATION>${dd.ship_to}</BASICFINALDESTINATION>` : '',
      dd.vehicle_number     ? `  <BASICSHIPVESSELNO>${dd.vehicle_number}</BASICSHIPVESSELNO>` : '',
    ].filter(Boolean).join('\n');

    // 2. EWAYBILLDETAILS.LIST with nested TRANSPORTDETAILS.LIST (validated against real TallyPrime export)
    const hasTransport = dd.vehicle_number || tallyCodedMode || dd.transporter_name || dd.transporter_id;

    // Build multi-line CONSIGNOR/CONSIGNEE address blocks (addr1 + addr2 as separate <ADDRESS> tags)
    const consignorLines = [dd.dispatch_from_address1, dd.dispatch_from_address2].map(l => (l || '').trim()).filter(Boolean);
    const consigneeLines = [dd.ship_to_address1,       dd.ship_to_address2      ].map(l => (l || '').trim()).filter(Boolean);
    const consignorAddrXml = consignorLines.length
      ? consignorLines.map(l => `      <CONSIGNORADDRESS>${l}</CONSIGNORADDRESS>`).join('\n')
      : `      <CONSIGNORADDRESS>${dd.dispatch_from || ''}</CONSIGNORADDRESS>`;
    const consigneeAddrXml = consigneeLines.length
      ? consigneeLines.map(l => `      <CONSIGNEEADDRESS>${l}</CONSIGNEEADDRESS>`).join('\n')
      : `      <CONSIGNEEADDRESS>${dd.ship_to || ''}</CONSIGNEEADDRESS>`;

    ewbDetailsXml = `
  <EWAYBILLDETAILS.LIST>
    <CONSIGNORADDRESS.LIST TYPE="String">
${consignorAddrXml}
    </CONSIGNORADDRESS.LIST>
    <CONSIGNEEADDRESS.LIST TYPE="String">
${consigneeAddrXml}
    </CONSIGNEEADDRESS.LIST>
    <DOCUMENTTYPE>Tax Invoice</DOCUMENTTYPE>
    <SUBTYPE>Supply</SUBTYPE>
    <CONSIGNORPLACE>${dd.dispatch_from || ''}</CONSIGNORPLACE>
    <CONSIGNEEPLACE>${dd.ship_to || ''}</CONSIGNEEPLACE>
    <CONSIGNORPINCODE>${dd.dispatch_from_pincode || ''}</CONSIGNORPINCODE>
    <CONSIGNEEPINCODE>${dd.ship_to_pincode || ''}</CONSIGNEEPINCODE>
    <SHIPPEDFROMSTATE>${dd.dispatch_from_state || ''}</SHIPPEDFROMSTATE>
    <SHIPPEDTOSTATE>${dd.ship_to_state || ''}</SHIPPEDTOSTATE>
    <ISCANCELLED>No</ISCANCELLED>
    <IGNOREGSTINVALIDATION>No</IGNOREGSTINVALIDATION>
    <ISCANCELPENDING>No</ISCANCELPENDING>
    <IGNOREGENERATIONVALIDATION>No</IGNOREGENERATIONVALIDATION>
    <ISEXPORTEDFORGENERATION>No</ISEXPORTEDFORGENERATION>
    <INTRASTATEAPPLICABILITY>No</INTRASTATEAPPLICABILITY>${hasTransport ? `
    <TRANSPORTDETAILS.LIST>
      <DOCUMENTDATE>${dispatchDate}</DOCUMENTDATE>
      <TRANSPORTERID>${dd.transporter_id || ''}</TRANSPORTERID>
      <TRANSPORTERNAME>${dd.transporter_name || ''}</TRANSPORTERNAME>
      <TRANSPORTMODE>${tallyCodedMode}</TRANSPORTMODE>
      <VEHICLENUMBER>${dd.vehicle_number || ''}</VEHICLENUMBER>
      <OLDVEHICLETYPE>${tallyVehicleType}</OLDVEHICLETYPE>
      <VEHICLETYPE>${tallyVehicleType}</VEHICLETYPE>
      <IGNOREVEHICLENOVALIDATION>No</IGNOREVEHICLENOVALIDATION>
      <ISTRANSIDPENDING>No</ISTRANSIDPENDING>
      <ISTRANSIDUPDATED>No</ISTRANSIDUPDATED>
      <IGNORETRANSIDVALIDATION>No</IGNORETRANSIDVALIDATION>
      <ISEXPORTEDFORTRANSPORTERID>No</ISEXPORTEDFORTRANSPORTERID>
      <ISPARTBPENDING>No</ISPARTBPENDING>
      <ISPARTBUPDATED>No</ISPARTBUPDATED>
      <IGNOREPARTBVALIDATION>No</IGNOREPARTBVALIDATION>
      <ISEXPORTEDFORPARTB>No</ISEXPORTEDFORPARTB>
    </TRANSPORTDETAILS.LIST>` : ''}
    <EXTENSIONDETAILS.LIST></EXTENSIONDETAILS.LIST>
    <MULTIVEHICLEDETAILS.LIST></MULTIVEHICLEDETAILS.LIST>
    <STATEWISETHRESHOLD.LIST></STATEWISETHRESHOLD.LIST>
  </EWAYBILLDETAILS.LIST>`;
  }

  // Generate TDK reference
  const tdkRef = await generateTDKReference(companyGuid, isOptional).catch(() => null);

  // TallyDekho Series: generate invoice number immediately (we own the sequence)
  // This number is stable and final — no 10s wait needed for Share PDF
  let tdkInvoiceNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkInvoiceNo = await generateTDSeriesNumber(companyGuid, 'SAL').catch(() => null);
    if (tdkInvoiceNo) effectiveVoucherNumber = tdkInvoiceNo;
  }

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
  <VOUCHERNUMBER>${effectiveVoucherNumber}</VOUCHERNUMBER>
  <REFERENCE>${tdkRef || reference || ''}</REFERENCE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>No</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${fullNarration}</NARRATION>
${topLevelDispatchXml}
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${-partyNetAmt}</AMOUNT>${tdkRef ? `
    <BILLALLOCATIONS.LIST>
      <NAME>${tdkRef}</NAME>
      <BILLTYPE>New Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${-partyNetAmt}</AMOUNT>
    </BILLALLOCATIONS.LIST>` : ''}
  </LEDGERENTRIES.LIST>`;

  // Inventory line items — stamp GSTRATE when the client sent per-line tax (Phase 3).
  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    const lineGstRate = Array.isArray(item.taxEntries) && item.taxEntries.length
      ? item.taxEntries.reduce((s, t) => s + (parseFloat(t.taxRate) || 0), 0)
      : (parseFloat(item.gstRate) || parseFloat(item.taxRate) || 0);
    const gstRateXml = lineGstRate > 0
      ? `
    <GSTOVERRIDDEN>Yes</GSTOVERRIDDEN>
    <IGSTAPPLICABLERATE>${lineGstRate}</IGSTAPPLICABLERATE>`
      : '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
    <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    <RATE>${item.rate || 0}</RATE>${gstRateXml}
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
      ${req.body.againstOrderNo ? `<ORDERNO>${req.body.againstOrderNo}</ORDERNO>` : '<ORDERNO/>'}
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
  // Logistics/freight entries + per-entry taxes
  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lg.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    // Per-logistics-entry taxes (e.g. GST on freight)
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lt.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }

  // (Collect Payment Now is handled by a SEPARATE Receipt voucher after this invoice posts —
  // see createReceiptForInvoice() helper. Invoice XML stays clean.)

  // Dispatch / EWB — pre-computed above, append now
  if (ewbDetailsXml) xml += ewbDetailsXml;

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger}${voucherNumber ? ' #' + voucherNumber : ''}`;
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'sales', label, amt, req.body, xml).catch(() => null);

  // Create app_voucher lifecycle record.
  // 2026-07-01 R4: RETURNING created_at as well so we can pass the same timestamp to
  // any chained Receipt — keeps intra-pair sort stable in audit-trail.
  let invoiceUuid = null;
  let invoiceCreatedAt = null;
  if (queueId && tdkRef) {
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'sales_invoice',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid, created_at`,
      [companyGuid, req.user.userId, queueId, tdkRef, original_entry_type,
       numbering_policy,
       tdkInvoiceNo || null,     // pre-set for tallydekho_series; null for tally_prime_series
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(req.body)]
    ).catch(e => { console.error('[app_vouchers] insert failed:', e.message); return { rows: [] }; });
    invoiceUuid      = avResult?.rows?.[0]?.invoice_uuid || null;
    invoiceCreatedAt = avResult?.rows?.[0]?.created_at   || null;

    // Phase 3: persist per-line tax geometry for Credit Note reversal
    // (common GST ledger / VAT / packing GST attribution).
    await persistVoucherLineTaxes(query, {
      companyGuid,
      tdkReferenceNo: tdkRef,
      items,
      taxes,
      logistics,
    }).catch(e => console.warn('[voucher_line_taxes] persist failed:', e.message));
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(queueId, result, null);
    const offline = result?.status === 'desktop_offline';

    // ── Paired Receipt Voucher (when Collect Payment Now is enabled) ──
    // Create a separate Receipt voucher linked to this invoice so the party ledger
    // shows both Invoice (Dr) and Receipt (Cr) as distinct entries.
    let receiptResult = null;
    if (!offline && collect_payment?.ledgerName && payAmt > 0 && invoiceUuid) {
      try {
        receiptResult = await createReceiptForInvoice({
          companyGuid, companyName, userId: req.user.userId, date,
          partyLedger, bankLedger: collect_payment.ledgerName, amount: payAmt,
          parentInvoiceUuid: invoiceUuid, parentTdkRef: tdkRef,
          isOptional, reference: reference,
          parentCreatedAt: invoiceCreatedAt,   // R4: share parent Sales timestamp
        });
        if (receiptResult?.ok) {
          console.log(`[receipt-pair] Created receipt ${receiptResult.tdkRef} for invoice ${tdkRef}`);
        }
      } catch (rcpErr) {
        console.error(`[receipt-pair] Helper threw for ${tdkRef}:`, rcpErr.message);
        receiptResult = { ok: false, error: rcpErr.message };
      }
    }

    // After a successful Tally write (desktop online), signal desktop to sync back the new voucher.
    // This ensures app_vouchers.tally_voucher_no is populated without waiting for the next full sync.
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId, receiptResult?.tallyId],
          extra: { rcpTdkRef: receiptResult?.tdkRef || null },
        });
      });
    }
    res.json({
      status: true, queued: offline, queueId,
      tdkReferenceNo: tdkRef, invoiceUuid,
      invoiceNumber: tdkInvoiceNo || result?.voucherNumber || null, // immediate for TD series
      numberingPolicy: numbering_policy,
      message: offline ? 'Entry saved. Will push to Tally when desktop connects.' : (isOptional ? 'Optional entry saved' : 'Sales invoice created'),
      data: result,
      voucherNumber: result?.voucherNumber || null,
      tallyId: result?.tallyId || null,
      receipt: receiptResult ? { ok: receiptResult.ok, tdkRef: receiptResult.tdkRef, error: receiptResult.error || null } : null,
    });
  } catch (e) {
    await updateWriteQueue(queueId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/payment ───────────────────────────────────────────────
// 2026-07-13 rewrite: Receipt parity — multi-bill allocation, instrument details,
// numbering policy, app_vouchers, preview/share flow. Cash/Bank leg ISPARTYLEDGER=Yes (Tally export parity).
router.post('/voucher/payment', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration, reference,
    partyLedger, ledgerAccount, bankLedger,
    paymentMethod = 'Cash',
    amount,
    billAllocations = [],
    instrumentDetails = null,
    entryType = 'regular',
    isOptional: isOptionalLegacy,
    numbering_policy = 'tally_prime_series',
  } = req.body;

  const cashOrBankLedger = ledgerAccount || bankLedger;
  if (!companyGuid || !partyLedger || !cashOrBankLedger || !amount) {
    return res.status(400).json({ status: false, message: 'partyLedger, ledgerAccount and amount required' });
  }

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  const dt = tallyDate(date);

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'PAY').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PAY').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  // Keep narration user/business-friendly (no TDK ids).
  const fullNarration = narration || '';

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  const blocksRaw = Array.isArray(billAllocations) ? billAllocations : [];
  // Merge duplicate Agst Ref names (bill_outstanding can have duplicate bill_name rows).
  // Tally rejects Payment imports that repeat the same bill NAME → CREATED=0 / false Posted.
  // Advance MUST have <NAME> (Tally reference XML); On Account must NOT. Auto-name nameless Advance.
  const autoAdvName = () => {
    const seq = (tdkRef || '').split('-').pop() || String(Date.now()).slice(-4);
    return `TDK-ADV-${seq}`;
  };
  const merged = new Map();
  for (const b of blocksRaw) {
    const bType = b.billType || 'On Account';
    const bAmt = Math.abs(parseFloat(b.amount) || 0);
    if (!bAmt) continue;
    let billRefName = b.billRefName || null;
    if (bType === 'Advance' && !billRefName) billRefName = autoAdvName();
    if (bType === 'On Account') billRefName = null;
    const key = bType === 'Agst Ref' && billRefName
      ? `Agst:${String(billRefName)}`
      : bType === 'Advance' && billRefName
        ? `Adv:${String(billRefName)}`
        : `${bType}:${merged.size}`;
    const prev = merged.get(key);
    if (prev) prev.amount += bAmt;
    else merged.set(key, { billRefName, billType: bType, amount: bAmt });
  }
  const blocks = [...merged.values()];
  // Payment party leg is debit (negative) — bill allocation amounts match the debit sign.
  const billXml = blocks.map(b => {
    const bAmt = Math.abs(parseFloat(b.amount) || 0);
    const bType = b.billType || 'On Account';
    // Agst Ref + Advance need NAME; On Account has no NAME (matches Tally export).
    const needsName = (bType === 'Agst Ref' || bType === 'Advance') && b.billRefName;
    const nameTag = needsName ? `<NAME>${esc(b.billRefName)}</NAME>` : '';
    return `    <BILLALLOCATIONS.LIST>
      ${nameTag}
      <BILLTYPE>${esc(bType)}</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${-bAmt}</AMOUNT>
    </BILLALLOCATIONS.LIST>`;
  }).join('\n');

  const methodToTxnType = { Cheque: 'Cheque', NEFT: 'Electronic Cheque', RTGS: 'Electronic Cheque', UPI: 'Others', Bank: 'Transacted' };
  const wantsBankAlloc = paymentMethod && paymentMethod !== 'Cash' && instrumentDetails;
  const bankAllocXml = wantsBankAlloc ? `    <BANKALLOCATIONS.LIST>
      <DATE>${tallyDate(instrumentDetails.instrumentDate || date)}</DATE>
      <INSTRUMENTDATE>${tallyDate(instrumentDetails.instrumentDate || date)}</INSTRUMENTDATE>
      <INSTRUMENTNUMBER>${esc(instrumentDetails.instrumentNo || reference || '')}</INSTRUMENTNUMBER>
      <BANKNAME>${esc(instrumentDetails.bankName || '')}</BANKNAME>
      <TRANSACTIONTYPE>${esc(instrumentDetails.transactionType || methodToTxnType[paymentMethod] || 'Others')}</TRANSACTIONTYPE>
      <PAYMENTFAVOURING>${esc(partyLedger)}</PAYMENTFAVOURING>
      <AMOUNT>${amt}</AMOUNT>
    </BANKALLOCATIONS.LIST>` : '';

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Payment" ACTION="Create">
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
  ${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}
  <REFERENCE>${esc(tdkRef || reference || '')}</REFERENCE>
  <NARRATION>${esc(fullNarration)}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(partyLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
${billXml}
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(cashOrBankLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
${bankAllocXml}
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    entryType: isOptional ? 'optional' : 'regular',
    paymentMethod,
    ledgerAccount: cashOrBankLedger,
    billAllocations: blocks,
    instrumentDetails: instrumentDetails || null,
    narration: fullNarration,
  };

  const label = `${partyLedger} → ${cashOrBankLedger}${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'payment', label, amt, persistPayload, xml).catch(() => null);

  let paymentUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'payment',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, partyLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[payment-app_voucher] insert failed:', e.message); return { rows: [] }; });
    paymentUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }
    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      paymentUuid,
      invoiceUuid: paymentUuid,
      voucherNumber,
      numberingPolicy: numbering_policy,
      message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional payment saved' : 'Payment created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    const msg = String(e.message || '');
    const isBillWise = /bill[- ]?wise|bill[- ]?by[- ]?bill|maintain bill/i.test(msg);
    if (isBillWise && paymentUuid) {
      try {
        await query(
          `UPDATE app_vouchers SET tally_sync_status='needs_manual_reconciliation', sync_error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE invoice_uuid=$2`,
          [`Tally rejected payment: party ledger missing 'Maintain bill-by-bill'. ${msg}`.slice(0, 500), paymentUuid]
        );
      } catch {}
    }
    res.status(500).json({ status: false, message: msg, billWiseError: isBillWise, tdkRef });
  }
});

// ── POST /tally/voucher/receipt ───────────────────────────────────────────────
// 2026-07-09 rewrite: multi-bill allocation, instrument details, numbering policy,
// app_vouchers row, preview/share flow.
//
// Request body (mobile Create Receipt screen):
//   companyGuid, companyName, date (YYYY-MM-DD), amount,
//   partyLedger, ledgerAccount    (Cash or Bank ledger name),
//   paymentMethod                 ('Cash'|'Bank'|'Cheque'|'NEFT'|'RTGS'|'UPI'),
//   billAllocations: [            (each block becomes one <BILLALLOCATIONS.LIST>)
//     { billRefName?, billType: 'Agst Ref'|'On Account'|'Advance', amount }
//   ],
//   instrumentDetails?: { instrumentNo, instrumentDate, bankName, transactionType },
//   entryType: 'regular'|'optional',
//   numbering_policy: 'tally_prime_series'|'tallydekho_series',
//   narration?, reference?
router.post('/voucher/receipt', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration, reference,
    partyLedger, ledgerAccount, bankLedger,
    paymentMethod = 'Cash',
    amount,
    billAllocations = [],
    instrumentDetails = null,
    entryType = 'regular',
    isOptional: isOptionalLegacy,
    numbering_policy = 'tally_prime_series',
  } = req.body;

  const cashOrBankLedger = ledgerAccount || bankLedger;
  if (!companyGuid || !partyLedger || !cashOrBankLedger || !amount) {
    return res.status(400).json({ status: false, message: 'partyLedger, ledgerAccount and amount required' });
  }

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  const dt = tallyDate(date);

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'RCP').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'RCP').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  // Keep narration user/business-friendly (no TDK ids).
  const fullNarration = narration || '';

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  // Same Advance NAME rule as Payment (Tally requires <NAME> for Advance leftover).
  const autoAdvNameRcp = () => {
    const seq = (tdkRef || '').split('-').pop() || String(Date.now()).slice(-4);
    return `TDK-ADV-${seq}`;
  };
  const blocks = (Array.isArray(billAllocations) ? billAllocations : []).map(b => {
    const bType = b.billType || 'On Account';
    let billRefName = b.billRefName || null;
    if (bType === 'Advance' && !billRefName) billRefName = autoAdvNameRcp();
    if (bType === 'On Account') billRefName = null;
    return { ...b, billType: bType, billRefName };
  });
  const billXml = blocks.map(b => {
    const bAmt = parseFloat(b.amount) || 0;
    const bType = b.billType || 'On Account';
    const needsName = (bType === 'Agst Ref' || bType === 'Advance') && b.billRefName;
    const nameTag = needsName ? `<NAME>${esc(b.billRefName)}</NAME>` : '';
    return `    <BILLALLOCATIONS.LIST>
      ${nameTag}
      <BILLTYPE>${esc(bType)}</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${bAmt}</AMOUNT>
    </BILLALLOCATIONS.LIST>`;
  }).join('\n');

  const methodToTxnType = { Cheque: 'Cheque', NEFT: 'Electronic Cheque', RTGS: 'Electronic Cheque', UPI: 'Others', Bank: 'Transacted' };
  const wantsBankAlloc = paymentMethod && paymentMethod !== 'Cash' && instrumentDetails;
  const bankAllocXml = wantsBankAlloc ? `    <BANKALLOCATIONS.LIST>
      <DATE>${tallyDate(instrumentDetails.instrumentDate || date)}</DATE>
      <INSTRUMENTDATE>${tallyDate(instrumentDetails.instrumentDate || date)}</INSTRUMENTDATE>
      <INSTRUMENTNUMBER>${esc(instrumentDetails.instrumentNo || reference || '')}</INSTRUMENTNUMBER>
      <BANKNAME>${esc(instrumentDetails.bankName || '')}</BANKNAME>
      <TRANSACTIONTYPE>${esc(instrumentDetails.transactionType || methodToTxnType[paymentMethod] || 'Others')}</TRANSACTIONTYPE>
      <PAYMENTFAVOURING>${esc(partyLedger)}</PAYMENTFAVOURING>
      <AMOUNT>${-amt}</AMOUNT>
    </BANKALLOCATIONS.LIST>` : '';

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Receipt" ACTION="Create">
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
  ${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}
  <REFERENCE>${esc(tdkRef || reference || '')}</REFERENCE>
  <NARRATION>${esc(fullNarration)}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <PARTYLEDGERNAME>${esc(partyLedger)}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(partyLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
${billXml}
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(cashOrBankLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
${bankAllocXml}
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    entryType: isOptional ? 'optional' : 'regular',
    paymentMethod,
    ledgerAccount: cashOrBankLedger,
    billAllocations: blocks,
    instrumentDetails: instrumentDetails || null,
    narration: fullNarration,
  };

  const label = `${partyLedger} ← ${cashOrBankLedger}${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'receipt', label, amt, persistPayload, xml).catch(() => null);

  let receiptUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'receipt',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, partyLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[receipt-app_voucher] insert failed:', e.message); return { rows: [] }; });
    receiptUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    // Prefer live ack number; else read what updateWriteQueue may have backfilled onto app_vouchers.
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }
    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      receiptUuid,
      invoiceUuid: receiptUuid,
      voucherNumber,
      numberingPolicy: numbering_policy,
      message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional receipt saved' : 'Receipt created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    const msg = String(e.message || '');
    const isBillWise = /bill[- ]?wise|bill[- ]?by[- ]?bill|maintain bill/i.test(msg);
    if (isBillWise && receiptUuid) {
      try {
        await query(
          `UPDATE app_vouchers SET tally_sync_status='needs_manual_reconciliation', sync_error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE invoice_uuid=$2`,
          [`Tally rejected receipt: customer ledger missing 'Maintain bill-by-bill'. ${msg}`.slice(0, 500), receiptUuid]
        );
      } catch {}
    }
    res.status(500).json({ status: false, message: msg, billWiseError: isBillWise, tdkRef });
  }
});

// ── POST /tally/voucher/journal ───────────────────────────────────────────────
// 2026-07-14 rewrite: Payment/Receipt parity — single Dr+Cr pair, TDK-JOR,
// app_vouchers, numbering, optional. Depreciation meta stored in payload only.
router.post('/voucher/journal', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration, reference,
    drLedger, crLedger, amount,
    entryType = 'regular',
    isOptional: isOptionalLegacy,
    numbering_policy = 'tally_prime_series',
    depreciationMeta = null,
    isPartyDr = false,
    isPartyCr = false,
  } = req.body;

  if (!companyGuid || !drLedger || !crLedger || !amount) {
    return res.status(400).json({ status: false, message: 'drLedger, crLedger and amount required' });
  }

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  if (!(amt > 0)) {
    return res.status(400).json({ status: false, message: 'amount must be greater than 0' });
  }
  const dt = tallyDate(date);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'JOR').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'JOR').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  // Keep narration user/business-friendly (no TDK ids).
  const fullNarration = narration || '';

  // Reference XML: Dr leg ISDEEMEDPOSITIVE=Yes + negative amount; Cr = No + positive.
  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Journal" ACTION="Create">
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
  ${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}
  <REFERENCE>${esc(tdkRef || reference || '')}</REFERENCE>
  <NARRATION>${esc(fullNarration)}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(drLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>${isPartyDr ? 'Yes' : 'No'}</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(crLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>${isPartyCr ? 'Yes' : 'No'}</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    entryType: isOptional ? 'optional' : 'regular',
    drLedger,
    crLedger,
    amount: amt,
    narration: fullNarration,
    depreciationMeta: depreciationMeta || null,
  };

  const label = `${drLedger} / ${crLedger}${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'journal', label, amt, persistPayload, xml).catch(() => null);

  let journalUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'journal',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       drLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[journal-app_voucher] insert failed:', e.message); return { rows: [] }; });
    journalUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }
    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      journalUuid,
      invoiceUuid: journalUuid,
      voucherNumber,
      numberingPolicy: numbering_policy,
      message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional journal saved' : 'Journal created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message, tdkRef });
  }
});

// ── POST /tally/voucher/contra ────────────────────────────────────────────────
// 2026-07-14 rewrite: Source(From)=Cr → Destination(To)=Dr, TDK-CON, BANKALLOCATIONS,
// optional matched CASHDENOMINATION (Contra_2), app_vouchers, numbering.
router.post('/voucher/contra', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration, reference,
    fromLedger, toLedger, amount,
    entryType = 'regular',
    isOptional: isOptionalLegacy,
    numbering_policy = 'tally_prime_series',
    contraKind = null, // cash_deposit | cash_withdrawal | bank_transfer | cash_transfer
    instrumentDetails = null,
    cashCount = null, // { used, matched, denominations: { [note]: qty }, counted }
    fromIsCash = false,
    toIsCash = false,
    fromIsBank = false,
    toIsBank = false,
  } = req.body;

  if (!companyGuid || !fromLedger || !toLedger || !amount) {
    return res.status(400).json({ status: false, message: 'fromLedger, toLedger and amount required' });
  }

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  if (!(amt > 0)) {
    return res.status(400).json({ status: false, message: 'amount must be greater than 0' });
  }
  const dt = tallyDate(date);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'CON').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'CON').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  // Keep narration user/business-friendly (no TDK ids).
  const fullNarration = narration || '';

  // Infer kind if client omitted
  let kind = contraKind;
  if (!kind) {
    if (fromIsCash && toIsBank) kind = 'cash_deposit';
    else if (fromIsBank && toIsCash) kind = 'cash_withdrawal';
    else if (fromIsBank && toIsBank) kind = 'bank_transfer';
    else if (fromIsCash && toIsCash) kind = 'cash_transfer';
    else kind = 'cash_transfer';
  }

  const txnTypeDefault = kind === 'cash_deposit' ? 'Cash'
    : kind === 'bank_transfer' ? 'Inter Bank Transfer'
    : kind === 'cash_withdrawal' ? 'Cheque'
    : 'Cash';

  const inst = instrumentDetails || {};
  const instrumentNo = String(inst.instrumentNo || reference || '').trim();
  const instrumentDate = tallyDate(inst.instrumentDate || date);
  const txnType = String(inst.transactionType || txnTypeDefault);

  // CASHDENOMINATION: only when cash count used + matched (never send mismatch).
  // Contra_2: 0-100-409-… = 100×500 + 409×100 → slots [2000,500,100,50,20,10,5,2,1].
  // UI may include 200 notes; fold them into the 100 slot (2×) for Tally.
  const denomSlots = [2000, 500, 100, 50, 20, 10, 5, 2, 1, 0, 0, 0];
  let cashDenomStr = null;
  if (cashCount && cashCount.used && cashCount.matched && cashCount.denominations) {
    const denoms = { ...(cashCount.denominations || {}) };
    const twoHundreds = Math.max(0, parseInt(denoms['200'] ?? denoms[200] ?? 0, 10) || 0);
    if (twoHundreds > 0) {
      const hundreds = Math.max(0, parseInt(denoms['100'] ?? denoms[100] ?? 0, 10) || 0);
      denoms['100'] = hundreds + twoHundreds * 2;
      delete denoms['200'];
      delete denoms[200];
    }
    const counts = denomSlots.map((face) => {
      if (!face) return 0;
      return Math.max(0, parseInt(denoms[String(face)] ?? denoms[face] ?? 0, 10) || 0);
    });
    cashDenomStr = counts.join('-');
  }

  const makeBankAlloc = (signedAmt, favouring, withDenom) => {
    const uniqueName = `tdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const denomTag = withDenom && cashDenomStr
      ? `\n        <CASHDENOMINATION>${cashDenomStr}</CASHDENOMINATION>`
      : '';
    const instrTag = instrumentNo
      ? `\n        <INSTRUMENTNUMBER>${esc(instrumentNo)}</INSTRUMENTNUMBER>`
      : '';
    const favourTag = favouring
      ? `\n        <PAYMENTFAVOURING>${esc(favouring)}</PAYMENTFAVOURING>`
      : '';
    return `    <BANKALLOCATIONS.LIST>
      <DATE>${dt}</DATE>
      <INSTRUMENTDATE>${instrumentDate}</INSTRUMENTDATE>
      <NAME>${uniqueName}</NAME>
      <TRANSACTIONTYPE>${esc(txnType)}</TRANSACTIONTYPE>${favourTag}${instrTag}
      <STATUS>No</STATUS>
      <PAYMENTMODE>Transacted</PAYMENTMODE>
      <ISCONNECTEDPAYMENT>No</ISCONNECTEDPAYMENT>
      <ISSPLIT>No</ISSPLIT>
      <ISCONTRACTUSED>No</ISCONTRACTUSED>
      <ISACCEPTEDWITHWARNING>No</ISACCEPTEDWITHWARNING>
      <ISTRANSFORCED>No</ISTRANSFORCED>${denomTag}
      <AMOUNT>${signedAmt}</AMOUNT>
    </BANKALLOCATIONS.LIST>`;
  };

  // From = Cr (+amt); To = Dr (−amt). Attach BANKALLOCATIONS on bank legs.
  // Deposit (cash→bank): denom on bank Dr (matches Contra_2).
  // Withdrawal (bank→cash): bank alloc on bank Cr with cheque.
  const fromBankAlloc = fromIsBank
    ? makeBankAlloc(amt, kind === 'cash_withdrawal' ? 'Self' : toLedger, false)
    : '';
  const toBankAlloc = toIsBank
    ? makeBankAlloc(-amt, fromLedger, kind === 'cash_deposit' && !!cashDenomStr)
    : '';

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Contra" ACTION="Create">
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Contra</VOUCHERTYPENAME>
  ${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}
  <REFERENCE>${esc(tdkRef || reference || '')}</REFERENCE>
  <NARRATION>${esc(fullNarration)}</NARRATION>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <PARTYLEDGERNAME>${esc(toLedger)}</PARTYLEDGERNAME>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(fromLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${amt}</AMOUNT>
${fromBankAlloc}
  </ALLLEDGERENTRIES.LIST>
  <ALLLEDGERENTRIES.LIST>
    <LEDGERNAME>${esc(toLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <AMOUNT>${-amt}</AMOUNT>
${toBankAlloc}
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    entryType: isOptional ? 'optional' : 'regular',
    fromLedger,
    toLedger,
    amount: amt,
    contraKind: kind,
    narration: fullNarration,
    instrumentDetails: inst,
    cashCount: cashCount && cashCount.used && cashCount.matched
      ? cashCount
      : (cashCount?.used ? { ...cashCount, matched: false } : null),
    cashDenomStr,
  };

  const label = `${fromLedger} → ${toLedger}${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'contra', label, amt, persistPayload, xml).catch(() => null);

  let contraUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'contra',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       fromLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[contra-app_voucher] insert failed:', e.message); return { rows: [] }; });
    contraUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }
    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      contraUuid,
      invoiceUuid: contraUuid,
      voucherNumber,
      numberingPolicy: numbering_policy,
      message: offline ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional contra saved' : 'Contra created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message, tdkRef });
  }
});

// ── POST /tally/voucher/sales-order ──────────────────────────────────────────
router.post('/voucher/sales-order', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, dueDate, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [],
    taxes = [],
    logistics = [],
    isOptional = false,
    original_entry_type = 'regular',
    numbering_policy = 'tally_prime_series',
    termsText,
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  const dueDt = dueDate ? tallyDate(dueDate) : dt;

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'SOR').catch(() => null);

  let tdkOrderNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkOrderNo = await generateTDSeriesNumber(companyGuid, 'SOR').catch(() => null);
    if (tdkOrderNo) effectiveVoucherNumber = tdkOrderNo;
  }

  // Persist terms in payload for preview/share; narration stays clean for Tally
  const persistPayload = { ...req.body, termsText: termsText || req.body.termsText || '' };

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
  <VOUCHERNUMBER>${effectiveVoucherNumber}</VOUCHERNUMBER>
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

  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    const orderNoTag = effectiveVoucherNumber || '';
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
      ${orderNoTag ? `<ORDERNO>${orderNoTag}</ORDERNO>` : '<ORDERNO/>'}
      <ORDERDUEDATE>${dueDt}</ORDERDUEDATE>
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${item.actualQty || item.billedQty || 1}</ACTUALQTY>
      <BILLEDQTY>${item.billedQty || 1}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  for (const tax of taxes) {
    if (!tax.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${tax.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(tax.taxAmount) || 0}</AMOUNT>
    <VATASSESSABLEVALUE>${parseFloat(tax.taxableValue) || 0}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lg.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lt.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger}${effectiveVoucherNumber ? ' #' + effectiveVoucherNumber : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'sales_order', label, amt, persistPayload, xml).catch(() => null);

  let orderUuid = null;
  if (qId && tdkRef) {
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'sales_order',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, original_entry_type,
       numbering_policy,
       tdkOrderNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[app_vouchers] sales_order insert failed:', e.message); return { rows: [] }; });
    orderUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    if (!offline && orderUuid) {
      await query(
        `UPDATE app_vouchers SET tally_sync_status='synced', books_impact_status='posted'
         WHERE invoice_uuid=$1`,
        [orderUuid]
      ).catch(() => {});
    }
    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      message: offline ? 'Saved. Will push when desktop connects.' : 'Sales order created',
      data: result,
      tdkReferenceNo: tdkRef,
      voucherNumber: tdkOrderNo || result?.voucherNumber || null,
      tallyId: result?.tallyId || null,
      invoiceUuid: orderUuid,
      numbering_policy,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    if (orderUuid) {
      await query(
        `UPDATE app_vouchers SET tally_sync_status='failed' WHERE invoice_uuid=$1`,
        [orderUuid]
      ).catch(() => {});
    }
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/master/party ──────────────────────────────────────────────────
router.post('/master/party', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName,
    name: _name, partyName,
    parent: _parent, address = '', state = '',
    country = 'India', gstin = '', email = '', phone = '', website = '',
    gstRegType: _gstRegType, gstType,
    pincode = '', isBillWise = 'Yes',
    mailingName: _mailingName,
    openingBalance = 0, isCr = false,
    bankDetails = null,
    vatDetails = null,
    pan = '',
    ledger_type,
    dutyCategory, dutyType, dutyTaxType,
    taxType: bodyTaxType,
    percentage, dutyPercentage,
    // Sales/Purchase/Income/Expense GST ledger fields (Custom Groups)
    gstApplicable, typeOfSupply, taxability, hsnCode,
    igstRate = 0, cgstRate = 0, sgstRate = 0,
    inventoryValuesAffected,
  } = req.body;

  const name = _name || partyName;
  const isDutiesLedger = ledger_type === 'duties_taxes'
    || /duties\s*&\s*taxes/i.test(String(_parent || ''));
  const parent = _parent || (isDutiesLedger ? 'Duties & Taxes' : 'Sundry Debtors');
  // Party GST registration only when explicitly sent (Sales Add Customer / PartyForm).
  // Do NOT default Regular — Cash/Bank/P&L custom ledgers must not get LEDGSTREGDETAILS.
  const gstRegType = isDutiesLedger ? '' : (_gstRegType || gstType || '');
  const mailingName = _mailingName || name;

  if (!companyGuid || !name) {
    return res.status(400).json({ status: false, message: 'companyGuid and name required' });
  }

  // Opening balance: Tally expects positive number + Dr/Cr suffix
  const obAmt = parseFloat(openingBalance) || 0;
  const obFormatted = obAmt !== 0 ? (isCr ? obAmt : -obAmt).toFixed(2) : '0';

  // Map mobile GST type values to Tally Prime-compatible values
  const gstTypeMap = {
    'Unregistered':          'Unregistered/Consumer',
    'Unregistered/Consumer': 'Unregistered/Consumer',
    'Regular':               'Regular',
    'Composition':           'Composition',
    'Consumer':              'Consumer',
    'SEZ':                   'SEZ',
    'Overseas':              'Overseas',
  };
  const gstRegTypeFinal = gstRegType ? (gstTypeMap[gstRegType] || gstRegType) : '';

  // Duties & Taxes statutory fields (Tally Prime: Type of Duty/Tax + conditional Tax type)
  const dutyCategoryRaw = dutyCategory || dutyTaxType || dutyType || '';
  const taxTypeRaw      = bodyTaxType || '';
  const ratePct         = parseFloat(percentage ?? dutyPercentage ?? 0) || 0;
  const GST_DUTY_HEAD_MAP = {
    IGST:         'Integrated Tax',
    CGST:         'Central Tax',
    'SGST/UTGST': 'State Tax',
    Cess:         'Cess',
  };
  const resolvedDutyHead = GST_DUTY_HEAD_MAP[taxTypeRaw] || taxTypeRaw;
  let dutiesXml = '';
  if (isDutiesLedger && dutyCategoryRaw) {
    dutiesXml = `
<ISBEHAVEASDUTY>Yes</ISBEHAVEASDUTY>
<TAXTYPE>${escapeXml(dutyCategoryRaw)}</TAXTYPE>`;
    if (taxTypeRaw && (dutyCategoryRaw === 'GST' || dutyCategoryRaw === 'Others')) {
      dutiesXml += `\n<GSTDUTYHEAD>${escapeXml(resolvedDutyHead)}</GSTDUTYHEAD>`;
    }
    dutiesXml += `\n<RATEOFTAXCALCULATION>${ratePct.toFixed(2)}</RATEOFTAXCALCULATION>`;
  }

  // Build address lines — split multiline string into separate ADDRESS tags
  const addressLines = address
    ? String(address).split(/\r?\n/).map(l => l.trim()).filter(Boolean)
    : [];
  const addressXml = addressLines.length
    ? `<ADDRESS.LIST TYPE="String">\n${addressLines.map(l => `<ADDRESS>${escapeXml(l)}</ADDRESS>`).join('\n')}\n</ADDRESS.LIST>`
    : '';

  // GST registration details list — required for GSTIN to save in TallyPrime
  // PARTYGSTIN alone is a computed field and is ignored on import; must use LEDGSTREGDETAILS.LIST
  // Field names confirmed: GSTREGISTRATIONTYPE (not REGISTRATIONTYPE), direct <GSTIN> tag (not GSTIN.LIST)
  const _gstDate = (() => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; })();

  // Sales / Purchase / Income / Expense GST ledger block (grafted from stock-item pattern)
  const ledgerGstAppl = gstApplicable
    || ((parseFloat(igstRate) > 0 || parseFloat(cgstRate) > 0 || parseFloat(sgstRate) > 0) ? 'Applicable' : '');
  let ledgerGstXml = '';
  if (ledgerGstAppl && !isDutiesLedger) {
    ledgerGstXml = `\n<GSTAPPLICABLE>${escapeXml(ledgerGstAppl)}</GSTAPPLICABLE>`;
    if (typeOfSupply) {
      ledgerGstXml += `\n<GSTTYPEOFSUPPLY>${escapeXml(typeOfSupply)}</GSTTYPEOFSUPPLY>`;
    }
    if (inventoryValuesAffected) {
      ledgerGstXml += `\n<INVENTORYVALUESAREFFECTED>${escapeXml(inventoryValuesAffected)}</INVENTORYVALUESAREFFECTED>`;
    }
    if (ledgerGstAppl === 'Applicable' && (hsnCode || taxability || igstRate || cgstRate || sgstRate)) {
      const _ig = parseFloat(igstRate) || 0;
      const _cg = parseFloat(cgstRate) || (_ig ? _ig / 2 : 0);
      const _sg = parseFloat(sgstRate) || (_ig ? _ig / 2 : 0);
      const taxabilityFinal = taxability || 'Taxable';
      ledgerGstXml += `
<GSTDETAILS.LIST>
  <APPLICABLEFROM>${_gstDate}</APPLICABLEFROM>
  ${hsnCode ? `<HSNCODE>${escapeXml(hsnCode)}</HSNCODE>` : ''}
  <TAXABILITY>${escapeXml(taxabilityFinal)}</TAXABILITY>
  <STATEWISEDETAILS.LIST>
    <STATENAME>Any State</STATENAME>
    <RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${_ig}</GSTRATE></RATEDETAILS.LIST>
    <RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${_cg}</GSTRATE></RATEDETAILS.LIST>
    <RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${_sg}</GSTRATE></RATEDETAILS.LIST>
  </STATEWISEDETAILS.LIST>
</GSTDETAILS.LIST>`;
    }
  }

  const gstDetailsXml = gstRegTypeFinal ? `
<LEDGSTREGDETAILS.LIST>
  <APPLICABLEFROM>${_gstDate}</APPLICABLEFROM>
  <GSTREGISTRATIONTYPE>${escapeXml(gstRegTypeFinal)}</GSTREGISTRATIONTYPE>
  ${state ? `<STATE>${escapeXml(state)}</STATE>` : ''}
  ${state ? `<PLACEOFSUPPLY>${escapeXml(state)}</PLACEOFSUPPLY>` : ''}
  ${gstin ? `<GSTIN>${escapeXml(gstin)}</GSTIN>` : ''}
  ${pan   ? `<PANNO>${escapeXml(pan)}</PANNO>`         : ''}
</LEDGSTREGDETAILS.LIST>` : '';

  // VAT fields (legacy pre-GST). 2026-07-06 R3: dealer-type saved but TIN/CST
  // were silently dropped in Tally 6.2. Fix: add correct tag names per Tally's
  // ledger master schema. VAT does NOT historise in Tally 6.2 (confirmed with
  // user: no history popup on VAT Details page) — flat tags remain correct.
  // Belt-and-suspenders: try TIN in 3 tag variants + CST in 2 tag variants.
  const vatXml = vatDetails ? `
${vatDetails.dealerType  ? `<VATDEALERTYPE>${escapeXml(vatDetails.dealerType)}</VATDEALERTYPE>`         : ''}
${vatDetails.vatTin     ? `<VATTINNUMBER>${escapeXml(vatDetails.vatTin)}</VATTINNUMBER>`               : ''}
${vatDetails.vatTin     ? `<STATEVATTINNUMBER>${escapeXml(vatDetails.vatTin)}</STATEVATTINNUMBER>`     : ''}
${vatDetails.vatTin     ? `<SALESTAXNUMBER>${escapeXml(vatDetails.vatTin)}</SALESTAXNUMBER>`           : ''}
${vatDetails.cstNo      ? `<INTERSTATESTNUMBER>${escapeXml(vatDetails.cstNo)}</INTERSTATESTNUMBER>`   : ''}
${vatDetails.cstNo      ? `<CSTNUMBER>${escapeXml(vatDetails.cstNo)}</CSTNUMBER>`                     : ''}
${vatDetails.formCApplicable ? `<ISAGAINST_FORM_C>Yes</ISAGAINST_FORM_C>`                           : ''}` : '';

  // Bank details — wrapped in LEDGERBANKALLOCATIONS.LIST
  const _bankAccNo = bankDetails?.accountNo || bankDetails?.accountNumber || '';
  const bankXml = (bankDetails && (_bankAccNo || bankDetails?.bankName || bankDetails?.ifsc)) ? `
<LEDGERBANKALLOCATIONS.LIST>
${_bankAccNo ? `  <BANKACCNO>${escapeXml(_bankAccNo)}</BANKACCNO>` : ''}
${_bankAccNo ? `  <BANKDETAILS>${escapeXml(_bankAccNo)}</BANKDETAILS>` : ''}
${bankDetails.bankName ? `  <BANKNAME>${escapeXml(bankDetails.bankName)}</BANKNAME>` : ''}
${(bankDetails.ifsc || bankDetails.ifscCode) ? `  <IFSCODE>${escapeXml(bankDetails.ifsc || bankDetails.ifscCode || '')}</IFSCODE>` : ''}
${(bankDetails.branch || bankDetails.branchName) ? `  <BANKBRANCHNAME>${escapeXml(bankDetails.branch || bankDetails.branchName || '')}</BANKBRANCHNAME>` : ''}
${(bankDetails.beneficiaryName || bankDetails.accountHolderName) ? `  <BANKACCHOLDERSHIPNAME>${escapeXml(bankDetails.beneficiaryName || bankDetails.accountHolderName || '')}</BANKACCHOLDERSHIPNAME>` : ''}
  <BANKACCHOLDERSHIPTYPE>Proprietor</BANKACCHOLDERSHIPTYPE>
</LEDGERBANKALLOCATIONS.LIST>` : '';

  // 2026-07-06 — Tally 6.2 mailing details historisation fix.
  // From TallyPrime 6.2, Mailing Details is a dated history collection
  // (Ledger Alter -> "Mailing Details (History)" popup, columns:
  //  Applicable From | Name | Update Address | State | Country | Pincode).
  // Flat top-level ADDRESS.LIST / LEDSTATENAME / COUNTRYNAME / PINCODE tags
  // are silently ignored unless a history entry with UpdateAddress=Yes exists.
  // Same pattern as LEDGSTREGDETAILS.LIST -- dated wrapper with APPLICABLEFROM.
  // Flat tags below are KEPT as fallback (harmless if 6.2 ignores them).
  const _mailDate = _gstDate; // same YYYYMMDD as GST (today)
  const hasMailingData = addressLines.length || state || country || pincode;
  // 2026-07-06 R2 — State + Country still "Not Applicable" after R1.
  // Address + Pincode saved OK, proving wrapper is right. State/Country need
  // broader tag coverage inside the wrapper. GST historised block uses <STATE>
  // (not <STATENAME>) — that's the strongest bet. Country tags order:
  // COUNTRY-first (Tally UI dependency: pick country -> unlocks state list).
  // Belt-and-suspenders: 4 country variants + 5 state variants. Tally silently
  // drops unknown tags, so extras are safe.
  const mailingDetailsXml = hasMailingData ? `
<LEDMAILINGDETAILS.LIST>
  <APPLICABLEFROM>${_mailDate}</APPLICABLEFROM>
  <LEDGERMAILINGNAME>${escapeXml(mailingName)}</LEDGERMAILINGNAME>
  <ISUPDATINGADDRESS>Yes</ISUPDATINGADDRESS>
  ${country ? `<COUNTRYNAME>${escapeXml(country)}</COUNTRYNAME>`               : ''}
  ${country ? `<COUNTRYOFRESIDENCE>${escapeXml(country)}</COUNTRYOFRESIDENCE>` : ''}
  ${country ? `<COUNTRY>${escapeXml(country)}</COUNTRY>`                       : ''}
  ${country ? `<LEDCOUNTRYNAME>${escapeXml(country)}</LEDCOUNTRYNAME>`         : ''}
  ${addressXml}
  ${state   ? `<LEDSTATENAME>${escapeXml(state)}</LEDSTATENAME>`     : ''}
  ${state   ? `<STATENAME>${escapeXml(state)}</STATENAME>`           : ''}
  ${state   ? `<STATE>${escapeXml(state)}</STATE>`                   : ''}
  ${state   ? `<PLACEOFSUPPLY>${escapeXml(state)}</PLACEOFSUPPLY>`   : ''}
  ${state   ? `<PRIORSTATENAME>${escapeXml(state)}</PRIORSTATENAME>` : ''}
  ${pincode ? `<PINCODE>${escapeXml(pincode)}</PINCODE>`             : ''}
</LEDMAILINGDETAILS.LIST>` : '';

  // 2026-07-02 — Mailing Details fix (Yash financial services debug).
  // Old approach: sent flat ADDRESS.LIST + LEDMULTIADDRESSLIST.LIST both in same
  // <LEDGER> block. Field ordering had <PARENT> AFTER mailing fields. Result:
  // Tally accepted NAME/GSTIN/PAN/email/phone/bank but silently dropped
  // address/state/country/pincode from Mailing Details.
  //
  // Root causes fixed:
  //   1. Removed LEDMULTIADDRESSLIST.LIST entirely — that block requires the
  //      multi-address feature enabled in Tally, and when off it poisons the
  //      whole mailing import (Tally 3.0+ quirk).
  //   2. Field ordering — <PARENT> now placed IMMEDIATELY after <NAME> so Tally
  //      resolves the group hierarchy before applying field bindings.
  //   3. MAILINGNAME.LIST + ADDRESS.LIST both wrapped with TYPE="String" (was
  //      already there on flat block — kept; inconsistent inner block gone).
  //
  // NOTE: LEDMULTIADDRESSLIST.LIST removal is intentional. If a customer
  // later needs multi-address support, re-add it behind a company config flag
  // (only send when Tally company has 'Maintain multiple mailing details' = Yes).

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>All Masters</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER NAME="${escapeXml(name)}" ACTION="Create">
<NAME>${escapeXml(name)}</NAME>
<PARENT>${escapeXml(parent)}</PARENT>
${dutiesXml}
${ledgerGstXml}
<MAILINGNAME.LIST TYPE="String"><MAILINGNAME>${escapeXml(mailingName)}</MAILINGNAME></MAILINGNAME.LIST>
${addressXml}
${pincode ? `<PINCODE>${escapeXml(pincode)}</PINCODE>`                 : ''}
<COUNTRYNAME>${escapeXml(country)}</COUNTRYNAME>
<COUNTRYOFRESIDENCE>${escapeXml(country)}</COUNTRYOFRESIDENCE>
${state   ? `<LEDSTATENAME>${escapeXml(state)}</LEDSTATENAME>`         : ''}
${state   ? `<STATENAME>${escapeXml(state)}</STATENAME>`               : ''}
${state   ? `<PRIORSTATENAME>${escapeXml(state)}</PRIORSTATENAME>`     : ''}
${state   ? `<PLACEOFSUPPLY>${escapeXml(state)}</PLACEOFSUPPLY>`       : ''}
${!isDutiesLedger && gstRegTypeFinal ? `<GSTREGISTRATIONTYPE>${escapeXml(gstRegTypeFinal)}</GSTREGISTRATIONTYPE>` : ''}
${gstin ? `<PARTYGSTIN>${escapeXml(gstin)}</PARTYGSTIN>`             : ''}
${pan   ? `<INCOMETAXNUMBER>${escapeXml(pan)}</INCOMETAXNUMBER>`     : ''}
${phone ? `<LEDGERMOBILE>${escapeXml(phone)}</LEDGERMOBILE>`         : ''}
${email ? `<EMAIL>${escapeXml(email)}</EMAIL>`                       : ''}
${email ? `<LEDGEREMAIL>${escapeXml(email)}</LEDGEREMAIL>`           : ''}
${website ? `<WEBSITE>${escapeXml(website)}</WEBSITE>`               : ''}
${website ? `<LEDGERWEBSITE>${escapeXml(website)}</LEDGERWEBSITE>`   : ''}
${website ? `<CONTACTWEBSITE>${escapeXml(website)}</CONTACTWEBSITE>` : ''}
${website ? `<HOMEPAGE>${escapeXml(website)}</HOMEPAGE>`             : ''}
<ISBILLWISEON>${isBillWise}</ISBILLWISEON>
${obAmt !== 0 ? `<OPENINGBALANCE>${obFormatted}</OPENINGBALANCE>` : ''}
${vatXml}
${gstDetailsXml}
${bankXml}
${mailingDetailsXml}
</LEDGER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'party', name, null, req.body, xml).catch(() => null);
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';

    // Immediately insert into local ledgers table so getParties returns it
    // without waiting for the next Tally sync. Tally sync will overwrite with real GUID.
    // Immediate insert — skip if a ledger with same name already exists (prevents duplicate before sync)
    const balanceType = isCr ? 'Cr' : 'Dr';
    query(
      `INSERT INTO ledgers (guid, company_guid, name, parent, gstin, pan, address, state_name, pincode, gst_registration_type, opening_balance, closing_balance, balance_type, tax_rate)
       SELECT gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11, $12
       WHERE NOT EXISTS (
         SELECT 1 FROM ledgers WHERE company_guid = $1 AND LOWER(name) = LOWER($2)
       )`,
      [companyGuid, name, parent, gstin || '', pan || '', address || '', state || null, pincode || null, gstRegTypeFinal || null, obAmt, balanceType, isDutiesLedger ? ratePct : 0]
    ).catch((e) => { console.warn('[party-immediate-insert]', e.message); }); // fire-and-forget, don't block response

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
// Mirrors Sales create signs flipped for purchase (party Cr +, inventory/tax Dr −).
// Reference: TallyPrime Purchase export — VCHTYPE Purchase, Item Invoice, BILLALLOCATIONS New Ref.
router.post('/voucher/purchase', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount, items = [], taxes = [], logistics = [],
    isOptional = false,
    voucherType = 'Purchase',
    make_payment = null,
    numbering_policy = 'tally_prime_series',
    original_entry_type = 'regular',
    dispatch_details = null,
  } = req.body;
  if (!companyGuid || !partyLedger) {
    return res.status(400).json({ status: false, message: 'companyGuid and partyLedger required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: false, message: 'At least one item is required' });
  }
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(totalAmount) || 0;
  const dt = tallyDate(date);
  const vchType = voucherType || 'Purchase';
  const payAmt = make_payment?.ledgerName && parseFloat(make_payment.amount) > 0
    ? parseFloat(make_payment.amount) : 0;

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'PUR').catch(() => null);
  // Keep narration user/business-friendly (no TDK ids). Identity = REFERENCE + bill New Ref.
  // LOCKED DECISIONS 2026-07-16: FORBIDDEN stuffing TDK into narration as primary identity.
  const fullNarration = narration || '';

  // ── Dispatch / EWB XML (same shape as Sales; DOCUMENTTYPE=Invoice for purchase inward) ──
  const toTallyDatePur = (d) => d ? String(d).replace(/-/g, '') : '';
  let topLevelDispatchXml = '';
  let ewbDetailsXml = '';
  if (dispatch_details) {
    const dd = dispatch_details;
    const modeSimpleMap = { road: 'Road', rail: 'Rail', air: 'Air', ship: 'Ship', 'not_applicable': '', 'not applicable': '' };
    const modeCodeMap   = { road: '1 - Road', rail: '2 - Rail', air: '3 - Air', ship: '4 - Ship' };
    const modeKey        = (dd.transport_mode || '').toLowerCase().replace(' ', '_');
    const tallySimpleMode = modeSimpleMap[modeKey] ?? dd.transport_mode ?? '';
    const tallyCodedMode  = modeCodeMap[modeKey] ?? '';
    const vtKey = (dd.vehicle_type || '').toLowerCase();
    const tallyVehicleType = vtKey.includes('over') ? 'O - Over Dimensional Cargo (ODC)'
                           : vtKey === 'regular'     ? 'R - Regular'
                           : dd.vehicle_type         || '';
    const dispatchDate = toTallyDatePur(dd.transport_doc_date || date);
    topLevelDispatchXml = [
      dispatchDate          ? `  <BILLOFLADINGDATE>${dispatchDate}</BILLOFLADINGDATE>` : '',
      tallySimpleMode       ? `  <BASICSHIPPEDBY>${tallySimpleMode}</BASICSHIPPEDBY>` : '',
      dd.transport_doc_no   ? `  <BASICSHIPDOCUMENTNO>${dd.transport_doc_no}</BASICSHIPDOCUMENTNO>` : '',
      dd.ship_to            ? `  <BASICFINALDESTINATION>${dd.ship_to}</BASICFINALDESTINATION>` : '',
      dd.vehicle_number     ? `  <BASICSHIPVESSELNO>${dd.vehicle_number}</BASICSHIPVESSELNO>` : '',
    ].filter(Boolean).join('\n');

    const hasTransport = dd.vehicle_number || tallyCodedMode || dd.transporter_name || dd.transporter_id;
    const consignorLines = [dd.dispatch_from_address1, dd.dispatch_from_address2].map(l => (l || '').trim()).filter(Boolean);
    const consigneeLines = [dd.ship_to_address1, dd.ship_to_address2].map(l => (l || '').trim()).filter(Boolean);
    const consignorAddrXml = consignorLines.length
      ? consignorLines.map(l => `      <CONSIGNORADDRESS>${l}</CONSIGNORADDRESS>`).join('\n')
      : `      <CONSIGNORADDRESS>${dd.dispatch_from || ''}</CONSIGNORADDRESS>`;
    const consigneeAddrXml = consigneeLines.length
      ? consigneeLines.map(l => `      <CONSIGNEEADDRESS>${l}</CONSIGNEEADDRESS>`).join('\n')
      : `      <CONSIGNEEADDRESS>${dd.ship_to || ''}</CONSIGNEEADDRESS>`;
    const ewbNoXml = dd.ewb_number ? `\n    <BILLNUMBER>${dd.ewb_number}</BILLNUMBER>` : '';
    const ewbDtXml = dd.ewb_date ? `\n    <BILLDATE>${toTallyDatePur(dd.ewb_date)}</BILLDATE>` : '';

    ewbDetailsXml = `
  <EWAYBILLDETAILS.LIST>
    <CONSIGNORADDRESS.LIST TYPE="String">
${consignorAddrXml}
    </CONSIGNORADDRESS.LIST>
    <CONSIGNEEADDRESS.LIST TYPE="String">
${consigneeAddrXml}
    </CONSIGNEEADDRESS.LIST>
    <DOCUMENTTYPE>Invoice</DOCUMENTTYPE>
    <SUBTYPE>Supply</SUBTYPE>${ewbNoXml}${ewbDtXml}
    <CONSIGNORPLACE>${dd.dispatch_from || ''}</CONSIGNORPLACE>
    <CONSIGNEEPLACE>${dd.ship_to || ''}</CONSIGNEEPLACE>
    <CONSIGNORPINCODE>${dd.dispatch_from_pincode || ''}</CONSIGNORPINCODE>
    <CONSIGNEEPINCODE>${dd.ship_to_pincode || ''}</CONSIGNEEPINCODE>
    <SHIPPEDFROMSTATE>${dd.dispatch_from_state || ''}</SHIPPEDFROMSTATE>
    <SHIPPEDTOSTATE>${dd.ship_to_state || ''}</SHIPPEDTOSTATE>
    <ISCANCELLED>No</ISCANCELLED>
    <IGNOREGSTINVALIDATION>No</IGNOREGSTINVALIDATION>
    <ISCANCELPENDING>No</ISCANCELPENDING>
    <IGNOREGENERATIONVALIDATION>No</IGNOREGENERATIONVALIDATION>
    <ISEXPORTEDFORGENERATION>No</ISEXPORTEDFORGENERATION>
    <INTRASTATEAPPLICABILITY>No</INTRASTATEAPPLICABILITY>${hasTransport ? `
    <TRANSPORTDETAILS.LIST>
      <DOCUMENTDATE>${dispatchDate}</DOCUMENTDATE>
      <TRANSPORTERID>${dd.transporter_id || ''}</TRANSPORTERID>
      <TRANSPORTERNAME>${dd.transporter_name || ''}</TRANSPORTERNAME>
      <TRANSPORTMODE>${tallyCodedMode}</TRANSPORTMODE>
      <VEHICLENUMBER>${dd.vehicle_number || ''}</VEHICLENUMBER>
      <OLDVEHICLETYPE>${tallyVehicleType}</OLDVEHICLETYPE>
      <VEHICLETYPE>${tallyVehicleType}</VEHICLETYPE>
      <IGNOREVEHICLENOVALIDATION>No</IGNOREVEHICLENOVALIDATION>
      <ISTRANSIDPENDING>No</ISTRANSIDPENDING>
      <ISTRANSIDUPDATED>No</ISTRANSIDUPDATED>
      <IGNORETRANSIDVALIDATION>No</IGNORETRANSIDVALIDATION>
      <ISEXPORTEDFORTRANSPORTERID>No</ISEXPORTEDFORTRANSPORTERID>
      <ISPARTBPENDING>No</ISPARTBPENDING>
      <ISPARTBUPDATED>No</ISPARTBUPDATED>
      <IGNOREPARTBVALIDATION>No</IGNOREPARTBVALIDATION>
      <ISEXPORTEDFORPARTB>No</ISEXPORTEDFORPARTB>
    </TRANSPORTDETAILS.LIST>` : ''}
    <EXTENSIONDETAILS.LIST></EXTENSIONDETAILS.LIST>
    <MULTIVEHICLEDETAILS.LIST></MULTIVEHICLEDETAILS.LIST>
    <STATEWISETHRESHOLD.LIST></STATEWISETHRESHOLD.LIST>
  </EWAYBILLDETAILS.LIST>`;
  }

  let tdkInvoiceNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkInvoiceNo = await generateTDSeriesNumber(companyGuid, 'PUR').catch(() => null);
    if (tdkInvoiceNo) effectiveVoucherNumber = tdkInvoiceNo;
  }

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="${vchType}" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${effectiveVoucherNumber}</VOUCHERNUMBER>
  <REFERENCE>${tdkRef || reference || ''}</REFERENCE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>No</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${fullNarration || ''}</NARRATION>
${topLevelDispatchXml}
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${amt}</AMOUNT>${tdkRef ? `
    <BILLALLOCATIONS.LIST>
      <NAME>${tdkRef}</NAME>
      <BILLTYPE>New Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${amt}</AMOUNT>
    </BILLALLOCATIONS.LIST>` : ''}
  </LEDGERENTRIES.LIST>`;

  for (const item of items) {
    const ia = parseFloat(item.amount) || 0;
    const qty = item.actualQty || item.billedQty || 1;
    const billed = item.billedQty || qty;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>
    <AMOUNT>${-ia}</AMOUNT>
    <ACTUALQTY>${qty}</ACTUALQTY>
    <BILLEDQTY>${billed}</BILLEDQTY>
    <RATE>${item.rate || 0}</RATE>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${item.purchaseLedger || 'Purchase Account GST'}</LEDGERNAME>
      <AMOUNT>${-ia}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
      <AMOUNT>${-ia}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${billed}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  for (const tax of taxes) {
    if (!tax.ledgerName || !(parseFloat(tax.taxAmount) > 0)) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${tax.ledgerName}</LEDGERNAME>
    <AMOUNT>${-parseFloat(tax.taxAmount)}</AMOUNT>
    <VATASSESSABLEVALUE>${-Math.abs(parseFloat(tax.taxableValue) || 0)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    const lgAmt = parseFloat(lg.amount) || 0;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lg.ledgerName}</LEDGERNAME>
    <AMOUNT>${-lgAmt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lt.ledgerName}</LEDGERNAME>
    <AMOUNT>${-parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }

  if (ewbDetailsXml) xml += ewbDetailsXml;

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = { ...req.body, tdkRef, make_payment, narration: fullNarration, voucherType: vchType, dispatch_details: dispatch_details || null };
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'purchase', partyLedger, amt, persistPayload, xml).catch(() => null);

  let invoiceUuid = null;
  let invoiceCreatedAt = null;
  if (qId && tdkRef) {
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'purchase_invoice',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid, created_at`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : (original_entry_type || 'regular'),
       numbering_policy || 'tally_prime_series',
       tdkInvoiceNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[purchase-app_voucher] insert failed:', e.message); return { rows: [] }; });
    invoiceUuid = avResult?.rows?.[0]?.invoice_uuid || null;
    invoiceCreatedAt = avResult?.rows?.[0]?.created_at || null;
  }

  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    const off = r?.status === 'desktop_offline';

    let paymentResult = null;
    if (!off && make_payment?.ledgerName && payAmt > 0 && invoiceUuid && tdkRef) {
      try {
        paymentResult = await createPaymentForInvoice({
          companyGuid, companyName, userId: req.user.userId, date,
          partyLedger, bankLedger: make_payment.ledgerName, amount: payAmt,
          parentInvoiceUuid: invoiceUuid, parentTdkRef: tdkRef,
          isOptional, reference: make_payment.reference || reference,
          parentCreatedAt: invoiceCreatedAt,
        });
        if (paymentResult?.ok) {
          console.log(`[payment-pair] Created payment ${paymentResult.tdkRef} for purchase ${tdkRef}`);
        }
      } catch (payErr) {
        console.error(`[payment-pair] Helper threw for ${tdkRef}:`, payErr.message);
        paymentResult = { ok: false, error: payErr.message };
      }
    }

    if (!off && tdkRef) {
      requestDesktopSyncAfterWrite({
        userId: req.user.userId,
        companyGuid,
        companyName,
        tdkRef,
        tallyIds: r?.tallyId ? [r.tallyId] : [],
        extra: { voucherType: vchType },
      }).catch(() => {});
    }

    res.json({
      status: true, queued: off, queueId: qId, tdkRef, invoiceUuid,
      tdkReferenceNo: tdkRef,
      numberingPolicy: numbering_policy || 'tally_prime_series',
      invoiceNumber: r?.voucherNumber || tdkInvoiceNo || null,
      payment: paymentResult,
      message: off ? 'Saved. Will push when desktop connects.' : (isOptional ? 'Optional purchase saved' : 'Purchase invoice created'),
      data: r, voucherNumber: r?.voucherNumber || tdkInvoiceNo || null, tallyId: r?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});


// ── Credit Note (Sales Return) XML builder ───────────────────────────────────
// Mirrors a real TallyPrime Credit Note export (Invoice Voucher View, Item Invoice
// entry mode, GST nature of return 01-Sales Return) with the export-only fields
// (GUID / REMOTEID / VCHKEY / ALTERID / empty *.LIST scaffolding) left out.
//
// Signs, as in the reference export:
//   inventory + batch + accounting allocation + tax legs → negative, ISDEEMEDPOSITIVE Yes
//   quantities                                            → positive
//   party leg                                             → positive, ISDEEMEDPOSITIVE No
// The party leg carries BILLALLOCATIONS.LIST / BILLTYPE 'Agst Ref' against the
// original invoice's bill reference so Tally knocks the return off that bill.
//
// Exported for the XML shape tests in src/__tests__/credit-note.test.js.
export function buildCreditNoteXml({
  companyName,
  date,
  voucherNumber = '',
  reference = '',
  narration = '',
  partyLedger,
  isOptional = false,
  items = [],
  taxes = [],
  billRefName,
  partyAmount = 0,
}) {
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Credit Note" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>Credit Note</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>
  <REFERENCE>${escapeXml(reference)}</REFERENCE>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <GSTNATUREOFRETURN>01-Sales Return</GSTNATUREOFRETURN>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${escapeXml(narration)}</NARRATION>
  <PARTYNAME>${escapeXml(partyLedger)}</PARTYNAME>
  <PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>`;

  for (const item of items) {
    const qty = item.qty;
    const amount = item.amount;
    const negAmt = -amount;
    // TallyPrime exports RATE qualified with the stock item's unit ("155.00/nos").
    const rawRate = item.rate ?? 0;
    const rateXml = String(rawRate).includes('/')
      ? String(rawRate)
      : `${rawRate}${item.unit ? `/${item.unit}` : ''}`;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <RATE>${escapeXml(rateXml)}</RATE>
    <AMOUNT>${negAmt}</AMOUNT>
    <ACTUALQTY>${qty}</ACTUALQTY>
    <BILLEDQTY>${qty}</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(item.godown || 'Main Location')}</GODOWNNAME>
      <BATCHNAME>${escapeXml(item.batch || 'Primary Batch')}</BATCHNAME>
      <AMOUNT>${negAmt}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <LEDGERNAME>${escapeXml(item.salesLedger)}</LEDGERNAME>
      <AMOUNT>${negAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  // Party leg first among ledger entries so Day Book Particulars = customer
  // (not the first tax ledger like CGST).
  xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(partyLedger)}</LEDGERNAME>
    <AMOUNT>${partyAmount}</AMOUNT>
    <BILLALLOCATIONS.LIST>
      <NAME>${escapeXml(billRefName)}</NAME>
      <BILLTYPE>Agst Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${partyAmount}</AMOUNT>
    </BILLALLOCATIONS.LIST>
  </LEDGERENTRIES.LIST>`;

  // Tax legs are the Sales pattern reversed: debit (ISDEEMEDPOSITIVE Yes) with a
  // negative amount and a negative assessable value.
  for (const tax of taxes) {
    if (!tax.ledgerName || !(tax.taxAmount > 0)) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <LEDGERNAME>${escapeXml(tax.ledgerName)}</LEDGERNAME>
    <AMOUNT>${-tax.taxAmount}</AMOUNT>
    <VATASSESSABLEVALUE>${-tax.taxableValue}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  return xml;
}

/**
 * Validate + normalise a Credit Note request against the linked invoice context.
 * Pure (no IO) so it can be unit-tested; returns either { error } or the
 * server-recomputed items/taxes/totals that the XML and the ledger rows use.
 *
 * Tax is always recalculated from the original invoice geometry (discount-safe
 * net taxable/unit + GST reverse). Client tax amounts are ignored.
 * Exported for src/__tests__/credit-note.test.js.
 */
export function prepareCreditNoteLines({ items = [], taxes = [], context, invoice }) {
  const invoiceLabel = invoice?.voucher_number || context?.linkedInvoice?.voucherNumber || 'the linked invoice';
  const itemIndex = new Map(context.items.map(i => [normalizeName(i.itemName), i]));
  const invoiceSalesKeys = new Set(context.invoiceSalesLedgers.map(l => normalizeName(l.ledgerName)));
  const companySalesKeys = new Set(context.companySalesLedgers.map(l => normalizeName(l.ledgerName)));
  const fallbackSalesLedger = context.defaultSalesLedger;

  // Same item may arrive on several request lines — the remaining-qty check has to
  // see the request total, not each line in isolation.
  const requestedQty = new Map();
  const validated = [];

  for (const raw of items) {
    const rawName = String(raw?.itemName || raw?.name || '').trim();
    if (!rawName) return { error: 'Each item needs an itemName' };

    const key = normalizeName(rawName);
    const ctxItem = itemIndex.get(key);
    if (!ctxItem) {
      return { error: `"${rawName}" is not on invoice ${invoiceLabel} — only items billed on the invoice can be returned` };
    }

    const qty = r3(Math.abs(toNum(raw.billedQty ?? raw.actualQty ?? raw.qty)));
    if (!(qty > 0)) return { error: `Return quantity for "${ctxItem.itemName}" must be greater than 0` };

    const totalForItem = r3((requestedQty.get(key) || 0) + qty);
    if (totalForItem > ctxItem.remainingQty + QTY_EPSILON) {
      return {
        error: `Cannot return ${totalForItem} of "${ctxItem.itemName}" — invoice ${invoiceLabel} billed ${ctxItem.soldQty}, ${ctxItem.previouslyReturnedQty} already returned, ${ctxItem.remainingQty} remaining`,
      };
    }
    requestedQty.set(key, totalForItem);

    const salesLedger = String(raw.salesLedger || raw.returnLedger || fallbackSalesLedger || '').trim();
    if (!salesLedger) {
      return { error: `salesLedger required for "${ctxItem.itemName}" — could not resolve the Sales ledger from invoice ${invoiceLabel}` };
    }
    const allowed = invoiceSalesKeys.size ? invoiceSalesKeys : companySalesKeys;
    if (!allowed.has(normalizeName(salesLedger))) {
      return {
        error: invoiceSalesKeys.size
          ? `"${salesLedger}" is not a Sales ledger used on invoice ${invoiceLabel}`
          : `"${salesLedger}" is not a Sales Accounts ledger for this company`,
      };
    }

    const unitNet = toNum(ctxItem.netTaxablePerUnit) > 0
      ? r2(toNum(ctxItem.netTaxablePerUnit))
      : (ctxItem.soldQty > 0 ? r2(toNum(ctxItem.soldAmount) / ctxItem.soldQty) : r2(toNum(ctxItem.rate)));
    if (!(unitNet > 0) && !(toNum(raw.amount) > 0)) {
      return { error: `Rate for "${ctxItem.itemName}" must be greater than 0` };
    }

    const hasExplicitAmount = raw.amount !== undefined && raw.amount !== null && raw.amount !== '';
    if (hasExplicitAmount && !(r2(Math.abs(toNum(raw.amount))) > 0)) {
      return { error: `Return amount for "${ctxItem.itemName}" must be greater than 0` };
    }

    validated.push({
      itemName: ctxItem.itemName,
      qty,
      amount: hasExplicitAmount ? r2(Math.abs(toNum(raw.amount))) : undefined,
      salesLedger,
      unit: String(raw.unit || ctxItem.unit || '').trim(),
      godown: String(raw.godown || ctxItem.godown || 'Main Location').trim(),
      batch: String(raw.batchName || raw.batch || 'Primary Batch').trim(),
    });
  }

  if (validated.length === 0) return { error: 'At least one item with a positive return quantity is required' };

  const calc = calcCreditNoteReturn({
    context,
    returnLines: validated.map(v => ({
      itemName: v.itemName,
      qty: v.qty,
      amount: v.amount,
    })),
  });

  if (!calc.items.length) return { error: 'At least one item with a positive return quantity is required' };

  const metaByName = new Map(validated.map(v => [normalizeName(v.itemName), v]));
  const normItems = calc.items.map(item => {
    const meta = metaByName.get(normalizeName(item.itemName)) || {};
    return {
      itemName: item.itemName,
      qty: item.qty,
      rate: item.rate,
      amount: item.amount,
      taxableValue: item.taxableValue,
      netTaxablePerUnit: item.netTaxablePerUnit,
      gstRate: item.gstRate,
      lineTaxes: item.lineTaxes || [],
      unit: meta.unit || item.unit || '',
      godown: meta.godown || item.godown || 'Main Location',
      batch: meta.batch || item.batch || 'Primary Batch',
      salesLedger: meta.salesLedger,
      hsn: item.hsn || '',
      soldQty: itemIndex.get(normalizeName(item.itemName))?.soldQty,
      remainingQtyBefore: itemIndex.get(normalizeName(item.itemName))?.remainingQty,
    };
  });

  // taxes arg is intentionally unused — GST reverse is server-owned.
  void taxes;

  return {
    items: normItems,
    taxes: calc.taxes,
    itemsTotal: calc.itemsTotal,
    taxTotal: calc.taxTotal,
    totalAmount: calc.totalAmount,
    returnTaxMode: calc.returnTaxMode,
    allocationMode: calc.allocationMode,
    fallbackUsed: calc.fallbackUsed,
    summary: calc.summary,
  };
}

// ── POST /tally/voucher/credit-note ──────────────────────────────────────────
// 2026-07-29 rewrite: Sales Return only, always linked to a Sales invoice.
// Follows the Sales / Delivery Note / Receipt production pattern — TDK reference,
// TallyDekho series numbering, app_vouchers lifecycle row, offline queue, desktop
// sync-back — and validates everything against the linked invoice server-side:
// company ownership, invoice is Sales, exact party match, item membership, positive
// qty/rate, cumulative returned qty across prior synced + queued Credit Notes, and
// that the Sales ledger belongs to the original invoice.
router.post('/voucher/credit-note', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration,
    partyLedger, totalAmount,
    items = [],     // [{ itemName, billedQty|actualQty|qty, rate, unit, godown, salesLedger }]
    taxes = [],     // [{ ledgerName, taxRate, taxAmount, taxableValue }]
    isOptional = false,
    original_entry_type,
    numbering_policy = 'tally_prime_series', // 'tally_prime_series' | 'tallydekho_series'
    linked_invoice = null,                   // { invoiceGuid, voucherNumber, billRefName, tdkRef }
    reference,                               // fallback only; REFERENCE is the TDK-CN ref
  } = req.body;

  const bad = (message, code = 400) => res.status(code).json({ status: false, message });

  if (!companyGuid) return bad('companyGuid required');
  if (!partyLedger) return bad('partyLedger required');
  if (!Array.isArray(items) || items.length === 0) return bad('items required');
  if (!linked_invoice || typeof linked_invoice !== 'object') {
    return bad('linked_invoice required — a Sales Return must be raised against a Sales invoice');
  }
  const invoiceRef = String(
    linked_invoice.invoiceGuid
    || linked_invoice.guid
    || linked_invoice.id
    || linked_invoice.voucherNumber
    || linked_invoice.invoice_no
    || linked_invoice.voucher_number
    || ''
  ).trim();
  if (!invoiceRef) return bad('linked_invoice.invoiceGuid or linked_invoice.voucherNumber required');

  const entryType = original_entry_type || (isOptional ? 'optional' : 'regular');

  let qId = null;
  let creditNoteUuid = null;
  try {
    // ── Ownership ────────────────────────────────────────────────────────────
    const { rows: coRows } = await query(
      'SELECT guid, name FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
      [companyGuid, req.user.userId]
    );
    if (!coRows[0]) return bad('Company not found or access denied', 403);
    const resolvedCompanyName = companyName || coRows[0].name;

    // ── Linked Sales invoice + cumulative return context ─────────────────────
    const resolved = await resolveCreditNoteContext(companyGuid, invoiceRef);
    if (!resolved.ok) return bad(resolved.message, resolved.status);
    const { invoice, context } = resolved;

    // ── Party must be the invoice party, exactly ─────────────────────────────
    if (normalizeName(partyLedger) !== normalizeName(invoice.party_name)) {
      return bad(`partyLedger "${partyLedger}" does not match invoice ${invoice.voucher_number} party "${invoice.party_name}"`);
    }

    // ── Items / taxes / totals, recomputed server-side ───────────────────────
    const prepared = prepareCreditNoteLines({ items, taxes, context, invoice });
    if (prepared.error) return bad(prepared.error);
    const { items: normItems, taxes: normTaxes, itemsTotal, taxTotal } = prepared;
    const amt = prepared.totalAmount;
    const clientTotal = (totalAmount === undefined || totalAmount === null || totalAmount === '')
      ? null : r2(totalAmount);
    const totalAdjusted = clientTotal !== null && Math.abs(clientTotal - amt) > 0.05;

    // ── Original bill reference for the Agst Ref allocation ──────────────────
    const clientBillRef = String(
      linked_invoice.billRefName
      || linked_invoice.bill_ref_name
      || linked_invoice.invoice_no
      || ''
    ).trim();
    const candidateKeys = new Set(context.linkedInvoice.billRefCandidates.map(normalizeName));
    const billRefName = clientBillRef && candidateKeys.has(normalizeName(clientBillRef))
      ? clientBillRef
      : context.linkedInvoice.billRefName;
    if (!billRefName) {
      return bad(`Could not resolve the original bill reference for invoice ${invoice.voucher_number}`);
    }

    // ── TDK reference + numbering ────────────────────────────────────────────
    const tdkRef = await generateTDKReference(companyGuid, isOptional, 'CN').catch(() => null);
    // Tally series → blank VOUCHERNUMBER, Tally assigns it and syncs it back.
    let tdkCreditNoteNo = null;
    let effectiveVoucherNumber = '';
    if (numbering_policy === 'tallydekho_series' && !isOptional) {
      tdkCreditNoteNo = await generateTDSeriesNumber(companyGuid, 'CN').catch(() => null);
      if (tdkCreditNoteNo) effectiveVoucherNumber = tdkCreditNoteNo;
    }

    const xml = buildCreditNoteXml({
      companyName: resolvedCompanyName,
      date,
      voucherNumber: effectiveVoucherNumber,
      reference: tdkRef || reference || '',
      narration: narration || '',
      partyLedger,
      isOptional,
      items: normItems,
      taxes: normTaxes,
      billRefName,
      partyAmount: amt,
    });

    const linkedInvoicePayload = {
      invoiceGuid: context.linkedInvoice.invoiceGuid,
      voucherNumber: context.linkedInvoice.voucherNumber,
      voucherType: context.linkedInvoice.voucherType,
      date: context.linkedInvoice.date,
      partyLedger: context.linkedInvoice.partyLedger,
      billRefName,
      tdkRef: context.linkedInvoice.tdkRef,
      reference: context.linkedInvoice.reference,
      amount: context.linkedInvoice.amount,
    };

    const persistPayload = {
      ...req.body,
      companyName: resolvedCompanyName,
      partyLedger,
      items: normItems,
      taxes: normTaxes,
      itemsTotal,
      taxTotal,
      totalAmount: amt,
      clientTotalAmount: clientTotal,
      isOptional,
      original_entry_type: entryType,
      numbering_policy,
      narration: narration || '',
      natureOfReturn: '01-Sales Return',
      linked_invoice: linkedInvoicePayload,
      tdkRef,
    };

    const label = `${partyLedger} ← return vs ${invoice.voucher_number || billRefName}`;
    qId = await logWriteQueue(req.user.userId, companyGuid, 'credit_note', label, amt, persistPayload, xml).catch(() => null);

    if (qId && tdkRef) {
      const avResult = await query(
        `INSERT INTO app_vouchers
         (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
          tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
          party_name, total_amount, voucher_date, payload)
         VALUES ($1,$2,$3,'credit_note',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
         RETURNING invoice_uuid`,
        [companyGuid, req.user.userId, qId, tdkRef, entryType,
         numbering_policy,
         tdkCreditNoteNo || null,
         partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
      ).catch(e => { console.error('[app_vouchers] credit_note insert failed:', e.message); return { rows: [] }; });
      creditNoteUuid = avResult?.rows?.[0]?.invoice_uuid || null;
    }

    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';

    // Ask desktop to pull the new voucher so tally_voucher_no lands without a full sync.
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName: resolvedCompanyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }

    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkReferenceNo: tdkRef,
      invoiceUuid: creditNoteUuid,
      creditNoteNumber: tdkCreditNoteNo || result?.voucherNumber || null,
      voucherNumber: tdkCreditNoteNo || result?.voucherNumber || null,
      numbering_policy,
      linkedInvoice: linkedInvoicePayload,
      totals: {
        itemsTotal,
        taxTotal,
        totalAmount: amt,
        clientTotalAmount: clientTotal,
        recomputed: totalAdjusted,
      },
      message: offline
        ? 'Entry saved. Will push to Tally when desktop connects.'
        : (isOptional ? 'Optional credit note saved' : 'Credit note created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message).catch(() => {});
    if (creditNoteUuid) {
      await query(
        `UPDATE app_vouchers SET tally_sync_status='failed', books_impact_status='not_posted',
             sync_error=$2, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
           WHERE invoice_uuid=$1`,
        [creditNoteUuid, String(e.message).slice(0, 500)]
      ).catch(() => {});
    }
    console.error('[voucher/credit-note]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
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

// ── POST /tally/voucher/delivery-note ─────────────────────────────────────────
// 2026-07-29 rewrite: payload aligned with the Sales / Sales Order contract (TDK
// reference, TallyDekho series numbering, app_vouchers lifecycle row, offline queue)
// and XML aligned with a real TallyPrime Delivery Note export — Invoice Voucher View,
// ISINVOICE No, DIFFACTUALQTY Yes, BASICSHIP* dispatch tags, INVOICEORDERLIST.LIST.
router.post('/voucher/delivery-note', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [],     // [{ itemName, actualQty, billedQty, rate, unit, amount, salesLedger, godown, trackingNumber }]
    taxes = [],     // [{ ledgerName, taxRate, taxAmount, taxableValue }]
    logistics = [], // [{ ledgerName, amount, taxes: [{ ledgerName, taxAmount }] }]
    isOptional = false,
    original_entry_type,
    numbering_policy = 'tally_prime_series', // 'tally_prime_series' | 'tallydekho_series'
    dispatch_details = null, // Order & Dispatch screenshot fields (see dispatchXml below)
    linked_order = null, // { order_date, order_no } — emits INVOICEORDERLIST.LIST
    trackingNumber = '', // voucher-level fallback for per-item trackingNumber
  } = req.body;

  if (!companyGuid || !partyLedger || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }
  if (items.some(it => !it?.itemName)) {
    return res.status(400).json({ status: false, message: 'Each item needs itemName' });
  }

  const isOpt = isOptional ? 'Yes' : 'No';
  const entryType = original_entry_type || (isOptional ? 'optional' : 'regular');
  const dt = tallyDate(date);
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  // Party is debited for the full delivery value (goods + taxes + logistics), same as Sales.
  const itemsTotal = items.reduce((s, it) => s + (parseFloat(it.amount) || 0), 0);
  const taxTotal   = taxes.reduce((s, t) => s + (parseFloat(t.taxAmount) || 0), 0);
  const logiTotal  = logistics.reduce((s, lg) => s + (parseFloat(lg.amount) || 0)
    + (lg.taxes || []).reduce((ls, lt) => ls + (parseFloat(lt.taxAmount) || 0), 0), 0);
  const derivedTotal = round2(itemsTotal + taxTotal + logiTotal);
  const requestedTotal = (totalAmount === undefined || totalAmount === null || totalAmount === '')
    ? derivedTotal
    : round2(totalAmount);
  // A balanced voucher is non-negotiable. If a stale client total differs from
  // the actual item/tax/logistics legs, use the derived total for the party leg.
  const amt = Math.abs(requestedTotal - derivedTotal) <= 0.05 ? requestedTotal : derivedTotal;

  // ── Order & Dispatch → top-level TallyPrime tags (Delivery Note screenshot) ─
  // Mode/Terms of Payment → BASICDUEDATEOFPYMT
  // Other References      → BASICORDERREF  (REFERENCE stays TDK-DN-* for reconciliation)
  // Terms of Delivery     → BASICORDERTERMS.LIST
  // Dispatch Doc No.      → BASICSHIPDOCUMENTNO
  // Dispatched through    → BASICSHIPPEDBY
  // Destination           → BASICFINALDESTINATION
  // Carrier Name/Agent    → EICHECKPOST
  // Bill of Lading/LR-RR  → BILLOFLADINGNO
  // LR Date               → BILLOFLADINGDATE
  // Motor Vehicle No.     → BASICSHIPVESSELNO
  let dispatchXml = '';
  if (dispatch_details) {
    const dd = dispatch_details;
    const modeSimpleMap = { road: 'Road', rail: 'Rail', air: 'Air', ship: 'Ship', 'not_applicable': '', 'not applicable': '' };
    const modeKey = (dd.dispatched_through || dd.transport_mode || '').toLowerCase().replace(/\s+/g, '_');
    const shippedBy = modeSimpleMap[modeKey]
      ?? (dd.dispatched_through || dd.transport_mode || '');
    const termsRaw = dd.terms_of_delivery || dd.termsOfDelivery || '';
    const termsLines = String(termsRaw)
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    const termsXml = termsLines.length
      ? [
          '  <BASICORDERTERMS.LIST TYPE="String">',
          ...termsLines.map(l => `    <BASICORDERTERMS>${escapeXml(l)}</BASICORDERTERMS>`),
          '  </BASICORDERTERMS.LIST>',
        ].join('\n')
      : '';
    const lrDate = dd.lr_date || dd.transport_doc_date || '';
    const lrDateXml = lrDate ? `  <BILLOFLADINGDATE>${tallyDate(lrDate)}</BILLOFLADINGDATE>` : '';
    const carrier = dd.carrier_name || dd.transporter_name || '';
    const blNo = dd.bill_of_lading_no || dd.lr_rr_no || '';
    dispatchXml = [
      dd.mode_of_payment || dd.payment_terms
        ? `  <BASICDUEDATEOFPYMT>${escapeXml(dd.mode_of_payment || dd.payment_terms)}</BASICDUEDATEOFPYMT>` : '',
      dd.other_references
        ? `  <BASICORDERREF>${escapeXml(dd.other_references)}</BASICORDERREF>` : '',
      termsXml,
      dd.transport_doc_no || dd.dispatch_doc_no
        ? `  <BASICSHIPDOCUMENTNO>${escapeXml(dd.transport_doc_no || dd.dispatch_doc_no)}</BASICSHIPDOCUMENTNO>` : '',
      shippedBy ? `  <BASICSHIPPEDBY>${escapeXml(shippedBy)}</BASICSHIPPEDBY>` : '',
      dd.ship_to || dd.destination
        ? `  <BASICFINALDESTINATION>${escapeXml(dd.ship_to || dd.destination)}</BASICFINALDESTINATION>` : '',
      carrier ? `  <EICHECKPOST>${escapeXml(carrier)}</EICHECKPOST>` : '',
      blNo ? `  <BILLOFLADINGNO>${escapeXml(blNo)}</BILLOFLADINGNO>` : '',
      lrDateXml,
      dd.vehicle_number
        ? `  <BASICSHIPVESSELNO>${escapeXml(dd.vehicle_number)}</BASICSHIPVESSELNO>` : '',
    ].filter(Boolean).join('\n');
  }

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'DN').catch(() => null);

  // TallyDekho Series: we own the sequence, so the number is final immediately.
  let tdkDeliveryNoteNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkDeliveryNoteNo = await generateTDSeriesNumber(companyGuid, 'DN').catch(() => null);
    if (tdkDeliveryNoteNo) effectiveVoucherNumber = tdkDeliveryNoteNo;
  }

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Delivery Note" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>Delivery Note</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${escapeXml(effectiveVoucherNumber)}</VOUCHERNUMBER>
  <REFERENCE>${escapeXml(tdkRef || reference || '')}</REFERENCE>
  <ISINVOICE>No</ISINVOICE>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${escapeXml(narration || '')}</NARRATION>
${dispatchXml}
  <PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(partyLedger)}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  for (const item of items) {
    const itemAmt  = parseFloat(item.amount) || 0;
    const actualQty = item.actualQty || item.billedQty || 1;
    const billedQty = item.billedQty || item.actualQty || 1;
    const rawRate  = item.rate ?? 0;
    // TallyPrime exports RATE with the stock item's unit (e.g. "389.83/nos"); keep any
    // rate the caller already qualified, otherwise append the unit when we know it.
    const rateXml = String(rawRate).includes('/')
      ? String(rawRate)
      : `${parseFloat(rawRate) || 0}${item.unit ? `/${item.unit}` : ''}`;
    const track = item.trackingNumber || trackingNumber || '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>
    <RATE>${escapeXml(rateXml)}</RATE>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${actualQty}</ACTUALQTY>
    <BILLEDQTY>${billedQty}</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(item.godown || 'Main Location')}</GODOWNNAME>
      <BATCHNAME>Primary Batch</BATCHNAME>${track ? `
      <TRACKINGNUMBER>${escapeXml(track)}</TRACKINGNUMBER>` : ''}
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${actualQty}</ACTUALQTY>
      <BILLEDQTY>${billedQty}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${escapeXml(item.salesLedger || 'Sales Account GST')}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  // Tally's own Delivery Note export has one combined ledger row per tax
  // ledger (for example a single "GST" row), even when several items share it.
  const taxLedgerTotals = new Map();
  const addTaxLedger = (tax, fallbackTaxable = 0) => {
    const name = String(tax?.ledgerName || '').trim();
    if (!name) return;
    const current = taxLedgerTotals.get(name) || { amount: 0, taxableValue: 0 };
    current.amount += parseFloat(tax.taxAmount) || 0;
    current.taxableValue += parseFloat(tax.taxableValue) || fallbackTaxable || 0;
    taxLedgerTotals.set(name, current);
  };
  taxes.forEach(tax => addTaxLedger(tax));

  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(lg.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      addTaxLedger(lt, parseFloat(lg.amount) || 0);
    }
  }

  for (const [ledgerName, values] of taxLedgerTotals.entries()) {
    if (!values.amount) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(ledgerName)}</LEDGERNAME>
    <AMOUNT>${round2(values.amount)}</AMOUNT>
    <VATASSESSABLEVALUE>${round2(values.taxableValue)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  // Order link (Delivery Note against a Sales Order / customer PO)
  const linkedOrderNo   = linked_order?.order_no   || linked_order?.orderNumber || '';
  const linkedOrderDate = linked_order?.order_date || linked_order?.orderDate   || '';
  if (linkedOrderNo) {
    xml += `
  <INVOICEORDERLIST.LIST>
    <BASICORDERDATE>${tallyDate(linkedOrderDate || date)}</BASICORDERDATE>
    <BASICPURCHASEORDERNO>${escapeXml(linkedOrderNo)}</BASICPURCHASEORDERNO>
  </INVOICEORDERLIST.LIST>`;
  }

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger}${effectiveVoucherNumber ? ' #' + effectiveVoucherNumber : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'delivery_note', label, amt, req.body, xml).catch(() => null);

  let deliveryNoteUuid = null;
  if (qId && tdkRef) {
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'delivery_note',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, entryType,
       numbering_policy,
       tdkDeliveryNoteNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(req.body)]
    ).catch(e => { console.error('[app_vouchers] delivery_note insert failed:', e.message); return { rows: [] }; });
    deliveryNoteUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';

    // Ask desktop to pull the new voucher so tally_voucher_no lands without a full sync.
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
        });
      });
    }

    res.json({
      status: true,
      queued: offline,
      queueId: qId,
      tdkReferenceNo: tdkRef,
      invoiceUuid: deliveryNoteUuid,
      deliveryNoteNumber: tdkDeliveryNoteNo || result?.voucherNumber || null,
      voucherNumber: tdkDeliveryNoteNo || result?.voucherNumber || null,
      numbering_policy,
      message: offline
        ? 'Entry saved. Will push to Tally when desktop connects.'
        : (isOptional ? 'Optional delivery note saved' : 'Delivery note created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    if (deliveryNoteUuid) {
      await query(
        `UPDATE app_vouchers SET tally_sync_status='failed', sync_error=$2,
           updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
         WHERE invoice_uuid=$1`,
        [deliveryNoteUuid, String(e.message).slice(0, 500)]
      ).catch(() => {});
    }
    res.status(500).json({ status: false, message: e.message });
  }
});

router.post('/voucher/cancel', authMiddleware, async (req, res) => {
  const { companyGuid, companyName, voucherGuid, voucherType, voucherNumber, date } = req.body;
  if (!companyGuid || !voucherGuid) return res.status(400).json({ status: false, message: 'voucherGuid required' });
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${voucherType}" ACTION="Cancel"><DATE>${tallyDate(date)}</DATE><VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><GUID>${voucherGuid}</GUID></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml); res.json({ status: true, message: 'Voucher cancelled in Tally', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { res.status(500).json({ status: false, message: e.message }); }
});

router.post('/master/stock-item', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName,
    name, groupName,
    category = '', unit = 'Nos',
    openingQty = 0, openingRate = 0,
    warehouse = '',
    hsnCode = '',
    igstRate = 0, cgstRate = 0, sgstRate = 0,
    numbering_policy = 'tally_prime_series',
    date,
    // Optional barcode-on-create (Add Item → Generate Barcode toggle)
    generateBarcode = false,
    salePrice = 0,
    barcodeLabel = null, // { itemName?, sku?, salePrice? } — label print prefs
    barcodeType = 'CODE128',
    barcodeSyncTarget = 'app_only',
  } = req.body;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!name) return res.status(400).json({ status: false, message: 'name required' });
  const effectiveGroup = String(groupName || '').trim();
  if (!effectiveGroup) return res.status(400).json({ status: false, message: 'groupName required' });
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  const parentXml = `<PARENT>${esc(effectiveGroup)}</PARENT>`;

  const qty = Math.max(0, Math.abs(parseFloat(openingQty) || 0));
  const rate = Math.max(0, parseFloat(openingRate) || 0);
  const openVal = qty * rate;
  const gstAppl = (igstRate > 0 || cgstRate > 0) ? 'Applicable' : 'Not Applicable';
  // If warehouse is provided, we will create godown-wise stock via Physical Stock voucher.
  // Otherwise, keep Tally STOCKITEM opening balance (single/implicit godown behavior).
  const godownOpening = qty > 0 && !!String(warehouse || '').trim();
  const openXml = godownOpening
    ? ''
    : (qty > 0 ? `<OPENINGBALANCE>${qty} ${unit}</OPENINGBALANCE><OPENINGRATE>${rate} /${unit}</OPENINGRATE><OPENINGVALUE>${openVal}</OPENINGVALUE>` : '');
  const _today = new Date(); const _appFrom = `${_today.getFullYear()}${String(_today.getMonth()+1).padStart(2,'0')}${String(_today.getDate()).padStart(2,'0')}`;
  const gstXml = hsnCode ? `<GSTAPPLICABLE>${gstAppl}</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>${_appFrom}</APPLICABLEFROM><HSNCODE>${hsnCode}</HSNCODE><TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>Any State</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${igstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${cgstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${sgstRate}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM ACTION="Create"><NAME>${name}</NAME>${parentXml}${category?`<CATEGORY>${category}</CATEGORY>`:''}<BASEUNITS>${unit}</BASEUNITS>${openXml}${gstXml}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'item', name, null, req.body, xml).catch(() => null);
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    const offItem = r?.status === 'desktop_offline';

    // Optional: create godown-wise opening using Physical Stock.
    // This fixes the "added item in different warehouse still shows in Main" issue.
    let offOpening = false;
    let openingQueueId = null;
    let openingError = null;

    if (godownOpening) {
      const godown = String(warehouse || '').trim();
      const dt = tallyDate(date || new Date().toISOString().slice(0, 10));
      const narration = `Opening Balance | ${name} @ ${godown}`;
      const tdkRef = await generateTDKReference(companyGuid, false, 'PHY').catch(() => null);
      let tdkVoucherNo = null;
      let effectiveVoucherNumber = '';
      if (numbering_policy === 'tallydekho_series') {
        tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PHY').catch(() => null);
        if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
      }

      const absQty = Math.max(0, qty);
      const physicalXml =
        `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC>` +
        `<REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>` +
        `</REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">` +
        `<VOUCHER VCHTYPE="Physical Stock" ACTION="Create">` +
        `<VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME>` +
        `<DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE>` +
        `${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}` +
        `<REFERENCE>${esc(tdkRef || '')}</REFERENCE><ISOPTIONAL>No</ISOPTIONAL>` +
        `<NARRATION>${esc(narration)}</NARRATION>` +
        `<ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>` +
        `<STOCKITEMNAME>${esc(name)}</STOCKITEMNAME>` +
        `<ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY>` +
        `<RATE>0</RATE><AMOUNT>0</AMOUNT>` +
        `<BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(godown)}</GODOWNNAME>` +
        `<ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY><AMOUNT>0</AMOUNT>` +
        `</BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>` +
        `</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

      const persistPayload = {
        ...req.body,
        tdkRef,
        numbering_policy,
        stockName: name,
        warehouse: godown,
        adjustmentReason: 'Opening Balance',
        adjustmentDirection: null,
        adjustmentQty: qty,
        qtyBefore: 0,
        qtyChange: qty,
        qtyAfter: qty,
        isIncrease: true,
        unit,
        note: '',
        narration,
        date: date || new Date().toISOString().slice(0, 10),
      };

      const label = `Opening Balance: ${name} (${qty} @ ${godown})${tdkRef ? ' (' + tdkRef + ')' : ''}`;
      const qId2 = await logWriteQueue(
        req.user.userId,
        companyGuid,
        'stock_adjustment',
        label,
        openVal || null,
        persistPayload,
        physicalXml
      ).catch(() => null);

      openingQueueId = qId2 || null;

      let adjustmentId = null;
      if (qId2 && tdkRef) {
        const { rows: av } = await query(
          `INSERT INTO app_vouchers
           (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
            tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
            party_name, total_amount, voucher_date, payload)
           VALUES ($1,$2,$3,'stock_adjustment',$4,'regular','regular','queued','not_posted',$5,$6,$7,$8,$9,$10)
           RETURNING invoice_uuid`,
          [
            companyGuid, req.user.userId, qId2, tdkRef,
            numbering_policy, tdkVoucherNo || null,
            name, openVal || null,
            date ? new Date(date) : null,
            JSON.stringify(persistPayload),
          ]
        ).catch(e => { console.error('[opening-balance-app_voucher] insert failed:', e.message); return { rows: [] }; });

        const { rows: adjRows } = await query(`
          INSERT INTO stock_adjustments
            (company_guid, user_id, stock_guid, stock_name, warehouse, adjustment_reason,
             adjustment_direction, qty_before, adjustment_qty, qty_change, qty_after, note, status, write_queue_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING',$13)
          RETURNING id
        `, [
          companyGuid, req.user.userId,
          name, name, godown, 'Opening Balance',
          null, 0, qty, qty, qty, null, qId2,
        ]).catch(() => ({ rows: [{}] }));

        adjustmentId = adjRows?.[0]?.id || null;
      }

      try {
        const r2 = await forwardToTally(companyGuid, req.user.userId, physicalXml);
        await updateWriteQueue(qId2, r2, null);

        offOpening = r2?.status === 'desktop_offline';
        if (adjustmentId) {
          const newStatus = (r2?.status === 'desktop_offline' || (r2?.message || '').includes('offline'))
            ? 'QUEUED' : 'PUSHED_TO_TALLY';
          await query(
            `UPDATE stock_adjustments SET status=$1, tally_voucher_number=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$3`,
            [newStatus, r2?.voucherNumber || null, adjustmentId]
          ).catch(() => {});
        }

        if (!offOpening) {
          setImmediate(() => {
            requestDesktopSyncAfterWrite({
              userId: req.user.userId,
              companyGuid,
              companyName,
              tdkRef,
              tallyIds: [r2?.tallyId],
            });
          });
        }
      } catch (e) {
        await updateWriteQueue(qId2, null, e.message).catch(() => {});
        openingError = e.message;
      }
    }

    const queued = offItem || offOpening;
    const tallyRejected = r?.status === false
      || (typeof r?.created === 'number' && r.created === 0 && !(r?.altered > 0) && !offItem);

    // Immediate local stocks row so barcode APIs / Total Stock work before next sync.
    // Tally sync later overwrites with the real GUID when available.
    let stockGuid = null;
    let barcode = null;
    let barcodeError = null;
    const saleRate = Math.max(0, parseFloat(salePrice) || 0);
    const taxRate = Math.max(0, parseFloat(igstRate) || 0);

    if (!tallyRejected) {
      try {
        const { rows: existing } = await query(
          `SELECT guid FROM stocks WHERE company_guid = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [companyGuid, name]
        );
        if (existing[0]?.guid) {
          stockGuid = existing[0].guid;
          await query(
            `UPDATE stocks SET
               group_name = COALESCE(NULLIF($3,''), group_name),
               unit = COALESCE(NULLIF($4,''), unit),
               tax_rate = CASE WHEN $5 > 0 THEN $5 ELSE tax_rate END,
               opening_qty = CASE WHEN $6 > 0 THEN $6 ELSE opening_qty END,
               opening_rate = CASE WHEN $7 > 0 THEN $7 ELSE opening_rate END,
               closing_qty = CASE WHEN $6 > 0 THEN $6 ELSE closing_qty END,
               closing_rate = CASE WHEN $8 > 0 THEN $8 WHEN $7 > 0 THEN $7 ELSE closing_rate END,
               closing_value = CASE WHEN $6 > 0 THEN ($6 * COALESCE(NULLIF($8,0), NULLIF($7,0), closing_rate, 0)) ELSE closing_value END,
               synced_at = EXTRACT(EPOCH FROM NOW())::BIGINT
             WHERE company_guid = $1 AND guid = $2`,
            [companyGuid, stockGuid, effectiveGroup, unit, taxRate, qty, rate, saleRate]
          ).catch(() => {});
        } else {
          const { rows: inserted } = await query(
            `INSERT INTO stocks (
               guid, company_guid, name, group_name, unit, hsn, tax_rate,
               opening_qty, opening_rate, closing_qty, closing_rate, closing_value, synced_at
             ) VALUES (
               gen_random_uuid()::text, $1, $2, $3, $4, $5, $6,
               $7, $8, $7, COALESCE(NULLIF($9,0), $8, 0),
               ($7 * COALESCE(NULLIF($9,0), $8, 0)),
               EXTRACT(EPOCH FROM NOW())::BIGINT
             )
             RETURNING guid`,
            [companyGuid, name, effectiveGroup, unit, hsnCode || null, taxRate || 0, qty, rate, saleRate]
          );
          stockGuid = inserted[0]?.guid || null;
        }
      } catch (e) {
        console.warn('[stock-item-immediate-insert]', e.message);
      }

      // Generate barcode when Add Item toggle is ON
      if (generateBarcode && stockGuid) {
        try {
          const { rows: [existingBc] } = await query(
            `SELECT barcode FROM stock_barcodes
             WHERE stock_guid = $1 AND company_guid = $2 AND is_primary = TRUE AND status = 'active'
             LIMIT 1`,
            [stockGuid, companyGuid]
          );
          if (existingBc?.barcode) {
            barcode = existingBc.barcode;
          } else {
            const { rows: [{ cnt }] } = await query(
              `SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_guid = $1`,
              [companyGuid]
            );
            const slug = String(companyGuid).replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
            let tries = 0;
            do {
              barcode = `TDK${slug}${(cnt + tries + 1).toString().padStart(7, '0').slice(-7)}`;
              tries += 1;
              const { rows: [dup] } = await query(
                `SELECT 1 FROM stock_barcodes WHERE company_guid = $1 AND barcode = $2`,
                [companyGuid, barcode]
              );
              if (!dup) break;
            } while (tries < 10);

            const syncTarget = String(barcodeSyncTarget || 'app_only');
            const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
            await query(
              `INSERT INTO stock_barcodes
                 (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
               VALUES ($1,$2,$3,$4,$5,'app_generated','active',TRUE,$6,$7)`,
              [companyGuid, stockGuid, name, barcode, barcodeType || 'CODE128', syncTarget, tallyStatus]
            );
          }
        } catch (e) {
          barcode = null;
          barcodeError = e.message;
          console.warn('[stock-item-barcode]', e.message);
        }
      }
    }

    if (tallyRejected) {
      return res.status(422).json({
        status: false,
        queued: false,
        queueId: qId,
        message: r?.message || 'Tally rejected the stock item',
        data: r,
      });
    }

    res.json({
      status: true,
      queued,
      queueId: qId,
      message: queued
        ? 'Saved. Will push when desktop connects.'
        : godownOpening
          ? 'Stock item and godown opening created in Tally'
          : 'Stock item created in Tally',
      data: r,
      voucherNumber: r?.voucherNumber || null,
      tallyId: r?.tallyId || null,
      openingError,
      openingQueueId,
      stockGuid,
      barcode,
      barcodeError,
      barcodeLabel: barcodeLabel || null,
    });
  } catch(e) {
    updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
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
// Stock Journal — multi-item; per-item fromGodown (Option A) + shared toGodown.
router.post('/voucher/stock-transfer', authMiddleware, async (req, res) => {
  const {
    companyGuid, companyName, date, narration, note,
    fromGodown, toGodown,
    items = [],
    isOptional = false,
    numbering_policy = 'tally_prime_series',
  } = req.body;

  if (!companyGuid || !toGodown) {
    return res.status(400).json({ status: false, message: 'toGodown required' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ status: false, message: 'items[] required' });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';
  const fullNarration = narration || note || '';

  const normalizedItems = items.map((it) => {
    const src = it.fromGodown || it.sourceWarehouse || fromGodown || '';
    return {
      itemName: it.itemName || it.name || '',
      qty: parseFloat(it.qty) || 1,
      rate: parseFloat(it.rate) || 0,
      unit: it.unit || 'pcs',
      fromGodown: src,
      availableQty: parseFloat(it.availableQty) || null,
    };
  });

  for (const it of normalizedItems) {
    if (!it.itemName) return res.status(400).json({ status: false, message: 'Each item needs itemName' });
    if (!it.fromGodown) return res.status(400).json({ status: false, message: `Source warehouse required for ${it.itemName}` });
    if (it.fromGodown === toGodown) {
      return res.status(400).json({ status: false, message: `Source and destination must differ for ${it.itemName}` });
    }
  }

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'STJ').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'STJ').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  let xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Stock Journal" ACTION="Create"><VOUCHERTYPENAME>Stock Journal</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE>${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}<REFERENCE>${esc(tdkRef || '')}</REFERENCE><ISOPTIONAL>${isOpt}</ISOPTIONAL><NARRATION>${esc(fullNarration)}</NARRATION>`;

  for (const item of normalizedItems) {
    const qty = item.qty;
    const src = item.fromGodown;
    xml += `<INVENTORYENTRIESOUT.LIST>`;
    xml += `<STOCKITEMNAME>${esc(item.itemName)}</STOCKITEMNAME>`;
    xml += `<ACTUALQTY>-${qty}</ACTUALQTY><BILLEDQTY>-${qty}</BILLEDQTY>`;
    xml += `<RATE>0</RATE><AMOUNT>0</AMOUNT>`;
    xml += `<BATCHALLOCATIONS.LIST>`;
    xml += `<GODOWNNAME>${esc(src)}</GODOWNNAME>`;
    xml += `<ACTUALQTY>-${qty}</ACTUALQTY><BILLEDQTY>-${qty}</BILLEDQTY>`;
    xml += `<AMOUNT>0</AMOUNT>`;
    xml += `</BATCHALLOCATIONS.LIST>`;
    xml += `</INVENTORYENTRIESOUT.LIST>`;
    xml += `<INVENTORYENTRIESIN.LIST>`;
    xml += `<STOCKITEMNAME>${esc(item.itemName)}</STOCKITEMNAME>`;
    xml += `<ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY>`;
    xml += `<RATE>0</RATE><AMOUNT>0</AMOUNT>`;
    xml += `<BATCHALLOCATIONS.LIST>`;
    xml += `<GODOWNNAME>${esc(toGodown)}</GODOWNNAME>`;
    xml += `<ACTUALQTY>${qty}</ACTUALQTY><BILLEDQTY>${qty}</BILLEDQTY>`;
    xml += `<AMOUNT>0</AMOUNT>`;
    xml += `</BATCHALLOCATIONS.LIST>`;
    xml += `</INVENTORYENTRIESIN.LIST>`;
  }

  xml += '</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>';

  const transferValue = normalizedItems.reduce((sum, item) => sum + item.qty * item.rate, 0);
  const sources = [...new Set(normalizedItems.map(i => i.fromGodown))];
  const labelFrom = sources.length === 1 ? sources[0] : `${sources.length} sources`;
  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    toGodown,
    fromGodown: sources.length === 1 ? sources[0] : fromGodown || null,
    items: normalizedItems,
    narration: fullNarration,
    date: date || new Date().toISOString().slice(0, 10),
  };

  const label = `${labelFrom} → ${toGodown} (${normalizedItems.length} items)${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_transfer', label, transferValue || null, persistPayload, xml).catch(() => null);

  let transferUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'stock_transfer',$4,$5,$5,'queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       `${labelFrom} → ${toGodown}`, transferValue || null, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[stock-transfer-app_voucher] insert failed:', e.message); return { rows: [] }; });
    transferUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml);
    await updateWriteQueue(qId, r, null);
    let voucherNumber = r?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const off = r?.status === 'desktop_offline';
    if (!off) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [r?.tallyId],
        });
      });
    }
    res.json({
      status: true, queued: off, queueId: qId,
      tdkRef, tdkReferenceNo: tdkRef,
      transferUuid, invoiceUuid: transferUuid,
      voucherNumber, numberingPolicy: numbering_policy,
      message: off ? 'Saved. Will push when desktop connects.' : 'Stock transfer created in Tally',
      data: r,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.json({
      status: true, queued: true, queueId: qId,
      tdkRef, tdkReferenceNo: tdkRef,
      transferUuid, invoiceUuid: transferUuid,
      numberingPolicy: numbering_policy,
      message: 'Saved. Will push to Tally when desktop connects.',
    });
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
    unit = 'pcs',
    numbering_policy = 'tally_prime_series',
  } = req.body;

  if (!companyGuid || !stockName || !adjustmentQty || !adjustmentReason) {
    return res.status(400).json({ status: false, message: 'stockName, adjustmentQty, adjustmentReason required' });
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

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

  const tdkRef = await generateTDKReference(companyGuid, false, 'PHY').catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series') {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PHY').catch(() => null);
    if (tdkVoucherNo) effectiveVoucherNumber = tdkVoucherNo;
  }

  // ── Build Physical Stock XML ──────────────────────────────────────────────
  const absQty = Math.max(0, qtyAfter);

  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="Physical Stock" ACTION="Create"><VOUCHERTYPENAME>Physical Stock</VOUCHERTYPENAME><DATE>${dt}</DATE><EFFECTIVEDATE>${dt}</EFFECTIVEDATE>${effectiveVoucherNumber ? `<VOUCHERNUMBER>${esc(effectiveVoucherNumber)}</VOUCHERNUMBER>` : ''}<REFERENCE>${esc(tdkRef || '')}</REFERENCE><ISOPTIONAL>No</ISOPTIONAL><NARRATION>${esc(narration)}</NARRATION><ALLINVENTORYENTRIES.LIST><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><STOCKITEMNAME>${esc(stockName)}</STOCKITEMNAME><ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY><RATE>0</RATE><AMOUNT>0</AMOUNT><BATCHALLOCATIONS.LIST><GODOWNNAME>${esc(godown)}</GODOWNNAME><ACTUALQTY>${absQty}</ACTUALQTY><BILLEDQTY>${absQty}</BILLEDQTY><AMOUNT>0</AMOUNT></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = {
    ...req.body,
    tdkRef,
    numbering_policy,
    stockName,
    warehouse: godown,
    adjustmentReason,
    adjustmentDirection: adjustmentDirection || null,
    adjustmentQty: qty,
    qtyBefore: parseFloat(qtyBefore || 0),
    qtyChange,
    qtyAfter,
    isIncrease,
    unit,
    note: note || '',
    narration,
    date: date || new Date().toISOString().slice(0, 10),
  };

  const label = `${adjustmentReason}: ${stockName} (${isIncrease ? '+' : '-'}${qty} @ ${godown})${tdkRef ? ' (' + tdkRef + ')' : ''}`;
  const adjValue = qty * (parseFloat(req.body.rate) || 0);
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_adjustment', label, adjValue || null, persistPayload, xml).catch(() => null);

  let adjustmentUuid = null;
  if (qId && tdkRef) {
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,'stock_adjustment',$4,'regular','regular','queued','not_posted',$5,$6,$7,$8,$9,$10)
       RETURNING invoice_uuid`,
      [companyGuid, req.user.userId, qId, tdkRef,
       numbering_policy, tdkVoucherNo || null,
       stockName, adjValue || null, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[stock-adjustment-app_voucher] insert failed:', e.message); return { rows: [] }; });
    adjustmentUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

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
      await query(`UPDATE stock_adjustments SET status=$1, tally_voucher_number=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$3`, [newStatus, r?.voucherNumber || null, adjustmentId]).catch(() => {});
    }
    let voucherNumber = r?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 LIMIT 1`,
        [tdkRef, companyGuid]
      ).catch(() => ({ rows: [] }));
      voucherNumber = avFresh[0]?.tally_voucher_no || null;
    }
    const off = r?.status === 'desktop_offline';
    if (!off) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [r?.tallyId],
        });
      });
    }
    res.json({
      status: true, queued: off, queueId: qId, adjustmentId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      adjustmentUuid,
      invoiceUuid: adjustmentUuid,
      voucherNumber,
      numberingPolicy: numbering_policy,
      message: off ? 'Saved. Will push to Tally when desktop connects.' : 'Stock adjustment created in Tally',
      data: r,
    });
  } catch(e) {
    await updateWriteQueue(qId, null, e.message);
    if (adjustmentId) {
      await query(`UPDATE stock_adjustments SET status='FAILED', error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`, [e.message, adjustmentId]).catch(() => {});
    }
    res.json({
      status: true, queued: true, queueId: qId, adjustmentId,
      tdkRef,
      tdkReferenceNo: tdkRef,
      adjustmentUuid,
      invoiceUuid: adjustmentUuid,
      numberingPolicy: numbering_policy,
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
    const result = await retrySingleEntry(id, req.user.userId);
    if (result.alreadySuccess) {
      return res.json({ status: true, message: result.message, alreadySuccess: true, voucherNumber: result.voucherNumber || null });
    }
    if (result.alreadyProcessing) {
      return res.status(409).json({ status: false, message: result.message, alreadyProcessing: true });
    }
    if (!result.success) {
      const code = /not found/i.test(result.message || '') ? 404 : 400;
      return res.status(code).json({ status: false, message: result.message });
    }
    if (result.message?.startsWith('Tally rejected')) {
      return res.status(422).json({ status: false, message: result.message });
    }
    res.json({
      status: true,
      queued: !!result.queued,
      message: result.message,
      voucherNumber: result.voucherNumber || null,
    });
  } catch (e) {
    await updateWriteQueue(id, null, e.message).catch(() => {});
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── Auto-retry: called when desktop comes online ───────────────────────────────
// Retry a single write_queue entry by id (used by /my-entries/:id/retry).
// Atomic claim: only desktop_offline / failed rows can be claimed. Concurrent
// Audit Trail taps on a queued row used to re-forward the same XML and create
// duplicate vouchers in Tally — the WHERE clause prevents that race.
export async function retrySingleEntry(entryId, userId) {
  try {
    const { rows: claimed } = await query(
      `UPDATE write_queue
          SET status='processing',
              error_message=NULL,
              updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE id=$1 AND user_id=$2
          AND status IN ('desktop_offline', 'failed', 'pending')
          AND xml IS NOT NULL
        RETURNING *`,
      [entryId, userId]
    );
    const entry = claimed[0];
    if (!entry) {
      const { rows } = await query(`SELECT id, status, xml, tally_voucher_number FROM write_queue WHERE id=$1 AND user_id=$2`, [entryId, userId]);
      const existing = rows[0];
      if (!existing) return { success: false, message: 'Entry not found' };
      if (existing.status === 'success') {
        return { success: true, alreadySuccess: true, message: 'Already pushed to Tally', voucherNumber: existing.tally_voucher_number || null };
      }
      if (existing.status === 'processing') {
        return { success: false, alreadyProcessing: true, message: 'Push already in progress — wait for it to finish' };
      }
      if (!existing.xml) return { success: false, message: 'No XML stored for retry' };
      return { success: false, message: `Cannot retry entry in status "${existing.status}"` };
    }

    // If Tally already assigned a number on a prior attempt, do not re-import.
    if (entry.tally_voucher_number) {
      await query(
        `UPDATE write_queue SET status='success', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`,
        [entryId]
      );
      return { success: true, alreadySuccess: true, message: 'Already pushed to Tally', voucherNumber: entry.tally_voucher_number };
    }

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
      voucherNumber: result?.voucherNumber || null,
    };
  } catch (err) {
    await updateWriteQueue(entryId, null, err.message).catch(() => {});
    return { success: false, message: err.message };
  }
}

// Phase C: per-user debounce map — prevents hammering Tally with retries
const _retryDebounce = new Map(); // userId → lastRunMs
const RETRY_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_MAX_PER_RUN  = 25; // cap per startup/reconnect

export async function retryOfflineEntries(userId, companyGuid) {
  // Debounce: skip if already ran within the last 5 minutes for this user
  const lastRun = _retryDebounce.get(userId) || 0;
  if (Date.now() - lastRun < RETRY_DEBOUNCE_MS) {
    console.log(`[write_queue] retryOfflineEntries debounced for user ${userId} (last run ${Math.round((Date.now()-lastRun)/1000)}s ago)`);
    return;
  }
  _retryDebounce.set(userId, Date.now());

  try {
    // companyGuid may be null when called on desktop reconnect — fetch ALL pending for this user
    // Only retry 'desktop_offline' and 'failed' entries.
    // Do NOT include 'pending' or 'processing' — those are actively being forwarded
    // and picking them up here would cause duplicate entries in Tally.
    // Phase C: capped at RETRY_MAX_PER_RUN entries per run
    const { rows } = companyGuid
      ? await query(
          `SELECT * FROM write_queue WHERE user_id=$1 AND company_guid=$2 AND status IN ('desktop_offline','failed') AND attempt_count < 5 AND (lock_expires_at IS NULL OR lock_expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT) ORDER BY created_at ASC LIMIT ${RETRY_MAX_PER_RUN}`,
          [userId, companyGuid]
        )
      : await query(
          `SELECT * FROM write_queue WHERE user_id=$1 AND status IN ('desktop_offline','failed') AND attempt_count < 5 AND (lock_expires_at IS NULL OR lock_expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT) ORDER BY created_at ASC LIMIT ${RETRY_MAX_PER_RUN}`,
          [userId]
        );
    if (!rows.length) return;
    console.log(`[write_queue] auto-retry: ${rows.length} entries for user ${userId}`);
    for (const entry of rows) {
      if (!entry.xml) continue;
      try {
        // Atomic claim — skip if another retry already grabbed this row
        const { rows: claimed } = await query(
          `UPDATE write_queue SET status='processing', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
            WHERE id=$1 AND status IN ('desktop_offline','failed')
            RETURNING id`,
          [entry.id]
        );
        if (!claimed[0]) continue;
        if (entry.tally_voucher_number) {
          await query(`UPDATE write_queue SET status='success', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$1`, [entry.id]);
          continue;
        }
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

// ────────────────────────────────────────────────────────────────────────────
// PHASE C — Outbox Pull / Claim / Result (targeted desktop posting)
// Desktop pulls pending writebacks, claims one, posts to Tally, reports result
// Only processes 'desktop_offline' entries (entries where desktop was offline at submit)
// ────────────────────────────────────────────────────────────────────────────
const LOCK_TTL_SECONDS = 300; // 5 minutes — if desktop crashes, entry re-opens after this

// Helper: resolve userId from device-id header (desktop auth)
async function resolveDesktopUser(req, res) {
  const deviceId = req.headers['device-id'] || req.headers['x-device-id'] || req.body?.deviceId;
  if (!deviceId) { res.status(401).json({ status: false, message: 'device-id header required' }); return null; }
  const { rows } = await query(`SELECT user_id FROM devices WHERE device_id=$1 AND paired=TRUE LIMIT 1`, [deviceId]);
  if (!rows[0]) { res.status(403).json({ status: false, message: 'Device not paired' }); return null; }
  return { userId: rows[0].user_id, deviceId };
}

// POST /tally/desktop/writeback/pending — desktop pulls its pending offline entries
router.post('/desktop/writeback/pending', async (req, res) => {
  try {
    const desktop = await resolveDesktopUser(req, res);
    if (!desktop) return;
    const { companyGuid, limit = 10 } = req.body;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    const maxLimit = Math.min(parseInt(limit) || 10, 25);
    const now = Math.floor(Date.now() / 1000);

    const { rows } = await query(
      `SELECT id, company_guid, entry_type, entry_label, payload, attempt_count
       FROM write_queue
       WHERE user_id=$1 AND company_guid=$2
         AND status IN ('desktop_offline','failed')
         AND attempt_count < 5
         AND (lock_expires_at IS NULL OR lock_expires_at < $3)
       ORDER BY created_at ASC LIMIT $4`,
      [desktop.userId, companyGuid, now, maxLimit]
    );

    res.json({
      status: true,
      data: { items: rows.map(r => ({
        outboxId:        r.id,
        entityType:      r.entry_type,
        entityLabel:     r.entry_label,
        companyGuid:     r.company_guid,
        referenceNumber: r.payload ? (JSON.parse(r.payload || '{}')?.reference || '') : '',
        attemptCount:    r.attempt_count,
      })), count: rows.length },
    });
  } catch (e) {
    console.error('[writeback/pending]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /tally/desktop/writeback/:outboxId/claim — lock entry + return XML for posting
router.post('/desktop/writeback/:outboxId/claim', async (req, res) => {
  try {
    const desktop = await resolveDesktopUser(req, res);
    if (!desktop) return;
    const { outboxId } = req.params;
    const now = Math.floor(Date.now() / 1000);
    const lockExpiresAt = now + LOCK_TTL_SECONDS;

    const { rows } = await query(
      `UPDATE write_queue
       SET locked_by_device_id=$1, locked_at=$2, lock_expires_at=$3, status='processing',
           updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
       WHERE id=$4 AND user_id=$5
         AND status IN ('desktop_offline','failed')
         AND (lock_expires_at IS NULL OR lock_expires_at < $2)
       RETURNING id, xml, payload, entry_type, company_guid`,
      [desktop.deviceId, now, lockExpiresAt, outboxId, desktop.userId]
    );

    if (!rows[0]) return res.status(409).json({ status: false, message: 'Entry already claimed or not found' });
    const entry = rows[0];

    res.json({
      status: true,
      data: {
        claimed:       true,
        outboxId:      entry.id,
        lockExpiresAt: new Date(lockExpiresAt * 1000).toISOString(),
        xml:           entry.xml,
        entityType:    entry.entry_type,
        companyGuid:   entry.company_guid,
      },
    });
  } catch (e) {
    console.error('[writeback/claim]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /tally/desktop/writeback/:outboxId/result — desktop reports Tally result
router.post('/desktop/writeback/:outboxId/result', async (req, res) => {
  try {
    const desktop = await resolveDesktopUser(req, res);
    if (!desktop) return;
    const { outboxId } = req.params;
    const { success, tallyVoucherNumber, tallyVoucherGuid, tallyAlterId, errorCode, errorMessage } = req.body;

    // Verify this device owns the lock
    const { rows: lockRows } = await query(
      `SELECT id, company_guid FROM write_queue WHERE id=$1 AND locked_by_device_id=$2 AND user_id=$3`,
      [outboxId, desktop.deviceId, desktop.userId]
    );
    if (!lockRows[0]) return res.status(403).json({ status: false, message: 'Not the lock owner or not found' });
    const { company_guid } = lockRows[0];

    if (success) {
      await query(
        `UPDATE write_queue SET status='success', tally_voucher_number=$1, tally_id=$2,
         locked_by_device_id=NULL, locked_at=NULL, lock_expires_at=NULL,
         error_message=NULL, attempt_count=attempt_count+1,
         updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$3`,
        [tallyVoucherNumber || null, tallyAlterId || null, outboxId]
      );
      if (tallyVoucherNumber) {
        const { rows: avRows } = await query(
          `UPDATE app_vouchers SET tally_voucher_no=$1, tally_guid=$2,
           tally_sync_status='synced', books_impact_status='posted',
           updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
           WHERE write_queue_id=$3 AND tally_sync_status!='synced'
           RETURNING tdk_reference_no`,
          [tallyVoucherNumber, tallyVoucherGuid || null, outboxId]
        ).catch(() => ({ rows: [] }));
        if (avRows[0]?.tdk_reference_no) {
          _socketService?.emitVoucherSynced?.(company_guid, avRows[0].tdk_reference_no, tallyVoucherNumber);
        }
      }
      res.json({ status: true, message: 'Result recorded. Invoice posted.' });
    } else {
      await query(
        `UPDATE write_queue SET status='failed', error_message=$1,
         locked_by_device_id=NULL, locked_at=NULL, lock_expires_at=NULL,
         attempt_count=attempt_count+1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$2`,
        [`[${errorCode || 'ERROR'}] ${errorMessage || 'Unknown error'}`, outboxId]
      );
      res.json({ status: true, message: 'Failure recorded.' });
    }
  } catch (e) {
    console.error('[writeback/result]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /tally/invoice/:tdkRef/pdf-log — mobile logs a PDF generation event
router.post('/invoice/:tdkRef/pdf-log', authMiddleware, async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid, pdfType = 'provisional', invoiceNumber, invoiceNumberLabel, watermark, fileName } = req.body;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

    // Lookup the invoice
    const { rows: avRows } = await query(
      `SELECT invoice_uuid, books_impact_status FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 AND user_id=$3`,
      [tdkRef, companyGuid, req.user.userId]
    );
    if (!avRows[0]) return res.status(404).json({ status: false, message: 'Invoice not found' });

    // Get next version number
    const { rows: vRows } = await query(
      `SELECT COALESCE(MAX(version_no), 0) + 1 AS next_ver FROM invoice_pdf_versions WHERE tdk_reference_no=$1`,
      [tdkRef]
    );
    const versionNo = vRows[0]?.next_ver || 1;

    await query(
      `INSERT INTO invoice_pdf_versions (tdk_reference_no, invoice_uuid, company_guid, user_id, version_no, pdf_type, posting_tag, invoice_number, invoice_number_label, watermark, file_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (tdk_reference_no, version_no) DO NOTHING`,
      [tdkRef, avRows[0].invoice_uuid, companyGuid, req.user.userId, versionNo,
       pdfType, avRows[0].books_impact_status === 'posted' ? 'Posted' : 'Not Posted',
       invoiceNumber || null, invoiceNumberLabel || 'Pending from TallyPrime', watermark || null, fileName || null]
    );

    res.json({ status: true, data: { versionNo, pdfType } });
  } catch (e) {
    console.error('[invoice/pdf-log]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── Helper: build VoucherDocument from app_vouchers row + company/party info ──────────────
async function buildVoucherDocument(av, companyRow, partyRow) {
  const p = av.payload || {};
  const vType = (av.voucher_type || '').toLowerCase();
  const isReceipt = vType === 'receipt';
  const isPayment = vType === 'payment';
  const isJournal = vType === 'journal';
  const isContra = vType === 'contra';
  const isStockAdjustment = vType === 'stock_adjustment';
  const isStockTransfer = vType === 'stock_transfer';

  // ── Stock Journal / stock transfer document ────────────────────────────────
  if (isStockTransfer) {
    const hasNumber = !!av.tally_voucher_no;
    const isPosted = av.books_impact_status === 'posted';
    const numberPending = isPosted && !hasNumber;
    const documentNumber = hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime');
    const postingTag = isPosted ? 'Posted' : 'Not Posted';
    const transferItems = Array.isArray(p.items) ? p.items : [];
    return {
      documentType: 'stock_transfer',
      tallyVoucherType: 'Stock Journal',
      documentNumber,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0, 10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      postingTag,
      isProvisional: !hasNumber,
      numberPending,
      watermarkText: numberPending
        ? 'Posted — Tally series number pending sync'
        : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
      numberingMode: av.numbering_policy || 'tally_prime_series',
      company: {
        name: companyRow?.name || p.companyName || '',
        address: companyRow?.address || '',
        gstin: companyRow?.gstin || '',
        pan: companyRow?.pan || '',
        phone: companyRow?.phone || '',
        email: companyRow?.email || '',
        state: companyRow?.state || '',
      },
      party: {
        name: av.party_name || `${p.fromGodown || ''} → ${p.toGodown || ''}`,
      },
      totals: {
        grandTotal: parseFloat(av.total_amount || 0),
      },
      stockTransfer: {
        toGodown: p.toGodown || '',
        fromGodown: p.fromGodown || null,
        items: transferItems.map(it => ({
          itemName: it.itemName || '',
          qty: parseFloat(it.qty) || 0,
          unit: it.unit || 'pcs',
          fromGodown: it.fromGodown || p.fromGodown || '',
          availableQty: it.availableQty != null ? parseFloat(it.availableQty) : null,
        })),
      },
      narration: p.narration || p.note || '',
    };
  }

  // ── Physical Stock / stock adjustment document ─────────────────────────────
  if (isStockAdjustment) {
    const hasNumber = !!av.tally_voucher_no;
    const isPosted = av.books_impact_status === 'posted';
    const numberPending = isPosted && !hasNumber;
    const documentNumber = hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime');
    const postingTag = isPosted ? 'Posted' : 'Not Posted';
    const adjQty = parseFloat(p.adjustmentQty || 0);
    const qtyBefore = parseFloat(p.qtyBefore || 0);
    const qtyAfter = parseFloat(p.qtyAfter ?? (qtyBefore + (p.isIncrease ? adjQty : -adjQty)));
    return {
      documentType: 'stock_adjustment',
      tallyVoucherType: 'Physical Stock',
      documentNumber,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0, 10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      postingTag,
      isProvisional: !hasNumber,
      numberPending,
      watermarkText: numberPending
        ? 'Posted — Tally series number pending sync'
        : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
      numberingMode: av.numbering_policy || 'tally_prime_series',
      company: {
        name: companyRow?.name || p.companyName || '',
        address: companyRow?.address || '',
        gstin: companyRow?.gstin || '',
        pan: companyRow?.pan || '',
        phone: companyRow?.phone || '',
        email: companyRow?.email || '',
        state: companyRow?.state || '',
      },
      party: {
        name: p.stockName || av.party_name || '',
      },
      totals: {
        grandTotal: parseFloat(av.total_amount || 0),
      },
      stockAdjustment: {
        stockName: p.stockName || av.party_name || '',
        warehouse: p.warehouse || '',
        adjustmentReason: p.adjustmentReason || '',
        adjustmentDirection: p.adjustmentDirection || null,
        isIncrease: !!p.isIncrease,
        qtyBefore,
        adjustmentQty: adjQty,
        qtyAfter,
        unit: p.unit || 'pcs',
      },
      narration: p.note || p.narration || '',
    };
  }

  // ── Contra document (Source Cr → Destination Dr) ───────────────────────────
  if (isContra) {
    const hasNumber = !!av.tally_voucher_no;
    const isPosted = av.books_impact_status === 'posted';
    const numberPending = isPosted && !hasNumber;
    const documentNumber = hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime');
    const postingTag = isPosted ? 'Posted' : 'Not Posted';
    return {
      documentType: 'contra',
      documentNumber,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      postingTag,
      isProvisional: !hasNumber,
      numberPending,
      watermarkText: numberPending
        ? 'Posted — Tally series number pending sync'
        : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
      numberingMode: av.numbering_policy || 'tally_prime_series',
      company: {
        name: companyRow?.name || p.companyName || '',
        address: companyRow?.address || '',
        gstin: companyRow?.gstin || '',
        pan: companyRow?.pan || '',
        phone: companyRow?.phone || '',
        email: companyRow?.email || '',
        state: companyRow?.state || '',
      },
      party: {
        name: av.party_name || p.fromLedger || '',
        address: '',
        gstin: '',
        pan: '',
        phone: '',
      },
      totals: {
        grandTotal: parseFloat(av.total_amount || p.amount || 0),
      },
      contra: {
        fromLedger: p.fromLedger || av.party_name || '',
        toLedger: p.toLedger || '',
        amount: parseFloat(av.total_amount || p.amount || 0),
        contraKind: p.contraKind || null,
        instrumentDetails: p.instrumentDetails || null,
        cashCount: p.cashCount || null,
        cashDenomStr: p.cashDenomStr || null,
      },
      narration: p.narration || '',
    };
  }

  // ── Journal document (single Dr+Cr pair) ───────────────────────────────────
  if (isJournal) {
    const hasNumber = !!av.tally_voucher_no;
    const isPosted = av.books_impact_status === 'posted';
    const numberPending = isPosted && !hasNumber;
    const documentNumber = hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime');
    const postingTag = isPosted ? 'Posted' : 'Not Posted';
    return {
      documentType: 'journal',
      documentNumber,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      postingTag,
      isProvisional: !hasNumber,
      numberPending,
      watermarkText: numberPending
        ? 'Posted — Tally series number pending sync'
        : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
      numberingMode: av.numbering_policy || 'tally_prime_series',
      company: {
        name: companyRow?.name || p.companyName || '',
        address: companyRow?.address || '',
        gstin: companyRow?.gstin || '',
        pan: companyRow?.pan || '',
        phone: companyRow?.phone || '',
        email: companyRow?.email || '',
        state: companyRow?.state || '',
      },
      party: {
        name: av.party_name || p.drLedger || '',
        address: '',
        gstin: '',
        pan: '',
        phone: '',
      },
      totals: {
        grandTotal: parseFloat(av.total_amount || p.amount || 0),
      },
      journal: {
        drLedger: p.drLedger || av.party_name || '',
        crLedger: p.crLedger || '',
        amount: parseFloat(av.total_amount || p.amount || 0),
        depreciationMeta: p.depreciationMeta || null,
      },
      narration: p.narration || '',
    };
  }

  // ── Receipt / Payment document (shared shape; payment uses `payment` key) ──
  if (isReceipt || isPayment) {
    const hasNumber = !!av.tally_voucher_no;
    const isPosted = av.books_impact_status === 'posted';
    // Posted in books but series not synced yet → not a "failed" provisional create
    const numberPending = isPosted && !hasNumber;
    const documentNumber = hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime');
    const postingTag = isPosted ? 'Posted' : 'Not Posted';
    const billAllocations = Array.isArray(p.billAllocations) ? p.billAllocations : [];
    const instrument = p.instrumentDetails || null;
    const moneyBlock = {
      amount: parseFloat(av.total_amount || p.amount || 0),
      paymentMethod: p.paymentMethod || 'Cash',
      ledgerAccount: p.ledgerAccount || p.bankLedger || '',
      billAllocations: billAllocations.map(b => ({
        billRefName: b.billRefName || null,
        billType:    b.billType || 'On Account',
        amount:      Math.abs(parseFloat(b.amount || 0)),
      })),
      instrument: instrument ? {
        instrumentNo:   instrument.instrumentNo || '',
        instrumentDate: instrument.instrumentDate || '',
        bankName:       instrument.bankName || '',
        transactionType: instrument.transactionType || '',
      } : null,
    };
    return {
      documentType: isPayment ? 'payment' : 'receipt',
      documentNumber,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      postingTag,
      isProvisional: !hasNumber,
      numberPending,
      watermarkText: numberPending
        ? 'Posted — Tally series number pending sync'
        : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
      numberingMode: av.numbering_policy || 'tally_prime_series',
      company: {
        name: companyRow?.name || p.companyName || '',
        address: companyRow?.address || '',
        gstin: companyRow?.gstin || '',
        pan: companyRow?.pan || '',
        phone: companyRow?.phone || '',
        email: companyRow?.email || '',
        state: companyRow?.state || '',
      },
      party: {
        name: av.party_name || p.partyLedger || '',
        address: partyRow?.address || '',
        gstin: partyRow?.gstin || '',
        pan: partyRow?.pan || '',
        phone: partyRow?.phone || '',
      },
      totals: {
        grandTotal: parseFloat(av.total_amount || p.amount || 0),
      },
      receipt: isReceipt ? moneyBlock : undefined,
      payment: isPayment ? moneyBlock : undefined,
      narration: p.narration || '',
    };
  }

  // ── Sales invoice document (original) ─────────────────────────────────────
  const items = (p.items || []).map((item, idx) => ({
    id: String(idx),
    name: item.itemName || item.name || 'Item',
    qty: parseFloat(item.billedQty || item.actualQty || 1),
    unit: item.unit || 'Nos',
    rate: parseFloat(item.rate || 0),
    discount: parseFloat(item.discount || 0),
    taxAmount: parseFloat(item.taxAmount || 0),
    amount: parseFloat(item.amount || 0),
  }));

  // Build tax lines from taxes array
  const taxLines = (p.taxes || []).map(t => ({
    description: t.ledgerName || 'Tax',
    rate: parseFloat(t.taxRate || 0),
    taxableAmount: parseFloat(t.taxableValue || 0),
    total: parseFloat(t.taxAmount || 0),
  }));

  const isProvisional = !av.tally_voucher_no;
  const invoiceNumberLabel = av.tally_voucher_no || 'Pending from TallyPrime';
  const postingTag = av.books_impact_status === 'posted' ? 'Posted' : 'Not Posted';
  const isSalesOrder = vType === 'sales_order';
  const isCreditNote = vType === 'credit_note';
  const isPurchaseInvoice = vType === 'purchase_invoice' || vType === 'purchase';

  // A Credit Note shares the item/tax/total shape of a Sales invoice; it only differs
  // in document type and in always carrying the invoice it returns against.
  const linkedInvoice = p.linked_invoice || p.linkedInvoice || null;

  const payBlock = p.make_payment || p.collect_payment || null;

  return {
    documentType: isCreditNote
      ? 'credit_note'
      : (isSalesOrder
        ? 'sales_order'
        : (isPurchaseInvoice ? 'purchase_invoice' : 'sales_invoice')),
    tallyVoucherType: isCreditNote ? 'Credit Note' : (isPurchaseInvoice ? 'Purchase' : undefined),
    documentNumber: invoiceNumberLabel,
    documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
    tdkRef: av.tdk_reference_no,
    invoiceUuid: av.invoice_uuid,
    postingTag,
    isProvisional,
    watermarkText: isProvisional ? 'Provisional / Pending Tally Posting' : null,
    numberingMode: av.numbering_policy || 'tally_prime_series',
    company: {
      name: companyRow?.name || p.companyName || '',
      address: companyRow?.address || '',
      gstin: companyRow?.gstin || '',
      pan: companyRow?.pan || '',
      phone: companyRow?.phone || '',
      email: companyRow?.email || '',
      state: companyRow?.state || '',
    },
    party: {
      name: av.party_name || p.partyLedger || '',
      address: partyRow?.address || '',
      gstin: partyRow?.gstin || '',
      pan: partyRow?.pan || '',
      phone: partyRow?.phone || '',
    },
    items,
    taxLines,
    totals: {
      subtotal: items.reduce((s, i) => s + i.amount, 0),
      taxTotal: taxLines.reduce((s, t) => s + t.total, 0),
      grandTotal: parseFloat(av.total_amount || p.totalAmount || 0),
      roundOff: parseFloat(p.roundOffAmount || 0),
    },
    narration: p.narration || '',
    termsText: p.termsText || '',
    dueDate: p.dueDate || '',
    rawPayload: p,
    creditNote: isCreditNote ? {
      natureOfReturn: p.natureOfReturn || '01-Sales Return',
      returnType: 'Sales Return',
      againstInvoice: linkedInvoice ? {
        invoiceGuid:   linkedInvoice.invoiceGuid   || null,
        voucherNumber: linkedInvoice.voucherNumber || null,
        date:          linkedInvoice.date          || null,
        billRefName:   linkedInvoice.billRefName   || null,
        tdkRef:        linkedInvoice.tdkRef        || null,
        amount:        linkedInvoice.amount != null ? parseFloat(linkedInvoice.amount) : null,
      } : null,
    } : undefined,
    paymentInfo: !isSalesOrder && payBlock ? {
      collected: parseFloat(payBlock.amount || 0),
      mode: payBlock.ledgerName || '',
      reference: payBlock.reference || '',
      kind: p.make_payment ? 'payment' : 'receipt',
    } : undefined,
    againstInvoiceNo: isCreditNote ? (linkedInvoice?.voucherNumber || linkedInvoice?.billRefName || '') : undefined,
    againstOrderNo: isSalesOrder ? (av.tally_voucher_no || p.againstOrderNo || '') : (p.againstOrderNo || ''),
    additionalCharges: (p.logistics || []).map(l => ({
      description: l.ledgerName || 'Charge',
      amount: parseFloat(l.amount || 0),
    })),
    dispatchDetails: !isSalesOrder ? (p.dispatch_details || null) : null,
  };
}

// ── Helper: poll for Tally voucher number up to maxWaitMs ─────────────────────
async function waitForTallyNumber(tdkRef, companyGuid, userId, maxWaitMs = 10000) {
  const pollInterval = 600;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { rows } = await query(
      `SELECT tally_voucher_no FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 AND user_id=$3`,
      [tdkRef, companyGuid, userId]
    ).catch(() => ({ rows: [] }));
    if (rows[0]?.tally_voucher_no) return rows[0].tally_voucher_no;
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return null;
}

// ── GET /tally/invoice/:tdkRef/preview ───────────────────────────────────────
router.get('/invoice/:tdkRef/preview', authMiddleware, async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid } = req.query;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

    const { rows: avRows } = await query(
      `SELECT * FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 AND user_id=$3`,
      [tdkRef, companyGuid, req.user.userId]
    );
    if (!avRows[0]) return res.status(404).json({ status: false, message: 'Invoice not found' });
    const av = avRows[0];

    const [{ rows: coRows }, { rows: partyRows }] = await Promise.all([
      query(`SELECT name, gstin, address, pan, phone, email, state FROM companies WHERE guid=$1`, [companyGuid]).catch(() => ({ rows: [] })),
      query(`SELECT name, gstin, mailing_address AS address FROM ledgers WHERE company_guid=$1 AND name=$2 LIMIT 1`, [companyGuid, av.party_name]).catch(() => ({ rows: [] })),
    ]);

    const doc = await buildVoucherDocument(av, coRows[0], partyRows[0]);

    res.json({ status: true, data: doc });
  } catch (e) {
    console.error('[invoice/preview]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/invoice/:tdkRef/share-pdf ────────────────────────────────────
// Returns invoice snapshot (provisional or final) after optionally waiting for Tally number.
router.post('/invoice/:tdkRef/share-pdf', authMiddleware, async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid, waitForTallyNumber: shouldWait = true, maxWaitMs = 10000 } = req.body;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

    // Check current state first
    const { rows: avRows } = await query(
      `SELECT * FROM app_vouchers WHERE tdk_reference_no=$1 AND company_guid=$2 AND user_id=$3`,
      [tdkRef, companyGuid, req.user.userId]
    );
    if (!avRows[0]) return res.status(404).json({ status: false, message: 'Invoice not found' });
    let av = avRows[0];

    // If we need to wait and no Tally number yet → poll
    if (shouldWait && !av.tally_voucher_no && av.numbering_policy === 'tally_prime_series') {
      const tallyNo = await waitForTallyNumber(tdkRef, companyGuid, req.user.userId, maxWaitMs);
      if (tallyNo) {
        // Refresh row
        const { rows: fresh } = await query(
          `SELECT * FROM app_vouchers WHERE tdk_reference_no=$1`, [tdkRef]
        ).catch(() => ({ rows: [] }));
        if (fresh[0]) av = fresh[0];
      }
    }

    const [{ rows: coRows }, { rows: partyRows }] = await Promise.all([
      query(`SELECT name, gstin, address, pan, phone, email, state FROM companies WHERE guid=$1`, [companyGuid]).catch(() => ({ rows: [] })),
      query(`SELECT name, gstin, mailing_address AS address FROM ledgers WHERE company_guid=$1 AND name=$2 LIMIT 1`, [companyGuid, av.party_name]).catch(() => ({ rows: [] })),
    ]);

    const doc = await buildVoucherDocument(av, coRows[0], partyRows[0]);
    const pdfType = av.tally_voucher_no ? 'final' : 'provisional';

    res.json({
      status: true,
      data: {
        ...doc,
        pdfType,
        fileName: pdfType === 'final'
          ? `Invoice-${av.tally_voucher_no}.pdf`
          : `Provisional-${tdkRef}.pdf`,
      },
    });
  } catch (e) {
    console.error('[invoice/share-pdf]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

export default router;
