// Tally Write API — creates vouchers/masters in Tally via desktop proxy
// Flow: App → Backend → Desktop proxy → Tally HTTP port (9000)
// The desktop app must have the /tally-proxy endpoint running (Phase 3)

import { Router } from 'express';
import { authMiddleware, requireDeviceCredential } from '../middleware/auth.js';
import { query } from '../db/schema.js';
import { requireTallyWriteAccess, verifyCompanyAccess } from '../middleware/companyAccess.js';
import { voucherToAppCompanyJoinSql } from '../utils/appVoucherCompanyMatch.js';
import { spendForWorkspaceAction } from '../services/billingService.js';
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
import {
  validateVoucherReferences,
  collectLineReferences,
  collectLedgerNameReferences,
} from '../services/voucherReferenceResolver.js';
import { resolveDebitNoteContext } from '../utils/debitNoteContext.js';
import { calcCreditNoteReturn } from '../utils/creditNoteTax.js';
import { persistVoucherLineTaxes } from '../utils/creditNoteItemTax.js';
import {
  buildSalesLikeVoucherXml,
  buildMinimalVoucherAlterXml,
  buildDispatchXml,
  buildSalesVoucherLinesXml,
  buildVoucherHeaderExtrasXml,
  tallyMasterIdFromVoucherGuid,
} from '../utils/salesLikeVoucherXml.js';
import {
  loadDocumentContext,
  buildCompanyBlock,
  buildPartyBlock,
  buildItemLines,
  buildTaxLines,
  buildChargeLines,
  buildHsnSummary,
  buildTotals,
  buildDocumentMetadata,
  buildShippingBlock,
  buildDispatchFromBlock,
  amountInWords,
  isRoundOffLedger,
} from '../utils/voucherDocument.js';
import {
  insertAppMaster,
  markAppMasterFailed,
  markAppMasterPushed,
} from '../utils/appMasters.js';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Socket service reference - injected from server.js after startup
let _socketService = null;
export function setTallyWriteSocket(s) { _socketService = s; }

/** After requireTallyWriteAccess — internal id + Tally GUID for Desktop. */

function resolvedCompany(req) {
  const id = req.company?.id;
  const tallyGuid = req.company?.tallyGuid || req.body?.companyGuid || req.body?.company_guid;
  if (id == null) {
    const err = new Error('Company not resolved');
    err.httpStatus = 403;
    throw err;
  }
  return { id: Number(id), tallyGuid, workspaceId: req.company?.workspaceId || null };
}

/** Ask desktop to pull newly created voucher(s) via SingleVoucher.xml (REFERENCE + number). */
async function requestDesktopSyncAfterWrite({ userId, workspaceId = null, companyId = null, companyGuid, companyName, tdkRef, tallyIds = [], extra = {} }) {
  if (!_socketService?.connectedClients) return;
  try {
    let deviceId = null;
    let wsId = workspaceId;
    if (!wsId && companyId != null) {
      const { rows: cos } = await query(
        `SELECT workspace_id, guid FROM companies WHERE id = $1 LIMIT 1`,
        [companyId]
      );
      wsId = cos[0]?.workspace_id || null;
      if (!companyGuid) companyGuid = cos[0]?.guid;
    }
    if (wsId) {
      const { rows: bind } = await query(
        `SELECT active_device_id FROM workspace_tally_bindings WHERE workspace_id = $1 LIMIT 1`,
        [wsId]
      );
      deviceId = bind[0]?.active_device_id || null;
      if (!deviceId) {
        const { rows: byWs } = await query(
          `SELECT device_id FROM devices WHERE workspace_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1`,
          [wsId]
        );
        deviceId = byWs[0]?.device_id || null;
      }
    }
    // No devices.user_id fallback — Workspace binding is sole Desktop routing source
    if (!deviceId) return;
    const ds = _socketService.connectedClients.get('desktop_' + deviceId);
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
    const reason = extra?.reason || 'voucher_created';
    console.log(`[sync:request] Triggered desktop sync after tally:write reason=${reason} ref=${tdkRef || 'n/a'} (tallyIds: ${ids.join(',') || 'none — full sync'})`);
  } catch (syncErr) {
    console.warn('[sync:request] Could not trigger desktop sync:', syncErr.message);
  }
}

/** Post-write number pull for entries that completed outside the live Sales/Purchase route
 *  (retryOfflineEntries / desktop writeback). Without this, tally_prime_series vouchers stay
 *  number-less in the app even though Tally assigned one (TDK-SAL-2026-0052). */
async function requestSyncAfterDeferredWrite(queueId, userId, { tallyIds = [], reason = 'deferred_posted', rcpTdkRef = null } = {}) {
  if (!queueId) return;
  try {
    const { rows } = await query(
      `SELECT wq.user_id, wq.company_id, wq.company_guid, wq.workspace_id, wq.payload, wq.tally_id, av.tdk_reference_no
         FROM write_queue wq
         LEFT JOIN app_vouchers av ON av.write_queue_id = wq.id
        WHERE wq.id = $1
        LIMIT 1`,
      [queueId]
    );
    const row = rows[0];
    if (!row) return;
    // The queue row names its own author. Callers that authenticate a Desktop
    // rather than a person have no user to pass.
    const author = userId || row.user_id;
    if (!author) return;
    let payload = row.payload;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload || '{}'); } catch { payload = {}; }
    }
    payload = payload || {};
    const ids = [...tallyIds, row.tally_id].map(String).filter(id => id && id !== '0' && id !== 'undefined');
    let companyGuid = row.company_guid;
    if (row.company_id != null) {
      const { rows: cos } = await query(
        `SELECT guid, workspace_id FROM companies WHERE id = $1 LIMIT 1`,
        [row.company_id]
      );
      companyGuid = cos[0]?.guid || companyGuid;
    }
    await requestDesktopSyncAfterWrite({
      userId: author,
      companyId: row.company_id,
      workspaceId: row.workspace_id,
      companyGuid,
      companyName: payload.companyName,
      tdkRef: row.tdk_reference_no || null,
      tallyIds: ids,
      extra: { reason, rcpTdkRef },
    });
  } catch (e) {
    console.warn(`[sync:request] deferred sync for queue ${queueId} failed:`, e.message);
  }
}

const router = Router();

// Write authz: each route uses requireTallyWriteAccess(pathKey) explicitly
// (see companyAccess.TALLY_WRITE_CAPABILITIES). Do not monkey-patch router.post.

// ── Helper: format date YYYYMMDD ──────────────────────────────────────────────
const tallyDate = (d) => {
  if (!d) return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }
  const s = String(d);
  if (/^\d{8}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).replace(/-/g, '');
  return s.replace(/-/g, '').slice(0, 8);
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
const forwardToTally = async (companyGuid, userId, xmlBody, opts = {}) => {
  const companyId = opts.companyId != null ? Number(opts.companyId) : null;
  let device = null;
  if (companyId != null && Number.isFinite(companyId)) {
    const { rows: byWs } = await query(
      `SELECT d.* FROM devices d
       JOIN companies c ON c.workspace_id = d.workspace_id
       WHERE c.id = $1 AND d.paired = TRUE AND d.binding_status IN ('ACTIVE','RESTORE_PENDING')
       ORDER BY d.last_seen DESC NULLS LAST LIMIT 1`,
      [companyId]
    ).catch(() => ({ rows: [] }));
    device = byWs[0] || null;
    if (!device) {
      const { rows: byCompanyWs } = await query(
        `SELECT d.* FROM devices d
         JOIN companies c ON c.workspace_id = d.workspace_id
         WHERE c.id = $1 AND d.paired = TRUE
         ORDER BY d.last_seen DESC NULLS LAST LIMIT 1`,
        [companyId]
      ).catch(() => ({ rows: [] }));
      device = byCompanyWs[0] || null;
    }
  } else if (opts.workspaceId && companyGuid) {
    const { rows: byWs } = await query(
      `SELECT d.* FROM devices d
       JOIN companies c ON c.workspace_id = d.workspace_id
       WHERE c.guid = $1 AND c.workspace_id = $2 AND d.paired = TRUE
       ORDER BY d.last_seen DESC NULLS LAST LIMIT 1`,
      [companyGuid, opts.workspaceId]
    ).catch(() => ({ rows: [] }));
    device = byWs[0] || null;
  }
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

/**
 * Charge workspace owner wallet for a metered action (TALLY_WRITE / PDF_GENERATE).
 * Idempotent on (workspace, kind, operationId). Demo mode skips. Returns false if
 * the HTTP response was already sent (402 insufficient credits).
 */
async function chargeWorkspaceService(req, res, { serviceKey, operationId, meta = {} }) {
  if (!operationId) return true;
  if (req.authz?.demoMode) return true;
  const workspaceId = req.workspaceId;
  if (!workspaceId) return true;
  try {
    await spendForWorkspaceAction({
      workspaceId,
      actorUserId: req.user?.userId,
      serviceKey,
      operationId: String(operationId),
      kind: serviceKey,
      meta,
    });
    return true;
  } catch (billErr) {
    const code = billErr?.code || '';
    if (
      code === 'INSUFFICIENT_CREDITS'
      || code === 'BILLING_INSUFFICIENT_CREDITS'
      || /insufficient/i.test(billErr?.message || '')
    ) {
      res.status(402).json({
        status: false,
        message: 'This Workspace does not have enough credits. Please ask the Workspace Owner to recharge from the Web Portal.',
        error: { code: 'INSUFFICIENT_CREDITS' },
      });
      return false;
    }
    throw billErr;
  }
}

// ── Helper: log entry to write_queue (company_id authoritative; guid for Desktop) ─
const logWriteQueue = async (userId, companyGuid, entryType, entryLabel, amount, payload, xml, companyId = null, workspaceId = null) => {
  let wsId = workspaceId;
  let resolvedId = companyId != null ? Number(companyId) : null;
  let resolvedGuid = companyGuid;
  if (resolvedId != null && Number.isFinite(resolvedId)) {
    const { rows: cRows } = await query(
      `SELECT id, guid, workspace_id FROM companies WHERE id = $1 LIMIT 1`,
      [resolvedId]
    ).catch(() => ({ rows: [] }));
    if (cRows[0]) {
      resolvedGuid = cRows[0].guid;
      wsId = wsId || cRows[0].workspace_id;
    }
  } else if (wsId && companyGuid) {
    const { rows: cRows } = await query(
      `SELECT id, guid, workspace_id FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
      [companyGuid, wsId]
    ).catch(() => ({ rows: [] }));
    wsId = cRows[0]?.workspace_id || wsId;
    resolvedId = cRows[0]?.id ?? null;
    resolvedGuid = cRows[0]?.guid || companyGuid;
  }
  let queueUserId = userId;
  if (wsId) {
    const { rows: wRows } = await query(
      `SELECT owner_user_id FROM workspaces WHERE id = $1 LIMIT 1`,
      [wsId]
    ).catch(() => ({ rows: [] }));
    if (wRows[0]?.owner_user_id) queueUserId = wRows[0].owner_user_id;
  }
  const { rows } = await query(
    `INSERT INTO write_queue (user_id, company_guid, company_id, entry_type, entry_label, amount, payload, xml, status, attempt_count, created_at, updated_at, workspace_id, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', 0, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT, $9, $10)
     RETURNING id`,
    [queueUserId, resolvedGuid, resolvedId, entryType, entryLabel, amount || null, JSON.stringify(payload), xml, wsId, userId]
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
    await markAppMasterFailed(id, error);
  } else if (result?.status === 'desktop_offline' || (result?.message || '').includes('not connected')) {
    await query(
      `UPDATE write_queue SET status = 'desktop_offline', error_message = $2,
       attempt_count = attempt_count + 1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id = $1`,
      [id, result?.message || 'Desktop offline']
    );
    // Keep app_masters queued — will push when desktop reconnects
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
    await markAppMasterFailed(id, errMsg);
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
    await markAppMasterFailed(id, errMsg);
  } else {
    let resolvedVoucherNumber = result?.voucherNumber || null;
    const tallyId = result?.tallyId || null;

    // This runs after the HTTP response and again inside setImmediate, so there
    // is no request in scope. write_queue is the authoritative tenant context:
    // company_id (internal), company_guid (Tally-facing) and the owning user.
    const { rows: wqCtxRows } = await query(
      `SELECT user_id, company_guid, company_id, workspace_id FROM write_queue WHERE id = $1`,
      [id]
    ).catch(() => ({ rows: [] }));
    const wqCtx = wqCtxRows[0] || null;
    const wqCompanyId = wqCtx?.company_id ?? null;

    // When Tally Series is used, import ack often returns LASTVCHID only (no VOUCHERNUMBER).
    // Backfill number from vouchers table via TDK narration/reference anchor when available.
    if (!resolvedVoucherNumber && wqCompanyId != null) {
      try {
        const { rows: avLookup } = await query(
          `SELECT company_guid, tdk_reference_no FROM app_vouchers WHERE write_queue_id = $1 LIMIT 1`,
          [id]
        );
        const tdkRef = avLookup[0]?.tdk_reference_no;
        if (tdkRef) {
          const { rows: vRows } = await query(
            `SELECT voucher_number FROM vouchers
              WHERE company_id = $1
                AND (
                  narration ILIKE '%' || $2 || '%'
                  OR COALESCE(reference,'') ILIKE '%' || $2 || '%'
                )
                AND COALESCE(is_cancelled, false) = false
              ORDER BY date DESC NULLS LAST, alter_id DESC NULLS LAST
              LIMIT 1`,
            [wqCompanyId, tdkRef]
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

    // Masters: pushed only — Posted waits for ingest confirmation (app_masters).
    await markAppMasterPushed(id);

    // Always mark app_vouchers posted on successful Tally write (number may arrive later via sync).
    const avResult = await query(`
      UPDATE app_vouchers
      SET tally_voucher_no      = COALESCE($1, tally_voucher_no),
          tally_sync_status     = 'synced',
          books_impact_status   = 'posted',
          updated_at            = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE write_queue_id = $2
      RETURNING company_id, company_guid, tdk_reference_no, tally_voucher_no
    `, [resolvedVoucherNumber || null, id]).catch(e => { console.error('[app_vouchers sync]', e.message); return { rows: [] }; });
    const avRows = avResult?.rows ?? [];
    const emitNo = resolvedVoucherNumber || avRows[0]?.tally_voucher_no || null;
    if (avRows.length > 0 && emitNo) {
      const { company_id, company_guid, tdk_reference_no } = avRows[0];
      _socketService?.emitVoucherSynced?.(company_guid, tdk_reference_no, emitNo, { companyId: company_id });
    }

    if (resolvedVoucherNumber) {
      // Auto-IRN: if e_invoice_mode = 'auto' and e_invoice_applicable = 'applicable_configured', trigger IRN
      setImmediate(async () => {
        try {
          if (!wqCtx || wqCompanyId == null) return;
          const { user_id: userId, company_guid: companyGuid } = wqCtx;

          // Check if auto-IRN is configured for this company
          const { rows: cfgRows } = await query(
            `SELECT e_invoice_applicable, e_invoice_mode FROM company_compliance_config WHERE company_id = $1`,
            [wqCompanyId]
          ).catch(() => ({ rows: [] }));
          const cfg = cfgRows[0];
          if (cfg?.e_invoice_applicable !== 'applicable_configured' || cfg?.e_invoice_mode !== 'auto') return;

          // Get voucherGuid for this write_queue entry
          const { rows: vRows } = await query(
            `SELECT guid FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
            [wqCompanyId, resolvedVoucherNumber]
          ).catch(() => ({ rows: [] }));
          if (!vRows[0]?.guid) return;

          const { rows: userRows } = await query(
            `SELECT integration_settings FROM users WHERE id = $1`, [userId]
          ).catch(() => ({ rows: [] }));
          const einvoiceCreds = userRows[0]?.integration_settings?.einvoice;
          if (!einvoiceCreds?.gstin || !einvoiceCreds?.username) return;

          const { rows: coRows } = await query(
            `SELECT gstin, name FROM companies WHERE id = $1`, [wqCompanyId]
          ).catch(() => ({ rows: [] }));
          // A Tally GUID is unique only inside one workspace, so the reload must
          // stay pinned to the company that owns this queue entry.
          const { rows: voucherRows } = await query(
            `SELECT * FROM vouchers WHERE guid = $1 AND company_id = $2`,
            [vRows[0].guid, wqCompanyId]
          ).catch(() => ({ rows: [] }));

          if (einvoiceCreds?.gstin && coRows[0] && voucherRows[0]) {
            console.log(`[auto-IRN] Triggering for ${resolvedVoucherNumber}`);
            await generateIRN(wqCompanyId, voucherRows[0], coRows[0], einvoiceCreds);
            console.log(`[auto-IRN] Success for ${resolvedVoucherNumber}`);
            await query(
              `UPDATE app_vouchers SET e_invoice_status = 'generated', updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE (company_id::text = $1::text OR company_guid = $1::text) AND tally_voucher_no = $2`,
              [wqCompanyId, resolvedVoucherNumber]
            ).catch(() => {});
          }
        } catch (autoErr) {
          console.error(`[auto-IRN] Failed for ${resolvedVoucherNumber}:`, autoErr.message);
        }
      });

      // Auto-EWB: if e_way_bill_mode = 'auto' and e_way_bill_applicable = 'applicable_configured'
      setImmediate(async () => {
        try {
          if (!wqCtx || wqCompanyId == null) return;
          const { user_id: userId, company_guid: companyGuid } = wqCtx;

          // Check if auto-EWB is configured for this company
          const { rows: ewbCfgRows } = await query(
            `SELECT e_way_bill_applicable, e_way_bill_mode FROM company_compliance_config WHERE company_id = $1`,
            [wqCompanyId]
          ).catch(() => ({ rows: [] }));
          const ewbCfg = ewbCfgRows[0];
          if (ewbCfg?.e_way_bill_applicable !== 'applicable_configured' || ewbCfg?.e_way_bill_mode !== 'auto') return;

          // Load voucher + dispatch details from app_vouchers payload
          const { rows: vRowsEWB } = await query(
            `SELECT v.*, av.payload as av_payload
             FROM vouchers v
             LEFT JOIN app_vouchers av ON av.tally_voucher_no = v.voucher_number AND ${voucherToAppCompanyJoinSql('v', 'av')}
             AND av.write_queue_id = $3
             AND av.voucher_date::text = v.date
             AND (
               (COALESCE(av.tdk_reference_no, '') <> '' AND COALESCE(v.reference, '') = av.tdk_reference_no)
               OR COALESCE(av.tdk_reference_no, '') = ''
             )
             WHERE v.company_id = $1 AND v.voucher_number = $2
             ORDER BY (av.payload IS NOT NULL) DESC, v.date DESC
             LIMIT 1`,
            [wqCompanyId, resolvedVoucherNumber, id]
          ).catch(() => ({ rows: [] }));
          if (!vRowsEWB[0]) return;

          const dispatchDetails = vRowsEWB[0].av_payload?.dispatch_details;
          if (!dispatchDetails?.dispatch_from || !dispatchDetails?.ship_to) return;

          const { rows: coRowsEWB }   = await query(`SELECT * FROM companies WHERE id = $1`, [wqCompanyId]).catch(() => ({ rows: [] }));
          const { rows: ewbUserRows } = await query(`SELECT integration_settings FROM users WHERE id = $1`, [userId]).catch(() => ({ rows: [] }));
          const ewbCreds = ewbUserRows[0]?.integration_settings?.ewaybill || {};

          await generateEWB(wqCompanyId, vRowsEWB[0], coRowsEWB[0], ewbCreds, dispatchDetails);
          console.log(`[auto-EWB] Success for ${resolvedVoucherNumber}`);
        } catch (ewbErr) {
          console.error(`[auto-EWB] Failed for ${resolvedVoucherNumber}:`, ewbErr.message);
        }
      });
    }
  }
};

