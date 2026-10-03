/**
 * Remove vouchers that were deleted in Tally.
 *
 * Normal sync only adds/updates vouchers. The desktop now sends, per company, Tally's full
 * voucher GUID list for every synced FY (`voucherLists` on /ingest/complete). It marks a list
 * complete only when the company's TDL Context was VERIFIED and every FY answer was a clean
 * envelope whose GUIDs all start with the company GUID.
 *
 * A voucher is deleted only when ALL hold:
 *   - the list is complete;
 *   - its GUID starts with `<companyGuid>-` (Tally origin — app-created rows never match);
 *   - it is not cancelled (Tally's list leaves cancelled vouchers out);
 *   - it belongs to a listed FY (date inside the period, or dateless stub of that FY);
 *   - it was last written before this sync began (synced_at < the earlier of the sync run's
 *     start and the upload's start; the sync run starts before any Tally fetch), so a voucher
 *     entered in Tally while the sync ran is never removed;
 *   - its GUID suffix is absent from Tally's list for that FY.
 * If any FY would lose more than MASS_SHARE of its vouchers (and more than MASS_MIN), nothing
 * is deleted for the company — that looks like a bad answer, and Hard Sync is the fix.
 *
 * VOUCHER_DELETION_MODE: `on` (default) | `dry_run` (report what would go) | `off`.
 */
import { getClient } from '../db/schema.js';

export const MASS_SHARE = 0.5;
export const MASS_MIN = 25;

export function voucherDeletionMode(env = process.env) {
  const m = String(env.VOUCHER_DELETION_MODE || 'on').trim().toLowerCase();
  return m === 'off' || m === 'dry_run' ? m : 'on';
}

