// Ingest pipeline — receives chunked data from Desktop
import { Router } from 'express';
import { query } from '../db/schema.js';
import { v4 as uuid } from 'uuid';
import { processIngestedData } from '../controllers/ingestProcessor.js';
import { purgeCompaniesForHardSync } from '../services/companyPurge.js';
import { consumeApprovedHardSync } from '../services/hardSyncService.js';
import { markFirstSyncConnected, getKnownLineageGuids } from '../services/deviceBinding.js';
import { evaluateLineage } from '../utils/tallyLineage.js';
import { requireDeviceCredential } from '../middleware/auth.js';

let _socketService = null;
export function setSocketService(s) { _socketService = s; }
const socketService = { notifySynced: (...args) => _socketService?.notifySynced(...args) };

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

function normalizeGstType(raw) {
  if (!raw) return 'Regular';
  const s = raw.toLowerCase();
  if (s.includes('composition')) return 'Composition';
  if (s.includes('non-resident') || s.includes('nonresident') || s.includes('nrtp')) return 'NonResident';
  if (s.includes('oidar')) return 'OIDAR';
  if (s.includes('isd') || s.includes('input service distributor')) return 'ISD';
  if (s.includes('tds')) return 'TDS_Deductor';
  if (s.includes('ecommerce') || s.includes('e-commerce') || s.includes('tcs')) return 'Ecommerce_Operator';
  if (s.includes('uin')) return 'UIN';
  if (s.includes('cancel')) return 'Cancelled';
  return 'Regular';
}