// ── TDK Reference Generator ────────────────────────────────────────────────────
async function generateTDKReference(companyGuid, isOptional, voucherTypeCode = 'SAL', companyId = null) {
  const prefix = isOptional ? `OPT-${voucherTypeCode}` : voucherTypeCode;
  const year = new Date().getFullYear();
  const id = companyId != null ? Number(companyId) : null;
  if (id == null || !Number.isFinite(id)) {
    throw new Error('companyId required for TDK reference');
  }
  let guid = companyGuid;
  if (!guid) {
    const { rows: cos } = await query(`SELECT guid FROM companies WHERE id = $1 LIMIT 1`, [id]);
    guid = cos[0]?.guid;
  }
  const { rows } = await query(
    `INSERT INTO tdk_reference_counters (company_id, company_guid, voucher_prefix, fiscal_year, last_seq)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (company_id, voucher_prefix, fiscal_year)
     DO UPDATE SET last_seq = tdk_reference_counters.last_seq + 1
     RETURNING last_seq`,
    [id, guid, prefix, year]
  );
  const seq = rows[0].last_seq;
  return `TDK-${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

// ── TallyDekho Series Invoice Number Generator ────────────────────────────────
// Returns formatted invoice number e.g. TD/SAL/26-27/00001
// Used when numbering_policy = 'tallydekho_series'
async function generateTDSeriesNumber(companyGuid, voucherTypeCode = 'SAL', companyId = null) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const curYear = now.getFullYear();
  const startYear = month >= 4 ? curYear : curYear - 1; // April = start of Indian FY
  const fiscalShort = `${String(startYear).slice(2)}-${String(startYear + 1).slice(2)}`;
  const prefix = `TDINV-${voucherTypeCode}`;
  const id = companyId != null ? Number(companyId) : null;
  if (id == null || !Number.isFinite(id)) {
    throw new Error('companyId required for TD series');
  }
  let guid = companyGuid;
  if (!guid) {
    const { rows: cos } = await query(`SELECT guid FROM companies WHERE id = $1 LIMIT 1`, [id]);
    guid = cos[0]?.guid;
  }
  const { rows } = await query(
    `INSERT INTO tdk_reference_counters (company_id, company_guid, voucher_prefix, fiscal_year, last_seq)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (company_id, voucher_prefix, fiscal_year)
     DO UPDATE SET last_seq = tdk_reference_counters.last_seq + 1
     RETURNING last_seq`,
    [id, guid, prefix, startYear]
  );
  const seq = rows[0].last_seq;
  return `TD/${voucherTypeCode}/${fiscalShort}/${String(seq).padStart(5, '0')}`;
}

// ── createReceiptForInvoice ── helper that pairs a Receipt voucher with a Sales Invoice
// when Collect Payment Now is enabled. Builds its own Receipt XML, logs to write_queue,
// creates a child app_voucher row linked via parent_invoice_uuid, and forwards to Tally.
/**
 * Party GSTIN / state and item HSN for the GST tags Tally expects on a voucher.
 *
 * The mobile app never sent these, so our vouchers printed without Place of
 * Supply, party GSTIN or HSN while native Tally entries carried all three.
 */
async function loadVoucherTagContext(companyId, partyLedger, items = []) {
  const names = (items || []).map(i => i.itemName || i.name).filter(Boolean);
  // companyId must be passed in — this helper has no access to `req`
  const ctx = await loadDocumentContext(companyId, partyLedger, names).catch(() => null);
  const masters = ctx?.itemMasters || new Map();
  return {
    partyGstin: ctx?.partyRow?.gstin || '',
    partyState: ctx?.partyRow?.state_name || '',
    withHsn: (list = []) => list.map(item => {
      const master = masters.get(String(item.itemName || '').toLowerCase());
      return {
        ...item,
        hsn: item.hsn || master?.hsn || '',
        typeOfSupply: item.typeOfSupply || master?.type_of_supply || '',
      };
    }),
  };
}

/** `<HSNCODE>` / `<DISCOUNT>` for an inventory line, empty when we know neither. */
function inventoryHsnDiscountXml(item) {
  const hsn = String(item.hsn || item.hsnCode || '').trim();
  const disc = parseFloat(item.discount);
  return [
    hsn ? `\n    <HSNCODE>${escapeXml(hsn)}</HSNCODE>` : '',
    Number.isFinite(disc) && disc !== 0 ? `\n    <DISCOUNT>${disc}</DISCOUNT>` : '',
  ].join('');
}

/** Bank instrument block for the cash/bank leg of a Receipt or Payment. */
function buildBankAllocationXml({
  paymentMethod = '', instrument = null, date, amount = 0, favouring = '', reference = '',
}) {
  // Same guard as the standalone Receipt/Payment routes: without instrument
  // details Tally gets a blank allocation it cannot reconcile.
  if (!paymentMethod || paymentMethod === 'Cash' || !instrument) return '';
  const methodToTxnType = {
    Cheque: 'Cheque', NEFT: 'Electronic Cheque', RTGS: 'Electronic Cheque',
    UPI: 'Others', Bank: 'Transacted',
  };
  const inst = instrument || {};
  const instDate = tallyDate(inst.instrumentDate || date);
  return `    <BANKALLOCATIONS.LIST>
      <DATE>${instDate}</DATE>
      <INSTRUMENTDATE>${instDate}</INSTRUMENTDATE>
      <INSTRUMENTNUMBER>${escapeXml(inst.instrumentNo || reference || '')}</INSTRUMENTNUMBER>
      <BANKNAME>${escapeXml(inst.bankName || '')}</BANKNAME>
      <TRANSACTIONTYPE>${escapeXml(inst.transactionType || methodToTxnType[paymentMethod] || 'Others')}</TRANSACTIONTYPE>
      <PAYMENTFAVOURING>${escapeXml(favouring)}</PAYMENTFAVOURING>
      <AMOUNT>${parseFloat(amount) || 0}</AMOUNT>
    </BANKALLOCATIONS.LIST>`;
}

async function createReceiptForInvoice({
  companyGuid, companyName, userId, date,
  partyLedger, bankLedger, amount, parentInvoiceUuid, parentTdkRef,
  isOptional = false, reference,
  paymentMethod = '', instrument = null, voucherNumber = '',
  parentCreatedAt = null,   // 2026-07-01 R4: share timestamp with parent Sales invoice
                            // so audit-trail sort keeps Invoice → Receipt sequence.
  req = null, res = null,
}) {
  if (!companyGuid || !partyLedger || !bankLedger || !(parseFloat(amount) > 0)) {
    throw new Error('createReceiptForInvoice: missing required fields');
  }
  const amt = parseFloat(amount);
  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const { rows: coRows } = await query(`SELECT id FROM companies WHERE guid=$1 LIMIT 1`, [companyGuid]).catch(() => ({ rows: [] }));
  const companyId = coRows[0]?.id ?? null;
  const rcpTdkRef = await generateTDKReference(companyGuid, isOptional, 'RCP', companyId);
  // A non-cash receipt carries the instrument on the bank leg, exactly like the
  // standalone Receipt route; without it Tally shows a bare bank entry.
  // The allocation amount must match the bank leg's signed AMOUNT (-amt here).
  const bankAllocXml = buildBankAllocationXml({
    paymentMethod, instrument, date, amount: -amt, favouring: partyLedger,
    reference: reference || parentTdkRef,
  });
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
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
  ${voucherNumber ? `<VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>` : ''}
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
${bankAllocXml}
  </ALLLEDGERENTRIES.LIST>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger} ← ${bankLedger} (linked: ${parentTdkRef})`;
  const payload = { companyGuid, companyName, date, partyLedger, bankLedger, amount: amt, isOptional, reference, parentInvoiceUuid, parentTdkRef, narration };
  const qId = await logWriteQueue(userId, companyGuid, 'receipt', label, amt, payload, xml, companyId).catch(() => null);

  // Create child app_voucher (linked to invoice via parent_invoice_uuid).
  // 2026-07-01 R4: explicitly set created_at to match the parent Sales invoice's timestamp
  // when provided. This keeps the pair's audit-trail sort stable (Invoice → Receipt within
  // pair via av.id ASC tiebreak). Fallback to DB default (EXTRACT(EPOCH FROM NOW())) when
  // parent timestamp isn't passed — preserves prior behavior for legacy callers.
  let receiptUuid = null;
  if (qId) {
    const createdAtSql = parentCreatedAt
      ? `$12::bigint`
      : `EXTRACT(EPOCH FROM NOW())::bigint`;
    const insertParams = [companyGuid, companyId, userId, qId, rcpTdkRef, isOptional ? 'optional' : 'regular',
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(payload), parentInvoiceUuid];
    if (parentCreatedAt) insertParams.push(parentCreatedAt);
    if (req && res) {
      if (!(await chargeWorkspaceService(req, res, {
        serviceKey: 'TALLY_WRITE',
        operationId: rcpTdkRef,
        meta: { voucherType: 'receipt', paired: true },
      }))) {
        return { ok: false, insufficientCredits: true, queueId: qId, tdkRef: rcpTdkRef };
      }
    }
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload, parent_invoice_uuid, created_at)
       VALUES ($1,$2,$3,$4,'receipt',$5,$6,$6,'queued','not_posted','tally_prime_series',$7,$8,$9,$10,$11, ${createdAtSql})
       RETURNING invoice_uuid`,
      insertParams
    ).catch(e => { console.error('[receipt-app_voucher] insert failed:', e.message); return { rows: [] }; });
    receiptUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, userId, xml, { companyId });
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
  paymentMethod = '', instrument = null, voucherNumber = '',
  parentCreatedAt = null,
  req = null, res = null,
}) {
  if (!companyGuid || !partyLedger || !bankLedger || !(parseFloat(amount) > 0)) {
    throw new Error('createPaymentForInvoice: missing required fields');
  }
  const amt = parseFloat(amount);
  const isOpt = isOptional ? 'Yes' : 'No';
  const dt = tallyDate(date);
  const { rows: coRowsPay } = await query(`SELECT id FROM companies WHERE guid=$1 LIMIT 1`, [companyGuid]).catch(() => ({ rows: [] }));
  const companyIdPay = coRowsPay[0]?.id ?? null;
  const payTdkRef = await generateTDKReference(companyGuid, isOptional, 'PAY', companyIdPay);
  const bankAllocXml = buildBankAllocationXml({
    paymentMethod, instrument, date, amount: amt, favouring: partyLedger,
    reference: reference || parentTdkRef,
  });
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
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
  ${voucherNumber ? `<VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>` : ''}
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
${bankAllocXml}
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
  const qId = await logWriteQueue(userId, companyGuid, 'payment', label, amt, payload, xml, companyIdPay).catch(() => null);

  let paymentUuid = null;
  if (qId) {
    const createdAtSql = parentCreatedAt ? `$12::bigint` : `EXTRACT(EPOCH FROM NOW())::bigint`;
    const insertParams = [companyGuid, companyIdPay, userId, qId, payTdkRef, isOptional ? 'optional' : 'regular',
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(payload), parentInvoiceUuid];
    if (parentCreatedAt) insertParams.push(parentCreatedAt);
    if (req && res) {
      if (!(await chargeWorkspaceService(req, res, {
        serviceKey: 'TALLY_WRITE',
        operationId: payTdkRef,
        meta: { voucherType: 'payment', paired: true },
      }))) {
        return { ok: false, insufficientCredits: true, queueId: qId, tdkRef: payTdkRef };
      }
    }
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload, parent_invoice_uuid, created_at)
       VALUES ($1,$2,$3,$4,'payment',$5,$6,$6,'queued','not_posted','tally_prime_series',$7,$8,$9,$10,$11, ${createdAtSql})
       RETURNING invoice_uuid`,
      insertParams
    ).catch(e => { console.error('[payment-app_voucher] insert failed:', e.message); return { rows: [] }; });
    paymentUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, userId, xml, { companyId: companyIdPay });
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

// ── ensurePairedVoucherForQueueEntry ──────────────────────────────────────────
// The paired Receipt/Payment is created inline by the Sales/Purchase route, but only
// when that route's own push to Tally succeeds. A deferred push (desktop offline, or a
// transient failure) is completed later by retryOfflineEntries or the desktop writeback
// endpoint — neither of which re-runs the route, so the invoice landed in Tally with no
// paired voucher and no error left behind. Call this after any delayed success to close
// that gap. Idempotent: an existing child voucher short-circuits, so it is safe to call
// on every completion and safe to re-run for backfills.
// Pure decision half, kept separate so the gating rules are testable without a database.
// Returns null when the entry owes no paired voucher.
export function planPairedVoucher(entryType, payload) {
  const isSales = entryType === 'sales';
  const isPurchase = entryType === 'purchase';
  if (!isSales && !isPurchase) return null;

  let p;
  try {
    p = typeof payload === 'string' ? JSON.parse(payload || '{}') : (payload || {});
  } catch {
    return null;
  }
  const pay = isSales ? p.collect_payment : p.make_payment;
  const amount = parseFloat(pay?.amount);
  if (!pay?.ledgerName || !(amount > 0)) return null;

  return {
    childType: isSales ? 'receipt' : 'payment',
    bankLedger: pay.ledgerName,
    amount,
    paymentMethod: pay.mode || '',
    instrument: pay.instrument || (pay.reference ? { instrumentNo: pay.reference } : null),
    reference: pay.reference || p.reference,
    isOptional: !!p.isOptional,
    date: p.date,
    companyName: p.companyName,
    partyLedger: p.partyLedger,
  };
}

export async function ensurePairedVoucherForQueueEntry(queueId, userId) {
  // Must never throw into retry/writeback success paths — a recovery failure must
  // not flip a successfully posted parent invoice back to failed / HTTP 500.
  if (!queueId) return null;
  try {
    const { rows } = await query(
      `SELECT wq.entry_type, wq.payload, wq.company_guid,
              av.invoice_uuid, av.tdk_reference_no, av.party_name, av.created_at, av.user_id
         FROM write_queue wq
         JOIN app_vouchers av ON av.write_queue_id = wq.id
        WHERE wq.id = $1
        LIMIT 1`,
      [queueId]
    );
    const row = rows[0];
    if (!row) return null;

    const plan = planPairedVoucher(row.entry_type, row.payload);
    if (!plan || !row.invoice_uuid || !row.tdk_reference_no) return null;

    const { rows: existing } = await query(
      `SELECT 1 FROM app_vouchers WHERE parent_invoice_uuid = $1 AND voucher_type = $2 LIMIT 1`,
      [row.invoice_uuid, plan.childType]
    );
    if (existing[0]) return null;

    const create = plan.childType === 'receipt' ? createReceiptForInvoice : createPaymentForInvoice;

    const result = await create({
      companyGuid: row.company_guid,
      companyName: plan.companyName,
      userId: userId || row.user_id,
      date: plan.date,
      partyLedger: plan.partyLedger || row.party_name,
      bankLedger: plan.bankLedger,
      amount: plan.amount,
      parentInvoiceUuid: row.invoice_uuid,
      parentTdkRef: row.tdk_reference_no,
      isOptional: plan.isOptional,
      reference: plan.reference,
      paymentMethod: plan.paymentMethod,
      instrument: plan.instrument,
      parentCreatedAt: row.created_at,
    });
    console.log(`[paired-recovery] ${plan.childType} ${result?.tdkRef} created for ${row.tdk_reference_no} (queue ${queueId})`);
    return result;
  } catch (e) {
    console.error(`[paired-recovery] queue ${queueId} failed:`, e.message);
    return { ok: false, error: e.message };
  }
}

