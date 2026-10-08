/**
 * Hard sync without delete-first.
 *
 * init-sync no longer purges. It consumes one approval (bound to device, workspace, company set and
 * a finite expiry) and opens a `hard_sync_jobs` row per company with the server start time and the
 * scope (selected FYs, or the whole company for a GUID replacement). The desktop then fetches every
 * selected FY in full; uploads upsert as in a normal sync, so the last dataset stays readable.
 *
 * Publication runs at /ingest/complete for that company, in one transaction, only when the upload
 * is a verified success and Tally's voucher list for the company was complete: rows in scope that
 * this run did not re-observe (written before the job started) are removed. App placeholders,
 * app-owned tables, bills (staged snapshot) and data outside the scope are never touched.
 * A failed, cancelled or expired job publishes nothing.
 */
import { v4 as uuid } from 'uuid';
import { VOUCHER_CHILD_TABLES } from './voucherDeletion.js';

export const APPROVAL_TTL_SECONDS = 30 * 60;
export const JOB_LEASE_SECONDS = 6 * 60 * 60;
// DB-clock (timestamptz) columns are compared with a margin so app/DB clock skew keeps rows, never drops them.
export const DB_CLOCK_MARGIN_SECONDS = 300;

const FY_RE = /^\d{4}-\d{4}$/;
const ISO = (d) => {
  const s = String(d || '').replace(/-/g, '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
};

export class HardSyncError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function manifestGuids(manifest) {
  const list = Array.isArray(manifest) ? manifest : [];
  return [...new Set(list.map((c) => String(c?.guid || c?.id || '').trim()).filter(Boolean))].sort();
}

const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Selected FYs → publication scope. Null when a year is unusable (caller then refuses the job). */
export function scopeFromYears(years) {
  const out = [];
  for (const y of Array.isArray(years) ? years : []) {
    const finYear = String(y?.finYear || y?.fin_year || '');
    const from = ISO(y?.begin || y?.beginDate);
    const to = ISO(y?.end || y?.endDate);
    if (!FY_RE.test(finYear) || !from || !to || from > to) return null;
    out.push({ finYear, from, to });
  }
  return out.length ? { all: false, years: out } : null;
}

/**
 * Validate and consume exactly one approval for this init-sync. Repeating the same init-sync while
 * its jobs are still open returns the same request (idempotent) instead of needing a new approval.
 * @returns {Promise<{ request: object, reused: boolean }>}
 */
export async function consumeHardSyncApproval(q, { workspaceId, deviceId, companies, membershipCount, nowSec }) {
  const guids = manifestGuids(companies);
  if (!guids.length) throw new HardSyncError('HARD_SYNC_SCOPE_EMPTY', 'Hard Sync needs at least one company.', 400);

  const { rows: open } = await q(
    `SELECT r.* FROM hard_sync_requests r
      WHERE r.workspace_id = $1 AND r.device_id = $2 AND r.status = 'EXECUTED'
        AND EXISTS (SELECT 1 FROM hard_sync_jobs j WHERE j.request_id = r.id AND j.status = 'preparing'
                     AND j.started_at > $3)
      ORDER BY r.created_at DESC LIMIT 1`,
    [workspaceId, deviceId, nowSec - JOB_LEASE_SECONDS]
  );
  if (open[0] && sameSet(manifestGuids(open[0].company_manifest_json), guids)) {
    return { request: open[0], reused: true };
  }

  let { rows } = await q(
    `SELECT * FROM hard_sync_requests
      WHERE workspace_id = $1 AND device_id = $2 AND status = 'APPROVED'
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, deviceId]
  );
  let req = rows[0];
  if (!req) {
    if ((await membershipCount(workspaceId)) > 1) {
      throw new HardSyncError('HARD_SYNC_APPROVAL_REQUIRED', 'Owner/Admin approval is required before Hard Sync.', 403);
    }
    // One-member workspace: self-approval policy, still bound to this scope and consumed once.
    const id = uuid();
    await q(
      `INSERT INTO hard_sync_requests
         (id, workspace_id, device_id, operation, status, company_manifest_json, created_at, decided_at, expires_at)
       VALUES ($1,$2,$3,'REBUILD','APPROVED',$4,$5,$5,$6)`,
      [id, workspaceId, deviceId, JSON.stringify(guids.map((guid) => ({ guid }))), nowSec, nowSec + APPROVAL_TTL_SECONDS]
    );
    ({ rows } = await q('SELECT * FROM hard_sync_requests WHERE id = $1', [id]));
    req = rows[0];
  }

  if (req.expires_at != null && Number(req.expires_at) <= nowSec) {
    await q(`UPDATE hard_sync_requests SET status = 'EXPIRED' WHERE id = $1 AND status = 'APPROVED'`, [req.id]);
    throw new HardSyncError('HARD_SYNC_EXPIRED', 'Hard Sync approval expired. Request approval again.');
  }
  const approved = manifestGuids(req.company_manifest_json);
  if (approved.length && !sameSet(approved, guids)) {
    throw new HardSyncError('HARD_SYNC_SCOPE_MISMATCH', 'The selected companies differ from the approved Hard Sync request.');
  }

  const { rows: consumed } = await q(
    `UPDATE hard_sync_requests SET status = 'EXECUTED', consumed_at = $2
      WHERE id = $1 AND status = 'APPROVED' AND (expires_at IS NULL OR expires_at > $2)
      RETURNING *`,
    [req.id, nowSec]
  );
  if (!consumed[0]) throw new HardSyncError('HARD_SYNC_ALREADY_CONSUMED', 'This Hard Sync approval was already used.');
  return { request: consumed[0], reused: false };
}

/** One job per (request, company); a repeated init-sync keeps the original start time. */
export async function openHardSyncJob(q, { request, workspaceId, deviceId, companyId, companyGuid, years, nowSec }) {
  const scope = request.operation === 'GUID_REPLACEMENT'
    ? { all: true, years: [], oldGuid: request.old_guid || null }
    : scopeFromYears(years);
  if (!scope) throw new HardSyncError('HARD_SYNC_SCOPE_INVALID', 'Hard Sync needs valid financial years for every company.', 400);
  await q(
    `INSERT INTO hard_sync_jobs (id, request_id, workspace_id, device_id, company_id, company_guid, scope_json, status, started_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'preparing',$8)
     ON CONFLICT (request_id, company_id) DO NOTHING`,
    [uuid(), request.id, workspaceId, deviceId, companyId, companyGuid, JSON.stringify(scope), nowSec]
  );
  const { rows } = await q('SELECT * FROM hard_sync_jobs WHERE request_id = $1 AND company_id = $2', [request.id, companyId]);
  return rows[0];
}

const MASTER_TABLES = [
  // [table, clock, tallyGuidOnly]
  ['ledgers', 'epoch', true],
  ['stocks', 'epoch', true],
  ['groups', 'epoch', true],
  ['warehouses', 'epoch', false],
  ['units', 'epoch', false],
  ['currencies', 'epoch', false],
  ['voucher_types', 'epoch', false],
  ['stock_categories', 'db', false],
];
const FY_TABLES = [
  ['ledger_fy_balances', 'db'],
  ['stock_fy_valuation', 'epoch'],
];

const staleClause = (clock, param) => (clock === 'db'
  ? `(synced_at IS NULL OR synced_at < to_timestamp(${param}::bigint - ${DB_CLOCK_MARGIN_SECONDS}))`
  : `COALESCE(synced_at, 0) < ${param}::bigint`);

async function guarded(client, sql, params) {
  await client.query('SAVEPOINT hs_pub');
  try {
    const r = await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT hs_pub');
    return r.rowCount || 0;
  } catch (err) {
    // Older databases may lack a projection table or column.
    if (err.code !== '42P01' && err.code !== '42703') throw err;
    await client.query('ROLLBACK TO SAVEPOINT hs_pub');
    return 0;
  }
}

/**
 * Decide and (when allowed) publish the company's replacement on an open transaction.
 * @returns {Promise<{ action: 'published'|'failed'|'abandoned'|'none'|'already', reason: string|null, jobId?: string, removed?: object }>}
 */
export async function publishHardSync(client, { deviceId, companyId, companyGuid, verified, voucherList, nowSec }) {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('voucher_reconcile:' || $1::text))`, [companyId]);
  const { rows } = await client.query(
    `SELECT * FROM hard_sync_jobs
      WHERE company_id = $1 AND device_id = $2 AND status IN ('preparing','published')
      ORDER BY started_at DESC LIMIT 1 FOR UPDATE`,
    [companyId, deviceId]
  );
  const job = rows[0];
  if (!job) return { action: 'none', reason: 'no_hard_sync_job' };
  if (job.status === 'published') return { action: 'already', reason: null, jobId: job.id };

  const finish = async (status, reason, result = null) => {
    await client.query(
      `UPDATE hard_sync_jobs SET status = $2, finished_at = $3, reason = $4, result_json = $5 WHERE id = $1`,
      [job.id, status, nowSec, reason, result ? JSON.stringify(result) : null]
    );
    return { action: status, reason, jobId: job.id, ...(result ? { removed: result } : {}) };
  };

  if (Number(job.started_at) + JOB_LEASE_SECONDS < nowSec) return finish('abandoned', 'lease_expired');
  if (!verified) return finish('failed', 'upload_not_verified');
  if (!voucherList?.complete) return finish('failed', `voucher_list_incomplete:${voucherList?.reason || 'missing'}`);

  const scope = job.scope_json || {};
  const started = Number(job.started_at);
  const prefix = `${companyGuid}-`;
  const removed = {};

  // A voucher goes only when Tally's complete list for its FY no longer has it; cancelled vouchers
  // are absent from that list by design and stay (finding 07).
  const listed = new Map((voucherList.years || []).map((y) => [y.finYear, y]));
  const years = scope.all ? [...listed.values()] : scope.years;
  const voucherGuids = [];
  const unlisted = [];
  for (const y of years) {
    const list = listed.get(y.finYear);
    if (!list) { unlisted.push(y.finYear); continue; }
    const { rows: stale } = await client.query(
      `SELECT guid FROM vouchers
        WHERE company_id = $1 AND left(guid, $2) = $3 AND COALESCE(is_cancelled, FALSE) = FALSE
          AND COALESCE(synced_at, 0) < $4 AND date >= $5 AND date <= $6`,
      [companyId, prefix.length, prefix, started, y.from, y.to]
    );
    for (const { guid } of stale) if (!list.ids.has(guid.slice(prefix.length))) voucherGuids.push(guid);
  }
  if (unlisted.length) removed.vouchers_kept_unlisted_years = unlisted;
  if (scope.oldGuid) {
    const oldPrefix = `${scope.oldGuid}-`;
    const { rows: old } = await client.query(
      'SELECT guid FROM vouchers WHERE company_id = $1 AND left(guid, $2) = $3',
      [companyId, oldPrefix.length, oldPrefix]
    );
    voucherGuids.push(...old.map((r) => r.guid));
  }
  if (voucherGuids.length) {
    for (const table of VOUCHER_CHILD_TABLES) {
      removed[table] = await guarded(client,
        `DELETE FROM ${table} WHERE company_id = $1 AND voucher_guid = ANY($2::text[])`, [companyId, voucherGuids]);
    }
    removed.vouchers = await guarded(client,
      'DELETE FROM vouchers WHERE company_id = $1 AND guid = ANY($2::text[])', [companyId, voucherGuids]);
  }

  // A table where this run re-observed nothing is kept whole: an export that silently returned no
  // rows must not read as "everything was deleted in Tally".
  const sweep = async (table, clock, filter, params) => {
    const stale = staleClause(clock, '$2');
    let counted = null;
    await client.query('SAVEPOINT hs_count');
    try {
      const { rows: c } = await client.query(
        `SELECT COUNT(*) FILTER (WHERE ${stale})::int AS stale, COUNT(*) FILTER (WHERE NOT (${stale}))::int AS fresh
           FROM ${table} WHERE company_id = $1 ${filter}`, params);
      await client.query('RELEASE SAVEPOINT hs_count');
      counted = c[0];
    } catch (err) {
      if (err.code !== '42P01' && err.code !== '42703') throw err;
      await client.query('ROLLBACK TO SAVEPOINT hs_count');
    }
    if (!counted || counted.stale === 0) return 0;
    if (counted.fresh === 0) return `kept:no_rows_this_run(${counted.stale})`;
    return guarded(client, `DELETE FROM ${table} WHERE company_id = $1 AND ${stale} ${filter}`, params);
  };

  for (const [table, clock] of FY_TABLES) {
    if (scope.all) {
      removed[table] = await sweep(table, clock, '', [companyId, started]);
      continue;
    }
    removed[table] = {};
    for (const y of scope.years) {
      removed[table][y.finYear] = await sweep(table, clock, 'AND financial_year = $3', [companyId, started, y.finYear]);
    }
  }

  for (const [table, clock, tallyGuidOnly] of MASTER_TABLES) {
    removed[table] = tallyGuidOnly
      ? await sweep(table, clock, 'AND left(guid, $3) = $4', [companyId, started, prefix.length, prefix])
      : await sweep(table, clock, '', [companyId, started]);
    if (tallyGuidOnly && scope.oldGuid) {
      const oldPrefix = `${scope.oldGuid}-`;
      removed[`${table}_old_company`] = await guarded(client,
        `DELETE FROM ${table} WHERE company_id = $1 AND left(guid, $2) = $3`, [companyId, oldPrefix.length, oldPrefix]);
    }
  }
  if (scope.oldGuid) {
    // Bills of the replaced Tally company; the new company's snapshot (applied earlier in the same
    // /ingest/complete) was written after the job started.
    removed.bill_outstanding_old_company = await guarded(client,
      'DELETE FROM bill_outstanding WHERE company_id = $1 AND COALESCE(synced_at, 0) < $2', [companyId, started]);
  }
  removed.ai_insights_cache = await guarded(client, 'DELETE FROM ai_insights_cache WHERE company_id = $1', [companyId]);

  return finish('published', null, removed);
}

/** publishHardSync in its own transaction; an error rolls everything back and keeps the live data. */
export async function publishHardSyncTx(getClient, args) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await publishHardSync(client, args);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return { action: 'kept', reason: `publish_failed: ${err.message}` };
  } finally {
    client.release();
  }
}

/** Jobs whose lease ran out can never publish later. */
export async function sweepExpiredHardSyncJobs(q, nowSec) {
  const { rowCount } = await q(
    `UPDATE hard_sync_jobs SET status = 'abandoned', finished_at = $1, reason = 'lease_expired'
      WHERE status = 'preparing' AND started_at < $2`,
    [nowSec, nowSec - JOB_LEASE_SECONDS]
  );
  return rowCount || 0;
}