// POST /desktop/init-sync
// Body: { companies, isHardSync? }
// Hard sync: purge Tally projection for selected GUIDs, then proceed (rebuild).
// Normal sync: unchanged (no purge).
router.post('/desktop/init-sync', requireDeviceCredential, async (req, res) => {
  const deviceId = req.deviceId || req.headers['device-id'];
  const { companies, isHardSync = false } = req.body || {};
  console.log(`[SYNC] init-sync from device ${deviceId}, companies: ${companies?.length}, hard=${!!isHardSync}`);

  try {
    const device = req.device || (await query('SELECT * FROM devices WHERE device_id = $1', [deviceId])).rows[0];
    const userId = device?.user_id;

    if (!userId) return res.status(403).json({ status: false, message: 'Device not paired' });

    const workspaceId = device.workspace_id;
    const incomingGuids = (companies || []).map((c) => c.guid).filter(Boolean);
    if (workspaceId && incomingGuids.length && isHardSync !== true) {
      const known = await getKnownLineageGuids(workspaceId);
      const verdict = evaluateLineage(known, incomingGuids);
      if (!verdict.ok) {
        return res.status(409).json({
          status: false,
          code: verdict.code || 'TALLY_DATA_MISMATCH',
          message: verdict.reason === 'guid_replacement_candidate'
            ? 'Company GUID changed. Owner/Admin must approve a GUID Replacement Hard Sync.'
            : 'This Tally data does not match the workspace. Restore the workspace backup or reset from Web.',
          data: { extra: verdict.extra, missing: verdict.missing, reason: verdict.reason },
        });
      }
    }

    if (isHardSync === true && companies?.length > 0) {
      try {
        await consumeApprovedHardSync(workspaceId, deviceId, companies, req.body?.guidReplacement);
      } catch (purgeErr) {
        console.error('[SYNC] Hard sync purge failed:', purgeErr.message);
        return res.status(purgeErr.httpStatus || 500).json({
          status: false,
          code: purgeErr.code,
          message: purgeErr.message || `Hard sync rebuild failed: ${purgeErr.message}`,
        });
      }
    }

    const alterIds = {};
    if (companies && companies.length > 0) {
      // Mark companies not in current sync as inactive (universal approach - never delete)
      const activeGuids = companies.map(c => c.guid).filter(Boolean);
      const ph         = activeGuids.map((_, i) => `$${i + 3}`).join(','); // for deactivate: $1=userId, $2=deviceId, $3+=guids
      const phActivate  = activeGuids.map((_, i) => `$${i + 2}`).join(','); // for activate: $1=userId, $2+=guids
      // Deactivate removed companies
      await query(
        `UPDATE companies SET is_active = FALSE WHERE user_id = $1 AND device_id = $2 AND guid NOT IN (${ph})`,
        [userId, deviceId, ...activeGuids]
      ).catch(() => {});
      // Activate current companies
      await query(
        `UPDATE companies SET is_active = TRUE WHERE user_id = $1 AND guid IN (${phActivate})`,
        [userId, ...activeGuids]
      ).catch(() => {});
    }
    if (companies) {
      for (const c of companies) {
        const { rows: lRows } = await query('SELECT MAX(alter_id) as max FROM ledgers WHERE company_guid = $1', [c.guid]);
        const { rows: vRows } = await query('SELECT MAX(alter_id) as max FROM vouchers WHERE company_guid = $1', [c.guid]);
        const masterAlterId = lRows[0]?.max || 0;
        const voucherAlterIdMax = vRows[0]?.max || 0;

        // Build per-year voucher alter_ids
        const voucherByYear = {};
        const allYears = c.allYears || c.years || [];
        for (const y of allYears) {
          const finYear = y.finYear || y.fin_year || y.name;
          if (!finYear) continue;
          const { rows: yvRows } = await query(
            `SELECT MAX(alter_id) as max FROM vouchers WHERE company_guid = $1 AND date >= $2 AND date <= $3`,
            [c.guid, y.begin || y.beginDate || '2000-01-01', y.end || y.endDate || '2099-12-31']
          ).catch(() => ({ rows: [{ max: 0 }] }));
          voucherByYear[finYear] = yvRows[0]?.max || 0;
        }

        alterIds[c.guid] = { master: masterAlterId, voucher: voucherByYear };

        try {
          // Tally's Company collection also carries the print identity (PAN as
          // INCOMETAXNUMBER, e-mail, phone, address, state, pincode). COALESCE on
          // update so a payload that omits a field never wipes a synced value.
          const companyAddress = Array.isArray(c.address)
            ? c.address.map((l) => String(l || '').trim()).filter(Boolean).join(', ')
            : (c.address || null);
          await query(`
            INSERT INTO companies (guid, user_id, device_id, name, formal_name, gstin, fy_start, fy_end, synced_at, is_active, gst_taxpayer_type,
                                   pan, phone, mobile, email, website, address, state, pincode, country)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            ON CONFLICT (guid) DO UPDATE SET
              user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id,
              name = EXCLUDED.name, formal_name = EXCLUDED.formal_name,
              gstin = COALESCE(EXCLUDED.gstin, companies.gstin), fy_start = EXCLUDED.fy_start,
              fy_end = EXCLUDED.fy_end, synced_at = EXCLUDED.synced_at,
              is_active = TRUE,
              gst_taxpayer_type = EXCLUDED.gst_taxpayer_type,
              pan     = COALESCE(EXCLUDED.pan,     companies.pan),
              phone   = COALESCE(EXCLUDED.phone,   companies.phone),
              mobile  = COALESCE(EXCLUDED.mobile,  companies.mobile),
              email   = COALESCE(EXCLUDED.email,   companies.email),
              website = COALESCE(EXCLUDED.website, companies.website),
              address = COALESCE(EXCLUDED.address, companies.address),
              state   = COALESCE(EXCLUDED.state,   companies.state),
              pincode = COALESCE(EXCLUDED.pincode, companies.pincode),
              country = COALESCE(EXCLUDED.country, companies.country)
          `, [c.guid, userId, deviceId, c.name || c.NAME || 'Unknown', c.formalName || c.name || '',
              c.gstin || c.GSTIN || c.gstNumber || null, c.startingFrom || null, c.endingAt || null, now(),
              normalizeGstType(c.GSTREGISTRATIONTYPE || c.GstRegistrationType || c.TAXPAYERTYPE || c.TaxpayerType || null),
              c.incomeTaxNumber || c.INCOMETAXNUMBER || null,
              c.phoneNumber || c.PHONENUMBER || null,
              c.mobileNumber || c.MOBILENO || null,
              c.email || c.EMAIL || null,
              c.website || c.WEBSITE || null,
              companyAddress,
              c.state || c.STATENAME || null,
              c.pincode || c.PINCODE || null,
              c.country || c.COUNTRYNAME || null]);
          console.log(`[DB] Company saved: ${c.name || c.guid}`);

          // Store all financial years for this company
          // c.years = user-selected years to sync (is_active = TRUE)
          // c.allYears = all years Tally knows about (is_active = FALSE unless also selected)
          const allYears = c.allYears || c.years || [];
          const selectedYears = c.years || [];
          const selectedFYNames = new Set(selectedYears.map(y => y.finYear || y.fin_year || y.name).filter(Boolean));
          console.log(`[DB] Years for ${c.name}: total=${allYears.length} selected=${selectedFYNames.size}`);

          // First deactivate all years for this company, then activate selected ones
          await query('UPDATE company_years SET is_active = FALSE WHERE company_guid = $1', [c.guid]).catch(() => {});

          const norm = d => d && d.length === 8 ? `${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}` : d;
          for (const y of allYears) {
            const finYear = y.finYear || y.fin_year || y.name || null;
            const beginDate = y.begin || y.beginDate || y.startDate || null;
            const endDate = y.end || y.endDate || null;
            if (!finYear || !beginDate || !endDate) {
              console.log('[DB] Skipping year (missing fields):', y);
              continue;
            }
            const isActive = selectedFYNames.has(finYear);
            try {
              await query(`
                INSERT INTO company_years (company_guid, fin_year, begin_date, end_date, is_active)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (company_guid, fin_year) DO UPDATE SET
                  begin_date = EXCLUDED.begin_date, end_date = EXCLUDED.end_date,
                  is_active = EXCLUDED.is_active
              `, [c.guid, finYear, norm(beginDate), norm(endDate), isActive]);
            } catch (ye) { console.warn('[DB] Year insert failed:', ye.message, y); }
          }
        } catch (e) {
          console.warn('[DB] Company save failed:', e.message);
        }
      }
    }

    const yearIds = {};
    if (companies) {
      companies.forEach(c => {
        yearIds[c.id || c.guid] = {};
        (c.allYears || c.years || []).forEach(y => {
          yearIds[c.id || c.guid][y.finYear || y] = `${c.guid}_${y.finYear || y}`;
        });
      });
    }

    if (workspaceId && companies?.length) {
      const guids = companies.map((c) => c.guid).filter(Boolean);
      if (guids.length) {
        await query(
          `UPDATE companies SET workspace_id = $1 WHERE guid = ANY($2::text[])`,
          [workspaceId, guids]
        ).catch(() => {});
      }
      await markFirstSyncConnected(workspaceId, deviceId, companies);
    }

    res.json({ status: true, data: { alterIds, yearIds, uploadId: uuid() } });
  } catch (err) {
    console.error('[SYNC] init-sync error:', err.message);
    res.status(500).json({ status: false, message: 'Sync init failed' });
  }
});