// ── POST /tally/voucher/sales ───────────────────────────────────
router.post('/voucher/sales', authMiddleware, requireTallyWriteAccess('/voucher/sales'), async (req, res) => {
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

  // Before any XML or queue row: every master this body names must belong to
  // the company the request resolved to.
  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'salesLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
    { kind: 'ledger', value: collect_payment?.ledgerName },
  ], { workspaceId: req.company?.workspaceId })) return;

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
        WHERE (company_id::text = $1::text OR company_guid = $1::text)
          AND voucher_type = 'sales_invoice'
          AND user_id = $2
          AND LOWER(TRIM(COALESCE(party_name,''))) = LOWER(TRIM($3))
          AND ABS(COALESCE(total_amount,0) - $4::numeric) < 0.02
          AND voucher_date = $5::date
          AND created_at > EXTRACT(EPOCH FROM NOW())::BIGINT - 120
        ORDER BY id DESC
        LIMIT 5`,
      [req.company?.id, req.user.userId, partyLedger, amt, date || null]
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
  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'SAL', req.company?.id).catch(() => null);

  // TallyDekho Series: generate invoice number immediately (we own the sequence)
  // This number is stable and final — no 10s wait needed for Share PDF
  let tdkInvoiceNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkInvoiceNo = await generateTDSeriesNumber(companyGuid, 'SAL', req.company?.id).catch(() => null);
    if (tdkInvoiceNo) effectiveVoucherNumber = tdkInvoiceNo;
  }

  // Sales and Proforma now share one builder, so a regular Sales Invoice sends the
  // same PARTYNAME / OBJVIEW / VCHENTRYMODE / unit-suffixed qty set that Proforma
  // already did, plus the GST tags a native Tally entry carries.
  const salesCtx = await loadDocumentContext(req.company?.id,
    partyLedger,
    items.map(i => i.itemName || i.name).filter(Boolean)
  ).catch(() => null);
  const itemsWithHsn = items.map(item => {
    const master = salesCtx?.itemMasters?.get(String(item.itemName || '').toLowerCase());
    return {
      ...item,
      hsn: item.hsn || master?.hsn || '',
      typeOfSupply: item.typeOfSupply || master?.type_of_supply || '',
    };
  });
  // Persist enriched HSN on the lifecycle payload so provisional preview/PDF
  // does not depend on a later stock re-sync to fill the column.
  const enrichedBody = { ...req.body, items: itemsWithHsn };
  // Round-off is its own ledger line in Tally, not a freight-style charge.
  const roundOffLine = logistics.find(l => l?.ledgerName && isRoundOffLedger(l.ledgerName)) || null;
  const chargeLines = logistics.filter(l => l !== roundOffLine);

  let xml = buildSalesLikeVoucherXml({
    companyName,
    vchType,
    action: 'Create',
    dt,
    voucherNumber: effectiveVoucherNumber,
    tdkRef: tdkRef || reference || '',
    isOptional,
    narration: fullNarration,
    partyLedger,
    partyAmt: partyNetAmt,
    items: itemsWithHsn,
    taxes,
    logistics: chargeLines,
    againstOrderNo: req.body.againstOrderNo || '',
    topLevelDispatchXml,
    ewbDetailsXml,
    placeOfSupply: dispatch_details?.ship_to_state || salesCtx?.partyRow?.state_name || '',
    partyGstin: salesCtx?.partyRow?.gstin || '',
    consigneeGstin: dispatch_details?.ship_to_gstin || '',
    referenceDate: date || '',
    paymentTerms: dispatch_details?.mode_of_payment || req.body.paymentTerms || '',
    termsText: req.body.termsText || dispatch_details?.terms_of_delivery || '',
    roundOff: roundOffLine ? { ledgerName: roundOffLine.ledgerName, amount: roundOffLine.amount } : null,
  });

  const label = `${partyLedger}${voucherNumber ? ' #' + voucherNumber : ''}`;
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'sales', label, amt, req.body, xml, req.company?.id).catch(() => null);

  // Create app_voucher lifecycle record.
  // 2026-07-01 R4: RETURNING created_at as well so we can pass the same timestamp to
  // any chained Receipt — keeps intra-pair sort stable in audit-trail.
  let invoiceUuid = null;
  let invoiceCreatedAt = null;
  if (queueId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'sales_invoice' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'sales_invoice',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid, created_at`,
      [companyGuid, req.company?.id ?? null, req.user.userId, queueId, tdkRef, original_entry_type,
       numbering_policy,
       tdkInvoiceNo || null,     // pre-set for tallydekho_series; null for tally_prime_series
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(enrichedBody)]
    ).catch(e => { console.error('[app_vouchers] insert failed:', e.message); return { rows: [] }; });
    invoiceUuid      = avResult?.rows?.[0]?.invoice_uuid || null;
    invoiceCreatedAt = avResult?.rows?.[0]?.created_at   || null;

    // Phase 3: persist per-line tax geometry for Credit Note reversal
    // (common GST ledger / VAT / packing GST attribution).
    await persistVoucherLineTaxes(query, {
      companyGuid,
      tdkReferenceNo: tdkRef,
      items: itemsWithHsn,
      taxes,
      logistics,
    }).catch(e => console.warn('[voucher_line_taxes] persist failed:', e.message));
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
          paymentMethod: collect_payment.mode || '',
          instrument: collect_payment.instrument || (collect_payment.reference
            ? { instrumentNo: collect_payment.reference }
            : null),
          parentCreatedAt: invoiceCreatedAt,   // R4: share parent Sales timestamp
          req, res,
        });
        if (receiptResult?.insufficientCredits) return;
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

// ── POST /tally/voucher/proforma ─────────────────────────────────────────────
// Always optional Sales in Tally. Separate app identity (proforma_invoice / TDK-PRF).
router.post('/voucher/proforma', authMiddleware, requireTallyWriteAccess('/voucher/proforma'), async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount,
    items = [],
    taxes = [],
    logistics = [],
    voucherType = 'Sales',
    dispatch_details = null,
  } = req.body;

  if (!companyGuid || !partyLedger || !items.length) {
    return res.status(400).json({ status: false, message: 'companyGuid, partyLedger and items required' });
  }

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'salesLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
  ], { workspaceId: req.company?.workspaceId })) return;

  const dt = tallyDate(date);
  const amt = parseFloat(totalAmount) || 0;
  const vchType = voucherType || 'Sales';
  const fullNarration = narration || '';

  const tdkRef = await generateTDKReference(companyGuid, false, 'PRF', req.company?.id).catch(() => null);

  const xml = buildSalesLikeVoucherXml({
    companyName,
    vchType,
    action: 'Create',
    dt,
    voucherNumber: voucherNumber || '',
    tdkRef: tdkRef || reference || '',
    isOptional: true,
    narration: fullNarration,
    partyLedger,
    partyAmt: amt,
    items,
    taxes,
    logistics,
    againstOrderNo: req.body.againstOrderNo || '',
  });

  const label = `${partyLedger}${voucherNumber ? ' #' + voucherNumber : ''}`;
  const persistPayload = { ...req.body, isOptional: true, original_entry_type: 'optional', tdkRef };
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'proforma', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let invoiceUuid = null;
  if (queueId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'proforma_invoice' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'proforma_invoice',$5,'optional','optional','queued','not_posted','tally_prime_series',$6,$7,$8,$9,$10)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, queueId, tdkRef,
       voucherNumber || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[app_vouchers] proforma insert failed:', e.message); return { rows: [] }; });
    invoiceUuid = avResult?.rows?.[0]?.invoice_uuid || null;

    await persistVoucherLineTaxes(query, {
      companyGuid,
      tdkReferenceNo: tdkRef,
      items,
      taxes,
      logistics,
    }).catch(e => console.warn('[voucher_line_taxes] proforma persist failed:', e.message));
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(queueId, result, null);
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef,
          tallyIds: [result?.tallyId],
          extra: { reason: 'proforma_created' },
        });
      });
    }
    res.json({
      status: true, queued: offline, queueId,
      tdkReferenceNo: tdkRef, invoiceUuid,
      invoiceNumber: result?.voucherNumber || null,
      numberingPolicy: 'tally_prime_series',
      message: offline ? 'Entry saved. Will push to Tally when desktop connects.' : 'Proforma invoice saved (optional)',
      data: result,
      voucherNumber: result?.voucherNumber || null,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(queueId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/proforma/convert ─────────────────────────────────────
// Same Tally voucher: DATE + TAGNAME=MASTER ID Alter. Flip ISOPTIONAL → No.
// Also send narration + convert-form item lines (no GUID/REMOTEID rebuild).
// Proven 2026-08-18 (narration-only probe on MASTERID 8560).
router.post('/voucher/proforma/convert', authMiddleware, requireTallyWriteAccess('/voucher/proforma/convert'), async (req, res) => {
  const {
    companyGuid, companyName, tdkRef,
    partyLedger: bodyParty, date: bodyDate, items: bodyItems, taxes: bodyTaxes,
    logistics: bodyLogistics, narration: bodyNarration, totalAmount: bodyTotal,
    salesLedger: bodySalesLedger, dispatch_details: bodyDispatch,
    collect_payment: bodyCollect, reference: bodyReference,
  } = req.body;
  if (!companyGuid || !tdkRef) {
    return res.status(400).json({ status: false, message: 'companyGuid and tdkRef required' });
  }

  const { rows: avRows } = await query(
    `SELECT * FROM app_vouchers
      WHERE tdk_reference_no=$1
        AND (company_id::text = $2::text OR company_guid = $2::text)
        AND user_id=$3 AND voucher_type='proforma_invoice'`,
    [tdkRef, req.company?.id, req.user.userId]
  );
  const av = avRows[0];
  if (!av) return res.status(404).json({ status: false, message: 'Proforma not found' });

  const p = typeof av.payload === 'string' ? JSON.parse(av.payload) : (av.payload || {});
  if (Array.isArray(bodyItems) && bodyItems.length) p.items = bodyItems;
  if (Array.isArray(bodyTaxes)) p.taxes = bodyTaxes;
  if (Array.isArray(bodyLogistics)) p.logistics = bodyLogistics;
  if (bodyParty) p.partyLedger = bodyParty;
  if (bodyDate) p.date = bodyDate;
  if (bodyNarration !== undefined) p.narration = bodyNarration;
  if (bodyTotal != null && bodyTotal !== '') p.totalAmount = bodyTotal;
  if (bodySalesLedger) p.salesLedger = bodySalesLedger;
  if (bodyDispatch) p.dispatch_details = bodyDispatch;
  if (bodyCollect) p.collect_payment = bodyCollect;
  if (bodyReference) p.reference = bodyReference;
  p.convert = true;
  p.tdkRef = tdkRef;
  p.isOptional = false;

  const hasDispatch = p.dispatch_details
    && Object.values(p.dispatch_details).some((v) => v != null && String(v).trim() !== '');
  const hasNarration = !!(p.narration && String(p.narration).trim());
  const sendItems = Array.isArray(bodyItems) && bodyItems.length > 0;
  const alreadyConverted = av.current_entry_type === 'regular' || av.conversion_status === 'converted';
  if (alreadyConverted && !hasDispatch && !hasNarration && !sendItems) {
    return res.json({
      status: true, alreadyConverted: true,
      tdkReferenceNo: tdkRef,
      invoiceNumber: av.tally_voucher_no || null,
      message: 'Already converted to invoice',
    });
  }
  const { rows: wqRowsEarly } = await query(
    `SELECT tally_id, status FROM write_queue WHERE id=$1`,
    [av.write_queue_id]
  ).catch(() => ({ rows: [] }));
  const tallyIdOk = wqRowsEarly[0]?.tally_id && String(wqRowsEarly[0].tally_id) !== '0';
  if (!av.tally_voucher_no && av.tally_sync_status !== 'synced' && !tallyIdOk) {
    return res.status(409).json({
      status: false,
      message: 'Wait until this Proforma is synced from Tally, then convert.',
    });
  }

  const items = p.items || [];
  const taxes = p.taxes || [];
  const logistics = p.logistics || [];
  const partyLedger = p.partyLedger || av.party_name;
  const amt = parseFloat(p.totalAmount || av.total_amount || 0);
  const vchType = p.voucherType || 'Sales';
  const collect_payment = p.collect_payment || null;
  const payAmt = collect_payment?.ledgerName && parseFloat(collect_payment.amount) > 0
    ? parseFloat(collect_payment.amount)
    : 0;

  const { rows: vRows } = await query(
    `SELECT guid, voucher_number, is_optional, date
       FROM vouchers
      WHERE company_id = $1
        AND COALESCE(is_cancelled, FALSE) = FALSE
        AND (
          ($2 <> '' AND guid = $2)
          OR reference = $3
          OR ($4 <> '' AND voucher_number = $4)
        )
      ORDER BY CASE WHEN COALESCE(is_optional, FALSE) THEN 0 ELSE 1 END,
               synced_at DESC NULLS LAST
      LIMIT 1`,
    [req.company?.id, av.tally_guid || '', tdkRef, av.tally_voucher_no || '']
  ).catch(() => ({ rows: [] }));
  const { rows: wqRows } = await query(
    `SELECT tally_id FROM write_queue WHERE id=$1`,
    [av.write_queue_id]
  ).catch(() => ({ rows: [] }));

  const rawMaster = wqRowsEarly[0]?.tally_id || wqRows[0]?.tally_id || '';
  let masterId = (rawMaster && String(rawMaster) !== '0') ? String(rawMaster) : '';
  const guid = vRows[0]?.guid || av.tally_guid || '';
  if (!masterId && guid) masterId = tallyMasterIdFromVoucherGuid(companyGuid, guid);
  const voucherNumber = av.tally_voucher_no || vRows[0]?.voucher_number || p.voucherNumber || '';
  // Identity date must be the Tally voucher date (probe failed conceptually on 20260817 vs 18).
  const dt = tallyDate(vRows[0]?.date || av.voucher_date || p.date);
  if (!masterId || !dt) {
    return res.status(409).json({
      status: false,
      message: 'Wait until this Proforma is fully synced from Tally, then convert.',
    });
  }

  const includeItems = sendItems || (!alreadyConverted && items.length > 0);
  let extraInnerXml = '';
  if (includeItems) {
    extraInnerXml += buildSalesVoucherLinesXml({
      partyLedger,
      partyAmt: amt,
      tdkRef,
      items,
      taxes,
      logistics,
      againstOrderNo: p.againstOrderNo || '',
    });
  }
  if (hasDispatch) extraInnerXml += (extraInnerXml ? '\n' : '') + buildDispatchXml(p.dispatch_details, dt);

  const xml = buildMinimalVoucherAlterXml({
    companyName: companyName || p.companyName,
    vchType,
    dt,
    masterId,
    tagName: 'MASTER ID',
    narration: hasNarration ? String(p.narration).trim() : undefined,
    isOptional: false,
    extraInnerXml,
  });

  const queueId = await logWriteQueue(
    req.user.userId, req.company?.id, 'proforma_convert',
    `${partyLedger} (convert to invoice)`, amt, { ...p, convert: true, tdkRef }, xml
  ).catch(() => null);

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    const createdCount = Number(result?.created || 0);
    const alteredCount = Number(result?.altered || 0);
    const resultId = String(result?.tallyId || '').trim();
    const createdInstead = createdCount > 0 && alteredCount === 0;
    const wrongVoucher = resultId && resultId !== '0' && resultId !== String(masterId);
    // Detect Create-instead-of-Alter. Do NOT auto-cancel.
    if (result && result.status !== 'desktop_offline' && result.status !== false
        && (createdInstead || wrongVoucher)) {
      const dupMsg = 'Tally created a new Sales voucher instead of converting this Proforma. Cancel any extra invoice in Tally manually. Do not retry convert on this Proforma.';
      await updateWriteQueue(queueId, { status: false, message: dupMsg, created: createdCount, altered: alteredCount }, null);
      return res.status(409).json({ status: false, message: dupMsg, created: createdCount, altered: alteredCount });
    }
    await updateWriteQueue(queueId, result, null);
    const offline = result?.status === 'desktop_offline';
    if (!offline && result?.status !== false) {
      await query(
        `UPDATE app_vouchers
            SET current_entry_type  = 'regular',
                books_impact_status = 'posted',
                conversion_status   = 'converted',
                tally_sync_status   = 'synced',
                tally_voucher_no    = COALESCE($2, tally_voucher_no),
                party_name          = COALESCE($3, party_name),
                total_amount        = COALESCE($4, total_amount),
                voucher_date        = COALESCE($5, voucher_date),
                payload             = $6,
                updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
          WHERE id = $1`,
        [
          av.id,
          result?.voucherNumber || av.tally_voucher_no || null,
          partyLedger || null,
          amt,
          p.date ? new Date(p.date) : null,
          JSON.stringify(p),
        ]
      );
      await persistVoucherLineTaxes(query, {
        companyGuid,
        tdkReferenceNo: tdkRef,
        items,
        taxes,
        logistics,
      }).catch(e => console.warn('[voucher_line_taxes] proforma convert persist failed:', e.message));

      let receiptResult = null;
      if (!alreadyConverted && collect_payment?.ledgerName && payAmt > 0 && av.invoice_uuid) {
        try {
          receiptResult = await createReceiptForInvoice({
            companyGuid, companyName: companyName || p.companyName, userId: req.user.userId,
            date: p.date, partyLedger, bankLedger: collect_payment.ledgerName, amount: payAmt,
            parentInvoiceUuid: av.invoice_uuid, parentTdkRef: tdkRef,
            isOptional: false, reference: p.reference,
            paymentMethod: collect_payment.mode || '',
            instrument: collect_payment.instrument || (collect_payment.reference
              ? { instrumentNo: collect_payment.reference }
              : null),
            req, res,
          });
          if (receiptResult?.insufficientCredits) return;
        } catch (rcpErr) {
          console.error(`[receipt-pair] Proforma convert receipt failed for ${tdkRef}:`, rcpErr.message);
          receiptResult = { ok: false, error: rcpErr.message };
        }
      }

      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName: companyName || p.companyName,
          tdkRef,
          tallyIds: [result?.tallyId, wqRows[0]?.tally_id, receiptResult?.tallyId],
          extra: { reason: 'proforma_converted', rcpTdkRef: receiptResult?.tdkRef || null },
        });
      });
    }
    res.json({
      status: true,
      queued: offline,
      queueId,
      tdkReferenceNo: tdkRef,
      invoiceUuid: av.invoice_uuid || null,
      invoiceNumber: result?.voucherNumber || av.tally_voucher_no || null,
      numberingPolicy: av.numbering_policy || 'tally_prime_series',
      message: offline
        ? 'Convert queued. Will push when desktop connects.'
        : 'Proforma converted to Sales Invoice',
      data: result,
    });
  } catch (e) {
    await updateWriteQueue(queueId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/payment ───────────────────────────────────────────────
// 2026-07-13 rewrite: Receipt parity — multi-bill allocation, instrument details,
// numbering policy, app_vouchers, preview/share flow. Cash/Bank leg ISPARTYLEDGER=Yes (Tally export parity).
router.post('/voucher/payment', authMiddleware, requireTallyWriteAccess('/voucher/payment'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    { kind: 'ledger', value: cashOrBankLedger },
  ], { workspaceId: req.company?.workspaceId })) return;

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  const dt = tallyDate(date);

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'PAY', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PAY', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'payment', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let paymentUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'payment' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'payment',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, partyLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[payment-app_voucher] insert failed:', e.message); return { rows: [] }; });
    paymentUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