/** Children first; bill_outstanding is owned by the bill snapshot and left alone. */
export const VOUCHER_CHILD_TABLES = [
  'voucher_ledger_entries',
  'voucher_inventory_items',
  'voucher_items',
  'voucher_line_taxes',
  'voucher_bill_allocations',
  'batch_allocations',
  'gst_voucher_details',
  'tax_transactions',
  'e_invoice_details',
  'e_way_bill_details',
  'stock_transactions',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FY_RE = /^\d{4}-\d{4}$/;
const ID_RE = /^[A-Za-z0-9]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @returns {Map<string, { complete: boolean, reason: string|null, years: Array<{ finYear: string, from: string, to: string, ids: Set<string> }> }>}
 */
export function parseVoucherLists(body) {
  const out = new Map();
  const list = Array.isArray(body?.voucherLists) ? body.voucherLists : [];
  for (const s of list) {
    const guid = String(s?.companyGuid || '').trim();
    if (!guid) continue;
    if (s.complete !== true) {
      out.set(guid, { complete: false, reason: typeof s.reason === 'string' ? s.reason : 'incomplete', years: [] });
      continue;
    }
    const years = [];
    let malformed = !Array.isArray(s.years) || s.years.length === 0;
    for (const y of malformed ? [] : s.years) {
      if (!FY_RE.test(String(y?.finYear)) || !DATE_RE.test(String(y?.from)) || !DATE_RE.test(String(y?.to))
        || y.from > y.to || !Array.isArray(y.ids) || !y.ids.every((id) => typeof id === 'string' && ID_RE.test(id))) {
        malformed = true;
        break;
      }
      years.push({ finYear: y.finYear, from: y.from, to: y.to, ids: new Set(y.ids) });
    }
    out.set(guid, malformed
      ? { complete: false, reason: 'malformed_voucher_list', years: [] }
      : { complete: true, reason: null, years });
  }
  return out;
}

const likeEscape = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Decide and apply on an open transaction.
 * @returns {Promise<{ action: 'deleted'|'dry_run'|'none'|'kept', reason: string|null, missing: number, deleted: number, years: Array<{ finYear: string, held: number, inTally: number, missing: number }> }>}
 */
export async function reconcileDeletedVouchers(client, { uploadId, syncRunId, companyId, companyGuid, summary, mode = voucherDeletionMode() }) {
  const result = { action: 'kept', reason: null, missing: 0, deleted: 0, years: [] };
  if (mode === 'off') { result.reason = 'disabled'; return result; }
  if (!summary) { result.reason = 'no_voucher_list'; return result; }
  if (!summary.complete) { result.reason = summary.reason || 'incomplete'; return result; }
  if (!companyGuid || !uploadId) { result.reason = 'missing_identity'; return result; }
  if (!syncRunId || !UUID_RE.test(String(syncRunId))) { result.reason = 'no_sync_run'; return result; }

  await client.query(`SELECT pg_advisory_xact_lock(hashtext('voucher_reconcile:' || $1::text))`, [companyId]);
  const { rows: up } = await client.query(
    `SELECT u.created_at AS upload_start,
            (SELECT EXTRACT(EPOCH FROM r.started_at)::bigint FROM sync_runs r WHERE r.id = $2::uuid) AS run_start
       FROM ingest_uploads u WHERE u.id = $1`,
    [uploadId, syncRunId]
  );
  const uploadStart = Number(up[0]?.upload_start);
  const runStart = Number(up[0]?.run_start);
  if (!Number.isFinite(uploadStart) || uploadStart <= 0) { result.reason = 'upload_not_found'; return result; }
  if (!Number.isFinite(runStart) || runStart <= 0 || up[0]?.run_start == null) { result.reason = 'sync_run_not_found'; return result; }
  const cutoff = Math.min(uploadStart, runStart);

  const prefix = `${companyGuid}-`;
  const missing = [];
  for (const y of summary.years) {
    const { rows } = await client.query(
      `SELECT guid FROM vouchers
        WHERE company_id = $1
          AND left(guid, $2) = $3
          AND COALESCE(is_cancelled, FALSE) = FALSE
          AND COALESCE(synced_at, 0) < $4
          AND ((date >= $5 AND date <= $6)
               OR (COALESCE(date, '') = '' AND raw_data LIKE $7))`,
      [companyId, prefix.length, prefix, cutoff, y.from, y.to,
        `%"YEAR_ID":"${likeEscape(`${companyGuid}_${y.finYear}`)}"%`]
    );
    const gone = rows.map((r) => r.guid).filter((g) => !y.ids.has(g.slice(prefix.length)));
    result.years.push({ finYear: y.finYear, held: rows.length, inTally: y.ids.size, missing: gone.length });
    if (gone.length > MASS_MIN && gone.length > rows.length * MASS_SHARE) {
      result.reason = `mass_delete_guard:${y.finYear}`;
      result.missing = gone.length;
      return result;
    }
    missing.push(...gone);
  }

  result.missing = missing.length;
  if (!missing.length) { result.action = 'none'; return result; }
  if (mode === 'dry_run') { result.action = 'dry_run'; return result; }

  for (const table of VOUCHER_CHILD_TABLES) {
    await client.query('SAVEPOINT voucher_child');
    try {
      await client.query(`DELETE FROM ${table} WHERE company_id = $1 AND voucher_guid = ANY($2::text[])`, [companyId, missing]);
      await client.query('RELEASE SAVEPOINT voucher_child');
    } catch (err) {
      // Older databases may lack a child table or its company_id column.
      if (err.code !== '42P01' && err.code !== '42703') throw err;
      await client.query('ROLLBACK TO SAVEPOINT voucher_child');
    }
  }
  const del = await client.query(
    'DELETE FROM vouchers WHERE company_id = $1 AND guid = ANY($2::text[])',
    [companyId, missing]
  );
  result.deleted = del.rowCount || 0;
  result.action = 'deleted';
  return result;
}

/** reconcileDeletedVouchers in its own transaction; any error rolls back and keeps every voucher. */
export async function reconcileDeletedVouchersTx(args) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await reconcileDeletedVouchers(client, args);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { action: 'kept', reason: `reconcile_failed: ${err.message}`, missing: 0, deleted: 0, years: [] };
  } finally {
    client.release();
  }
}