// POST /ingest/init
router.post('/ingest/init', async (req, res) => {
  const deviceId = req.headers['device-id'];
  const uploadId = uuid();
  try {
    await query('INSERT INTO ingest_uploads (id, device_id) VALUES ($1, $2)', [uploadId, deviceId]);
    console.log(`[INGEST] init upload ${uploadId} from device ${deviceId}`);
    res.json({ status: true, data: { uploadId } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Init failed' });
  }
});

// POST /ingest/sync-run/start — V2: create a sync_run record before sync starts
router.post('/ingest/sync-run/start', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { body = {}; } }
  const { companyGuid, syncType = 'normal', expectedCounts } = body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const { rows } = await query(
      `INSERT INTO sync_runs (company_guid, sync_type, status, expected_counts, started_at)
       VALUES ($1, $2, 'running', $3, NOW()) RETURNING id`,
      [companyGuid, syncType, expectedCounts ? JSON.stringify(expectedCounts) : null]
    );
    const syncRunId = rows[0].id;
    console.log(`[SYNC_RUN] started ${syncRunId} | company: ${companyGuid} | type: ${syncType}`);
    res.json({ status: true, data: { syncRunId } });
  } catch (err) {
    console.error('[SYNC_RUN] start error:', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /ingest/sync-run/complete — V2: mark sync_run as completed with record counts
router.post('/ingest/sync-run/complete', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { body = {}; } }
  const { syncRunId, uploadId, recordCounts, status = 'completed', errorMessage } = body || {};
  if (!syncRunId) return res.status(400).json({ status: false, message: 'syncRunId required' });
  try {
    await query(
      `UPDATE sync_runs SET status=$1, record_counts=$2, upload_id=$3, error_message=$4, completed_at=NOW()
       WHERE id=$5`,
      [status, recordCounts ? JSON.stringify(recordCounts) : null, uploadId || null, errorMessage || null, syncRunId]
    );
    console.log(`[SYNC_RUN] ${status} ${syncRunId}`);
    res.json({ status: true, data: { syncRunId, status } });
  } catch (err) {
    console.error('[SYNC_RUN] complete error:', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// GET /ingest/sync-run/history?companyGuid= — V2: sync run history + monitoring
router.get('/ingest/sync-run/history', async (req, res) => {
  const { companyGuid, limit = 20 } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const { rows } = await query(
      `SELECT id, sync_type, status, record_counts, expected_counts, error_message, started_at, completed_at,
              EXTRACT(EPOCH FROM (completed_at - started_at)) as duration_seconds
       FROM sync_runs WHERE company_guid=$1 ORDER BY started_at DESC LIMIT $2`,
      [companyGuid, parseInt(limit)]
    );
    res.json({ status: true, data: rows });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /ingest/chunk
router.post('/ingest/chunk', async (req, res) => {
  const uploadId  = req.headers['upload-id'];
  const streamName = req.headers['stream-name'];
  const chunkIndex = parseInt(req.headers['chunk-index'] || '0');
  const deviceId  = req.headers['device-id'];

  if (!uploadId || !streamName) return res.status(400).json({ status: false, message: 'Missing headers' });
  // Require device-id header to prevent unauthenticated writes
  if (!deviceId) return res.status(401).json({ status: false, message: 'device-id header required' });

  try {
    const { rows: devices } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    const device = devices[0];
    // Device must be registered (even if not paired) to write data
    if (!device) return res.status(403).json({ status: false, message: 'Device not registered. Run the desktop app first.' });
    const userId = device?.user_id;
    if (!userId) return res.status(403).json({ status: false, message: 'Device not paired to any user. Complete pairing first.' });

    let data;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    if (typeof raw === 'string') {
      const lines = raw.trim().split('\n').filter(Boolean);
      data = lines.length > 1
        ? lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        : JSON.parse(raw);
    } else {
      data = raw;
    }
    if (!Array.isArray(data)) data = data ? [data] : [];

    let companyGuid = req.headers['company-guid'];
    if (!companyGuid && data.length > 0) {
      companyGuid = data[0]?.COMPANY_GUID || data[0]?.company_guid || null;
    }
    if (!companyGuid) {
      const { rows } = await query('SELECT company_guid FROM ingest_uploads WHERE id = $1', [uploadId]);
      companyGuid = rows[0]?.company_guid;
    }
    if (companyGuid) {
      await query('UPDATE ingest_uploads SET company_guid = $1 WHERE id = $2', [companyGuid, uploadId]);
    }

    console.log(`[INGEST] chunk ${chunkIndex} | stream: ${streamName} | company: ${companyGuid || 'unknown'} | records: ${data.length}`);

    if (data.length > 0) {
      await processIngestedData(streamName, data, companyGuid, userId, deviceId);
    }

    await query('UPDATE ingest_uploads SET chunks = chunks + 1 WHERE id = $1', [uploadId]);
    res.json({ status: true, data: { received: true, chunkIndex } });
  } catch (err) {
    console.error('[INGEST] chunk error:', err.message);
    res.status(500).json({ status: false, message: 'Chunk processing failed' });
  }
});

// POST /ingest/complete
router.post('/ingest/complete', async (req, res) => {
  let body = req.body;
  if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString()); } catch { body = {}; } }
  const { uploadId, isHardSync, voucherCount, ledgerCount, stockCount, recordCount } = body || {};
  let { companyGuid } = body || {};
  const deviceId = req.headers['device-id'];

  try {
    if (!companyGuid && uploadId) {
      const { rows } = await query('SELECT company_guid FROM ingest_uploads WHERE id = $1', [uploadId]);
      companyGuid = rows[0]?.company_guid;
    }

    await query('UPDATE ingest_uploads SET status = $1, completed_at = $2 WHERE id = $3', ['complete', now(), uploadId || '']);
    await query('UPDATE devices SET last_seen = $1 WHERE device_id = $2', [now(), deviceId]);

    const { rows: devices } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
    const userId = devices[0]?.user_id;

    if (companyGuid) {
      await query('UPDATE companies SET synced_at = $1 WHERE guid = $2', [now(), companyGuid]);

      // Log the sync operation
      await query(
        `INSERT INTO sync_log (device_id, user_id, company_guid, synced_at, mode, voucher_count, ledger_count, stock_count, record_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'success')`,
        [
          deviceId || 'unknown',
          userId || null,
          companyGuid,
          now(),
          isHardSync ? 'hard' : 'normal',
          voucherCount || 0,
          ledgerCount  || 0,
          stockCount   || 0,
          recordCount  || 0,
        ]
      ).catch(err => console.error('[sync_log] insert failed:', err.message));
    }

    // CTO Spec: Backdated Sync Cascade
    // When a sync completes, check if any vouchers have dates in past FYs
    // If so, invalidate (delete) ledger_fy_balances for affected FYs so they
    // get fresh anchors on the next LedgerOpeningBalance.xml sync.
    // This ensures backdated entries cascade correctly to future FY openings.
    if (companyGuid) {
      try {
        // Find all FYs that have voucher entries newer than their fy_balance anchor
        const { rows: staleAnchors } = await query(`
          SELECT DISTINCT vle.financial_year
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
          JOIN ledger_fy_balances lfb
            ON lfb.company_guid = vle.company_guid
            AND lfb.ledger_name = vle.ledger_name
            AND lfb.financial_year = vle.financial_year
          WHERE vle.company_guid = $1
            AND to_timestamp(v.synced_at) > lfb.synced_at  -- voucher newer than FY anchor (cast bigint epoch → timestamp)
            AND vle.financial_year IS NOT NULL
        `, [companyGuid]);

        if (staleAnchors.length > 0) {
          const staleYears = staleAnchors.map(r => r.financial_year);
          console.log(`[INGEST] Backdated sync detected. Stale FY anchors: ${staleYears.join(', ')}. Will refresh on next sync.`);
          // Delete stale anchors — they'll be repopulated on next LedgerOpeningBalance.xml sync
          // This forces correct recalculation instead of serving stale opening balances
          await query(
            `DELETE FROM ledger_fy_balances WHERE company_guid = $1 AND financial_year = ANY($2::text[])`,
            [companyGuid, staleYears]
          );
          console.log(`[INGEST] ♻️ Invalidated ${staleYears.length} stale FY anchors for recalculation`);
        }
      } catch (cascadeErr) {
        console.warn('[INGEST] Backdated cascade check failed (non-fatal):', cascadeErr.message);
      }
    }

    // Backfill VLE financial_year from parent voucher (runs after every sync)
    // Fixes cases where _FINANCIAL_YEAR was null during ingest
    if (companyGuid) {
      try {
        const { rowCount } = await query(`
          UPDATE voucher_ledger_entries vle
          SET financial_year = v.financial_year
          FROM vouchers v
          WHERE vle.voucher_guid = v.guid
            AND vle.company_guid = v.company_guid
            AND vle.company_guid = $1
            AND vle.financial_year IS NULL
            AND v.financial_year IS NOT NULL
        `, [companyGuid]);
        if (rowCount > 0) console.log(`[INGEST] ✅ Backfilled financial_year for ${rowCount} VLE rows`);
      } catch (fyErr) {
        console.warn('[INGEST] VLE FY backfill failed (non-fatal):', fyErr.message);
      }
    }

    // V2 Monitoring: compute record counts from DB for validation
    let recordCounts = {};
    if (companyGuid) {
      try {
        const [vCount, lCount, sCount, vleCount] = await Promise.all([
          query('SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1', [companyGuid]),
          query('SELECT COUNT(*) as c FROM ledgers WHERE company_guid=$1', [companyGuid]),
          query('SELECT COUNT(*) as c FROM stocks WHERE company_guid=$1', [companyGuid]),
          query('SELECT COUNT(*) as c FROM voucher_ledger_entries WHERE company_guid=$1', [companyGuid]),
        ]);
        recordCounts = {
          vouchers: parseInt(vCount.rows[0]?.c || 0),
          ledgers:  parseInt(lCount.rows[0]?.c || 0),
          stocks:   parseInt(sCount.rows[0]?.c || 0),
          voucher_ledger_entries: parseInt(vleCount.rows[0]?.c || 0),
        };
        // Log warning if counts look suspiciously low (basic sanity check)
        if (isHardSync && recordCounts.vouchers < 10) {
          console.warn(`[INGEST] ⚠️ Hard sync completed but only ${recordCounts.vouchers} vouchers — may indicate sync issue`);
        }
        console.log(`[INGEST] Record counts post-sync:`, recordCounts);
      } catch (countErr) {
        console.warn('[INGEST] Count check failed:', countErr.message);
      }
    }

    console.log(`[INGEST] ✅ Sync complete | device: ${deviceId} | company: ${companyGuid} | user: ${userId}`);

    // Backfill tax_transactions.voucher_date from vouchers where it's null
    // Handles cases where tax extraction ran before the voucher date was stored
    try {
      const { rowCount } = await query(`
        UPDATE tax_transactions tt
        SET voucher_date = v.date
        FROM vouchers v
        WHERE v.guid = tt.voucher_guid
          AND v.company_guid = tt.company_guid
          AND tt.company_guid = $1
          AND (tt.voucher_date IS NULL OR tt.voucher_date = '')
          AND v.date IS NOT NULL AND v.date != ''
      `, [companyGuid]);
      if (rowCount > 0) console.log(`[INGEST] Backfilled ${rowCount} tax_transaction dates from vouchers`);
    } catch (e) { console.warn('[INGEST] Tax date backfill failed (non-fatal):', e.message); }

    // One-time tax extraction if table is empty (legacy companies synced before tax feature)
    try {
      const { rows: tc } = await query('SELECT COUNT(*)::int AS c FROM tax_transactions WHERE company_guid=$1', [companyGuid]);
      if ((tc[0]?.c || 0) === 0) {
        const { backfillTaxTransactions } = await import('../controllers/ingestProcessor.js');
        const n = await backfillTaxTransactions(companyGuid);
        console.log(`[INGEST] Tax backfill: extracted from ${n} vouchers for ${companyGuid}`);
      }
    } catch (e) { console.warn('[INGEST] Tax backfill failed (non-fatal):', e.message); }

    if (userId) {
      try { socketService.notifySynced(userId, companyGuid); } catch (e) { console.warn('[WS] emit failed:', e.message); }
    }

    res.json({ status: true, message: 'Sync complete', data: { recordCounts } });
  } catch (err) {
    console.error('[INGEST] complete error:', err.message);
    res.status(500).json({ status: false, message: 'Complete failed' });
  }
});

export default router;