router.post('/voucher/receipt', authMiddleware, requireTallyWriteAccess('/voucher/receipt'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    { kind: 'ledger', value: cashOrBankLedger },
  ], { workspaceId: req.company?.workspaceId })) return;

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  const dt = tallyDate(date);

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'RCP', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'RCP', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'receipt', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let receiptUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'receipt' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'receipt',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, partyLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[receipt-app_voucher] insert failed:', e.message); return { rows: [] }; });
    receiptUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    // Prefer live ack number; else read what updateWriteQueue may have backfilled onto app_vouchers.
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
router.post('/voucher/journal', authMiddleware, requireTallyWriteAccess('/voucher/journal'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: isPartyDr ? 'party' : undefined, value: drLedger },
    { kind: 'ledger', role: isPartyCr ? 'party' : undefined, value: crLedger },
  ], { workspaceId: req.company?.workspaceId })) return;

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  if (!(amt > 0)) {
    return res.status(400).json({ status: false, message: 'amount must be greater than 0' });
  }
  const dt = tallyDate(date);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'JOR', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'JOR', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'journal', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let journalUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'journal' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'journal',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       drLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[journal-app_voucher] insert failed:', e.message); return { rows: [] }; });
    journalUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
router.post('/voucher/contra', authMiddleware, requireTallyWriteAccess('/voucher/contra'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', value: fromLedger },
    { kind: 'ledger', value: toLedger },
  ], { workspaceId: req.company?.workspaceId })) return;

  const isOptional = (typeof isOptionalLegacy === 'boolean') ? isOptionalLegacy : (entryType === 'optional');
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(amount) || 0;
  if (!(amt > 0)) {
    return res.status(400).json({ status: false, message: 'amount must be greater than 0' });
  }
  const dt = tallyDate(date);
  const esc = (s) => String(s == null ? '' : s).replace(/[<>&"]/g, (c) => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;' }[c]));

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'CON', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'CON', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'contra', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let contraUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'contra' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'contra',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       fromLedger, amt, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[contra-app_voucher] insert failed:', e.message); return { rows: [] }; });
    contraUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    let voucherNumber = result?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
router.post('/voucher/sales-order', authMiddleware, requireTallyWriteAccess('/voucher/sales-order'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'salesLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
  ], { workspaceId: req.company?.workspaceId })) return;

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'SOR', req.company?.id).catch(() => null);

  let tdkOrderNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkOrderNo = await generateTDSeriesNumber(companyGuid, 'SOR', req.company?.id).catch(() => null);
    if (tdkOrderNo) effectiveVoucherNumber = tdkOrderNo;
  }

  // Persist terms in payload for preview/share; narration stays clean for Tally
  const persistPayload = { ...req.body, termsText: termsText || req.body.termsText || '' };

  const soTagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, items);
  const soItems = soTagCtx.withHsn(items);
  const soExtrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply: req.body.placeOfSupply || soTagCtx.partyState,
    partyGstin: soTagCtx.partyGstin,
    referenceDate: req.body.referenceDate || '',
    paymentTerms: req.body.paymentTerms || '',
    termsText: termsText || req.body.termsText || '',
  });

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
${soExtrasXml}
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  for (const item of soItems) {
    const itemAmt = parseFloat(item.amount) || 0;
    const orderNoTag = effectiveVoucherNumber || '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'sales_order', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let orderUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'sales_order' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'sales_order',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, original_entry_type,
       numbering_policy,
       tdkOrderNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[app_vouchers] sales_order insert failed:', e.message); return { rows: [] }; });
    orderUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
router.post('/master/party', authMiddleware, requireTallyWriteAccess('/master/party'), async (req, res) => {
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'party', name, null, req.body, xml, req.company?.id).catch(() => null);
  if (qId) {
    await insertAppMaster({
      companyGuid,
      userId: req.user.userId,
      writeQueueId: qId,
      masterType: 'party',
      masterName: name,
      payload: req.body,
    });
  }
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
         SELECT 1 FROM ledgers WHERE company_id = $1 AND LOWER(name) = LOWER($2)
       )`,
      [req.company?.id, name, parent, gstin || '', pan || '', address || '', state || null, pincode || null, gstRegTypeFinal || null, obAmt, balanceType, isDutiesLedger ? ratePct : 0]
    ).catch((e) => { console.warn('[party-immediate-insert]', e.message); }); // fire-and-forget, don't block response

    // Masters need LedgerFull pull (not SingleVoucher) — empty tallyIds forces full post-write sync.
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef: null,
          tallyIds: [],
          extra: { reason: 'master_created', masterType: 'party', masterName: name },
        });
      });
    }

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


// POST /tally/master/warehouse - Create Godown/Warehouse in Tally
router.post('/master/warehouse', authMiddleware, requireTallyWriteAccess('/master/warehouse'), async (req, res) => {
  const { companyGuid, companyName, name, parentGodown = '', address = '' } = req.body;
  if (!companyGuid || !name) return res.status(400).json({ status: false, message: 'companyGuid and name required' });
  const addressXml = address ? `<ADDRESS.LIST TYPE="String"><ADDRESS>${address}</ADDRESS></ADDRESS.LIST>` : '';
  // Skip <PARENT> if empty or 'Primary' — Tally auto-assigns to root. Sending 'Primary' causes
  // "Godown does not exist" error if the user's Tally doesn't have a godown named 'Primary'.
  const effectiveParent = (parentGodown && parentGodown.toLowerCase() !== 'primary') ? parentGodown : '';
  const parentXml = effectiveParent ? `<PARENT>${effectiveParent}</PARENT>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><GODOWN NAME="${name}" ACTION="Create"><NAME>${name}</NAME>${parentXml}${addressXml}</GODOWN></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'warehouse', name, null, req.body, xml, req.company?.id).catch(() => null);
  if (qId) {
    await insertAppMaster({
      companyGuid,
      userId: req.user.userId,
      writeQueueId: qId,
      masterType: 'warehouse',
      masterName: name,
      payload: req.body,
    });
  }
  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef: null,
          tallyIds: [],
          extra: { reason: 'master_created', masterType: 'warehouse', masterName: name },
        });
      });
    }
    res.json({ status: true, queued: offline, queueId: qId, message: offline ? 'Saved. Will push when desktop connects.' : 'Warehouse created in Tally', data: result, voucherNumber: result?.voucherNumber || null, tallyId: result?.tallyId || null });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});


// POST /tally/voucher/purchase-order
// Mirrors Sales Order with purchase signs (party Cr +, inventory/tax Dr −).
// TDK ref prefix POR; ORDERNO/ORDERDUEDATE on batches (desktop CreatePurchaseOrder.xml).
router.post('/voucher/purchase-order', authMiddleware, requireTallyWriteAccess('/voucher/purchase-order'), async (req, res) => {
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

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'POR', req.company?.id).catch(() => null);

  let tdkOrderNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkOrderNo = await generateTDSeriesNumber(companyGuid, 'POR', req.company?.id).catch(() => null);
    if (tdkOrderNo) effectiveVoucherNumber = tdkOrderNo;
  }

  const persistPayload = { ...req.body, tdkRef, termsText: termsText || req.body.termsText || '', voucherType: 'Purchase Order' };

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'purchaseLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
  ], { workspaceId: req.company?.workspaceId })) return;

  const poTagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, items);
  const poItems = poTagCtx.withHsn(items);
  const poExtrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply: req.body.placeOfSupply || poTagCtx.partyState,
    partyGstin: poTagCtx.partyGstin,
    referenceDate: req.body.referenceDate || '',
    paymentTerms: req.body.paymentTerms || '',
    termsText: termsText || req.body.termsText || '',
  });

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Purchase Order" ACTION="Create">
  <VOUCHERTYPENAME>Purchase Order</VOUCHERTYPENAME>
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
${poExtrasXml}
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  for (const item of poItems) {
    const itemAmt = parseFloat(item.amount) || 0;
    const qty = item.actualQty || item.billedQty || 1;
    const billed = item.billedQty || qty;
    const orderNoTag = effectiveVoucherNumber || '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
    <AMOUNT>${-itemAmt}</AMOUNT>
    <ACTUALQTY>${qty}</ACTUALQTY>
    <BILLEDQTY>${billed}</BILLEDQTY>
    <RATE>${item.rate || 0}</RATE>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${item.purchaseLedger || 'Purchase Account GST'}</LEDGERNAME>
      <AMOUNT>${-itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
      ${orderNoTag ? `<ORDERNO>${orderNoTag}</ORDERNO>` : '<ORDERNO/>'}
      <ORDERDUEDATE>${dueDt}</ORDERDUEDATE>
      <AMOUNT>${-itemAmt}</AMOUNT>
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

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const label = `${partyLedger}${effectiveVoucherNumber ? ' #' + effectiveVoucherNumber : ''}`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'purchase_order', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let orderUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'purchase_order' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'purchase_order',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, original_entry_type || (isOptional ? 'optional' : 'regular'),
       numbering_policy,
       tdkOrderNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[app_vouchers] purchase_order insert failed:', e.message); return { rows: [] }; });
    orderUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
      message: offline ? 'Saved. Will push when desktop connects.' : 'Purchase order created',
      data: result,
      tdkReferenceNo: tdkRef,
      voucherNumber: tdkOrderNo || result?.voucherNumber || null,
      tallyId: result?.tallyId || null,
      invoiceUuid: orderUuid,
      numberingPolicy: numbering_policy,
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

// POST /tally/voucher/purchase
// Mirrors Sales create signs flipped for purchase (party Cr +, inventory/tax Dr −).
// Reference: TallyPrime Purchase export — VCHTYPE Purchase, Item Invoice, BILLALLOCATIONS New Ref.
router.post('/voucher/purchase', authMiddleware, requireTallyWriteAccess('/voucher/purchase'), async (req, res) => {
  const {
    companyGuid, companyName, date, voucherNumber, reference, narration,
    partyLedger, totalAmount, items = [], taxes = [], logistics = [],
    isOptional = false,
    voucherType = 'Purchase',
    make_payment = null,
    numbering_policy = 'tally_prime_series',
    original_entry_type = 'regular',
    againstOrderNo = null,
    dispatch_details = null,
    placeOfSupply = null,
    referenceDate = null,
    paymentTerms = null,
    termsText = null,
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

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'PUR', req.company?.id).catch(() => null);
  // Keep narration user/business-friendly (no TDK ids). Identity = REFERENCE + bill New Ref.
  // LOCKED DECISIONS 2026-07-16: FORBIDDEN stuffing TDK into narration as primary identity.
  const fullNarration = narration || '';

  let tdkInvoiceNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkInvoiceNo = await generateTDSeriesNumber(companyGuid, 'PUR', req.company?.id).catch(() => null);
    if (tdkInvoiceNo) effectiveVoucherNumber = tdkInvoiceNo;
  }

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'purchaseLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
    { kind: 'ledger', value: make_payment?.ledgerName },
  ], { workspaceId: req.company?.workspaceId })) return;

  const tagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, items);
  const itemsWithHsn = tagCtx.withHsn(items);
  const headerExtrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply: placeOfSupply || dispatch_details?.dispatch_from_state || tagCtx.partyState,
    partyGstin: tagCtx.partyGstin,
    referenceDate: referenceDate || null,
    paymentTerms: paymentTerms || '',
    termsText: termsText || '',
  });
  const purchaseDispatchXml = buildDispatchXml(dispatch_details, date);

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
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
${[headerExtrasXml, purchaseDispatchXml].filter(Boolean).join('\n')}

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

  for (const item of itemsWithHsn) {
    const ia = parseFloat(item.amount) || 0;
    const qty = item.actualQty || item.billedQty || 1;
    const billed = item.billedQty || qty;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
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
      ${againstOrderNo ? `<ORDERNO>${againstOrderNo}</ORDERNO>` : '<ORDERNO/>'}
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

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const persistPayload = { ...req.body, tdkRef, make_payment, narration: fullNarration, voucherType: vchType, againstOrderNo: againstOrderNo || null };
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'purchase', partyLedger, amt, persistPayload, xml, req.company?.id).catch(() => null);

  let invoiceUuid = null;
  let invoiceCreatedAt = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'purchase_invoice' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'purchase_invoice',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid, created_at`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : (original_entry_type || 'regular'),
       numbering_policy || 'tally_prime_series',
       tdkInvoiceNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[purchase-app_voucher] insert failed:', e.message); return { rows: [] }; });
    invoiceUuid = avResult?.rows?.[0]?.invoice_uuid || null;
    invoiceCreatedAt = avResult?.rows?.[0]?.created_at || null;
  }

  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
          paymentMethod: make_payment.mode || '',
          instrument: make_payment.instrument || (make_payment.reference
            ? { instrumentNo: make_payment.reference }
            : null),
          parentCreatedAt: invoiceCreatedAt,
          req, res,
        });
        if (paymentResult?.insufficientCredits) return;
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
  placeOfSupply = '',
  partyGstin = '',
  referenceDate = '',
  paymentTerms = '',
  termsText = '',
  dispatch_details = null,
}) {
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';
  const extrasXml = [
    buildVoucherHeaderExtrasXml({ placeOfSupply, partyGstin, referenceDate, paymentTerms, termsText }),
    buildDispatchXml(dispatch_details, date),
  ].filter(Boolean).join('\n');

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
  <PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>${extrasXml ? `\n${extrasXml}` : ''}`;

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
    <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
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
router.post('/voucher/credit-note', authMiddleware, requireTallyWriteAccess('/voucher/credit-note'), async (req, res) => {
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
    dispatch_details = null,
    placeOfSupply = null,
    referenceDate = null,
    paymentTerms = null,
    termsText = null,
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
    // ── Ownership (workspace lineage — middleware already gated access) ───────
    const { rows: coRows } = await query(
      'SELECT guid, name FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1',
      [req.company?.id, req.workspaceId]
    );
    if (!coRows[0]) return bad('Company not found or access denied', 403);
    const resolvedCompanyName = companyName || coRows[0].name;

    // ── Linked Sales invoice + cumulative return context ─────────────────────
    const resolved = await resolveCreditNoteContext(req.company?.id, invoiceRef);
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
    const tdkRef = await generateTDKReference(companyGuid, isOptional, 'CN', req.company?.id).catch(() => null);
    // Tally series → blank VOUCHERNUMBER, Tally assigns it and syncs it back.
    let tdkCreditNoteNo = null;
    let effectiveVoucherNumber = '';
    if (numbering_policy === 'tallydekho_series' && !isOptional) {
      tdkCreditNoteNo = await generateTDSeriesNumber(companyGuid, 'CN', req.company?.id).catch(() => null);
      if (tdkCreditNoteNo) effectiveVoucherNumber = tdkCreditNoteNo;
    }

    const cnTagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, normItems);
    const xml = buildCreditNoteXml({
      companyName: resolvedCompanyName,
      date,
      voucherNumber: effectiveVoucherNumber,
      reference: tdkRef || reference || '',
      narration: narration || '',
      partyLedger,
      isOptional,
      items: cnTagCtx.withHsn(normItems),
      taxes: normTaxes,
      billRefName,
      partyAmount: amt,
      placeOfSupply: placeOfSupply || cnTagCtx.partyState,
      partyGstin: cnTagCtx.partyGstin,
      referenceDate: referenceDate || context.linkedInvoice.date || '',
      paymentTerms: paymentTerms || '',
      termsText: termsText || '',
      dispatch_details,
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
    qId = await logWriteQueue(req.user.userId, companyGuid, 'credit_note', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

    if (qId && tdkRef) {
      if (!(await chargeWorkspaceService(req, res, {
        serviceKey: 'TALLY_WRITE',
        operationId: tdkRef,
        meta: { voucherType: 'credit_note' },
      }))) return;
      const avResult = await query(
        `INSERT INTO app_vouchers
         (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
          tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
          party_name, total_amount, voucher_date, payload)
         VALUES ($1,$2,$3,$4,'credit_note',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
         RETURNING invoice_uuid`,
        [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, entryType,
         numbering_policy,
         tdkCreditNoteNo || null,
         partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
      ).catch(e => { console.error('[app_vouchers] credit_note insert failed:', e.message); return { rows: [] }; });
      creditNoteUuid = avResult?.rows?.[0]?.invoice_uuid || null;
    }

    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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

// ── Debit Note (Purchase Return) XML builder ─────────────────────────────────
// Mirror of Credit Note with flipped signs (CreateDebitNote.xml / Purchase pattern):
//   party leg       → negative, ISDEEMEDPOSITIVE Yes (Dr vendor)
//   inventory + tax → positive, ISDEEMEDPOSITIVE No  (Cr purchase / tax)
// GST nature: 02-Purchase Return. Prefix DBN (not DN — Delivery Note).
export function buildDebitNoteXml({
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
  placeOfSupply = '',
  partyGstin = '',
  referenceDate = '',
  paymentTerms = '',
  termsText = '',
}) {
  const dt = tallyDate(date);
  const isOpt = isOptional ? 'Yes' : 'No';
  const partyAmt = -Math.abs(partyAmount);
  const extrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply, partyGstin, referenceDate, paymentTerms, termsText,
  });

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER VCHTYPE="Debit Note" ACTION="Create" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>Debit Note</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${escapeXml(voucherNumber)}</VOUCHERNUMBER>
  <REFERENCE>${escapeXml(reference)}</REFERENCE>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <GSTNATUREOFRETURN>02-Purchase Return</GSTNATUREOFRETURN>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <NARRATION>${escapeXml(narration)}</NARRATION>
  <PARTYNAME>${escapeXml(partyLedger)}</PARTYNAME>
  <PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>${extrasXml ? `\n${extrasXml}` : ''}`;

  for (const item of items) {
    const qty = item.qty;
    const amount = item.amount;
    const rawRate = item.rate ?? 0;
    const rateXml = String(rawRate).includes('/')
      ? String(rawRate)
      : `${rawRate}${item.unit ? `/${item.unit}` : ''}`;
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <RATE>${escapeXml(rateXml)}</RATE>
    <AMOUNT>${amount}</AMOUNT>
    <ACTUALQTY>${qty}</ACTUALQTY>
    <BILLEDQTY>${qty}</BILLEDQTY>
    <BATCHALLOCATIONS.LIST>
      <GODOWNNAME>${escapeXml(item.godown || 'Main Location')}</GODOWNNAME>
      <BATCHNAME>${escapeXml(item.batch || 'Primary Batch')}</BATCHNAME>
      <AMOUNT>${amount}</AMOUNT>
      <ACTUALQTY>${qty}</ACTUALQTY>
      <BILLEDQTY>${qty}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <ISPARTYLEDGER>No</ISPARTYLEDGER>
      <LEDGERNAME>${escapeXml(item.purchaseLedger)}</LEDGERNAME>
      <AMOUNT>${amount}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(partyLedger)}</LEDGERNAME>
    <AMOUNT>${partyAmt}</AMOUNT>
    <BILLALLOCATIONS.LIST>
      <NAME>${escapeXml(billRefName)}</NAME>
      <BILLTYPE>Agst Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${partyAmt}</AMOUNT>
    </BILLALLOCATIONS.LIST>
  </LEDGERENTRIES.LIST>`;

  for (const tax of taxes) {
    if (!tax.ledgerName || !(tax.taxAmount > 0)) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <ISPARTYLEDGER>No</ISPARTYLEDGER>
    <LEDGERNAME>${escapeXml(tax.ledgerName)}</LEDGERNAME>
    <AMOUNT>${tax.taxAmount}</AMOUNT>
    <VATASSESSABLEVALUE>${tax.taxableValue}</VATASSESSABLEVALUE>
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
 * Validate + normalise a Debit Note request against the linked Purchase invoice.
 * Reuses calcCreditNoteReturn (ledger-agnostic GST reverse math).
 */
export function prepareDebitNoteLines({ items = [], taxes = [], context, invoice }) {
  const invoiceLabel = invoice?.voucher_number || context?.linkedInvoice?.voucherNumber || 'the linked invoice';
  const itemIndex = new Map(context.items.map(i => [normalizeName(i.itemName), i]));
  const invoicePurchaseKeys = new Set(context.invoicePurchaseLedgers.map(l => normalizeName(l.ledgerName)));
  const companyPurchaseKeys = new Set(context.companyPurchaseLedgers.map(l => normalizeName(l.ledgerName)));
  const fallbackPurchaseLedger = context.defaultPurchaseLedger;

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

    const purchaseLedger = String(
      raw.purchaseLedger || raw.returnLedger || raw.salesLedger || fallbackPurchaseLedger || ''
    ).trim();
    if (!purchaseLedger) {
      return { error: `purchaseLedger required for "${ctxItem.itemName}" — could not resolve the Purchase ledger from invoice ${invoiceLabel}` };
    }
    const allowed = invoicePurchaseKeys.size ? invoicePurchaseKeys : companyPurchaseKeys;
    if (!allowed.has(normalizeName(purchaseLedger))) {
      return {
        error: invoicePurchaseKeys.size
          ? `"${purchaseLedger}" is not a Purchase ledger used on invoice ${invoiceLabel}`
          : `"${purchaseLedger}" is not a Purchase Accounts ledger for this company`,
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
      purchaseLedger,
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
      purchaseLedger: meta.purchaseLedger,
      hsn: item.hsn || '',
      soldQty: itemIndex.get(normalizeName(item.itemName))?.soldQty,
      remainingQtyBefore: itemIndex.get(normalizeName(item.itemName))?.remainingQty,
    };
  });

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
    summary: {
      ...calc.summary,
      totalVendorDebit: calc.totalAmount,
    },
  };
}

// ── POST /tally/voucher/debit-note ────────────────────────────────────────────
// Purchase Return only, always linked to a Purchase invoice. Prefix DBN (not DN).
router.post('/voucher/debit-note', authMiddleware, requireTallyWriteAccess('/voucher/debit-note'), async (req, res) => {
  const {
    companyGuid, companyName, date, narration,
    partyLedger, totalAmount,
    items = [],
    taxes = [],
    isOptional = false,
    original_entry_type,
    numbering_policy = 'tally_prime_series',
    linked_invoice = null,
    reference,
  } = req.body;

  const bad = (message, code = 400) => res.status(code).json({ status: false, message });

  if (!companyGuid) return bad('companyGuid required');
  if (!partyLedger) return bad('partyLedger required');
  if (!Array.isArray(items) || items.length === 0) return bad('items required');
  if (!linked_invoice || typeof linked_invoice !== 'object') {
    return bad('linked_invoice required — a Purchase Return must be raised against a Purchase invoice');
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
  let debitNoteUuid = null;
  try {
    const { rows: coRows } = await query(
      'SELECT guid, name FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1',
      [req.company?.id, req.workspaceId]
    );
    if (!coRows[0]) return bad('Company not found or access denied', 403);
    const resolvedCompanyName = companyName || coRows[0].name;

    const resolved = await resolveDebitNoteContext(req.company?.id, invoiceRef);
    if (!resolved.ok) return bad(resolved.message, resolved.status);
    const { invoice, context } = resolved;

    if (normalizeName(partyLedger) !== normalizeName(invoice.party_name)) {
      return bad(`partyLedger "${partyLedger}" does not match invoice ${invoice.voucher_number} party "${invoice.party_name}"`);
    }

    const prepared = prepareDebitNoteLines({ items, taxes, context, invoice });
    if (prepared.error) return bad(prepared.error);
    const { items: normItems, taxes: normTaxes, itemsTotal, taxTotal } = prepared;
    const amt = prepared.totalAmount;
    const clientTotal = (totalAmount === undefined || totalAmount === null || totalAmount === '')
      ? null : r2(totalAmount);
    const totalAdjusted = clientTotal !== null && Math.abs(clientTotal - amt) > 0.05;

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

    // DBN — must not collide with Delivery Note DN
    const tdkRef = await generateTDKReference(companyGuid, isOptional, 'DBN', req.company?.id).catch(() => null);
    let tdkDebitNoteNo = null;
    let effectiveVoucherNumber = '';
    if (numbering_policy === 'tallydekho_series' && !isOptional) {
      tdkDebitNoteNo = await generateTDSeriesNumber(companyGuid, 'DBN', req.company?.id).catch(() => null);
      if (tdkDebitNoteNo) effectiveVoucherNumber = tdkDebitNoteNo;
    }

    const dnTagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, normItems);
    const xml = buildDebitNoteXml({
      companyName: resolvedCompanyName,
      date,
      voucherNumber: effectiveVoucherNumber,
      reference: tdkRef || reference || '',
      narration: narration || '',
      partyLedger,
      isOptional,
      items: dnTagCtx.withHsn(normItems),
      taxes: normTaxes,
      billRefName,
      partyAmount: amt,
      placeOfSupply: req.body.placeOfSupply || dnTagCtx.partyState,
      partyGstin: dnTagCtx.partyGstin,
      referenceDate: req.body.referenceDate || context.linkedInvoice.date || '',
      paymentTerms: req.body.paymentTerms || '',
      termsText: req.body.termsText || '',
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
      natureOfReturn: '02-Purchase Return',
      linked_invoice: linkedInvoicePayload,
      tdkRef,
    };

    const label = `${partyLedger} ← return vs ${invoice.voucher_number || billRefName}`;
    qId = await logWriteQueue(req.user.userId, companyGuid, 'debit_note', label, amt, persistPayload, xml, req.company?.id).catch(() => null);

    if (qId && tdkRef) {
      if (!(await chargeWorkspaceService(req, res, {
        serviceKey: 'TALLY_WRITE',
        operationId: tdkRef,
        meta: { voucherType: 'debit_note' },
      }))) return;
      const avResult = await query(
        `INSERT INTO app_vouchers
         (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
          tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
          party_name, total_amount, voucher_date, payload)
         VALUES ($1,$2,$3,$4,'debit_note',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
         RETURNING invoice_uuid`,
        [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, entryType,
         numbering_policy,
         tdkDebitNoteNo || null,
         partyLedger, amt, date ? new Date(date) : null, JSON.stringify(persistPayload)]
      ).catch(e => { console.error('[app_vouchers] debit_note insert failed:', e.message); return { rows: [] }; });
      debitNoteUuid = avResult?.rows?.[0]?.invoice_uuid || null;
    }

    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, result, null);
    const offline = result?.status === 'desktop_offline';

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
      invoiceUuid: debitNoteUuid,
      debitNoteNumber: tdkDebitNoteNo || result?.voucherNumber || null,
      voucherNumber: tdkDebitNoteNo || result?.voucherNumber || null,
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
        : (isOptional ? 'Optional debit note saved' : 'Debit note created'),
      data: result,
      tallyId: result?.tallyId || null,
    });
  } catch (e) {
    await updateWriteQueue(qId, null, e.message).catch(() => {});
    if (debitNoteUuid) {
      await query(
        `UPDATE app_vouchers SET tally_sync_status='failed', books_impact_status='not_posted',
             sync_error=$2, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
           WHERE invoice_uuid=$1`,
        [debitNoteUuid, String(e.message).slice(0, 500)]
      ).catch(() => {});
    }
    console.error('[voucher/debit-note]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/voucher/delivery-note ─────────────────────────────────────────
// 2026-07-29 rewrite: payload aligned with the Sales / Sales Order contract (TDK
// reference, TallyDekho series numbering, app_vouchers lifecycle row, offline queue)
// and XML aligned with a real TallyPrime Delivery Note export — Invoice Voucher View,
// ISINVOICE No, DIFFACTUALQTY Yes, BASICSHIP* dispatch tags, INVOICEORDERLIST.LIST.
router.post('/voucher/delivery-note', authMiddleware, requireTallyWriteAccess('/voucher/delivery-note'), async (req, res) => {
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

  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'ledger', role: 'party', value: partyLedger },
    ...collectLineReferences(items, { ledgerField: 'salesLedger' }),
    ...collectLedgerNameReferences(taxes),
    ...collectLedgerNameReferences(logistics),
  ], { workspaceId: req.company?.workspaceId })) return;

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

  // Delivery Note builds its own BASICSHIP* tags above, so only the e-Way Bill
  // block is borrowed from the shared dispatch builder.
  const dnEwbXml = buildDispatchXml(dispatch_details, date, { ewbOnly: true });
  const dnTagCtx = await loadVoucherTagContext(req.company?.id, partyLedger, items);
  const dnItems = dnTagCtx.withHsn(items);
  const dnExtrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply: req.body.placeOfSupply || dispatch_details?.ship_to_state || dnTagCtx.partyState,
    partyGstin: dnTagCtx.partyGstin,
    referenceDate: req.body.referenceDate || linked_order?.order_date || '',
  });

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'DN', req.company?.id).catch(() => null);

  // TallyDekho Series: we own the sequence, so the number is final immediately.
  let tdkDeliveryNoteNo = null;
  let effectiveVoucherNumber = voucherNumber || '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkDeliveryNoteNo = await generateTDSeriesNumber(companyGuid, 'DN', req.company?.id).catch(() => null);
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
${[dispatchXml, dnExtrasXml, dnEwbXml].filter(Boolean).join('\n')}
  <PARTYLEDGERNAME>${escapeXml(partyLedger)}</PARTYLEDGERNAME>

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${escapeXml(partyLedger)}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;

  for (const item of dnItems) {
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
    <STOCKITEMNAME>${escapeXml(item.itemName)}</STOCKITEMNAME>${inventoryHsnDiscountXml(item)}
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'delivery_note', label, amt, req.body, xml, req.company?.id).catch(() => null);

  let deliveryNoteUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'delivery_note' },
    }))) return;
    const avResult = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'delivery_note',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, entryType,
       numbering_policy,
       tdkDeliveryNoteNo || null,
       partyLedger, amt, date ? new Date(date) : null, JSON.stringify(req.body)]
    ).catch(e => { console.error('[app_vouchers] delivery_note insert failed:', e.message); return { rows: [] }; });
    deliveryNoteUuid = avResult?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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

router.post('/voucher/cancel', authMiddleware, requireTallyWriteAccess('/voucher/cancel'), async (req, res) => {
  const { companyGuid, companyName, voucherGuid, voucherType, voucherNumber, date } = req.body;
  if (!companyGuid || !voucherGuid) return res.status(400).json({ status: false, message: 'voucherGuid required' });
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER VCHTYPE="${voucherType}" ACTION="Cancel"><DATE>${tallyDate(date)}</DATE><VOUCHERTYPENAME>${voucherType}</VOUCHERTYPENAME><VOUCHERNUMBER>${voucherNumber||''}</VOUCHERNUMBER><GUID>${voucherGuid}</GUID></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  try { const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id }); res.json({ status: true, message: 'Voucher cancelled in Tally', data: r, voucherNumber: r?.voucherNumber || null, tallyId: r?.tallyId || null }); } catch(e) { res.status(500).json({ status: false, message: e.message }); }
});

router.post('/master/stock-item', authMiddleware, requireTallyWriteAccess('/master/stock-item'), async (req, res) => {
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
  // Emit GST details whenever a rate was supplied, not only when an HSN code is
  // present. The stock-item form sends the chosen tax rate with an empty
  // hsnCode, so gating the whole block on HSN silently discarded the rate: the
  // item reached Tally with no GST configured while the UI reported success.
  // HSNCODE itself stays optional, which is what Tally expects.
  const hasGstRate = igstRate > 0 || cgstRate > 0 || sgstRate > 0;
  const gstXml = (hsnCode || hasGstRate) ? `<GSTAPPLICABLE>${gstAppl}</GSTAPPLICABLE><GSTDETAILS.LIST><APPLICABLEFROM>${_appFrom}</APPLICABLEFROM>${hsnCode ? `<HSNCODE>${hsnCode}</HSNCODE>` : ''}<TAXABILITY>Taxable</TAXABILITY><STATEWISEDETAILS.LIST><STATENAME>Any State</STATENAME><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Integrated Tax</GSTRATEDUTYHEAD><GSTRATE>${igstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>Central Tax</GSTRATEDUTYHEAD><GSTRATE>${cgstRate}</GSTRATE></RATEDETAILS.LIST><RATEDETAILS.LIST><GSTRATEDUTYHEAD>State Tax</GSTRATEDUTYHEAD><GSTRATE>${sgstRate}</GSTRATE></RATEDETAILS.LIST></STATEWISEDETAILS.LIST></GSTDETAILS.LIST>` : '';
  const xml = `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM ACTION="Create"><NAME>${name}</NAME>${parentXml}${category?`<CATEGORY>${category}</CATEGORY>`:''}<BASEUNITS>${unit}</BASEUNITS>${openXml}${gstXml}</STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'item', name, null, req.body, xml, req.company?.id).catch(() => null);
  if (qId) {
    await insertAppMaster({
      companyGuid,
      userId: req.user.userId,
      writeQueueId: qId,
      masterType: 'item',
      masterName: name,
      payload: req.body,
    });
  }
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
      const tdkRef = await generateTDKReference(companyGuid, false, 'PHY', req.company?.id).catch(() => null);
      let tdkVoucherNo = null;
      let effectiveVoucherNumber = '';
      if (numbering_policy === 'tallydekho_series') {
        tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PHY', req.company?.id).catch(() => null);
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
      , req.company?.id).catch(() => null);

      openingQueueId = qId2 || null;

      let adjustmentId = null;
      if (qId2 && tdkRef) {
        if (!(await chargeWorkspaceService(req, res, {
          serviceKey: 'TALLY_WRITE',
          operationId: tdkRef,
          meta: { voucherType: 'stock_adjustment' },
        }))) return;
        const { rows: av } = await query(
          `INSERT INTO app_vouchers
           (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
            tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
            party_name, total_amount, voucher_date, payload)
           VALUES ($1,$2,$3,$4,'stock_adjustment',$5,'regular','regular','queued','not_posted',$6,$7,$8,$9,$10,$11)
           RETURNING invoice_uuid`,
          [companyGuid, req.company?.id ?? null, req.user.userId, qId2, tdkRef,
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
        const r2 = await forwardToTally(companyGuid, req.user.userId, physicalXml, { companyId: req.company?.id });
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
          `SELECT guid FROM stocks WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
          [req.company?.id, name]
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
             WHERE company_id = $1 AND guid = $2`,
            [req.company?.id, stockGuid, effectiveGroup, unit, taxRate, qty, rate, saleRate]
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
            [req.company?.id, name, effectiveGroup, unit, hsnCode || null, taxRate || 0, qty, rate, saleRate]
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
             WHERE stock_guid = $1 AND company_id = $2 AND is_primary = TRUE AND status = 'active'
             LIMIT 1`,
            [stockGuid, req.company?.id]
          );
          if (existingBc?.barcode) {
            barcode = existingBc.barcode;
          } else {
            const { rows: [{ cnt }] } = await query(
              `SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_id = $1`,
              [req.company?.id]
            );
            const slug = String(companyGuid).replace(/[^A-Z0-9]/gi, '').slice(0, 4).toUpperCase().padEnd(4, 'X');
            let tries = 0;
            do {
              barcode = `TDK${slug}${(cnt + tries + 1).toString().padStart(7, '0').slice(-7)}`;
              tries += 1;
              const { rows: [dup] } = await query(
                `SELECT 1 FROM stock_barcodes WHERE company_id = $1 AND barcode = $2`,
                [req.company?.id, barcode]
              );
              if (!dup) break;
            } while (tries < 10);

            const syncTarget = String(barcodeSyncTarget || 'app_only');
            const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
            await query(
              `INSERT INTO stock_barcodes
                 (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
               VALUES ($1,$2,$3,$4,$5,'app_generated','active',TRUE,$6,$7)`,
              [req.company?.id, stockGuid, name, barcode, barcodeType || 'CODE128', syncTarget, tallyStatus]
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

    if (!queued) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName,
          tdkRef: null,
          tallyIds: [],
          extra: { reason: 'master_created', masterType: 'item', masterName: name },
        });
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
router.post('/master/stock-item-alter', authMiddleware, requireTallyWriteAccess('/master/stock-item-alter'), async (req, res) => {
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

  const qId = await logWriteQueue(req.user.userId, companyGuid, 'alter_stock_item', existingName, null, req.body, xml, req.company?.id).catch(() => null);
  if (qId) {
    await insertAppMaster({
      companyGuid,
      userId: req.user.userId,
      writeQueueId: qId,
      masterType: 'alter_stock_item',
      masterName: changes?.name || existingName,
      payload: req.body,
    });
  }
  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
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
router.post('/voucher/stock-transfer', authMiddleware, requireTallyWriteAccess('/voucher/stock-transfer'), async (req, res) => {
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

  // Raw items, not normalizedItems: the normalizer substitutes 'pcs' for a
  // missing unit, and a default this backend chose is not a caller reference.
  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'godown', value: toGodown },
    { kind: 'godown', value: fromGodown },
    ...(items || []).flatMap((it) => [
      { kind: 'stock', value: it?.itemName ?? it?.name },
      { kind: 'godown', value: it?.fromGodown ?? it?.sourceWarehouse },
      { kind: 'unit', value: it?.unit },
    ]),
  ], { workspaceId: req.company?.workspaceId })) return;

  for (const it of normalizedItems) {
    if (!it.itemName) return res.status(400).json({ status: false, message: 'Each item needs itemName' });
    if (!it.fromGodown) return res.status(400).json({ status: false, message: `Source warehouse required for ${it.itemName}` });
    if (it.fromGodown === toGodown) {
      return res.status(400).json({ status: false, message: `Source and destination must differ for ${it.itemName}` });
    }
  }

  const tdkRef = await generateTDKReference(companyGuid, isOptional, 'STJ', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series' && !isOptional) {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'STJ', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_transfer', label, transferValue || null, persistPayload, xml, req.company?.id).catch(() => null);

  let transferUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'stock_transfer' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'stock_transfer',$5,$6,$6,'queued','not_posted',$7,$8,$9,$10,$11,$12)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef, isOptional ? 'optional' : 'regular',
       numbering_policy, tdkVoucherNo || null,
       `${labelFrom} → ${toGodown}`, transferValue || null, date ? new Date(date) : null,
       JSON.stringify(persistPayload)]
    ).catch(e => { console.error('[stock-transfer-app_voucher] insert failed:', e.message); return { rows: [] }; });
    transferUuid = av?.rows?.[0]?.invoice_uuid || null;
  }

  try {
    const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, r, null);
    let voucherNumber = r?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
router.post('/voucher/stock-adjustment', authMiddleware, requireTallyWriteAccess('/voucher/stock-adjustment'), async (req, res) => {
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

  // `unit` carries a destructuring default, so only a unit the body actually
  // sent is a reference worth proving.
  if (!await validateVoucherReferences(res, req.company?.id, [
    { kind: 'stock', value: stockName },
    { kind: 'godown', value: warehouse },
    { kind: 'unit', value: req.body?.unit },
  ], { workspaceId: req.company?.workspaceId })) return;

  const qty     = Math.abs(parseFloat(adjustmentQty));
  const qtyChange = isIncrease ? qty : -qty;
  const qtyAfter  = parseFloat(qtyBefore || 0) + qtyChange;
  const godown    = warehouse || 'Main Location';
  const dt        = tallyDate(date);
  const narration = `${adjustmentReason}${adjustmentDirection ? ' - ' + adjustmentDirection : ''}${note ? ' | ' + note : ''}`;

  const tdkRef = await generateTDKReference(companyGuid, false, 'PHY', req.company?.id).catch(() => null);
  let tdkVoucherNo = null;
  let effectiveVoucherNumber = '';
  if (numbering_policy === 'tallydekho_series') {
    tdkVoucherNo = await generateTDSeriesNumber(companyGuid, 'PHY', req.company?.id).catch(() => null);
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
  const qId = await logWriteQueue(req.user.userId, companyGuid, 'stock_adjustment', label, adjValue || null, persistPayload, xml, req.company?.id).catch(() => null);

  let adjustmentUuid = null;
  if (qId && tdkRef) {
    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'TALLY_WRITE',
      operationId: tdkRef,
      meta: { voucherType: 'stock_adjustment' },
    }))) return;
    const av = await query(
      `INSERT INTO app_vouchers
       (company_guid, company_id, user_id, write_queue_id, voucher_type, tdk_reference_no, original_entry_type, current_entry_type,
        tally_sync_status, books_impact_status, numbering_policy, tally_voucher_no,
        party_name, total_amount, voucher_date, payload)
       VALUES ($1,$2,$3,$4,'stock_adjustment',$5,'regular','regular','queued','not_posted',$6,$7,$8,$9,$10,$11)
       RETURNING invoice_uuid`,
      [companyGuid, req.company?.id ?? null, req.user.userId, qId, tdkRef,
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
    const r = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(qId, r, null);
    // Update adjustment status
    if (adjustmentId) {
      const newStatus = (r?.status === 'desktop_offline' || (r?.message || '').includes('offline')) ? 'QUEUED' : 'PUSHED_TO_TALLY';
      await query(`UPDATE stock_adjustments SET status=$1, tally_voucher_number=$2, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE id=$3`, [newStatus, r?.voucherNumber || null, adjustmentId]).catch(() => {});
    }
    let voucherNumber = r?.voucherNumber || effectiveVoucherNumber || null;
    if (!voucherNumber && tdkRef) {
      const { rows: avFresh } = await query(
        `SELECT tally_voucher_no FROM app_vouchers
          WHERE tdk_reference_no=$1
            AND (
              ($2::bigint IS NOT NULL AND company_id=$2)
              OR ($2::text IS NOT NULL AND company_guid=$2::text)
            )
          LIMIT 1`,
        [tdkRef, req.company?.id]
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
  if (!(await verifyCompanyAccess(req, res, companyGuid))) return;
  try {
    const companyId = req.company.id;
    const conditions = ['company_id = $1', 'user_id = $2'];
    const params = [companyId, req.user.userId];
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
       FROM write_queue WHERE company_id = $1 AND user_id = $2`,
      [companyId, req.user.userId]
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

    const result = await forwardToTally(entry.company_guid, userId, entry.xml, { companyId: entry.company_id });
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

// Phase C: per-workspace debounce map — prevents hammering Tally with retries
const _retryDebounce = new Map(); // workspaceId → lastRunMs
const RETRY_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const RETRY_MAX_PER_RUN  = 25; // cap per startup/reconnect

export async function retryOfflineEntries(workspaceId, companyGuid = null) {
  // A Tally GUID is unique only inside one workspace, so narrowing the retry set
  // by GUID alone could re-push another tenant's queued XML. The workspace is the
  // authority for which Desktop a queued write belongs to; a user id is not, since
  // one user can own several workspaces.
  if (!workspaceId) {
    throw new Error('retryOfflineEntries: workspaceId is required');
  }
  // Debounce: skip if already ran within the last 5 minutes for this workspace
  const debounceKey = workspaceId;
  const lastRun = _retryDebounce.get(debounceKey) || 0;
  if (Date.now() - lastRun < RETRY_DEBOUNCE_MS) {
    console.log(`[write_queue] retryOfflineEntries debounced for ${debounceKey} (last run ${Math.round((Date.now()-lastRun)/1000)}s ago)`);
    return;
  }
  _retryDebounce.set(debounceKey, Date.now());

  try {
    // Prefer workspace binding. companyGuid is an optional extra filter, never the auth key.
    // Only retry 'desktop_offline' and 'failed' entries.
    // Do NOT include 'pending' or 'processing' — those are actively being forwarded
    // and picking them up here would cause duplicate entries in Tally.
    const params = [workspaceId];
    const clauses = [
      `workspace_id = $1`,
      `status IN ('desktop_offline','failed')`,
      `attempt_count < 5`,
      `(lock_expires_at IS NULL OR lock_expires_at < EXTRACT(EPOCH FROM NOW())::BIGINT)`,
    ];
    if (companyGuid) {
      params.push(companyGuid);
      // The GUID only names a company once the workspace has been applied, so it
      // resolves to company_id rather than matching write_queue.company_guid.
      clauses.push(
        `company_id IN (SELECT id FROM companies WHERE guid = $${params.length} AND workspace_id = $1)`
      );
    }
    const { rows } = await query(
      `SELECT * FROM write_queue WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC LIMIT ${RETRY_MAX_PER_RUN}`,
      params
    );
    if (!rows.length) return;
    console.log(`[write_queue] auto-retry: ${rows.length} entries for workspace ${workspaceId}`);
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
          // Already posted to Tally without re-running the Sales/Purchase route —
          // still owe a paired Receipt/Payment if Collect/Make Payment Now was set.
          const pairedEarly = await ensurePairedVoucherForQueueEntry(entry.id, userId);
          await requestSyncAfterDeferredWrite(entry.id, userId, {
            tallyIds: [entry.tally_id, pairedEarly?.tallyId],
            reason: 'retry_already_numbered',
            rcpTdkRef: pairedEarly?.tdkRef || null,
          });
          continue;
        }
        const result = await forwardToTally(entry.company_guid, userId, entry.xml, { companyId: entry.company_id });
        await updateWriteQueue(entry.id, result, null);
        // This retry re-pushes stored XML only, so a Sales/Purchase with Collect/Make
        // Payment Now would otherwise post without its paired Receipt/Payment.
        // updateWriteQueue owns the success verdict — read it back rather than re-deriving.
        const { rows: settled } = await query(`SELECT status, tally_id FROM write_queue WHERE id=$1`, [entry.id]);
        if (settled[0]?.status === 'success') {
          const paired = await ensurePairedVoucherForQueueEntry(entry.id, userId);
          // Live Sales/Purchase routes request a post-write sync so tally_voucher_no
          // lands; retry used to skip that, leaving numbers blank (e.g. TDK-SAL-2026-0052).
          await requestSyncAfterDeferredWrite(entry.id, userId, {
            tallyIds: [settled[0].tally_id, result?.tallyId, paired?.tallyId],
            reason: 'retry_posted',
            rcpTdkRef: paired?.tdkRef || null,
          });
        }
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
             FROM write_queue WHERE user_id = $1 AND company_id = $2`;
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
// Bank Feeds / Settings → create Bank Accounts (or OD) ledger in Tally.
//
// Forensic map (2026-09-09) — form field → Tally Bank Account Details:
//   accountNumber → $BankAccountDetails[1].AccountNumber  (+ legacy $BankDetails)
//   ifsc          → $IFSCode AND $BankAccountDetails[1].IFSCCode  (flat IFSCODE alone worked)
//   bankName      → ledger <NAME> AND $BankAccountDetails[1].BankName
//   branch        → $BankBranchName  (ledger-level BANKBRANCHNAME — NOT inside the LIST)
//   accountType   → PARENT: Bank Accounts | Bank OD A/c  (+ DESCRIPTION so SAVING/CURRENT
//                   is not silently discarded — Tally has no SAVING/CURRENT UI field here)
//   companyName   → $BankAccHolderName (A/c Holder’s Name)
//
// Wrong old tag <BANKACNO> alone does NOT fill A/c No. Branch was never even in the XML.
router.post('/master/bank', authMiddleware, requireTallyWriteAccess('/master/bank'), async (req, res) => {
  const {
    companyGuid, companyName,
    bankName, accountNumber, ifsc, accountType, openingBalance, branch,
    ledgerName: bodyLedgerName,
    accountHolderName,
  } = req.body;
  if (!companyGuid || !bankName)
    return res.status(400).json({ status: false, message: 'companyGuid and bankName required' });

  const institutionName = String(bankName).trim();
  // Optional separate ledger name; default = bank name (Bank Feeds form has one field).
  const ledgerName = String(bodyLedgerName || institutionName).trim();
  const accNo = String(accountNumber || '').trim();
  const ifscCode = String(ifsc || '').trim().toUpperCase();
  const branchName = String(branch || '').trim();
  const holderName = String(accountHolderName || companyName || '').trim();
  const typeRaw = String(accountType || 'SAVING').trim().toUpperCase();
  const parentGroup = (typeRaw === 'OD' || typeRaw === 'CC')
    ? 'Bank OD A/c'
    : 'Bank Accounts';
  const openBal = parseFloat(openingBalance) || 0;
  const openBalXml = openBal !== 0
    ? (openBal > 0
      ? `${openBal.toFixed(2)} Dr`
      : `${Math.abs(openBal).toFixed(2)} Cr`)
    : '0';

  // Prefer Alter when ledger already exists locally (re-save / fix empty A/c after partial create).
  let tallyAction = 'Create';
  try {
    const { rows: existingRows } = await query(
      `SELECT 1 FROM ledgers WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
      [req.company?.id, ledgerName]
    );
    if (existingRows.length) tallyAction = 'Alter';
  } catch { /* Create */ }

  // Type label kept on the ledger so SAVING/CURRENT is not lost (Tally UI has no such field).
  const typeDesc = `Account Type: ${typeRaw}`;

  // Bank Account Details collection — A/c No + IFSC + Bank Name (List of Banks / free text).
  // Branch stays OUTSIDE this list (Tally Excel import maps Branch → Bank Branch Name).
  const bankAccountDetailsXml = (accNo || ifscCode || institutionName) ? `
  <BANKACCOUNTDETAILS.LIST>
${accNo ? `    <ACCOUNTNUMBER>${escapeXml(accNo)}</ACCOUNTNUMBER>` : ''}
${ifscCode ? `    <IFSCCODE>${escapeXml(ifscCode)}</IFSCCODE>` : ''}
${ifscCode ? `    <IFSCODE>${escapeXml(ifscCode)}</IFSCODE>` : ''}
    <BANKNAME>${escapeXml(institutionName)}</BANKNAME>
  </BANKACCOUNTDETAILS.LIST>` : '';

  const xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>All Masters</REPORTNAME>
  ${companyName ? `<STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>` : ''}
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<LEDGER NAME="${escapeXml(ledgerName)}" ACTION="${tallyAction}">
  <NAME>${escapeXml(ledgerName)}</NAME>
  <PARENT>${parentGroup}</PARENT>
  <OPENINGBALANCE>${openBalXml}</OPENINGBALANCE>
  <DESCRIPTION>${escapeXml(typeDesc)}</DESCRIPTION>
  ${holderName ? `<BANKACCHOLDERNAME>${escapeXml(holderName)}</BANKACCHOLDERNAME>` : ''}
  ${ifscCode ? `<IFSCODE>${escapeXml(ifscCode)}</IFSCODE>` : ''}
  ${accNo ? `<BANKDETAILS>${escapeXml(accNo)}</BANKDETAILS>` : ''}
  ${accNo ? `<BANKACCNO>${escapeXml(accNo)}</BANKACCNO>` : ''}
  ${institutionName ? `<BANKNAME>${escapeXml(institutionName)}</BANKNAME>` : ''}
  ${branchName ? `<BANKBRANCHNAME>${escapeXml(branchName)}</BANKBRANCHNAME>` : ''}
  ${bankAccountDetailsXml}
  <ISDEFAULTLEDGER>No</ISDEFAULTLEDGER>
</LEDGER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;

  const payload = {
    companyGuid, companyName,
    bankName: institutionName,
    ledgerName,
    accountNumber: accNo,
    ifsc: ifscCode,
    accountType: typeRaw,
    openingBalance,
    branch: branchName,
    accountHolderName: holderName || null,
    tallyAction,
  };
  const queueId = await logWriteQueue(req.user.userId, companyGuid, 'bank', ledgerName, openBal, payload, xml, req.company?.id);
  if (queueId) {
    await insertAppMaster({
      companyGuid,
      userId: req.user.userId,
      writeQueueId: queueId,
      masterType: 'bank',
      masterName: ledgerName,
      payload,
    });
  }

  // Immediate local ledgers upsert — Bank Feeds + Bank Balance read ledgers only.
  // Without this, new banks are invisible until LedgerFull sync; A/c/branch stay blank
  // if Tally still had the old wrong XML tags. Ingest COALESCE keeps non-empty local values.
  const upsertLocalBank = async () => {
    try {
      await query(
        `INSERT INTO ledgers (
           guid, company_guid, name, parent,
           opening_balance, closing_balance, balance_type,
           bank_account_no, bank_ifsc, bank_name, bank_branch, bank_holder, bank_account_type
         )
         SELECT gen_random_uuid()::text, $1, $2, $3, $4, $4, 'Dr', $5, $6, $7, $8, $9, $10
         WHERE NOT EXISTS (
           SELECT 1 FROM ledgers WHERE company_id = $1 AND LOWER(name) = LOWER($2)
         )`,
        [
          companyGuid, ledgerName, parentGroup, openBal,
          accNo || null, ifscCode || null, institutionName || null,
          branchName || null, holderName || null, typeRaw || null,
        ]
      );
      await query(
        `UPDATE ledgers SET
           parent             = COALESCE(NULLIF($3, ''), parent),
           bank_account_no    = COALESCE(NULLIF($4, ''), bank_account_no),
           bank_ifsc          = COALESCE(NULLIF($5, ''), bank_ifsc),
           bank_name          = COALESCE(NULLIF($6, ''), bank_name),
           bank_branch        = COALESCE(NULLIF($7, ''), bank_branch),
           bank_holder        = COALESCE(NULLIF($8, ''), bank_holder),
           bank_account_type  = COALESCE(NULLIF($9, ''), bank_account_type)
         WHERE company_id = $1 AND LOWER(name) = LOWER($2)`,
        [
          companyGuid, ledgerName, parentGroup,
          accNo, ifscCode, institutionName, branchName, holderName, typeRaw,
        ]
      );
    } catch (e) {
      console.warn('[bank-immediate-upsert]', e.message);
    }
  };

  let result;
  try {
    result = await forwardToTally(companyGuid, req.user.userId, xml, { companyId: req.company?.id });
    await updateWriteQueue(queueId, result, null);
    await upsertLocalBank();
    const offline = result?.status === 'desktop_offline';
    if (!offline) {
      setImmediate(() => {
        requestDesktopSyncAfterWrite({
          userId: req.user.userId,
          companyGuid,
          companyName: companyName || req.body.companyName || null,
          tdkRef: null,
          tallyIds: [],
          extra: { reason: 'master_created', masterType: 'bank', masterName: ledgerName },
        });
      });
    }
    return res.json({
      status: true,
      data: {
        message: offline
          ? 'Bank ledger queued - will push when Tally is online'
          : `Bank ledger ${tallyAction === 'Alter' ? 'updated' : 'created'} in Tally`,
        bankName: ledgerName,
        accountNumber: accNo,
        ifsc: ifscCode,
        branch: branchName,
        accountType: typeRaw,
        queueId,
        tallyAction,
        tallyResult: result,
      },
    });
  } catch (err) {
    await updateWriteQueue(queueId, null, err.message);
    // Still upsert locally so Bank Feeds / Bank Balance show the account immediately
    await upsertLocalBank();
    return res.json({
      status: true,
      data: {
        message: 'Bank ledger queued - will push when Tally is online',
        bankName: ledgerName,
        accountNumber: accNo,
        ifsc: ifscCode,
        branch: branchName,
        accountType: typeRaw,
        queueId,
        tallyAction,
        error: err.message,
      },
    });
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
      WHERE user_id=$1 AND company_id=$2 AND operation='bank'
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.user.userId, req.company?.id]);
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
    'SELECT sku FROM stocks WHERE guid=$1 AND company_id=$2',
    [stockGuid, req.company?.id]
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
    userId, req.company?.id, 'barcode_sync',
    `${stockName} → ${barcode} (${syncTarget})`,
    null, { stockGuid, stockName, barcode, syncTarget }, xml
  ).catch(() => null);

  let result;
  try {
    result = await forwardToTally(companyGuid, userId, xml, { companyId: req.company?.id });
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

// A paired Desktop speaks for exactly one workspace, and that binding is the
// only thing that says which queued writes it may see. This used to fall back to
// devices.user_id, which stopped being written long ago and covered several
// workspaces when it was.
async function resolveDesktopWorkspace(req, res) {
  const deviceId = req.headers['device-id'] || req.headers['x-device-id'] || req.body?.deviceId;
  if (!deviceId) { res.status(401).json({ status: false, message: 'device-id header required' }); return null; }
  const { rows } = await query(
    `SELECT workspace_id, device_id FROM devices WHERE device_id=$1 AND paired=TRUE LIMIT 1`,
    [deviceId]
  );
  if (!rows[0]) { res.status(403).json({ status: false, message: 'Device not paired' }); return null; }
  if (!rows[0].workspace_id) {
    res.status(403).json({
      status: false,
      code: 'DEVICE_NOT_BOUND_TO_WORKSPACE',
      message: 'Device is paired but not bound to a workspace',
    });
    return null;
  }
  return {
    deviceId: rows[0].device_id || deviceId,
    workspaceId: rows[0].workspace_id,
  };
}

// POST /tally/desktop/writeback/pending — desktop pulls pending offline entries for its Workspace
// Auth is the paired device. Backend resolves workspace. companyGuid is optional filter only.
router.post('/desktop/writeback/pending', requireDeviceCredential, async (req, res) => {
  try {
    const desktop = await resolveDesktopWorkspace(req, res);
    if (!desktop) return;
    const { companyGuid = null, limit = 10 } = req.body || {};
    const maxLimit = Math.min(parseInt(limit) || 10, 25);
    const now = Math.floor(Date.now() / 1000);

    const params = [now, desktop.workspaceId];
    const clauses = [
      `workspace_id = $2`,
      `status IN ('desktop_offline','failed')`,
      `attempt_count < 5`,
      `(lock_expires_at IS NULL OR lock_expires_at < $1)`,
    ];
    if (companyGuid) {
      params.push(companyGuid);
      // The same Tally GUID exists in other workspaces, so it names a company
      // only after the workspace has been applied.
      clauses.push(
        `company_id IN (SELECT id FROM companies WHERE guid = $${params.length} AND workspace_id = $2)`
      );
    }
    params.push(maxLimit);
    const { rows } = await query(
      `SELECT id, company_guid, entry_type, entry_label, payload, attempt_count
       FROM write_queue
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at ASC LIMIT $${params.length}`,
      params
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
router.post('/desktop/writeback/:outboxId/claim', requireDeviceCredential, async (req, res) => {
  try {
    const desktop = await resolveDesktopWorkspace(req, res);
    if (!desktop) return;
    const { outboxId } = req.params;
    const now = Math.floor(Date.now() / 1000);
    const lockExpiresAt = now + LOCK_TTL_SECONDS;

    const { rows } = await query(
      `UPDATE write_queue
       SET locked_by_device_id=$1, locked_at=$2, lock_expires_at=$3, status='processing',
           updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
       WHERE id=$4
         AND workspace_id=$5
         AND status IN ('desktop_offline','failed')
         AND (lock_expires_at IS NULL OR lock_expires_at < $2)
       RETURNING id, xml, payload, entry_type, company_guid`,
      [desktop.deviceId, now, lockExpiresAt, outboxId, desktop.workspaceId]
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
router.post('/desktop/writeback/:outboxId/result', requireDeviceCredential, async (req, res) => {
  try {
    const desktop = await resolveDesktopWorkspace(req, res);
    if (!desktop) return;
    const { outboxId } = req.params;
    const { success, tallyVoucherNumber, tallyVoucherGuid, tallyAlterId, errorCode, errorMessage } = req.body;

    // Verify this device owns the lock
    const { rows: lockRows } = await query(
      `SELECT id, company_guid FROM write_queue
       WHERE id=$1 AND locked_by_device_id=$2 AND workspace_id=$3`,
      [outboxId, desktop.deviceId, desktop.workspaceId]
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
          _socketService?.emitVoucherSynced?.(company_guid, avRows[0].tdk_reference_no, tallyVoucherNumber, { companyId: avRows[0].company_id });
        }
      }
      // Desktop completed a deferred push without going through the Sales/Purchase
      // route, so create the paired Receipt/Payment here if one is still owed.
      // null author: the Desktop is the caller, so both helpers take the user
      // from the queue row that recorded who wrote the entry.
      const paired = await ensurePairedVoucherForQueueEntry(outboxId, null);
      // If desktop did not return a voucher number (common under tally_prime_series),
      // ask it to pull SingleVoucher so the number lands the same way as the live path.
      if (!tallyVoucherNumber) {
        await requestSyncAfterDeferredWrite(outboxId, null, {
          tallyIds: [tallyAlterId, paired?.tallyId],
          reason: 'writeback_posted',
          rcpTdkRef: paired?.tdkRef || null,
        });
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
router.post('/invoice/:tdkRef/pdf-log', authMiddleware, requireTallyWriteAccess('/invoice/:tdkRef/share-pdf'), async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid, pdfType = 'provisional', invoiceNumber, invoiceNumberLabel, watermark, fileName } = req.body;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

    // Lookup the invoice
    const { rows: avRows } = await query(
      `SELECT invoice_uuid, books_impact_status FROM app_vouchers
        WHERE tdk_reference_no=$1
          AND (company_id::text = $2::text OR company_guid = $2::text)
          AND user_id=$3`,
      [tdkRef, req.company?.id, req.user.userId]
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
      [tdkRef, avRows[0].invoice_uuid, req.company?.id, req.user.userId, versionNo,
       pdfType, avRows[0].books_impact_status === 'posted' ? 'Posted' : 'Not Posted',
       invoiceNumber || null, invoiceNumberLabel || 'Pending from TallyPrime', watermark || null, fileName || null]
    );

    res.json({ status: true, data: { versionNo, pdfType } });
  } catch (e) {
    console.error('[invoice/pdf-log]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── VoucherDocument presentation tables (see tallydekho-brain/PDF_LAYOUT_SPEC.md) ─────────

const DOCUMENT_TYPE_BY_VOUCHER = {
  sales: 'sales_invoice',
  sales_invoice: 'sales_invoice',
  proforma_invoice: 'proforma_invoice',
  purchase: 'purchase_invoice',
  purchase_invoice: 'purchase_invoice',
  credit_note: 'credit_note',
  debit_note: 'debit_note',
  delivery_note: 'delivery_note',
  receipt_note: 'receipt_note',
  sales_order: 'sales_order',
  purchase_order: 'purchase_order',
  // No write path (Proforma and Sales Order cover pre-sale), but Tally-synced
  // quotations must not fall through and render as a tax invoice.
  quotation: 'quotation',
};

const TALLY_VOUCHER_TYPE_BY_DOCUMENT = {
  sales_invoice: 'Sales',
  proforma_invoice: 'Sales',
  purchase_invoice: 'Purchase',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  delivery_note: 'Delivery Note',
  receipt_note: 'Receipt Note',
  sales_order: 'Sales Order',
  purchase_order: 'Purchase Order',
};

const DOCUMENT_TITLE = {
  sales_invoice: 'TAX INVOICE',
  proforma_invoice: 'PROFORMA INVOICE',
  purchase_invoice: 'TAX INVOICE',
  credit_note: 'Tax Invoice',
  debit_note: 'Debit Note',
  delivery_note: 'DELIVERY NOTE',
  receipt_note: 'RECEIPT NOTE',
  sales_order: 'SALES ORDER',
  purchase_order: 'PURCHASE ORDER',
  receipt: 'Receipt Voucher',
  payment: 'Payment Voucher',
  journal: 'Journal Voucher',
  contra: 'Contra Voucher',
  stock_transfer: 'Stock Journal',
  stock_adjustment: 'Physical Stock',
};

const PURCHASE_SIDE_DOCUMENTS = new Set(['purchase_invoice', 'debit_note', 'purchase_order', 'receipt_note']);
const HSN_SUMMARY_DOCUMENTS = new Set(['sales_invoice', 'proforma_invoice', 'purchase_invoice']);
const DECLARATION_DOCUMENTS = new Set(['sales_invoice', 'proforma_invoice']);

/**
 * Which layout family the renderer should use.
 * `invoice` = Tally invoice grid, `voucher` = Dr/Cr accounting voucher,
 * `stock` = stock journal / physical stock sheet.
 */
function documentLayout(documentType) {
  if (['receipt', 'payment', 'journal', 'contra'].includes(documentType)) {
    return {
      family: 'voucher',
      title: DOCUMENT_TITLE[documentType],
      columns: ['receipt', 'payment'].includes(documentType) ? ['amount'] : ['debit', 'credit'],
      showThrough: ['receipt', 'payment'].includes(documentType),
      showGstin: documentType !== 'contra',
      showSignatory: true,
    };
  }
  if (['stock_transfer', 'stock_adjustment'].includes(documentType)) {
    return {
      family: 'stock',
      title: DOCUMENT_TITLE[documentType],
      showSignatory: true,
    };
  }
  return {
    family: 'invoice',
    title: DOCUMENT_TITLE[documentType] || 'TAX INVOICE',
    partyRole: PURCHASE_SIDE_DOCUMENTS.has(documentType) ? 'supplier' : 'buyer',
    partyLabel: PURCHASE_SIDE_DOCUMENTS.has(documentType) ? 'Supplier (Bill from)' : 'Buyer (Bill to)',
    showHsnSummary: HSN_SUMMARY_DOCUMENTS.has(documentType),
    showDeclaration: DECLARATION_DOCUMENTS.has(documentType),
    showReceivedInGoodCondition: documentType === 'delivery_note',
    showJurisdiction: DECLARATION_DOCUMENTS.has(documentType),
    computerGeneratedText: documentType === 'sales_invoice'
      ? 'This is a Computer Generated Invoice'
      : 'This is a Computer Generated Document',
    showSignatory: true,
  };
}

/** Number / posting state shared by every document type. */
function documentNumbering(av) {
  const hasNumber = !!av.tally_voucher_no;
  const isPosted = av.books_impact_status === 'posted';
  const numberPending = isPosted && !hasNumber;
  return {
    documentNumber: hasNumber
      ? av.tally_voucher_no
      : (numberPending ? 'Posted · number pending sync' : 'Pending from TallyPrime'),
    postingTag: isPosted ? 'Posted' : 'Not Posted',
    isProvisional: !hasNumber,
    numberPending,
    watermarkText: numberPending
      ? 'Posted — Tally series number pending sync'
      : (!hasNumber ? 'Provisional / Pending Tally Posting' : null),
    numberingMode: av.numbering_policy || 'tally_prime_series',
  };
}

// ── Helper: build VoucherDocument from app_vouchers row + company/party info ──────────────
async function buildVoucherDocument(av, ctxOverride = null) {
  const p = av.payload || {};
  const vType = (av.voucher_type || '').toLowerCase();
  const isReceipt = vType === 'receipt';
  const isPayment = vType === 'payment';
  const isJournal = vType === 'journal';
  const isContra = vType === 'contra';
  const isStockAdjustment = vType === 'stock_adjustment';
  const isStockTransfer = vType === 'stock_transfer';

  const partyName = av.party_name || p.partyLedger || '';
  const itemNames = (Array.isArray(p.items) ? p.items : [])
    .map((i) => i.itemName || i.name)
    .filter(Boolean);
  const ctx = ctxOverride
    || await loadDocumentContext(av.company_id, partyName, itemNames);
  const company = buildCompanyBlock(ctx.companyRow, p, ctx.printProfile);
  const party = buildPartyBlock(ctx.partyRow, partyName);
  const numbering = documentNumbering(av);

  // ── Stock Journal / stock transfer document ────────────────────────────────
  if (isStockTransfer) {
    const transferItems = Array.isArray(p.items) ? p.items : [];
    const transferTotal = parseFloat(av.total_amount || 0);
    // Tally's Stock Journal prints a Source (Consumption) table and a
    // Destination (Production) table, so each moved item becomes two lines.
    const transferLines = [];
    transferItems.forEach((it, idx) => {
      const qty = parseFloat(it.qty) || 0;
      const rate = parseFloat(it.rate) || 0;
      const base = {
        name: it.itemName || '',
        qty,
        unit: it.unit || 'pcs',
        rate,
        amount: parseFloat(it.amount) || rate * qty,
      };
      transferLines.push({
        ...base,
        id: `${idx}-out`,
        direction: 'out',
        godown: it.fromGodown || p.fromGodown || '',
      });
      transferLines.push({
        ...base,
        id: `${idx}-in`,
        direction: 'in',
        godown: p.toGodown || '',
      });
    });
    return {
      documentType: 'stock_transfer',
      tallyVoucherType: 'Stock Journal',
      ...numbering,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0, 10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      layout: documentLayout('stock_transfer'),
      company,
      party: {
        ...party,
        name: av.party_name || `${p.fromGodown || ''} → ${p.toGodown || ''}`,
      },
      totals: {
        grandTotal: transferTotal,
        totalQty: transferItems.reduce((s, it) => s + (parseFloat(it.qty) || 0), 0),
      },
      totalInWords: amountInWords(transferTotal),
      items: transferLines,
      metadata: {
        referenceNo: av.tdk_reference_no || null,
        sourceGodown: p.fromGodown || (transferItems[0] && transferItems[0].fromGodown) || null,
        destinationGodown: p.toGodown || null,
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
    const adjQty = parseFloat(p.adjustmentQty || 0);
    const qtyBefore = parseFloat(p.qtyBefore || 0);
    const qtyAfter = parseFloat(p.qtyAfter ?? (qtyBefore + (p.isIncrease ? adjQty : -adjQty)));
    const adjTotal = parseFloat(av.total_amount || 0);
    return {
      documentType: 'stock_adjustment',
      tallyVoucherType: 'Physical Stock',
      ...numbering,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0, 10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      layout: documentLayout('stock_adjustment'),
      company,
      party: {
        ...party,
        name: p.stockName || av.party_name || '',
      },
      totals: {
        grandTotal: adjTotal,
        totalQty: adjQty,
      },
      totalInWords: amountInWords(adjTotal),
      // Physical Stock prints a single counted-quantity table, so no direction.
      items: [{
        id: '0',
        name: p.stockName || av.party_name || '',
        qty: qtyAfter,
        unit: p.unit || 'pcs',
        rate: parseFloat(p.rate) || 0,
        amount: adjTotal,
        godown: p.warehouse || '',
      }],
      metadata: {
        referenceNo: av.tdk_reference_no || null,
        warehouse: p.warehouse || null,
        adjustmentReason: p.adjustmentReason || null,
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
    const contraTotal = parseFloat(av.total_amount || p.amount || 0);
    return {
      documentType: 'contra',
      tallyVoucherType: 'Contra',
      ...numbering,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      layout: documentLayout('contra'),
      company,
      party: {
        ...party,
        name: av.party_name || p.fromLedger || '',
      },
      totals: {
        grandTotal: contraTotal,
      },
      totalInWords: amountInWords(contraTotal),
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
    const journalTotal = parseFloat(av.total_amount || p.amount || 0);
    return {
      documentType: 'journal',
      tallyVoucherType: 'Journal',
      ...numbering,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      layout: documentLayout('journal'),
      company,
      party: {
        ...party,
        name: av.party_name || p.drLedger || '',
      },
      totals: {
        grandTotal: journalTotal,
      },
      totalInWords: amountInWords(journalTotal),
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
    const moneyTotal = parseFloat(av.total_amount || p.amount || 0);
    const documentType = isPayment ? 'payment' : 'receipt';
    return {
      documentType,
      tallyVoucherType: isPayment ? 'Payment' : 'Receipt',
      ...numbering,
      documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
      tdkRef: av.tdk_reference_no,
      invoiceUuid: av.invoice_uuid,
      layout: documentLayout(documentType),
      company,
      party,
      totals: {
        grandTotal: moneyTotal,
      },
      totalInWords: amountInWords(moneyTotal),
      receipt: isReceipt ? moneyBlock : undefined,
      payment: isPayment ? moneyBlock : undefined,
      narration: p.narration || '',
    };
  }

  // ── Invoice-grid documents (sales / purchase / notes / orders) ─────────────
  const isSalesOrder = vType === 'sales_order';
  const isPurchaseOrder = vType === 'purchase_order';
  const isCreditNote = vType === 'credit_note';
  const isDebitNote = vType === 'debit_note';
  const isDeliveryNote = vType === 'delivery_note';
  const isPurchaseInvoice = vType === 'purchase_invoice' || vType === 'purchase';
  const isProforma = vType === 'proforma_invoice';
  const isOrder = isSalesOrder || isPurchaseOrder;

  // A converted Proforma prints as a Tax Invoice; while still optional it stays Proforma.
  const documentType = isProforma
    && !(av.current_entry_type === 'optional' && av.conversion_status !== 'converted')
    ? 'sales_invoice'
    : (DOCUMENT_TYPE_BY_VOUCHER[vType] || 'sales_invoice');

  const items = buildItemLines(p, ctx.itemMasters);
  const taxLines = buildTaxLines(p);
  const { charges, roundOff, roundOffLabel } = buildChargeLines(p);
  const totals = buildTotals(p, av, items, taxLines, charges, roundOff);
  if (roundOffLabel) totals.roundOffLabel = roundOffLabel;
  const hsnSummary = HSN_SUMMARY_DOCUMENTS.has(documentType)
    ? buildHsnSummary(items, taxLines)
    : [];
  const metadata = buildDocumentMetadata(p, av);
  const shipping = buildShippingBlock(p, party);
  const dispatchFrom = buildDispatchFromBlock(p, company);

  // Notes carry the invoice they are raised against.
  const linkedInvoice = p.linked_invoice || p.linkedInvoice || null;
  const againstInvoice = linkedInvoice ? {
    invoiceGuid:   linkedInvoice.invoiceGuid   || null,
    voucherNumber: linkedInvoice.voucherNumber || null,
    date:          linkedInvoice.date          || null,
    billRefName:   linkedInvoice.billRefName   || null,
    tdkRef:        linkedInvoice.tdkRef        || null,
    amount:        linkedInvoice.amount != null ? parseFloat(linkedInvoice.amount) : null,
  } : null;

  const payBlock = p.make_payment || p.collect_payment || null;

  return {
    documentType,
    tallyVoucherType: TALLY_VOUCHER_TYPE_BY_DOCUMENT[documentType] || 'Sales',
    layout: documentLayout(documentType),
    currentEntryType: av.current_entry_type || null,
    conversionStatus: av.conversion_status || null,
    canConvertProforma: isProforma
      && av.current_entry_type === 'optional'
      && av.conversion_status !== 'converted'
      && (!!av.tally_voucher_no || av.tally_sync_status === 'synced'),
    ...numbering,
    documentDate: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0,10) : (p.date || ''),
    tdkRef: av.tdk_reference_no,
    invoiceUuid: av.invoice_uuid,
    company,
    party,
    billing: party,
    shipping,
    dispatchFrom,
    metadata,
    items,
    taxLines,
    hsnSummary,
    additionalCharges: charges,
    totals,
    totalInWords: amountInWords(totals.grandTotal),
    taxAmountInWords: totals.taxTotal > 0 ? amountInWords(totals.taxTotal) : 'NIL',
    narration: p.narration || '',
    termsText: p.termsText || '',
    dueDate: p.dueDate || '',
    placeOfSupply: metadata.placeOfSupply,
    rawPayload: p,
    creditNote: isCreditNote ? {
      natureOfReturn: p.natureOfReturn || '01-Sales Return',
      returnType: 'Sales Return',
      againstInvoice,
    } : undefined,
    debitNote: isDebitNote ? {
      natureOfReturn: p.natureOfReturn || '02-Purchase Return',
      returnType: 'Purchase Return',
      againstInvoice,
    } : undefined,
    deliveryNote: isDeliveryNote ? {
      trackingNumbers: (Array.isArray(p.items) ? p.items : [])
        .map((i) => i.trackingNumber).filter(Boolean),
    } : undefined,
    paymentInfo: !isOrder && payBlock ? {
      collected: parseFloat(payBlock.amount || 0),
      mode: payBlock.ledgerName || '',
      reference: payBlock.reference || '',
      kind: p.make_payment ? 'payment' : 'receipt',
    } : undefined,
    againstInvoiceNo: (isCreditNote || isDebitNote)
      ? (againstInvoice?.voucherNumber || againstInvoice?.billRefName || '')
      : undefined,
    againstOrderNo: isOrder ? (av.tally_voucher_no || p.againstOrderNo || '') : (p.againstOrderNo || ''),
    supplierInvoiceNo: isPurchaseInvoice ? (p.vendorInvoiceNo || '') : undefined,
    supplierInvoiceDate: isPurchaseInvoice ? (p.vendorInvoiceDate || '') : undefined,
    dispatchDetails: !isOrder ? (p.dispatch_details || null) : null,
  };
}

// ── Helper: poll for Tally voucher number up to maxWaitMs ─────────────────────
async function waitForTallyNumber(tdkRef, companyId, userId, maxWaitMs = 10000) {
  const pollInterval = 600;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { rows } = await query(
      `SELECT tally_voucher_no FROM app_vouchers
        WHERE tdk_reference_no=$1 AND user_id=$3
          AND (
            ($2::bigint IS NOT NULL AND company_id=$2)
            OR ($2::text IS NOT NULL AND company_guid=$2::text)
          )
        LIMIT 1`,
      [tdkRef, companyId ?? null, userId]
    ).catch(() => ({ rows: [] }));
    if (rows[0]?.tally_voucher_no) return rows[0].tally_voucher_no;
    await new Promise(r => setTimeout(r, pollInterval));
  }
  return null;
}

// ── GET /tally/master/:queueId/preview ───────────────────────────────────────
// Master/ledger preview keyed by write_queue.id (not TDK ref).
router.get('/master/:queueId/preview', authMiddleware, async (req, res) => {
  try {
    const queueId = parseInt(req.params.queueId, 10);
    const { companyGuid } = req.query;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!(await verifyCompanyAccess(req, res, companyGuid))) return;
    if (!queueId) return res.status(400).json({ status: false, message: 'queueId required' });

    const { rows } = await query(
      `SELECT wq.id, wq.entry_type, wq.entry_label, wq.status AS queue_status,
              wq.amount, wq.payload, wq.error_message, wq.created_at,
              am.master_type, am.master_name, am.tally_guid,
              am.tally_sync_status, am.books_impact_status, am.payload AS am_payload
         FROM write_queue wq
         LEFT JOIN app_masters am ON am.write_queue_id = wq.id
        WHERE wq.id = $1
          AND wq.company_id = $2
          AND wq.user_id = $3
          AND wq.entry_type IN ('party','bank','warehouse','item','alter_stock_item')`,
      [queueId, req.company.id, req.user.userId]
    );
    if (!rows[0]) return res.status(404).json({ status: false, message: 'Master entry not found' });

    const row = rows[0];
    const payload = row.am_payload || row.payload || {};
    const masterType = row.master_type || row.entry_type;
    const masterName = row.master_name || row.entry_label || payload.name || payload.partyName || payload.bankName || '';
    const posted = row.books_impact_status === 'posted';

    let live = null;
    if (masterType === 'party' || masterType === 'bank') {
      const { rows: ledgers } = await query(
        `SELECT guid, name, parent, gstin, pan, address, state_name, pincode,
                gst_registration_type, opening_balance, closing_balance, balance_type, tax_rate, phone, email
           FROM ledgers
          WHERE company_id = $1 AND LOWER(name) = LOWER($2)
          ORDER BY CASE WHEN guid LIKE $1 || '%' THEN 0 ELSE 1 END
          LIMIT 1`,
        [req.company?.id, masterName]
      ).catch(() => ({ rows: [] }));
      live = ledgers[0] || null;
    } else if (masterType === 'warehouse') {
      const { rows: wh } = await query(
        `SELECT guid, name, parent, address FROM warehouses
          WHERE company_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1`,
        [req.company?.id, masterName]
      ).catch(() => ({ rows: [] }));
      live = wh[0] || null;
    } else if (masterType === 'item' || masterType === 'alter_stock_item') {
      const { rows: stocks } = await query(
        `SELECT guid, name, group_name, unit, hsn, tax_rate, opening_qty, opening_rate,
                closing_qty, closing_rate, closing_value
           FROM stocks
          WHERE company_id = $1 AND LOWER(name) = LOWER($2)
          ORDER BY CASE WHEN guid LIKE $1 || '%' THEN 0 ELSE 1 END
          LIMIT 1`,
        [req.company?.id, masterName]
      ).catch(() => ({ rows: [] }));
      live = stocks[0] || null;
    }

    const ledgerType = payload.ledger_type || null;
    const typeLabel = ({
      party: ledgerType === 'duties_taxes' ? 'Duties & Taxes'
        : ledgerType === 'sundry_creditor' ? 'Sundry Creditors'
        : ledgerType === 'sundry_debtor' ? 'Sundry Debtors'
        : ledgerType === 'custom' ? 'Custom Ledger'
        : 'Ledger',
      bank: 'Bank Ledger',
      warehouse: 'Warehouse',
      item: 'Stock Item',
      alter_stock_item: 'Stock Item Edit',
    })[masterType] || 'Master';

    res.json({
      status: true,
      data: {
        kind: 'master',
        queueId: row.id,
        masterType,
        ledgerType,
        typeLabel,
        name: masterName,
        parent: live?.parent || live?.group_name || payload.parent || payload.parentGodown || payload.groupName || null,
        queueStatus: row.queue_status,
        tallySyncStatus: row.tally_sync_status || null,
        booksImpactStatus: row.books_impact_status || 'not_posted',
        postingTag: posted ? 'Posted' : (row.queue_status === 'success' || row.tally_sync_status === 'pushed' ? 'Awaiting Sync' : 'Not Posted'),
        syncConfirmed: posted,
        tallyGuid: row.tally_guid || live?.guid || null,
        createdAt: row.created_at,
        errorMessage: row.error_message || null,
        // Snapshot from create payload (always available)
        payload: {
          gstin: payload.gstin || live?.gstin || null,
          pan: payload.pan || live?.pan || null,
          phone: payload.phone || live?.phone || null,
          email: payload.email || live?.email || null,
          address: payload.address || live?.address || null,
          state: payload.state || live?.state_name || null,
          pincode: payload.pincode || live?.pincode || null,
          gstRegType: payload.gstRegType || payload.gstType || live?.gst_registration_type || null,
          openingBalance: payload.openingBalance ?? live?.opening_balance ?? row.amount ?? 0,
          isCr: payload.isCr ?? (live?.balance_type === 'Cr'),
          dutyCategory: payload.dutyCategory || null,
          taxType: payload.taxType || null,
          percentage: payload.percentage ?? payload.dutyPercentage ?? live?.tax_rate ?? null,
          gstApplicable: payload.gstApplicable || null,
          hsnCode: payload.hsnCode || live?.hsn || null,
          igstRate: payload.igstRate ?? live?.tax_rate ?? null,
          unit: payload.unit || live?.unit || null,
          openingQty: payload.openingQty ?? live?.opening_qty ?? null,
          openingRate: payload.openingRate ?? live?.opening_rate ?? null,
          warehouse: payload.warehouse || null,
          bankDetails: payload.bankDetails || null,
          accountNumber: payload.accountNumber || null,
          ifsc: payload.ifsc || null,
          accountType: payload.accountType || null,
          changes: payload.changes || null,
        },
        live: live || null,
      },
    });
  } catch (e) {
    console.error('[master/preview]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── GET /tally/invoice/:tdkRef/preview ───────────────────────────────────────
router.get('/invoice/:tdkRef/preview', authMiddleware, async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid } = req.query;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!(await verifyCompanyAccess(req, res, companyGuid))) return;

    const companyId = req.company?.id;
    // Legacy writers put numeric company_id into company_guid and left company_id NULL.
    // Match either the real guid, the numeric id-as-text, or company_id.
    const { rows: avRows } = await query(
      `SELECT * FROM app_vouchers
       WHERE tdk_reference_no = $1
         AND user_id = $2
         AND (
           ($3::bigint IS NOT NULL AND company_id = $3)
           OR company_guid = $4
           OR ($3::text IS NOT NULL AND company_guid = $3::text)
         )
       ORDER BY (company_id IS NOT NULL) DESC, created_at DESC NULLS LAST
       LIMIT 1`,
      [tdkRef, req.user.userId, companyId ?? null, companyGuid]
    );
    if (!avRows[0]) return res.status(404).json({ status: false, message: 'Invoice not found' });
    const av = avRows[0];

    const doc = await buildVoucherDocument(av);

    res.json({ status: true, data: doc });
  } catch (e) {
    console.error('[invoice/preview]', e.message);
    res.status(500).json({ status: false, message: e.message });
  }
});

// ── POST /tally/invoice/:tdkRef/share-pdf ────────────────────────────────────
// Returns invoice snapshot (provisional or final) after optionally waiting for Tally number.
router.post('/invoice/:tdkRef/share-pdf', authMiddleware, requireTallyWriteAccess('/invoice/:tdkRef/share-pdf'), async (req, res) => {
  try {
    const { tdkRef } = req.params;
    const { companyGuid, waitForTallyNumber: shouldWait = true, maxWaitMs = 10000 } = req.body;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    // requireTallyWriteAccess already bound req.company

    if (!(await chargeWorkspaceService(req, res, {
      serviceKey: 'PDF_GENERATE',
      operationId: `pdf:${tdkRef}`,
      meta: { tdkRef },
    }))) return;

    const companyId = req.company?.id;
    const { rows: avRows } = await query(
      `SELECT * FROM app_vouchers
       WHERE tdk_reference_no = $1
         AND user_id = $2
         AND (
           ($3::bigint IS NOT NULL AND company_id = $3)
           OR company_guid = $4
           OR ($3::text IS NOT NULL AND company_guid = $3::text)
         )
       ORDER BY (company_id IS NOT NULL) DESC, created_at DESC NULLS LAST
       LIMIT 1`,
      [tdkRef, req.user.userId, companyId ?? null, companyGuid]
    );
    if (!avRows[0]) return res.status(404).json({ status: false, message: 'Invoice not found' });
    let av = avRows[0];

    // If we need to wait and no Tally number yet → poll
    if (shouldWait && !av.tally_voucher_no && av.numbering_policy === 'tally_prime_series') {
      const tallyNo = await waitForTallyNumber(tdkRef, req.company?.id, req.user.userId, maxWaitMs);
      if (tallyNo) {
        // Refresh row
        const { rows: fresh } = await query(
          `SELECT * FROM app_vouchers WHERE tdk_reference_no=$1`, [tdkRef]
        ).catch(() => ({ rows: [] }));
        if (fresh[0]) av = fresh[0];
      }
    }

    const doc = await buildVoucherDocument(av);
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

export { buildVoucherDocument };
export default router;
