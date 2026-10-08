/**
 * sync_runs lifecycle: a run belongs to the device that started it, stays alive through
 * heartbeats, and reaches exactly one terminal status. Runs whose lease lapses are swept to
 * 'abandoned' so a crashed desktop never leaves a run 'running' forever.
 */

export const SYNC_RUN_LEASE_SECONDS = 15 * 60;
export const SYNC_RUN_TERMINAL_STATUSES = Object.freeze(['completed', 'partial', 'failed']);

/** Client-reported terminal status, or null when it is not one the server accepts. */
export function normalizeTerminalStatus(status) {
  const s = String(status ?? 'completed').trim().toLowerCase();
  return SYNC_RUN_TERMINAL_STATUSES.includes(s) ? s : null;
}

/** Marks runs whose last heartbeat is older than the lease as abandoned. Returns the count. */
export async function sweepStaleSyncRuns(q, { companyGuid = null, leaseSeconds = SYNC_RUN_LEASE_SECONDS } = {}) {
  const { rowCount } = await q(
    `UPDATE sync_runs
        SET status = 'abandoned',
            completed_at = NOW(),
            error_message = COALESCE(error_message, 'lease expired without heartbeat')
      WHERE status = 'running'
        AND COALESCE(heartbeat_at, started_at) < NOW() - make_interval(secs => $1)
        AND ($2::text IS NULL OR company_guid = $2)`,
    [leaseSeconds, companyGuid]
  );
  return rowCount || 0;
}

export async function startSyncRun(q, { companyGuid, companyId, deviceId, syncType, expectedCounts }) {
  await sweepStaleSyncRuns(q, { companyGuid });
  const { rows } = await q(
    `INSERT INTO sync_runs (company_guid, company_id, device_id, sync_type, status, expected_counts, started_at, heartbeat_at)
     VALUES ($1, $2, $3, $4, 'running', $5, NOW(), NOW()) RETURNING id`,
    [companyGuid, companyId, deviceId, syncType === 'hard' ? 'hard' : 'normal',
      expectedCounts ? JSON.stringify(expectedCounts) : null]
  );
  return rows[0].id;
}

/** Extends the lease. Returns false when the run is not this device's running run. */
export async function heartbeatSyncRun(q, { syncRunId, deviceId }) {
  const { rowCount } = await q(
    `UPDATE sync_runs SET heartbeat_at = NOW()
      WHERE id = $1 AND device_id = $2 AND status = 'running'`,
    [syncRunId, deviceId]
  );
  return rowCount > 0;
}

/**
 * Fenced terminal transition: only the owning device, only from 'running'.
 * Returns { ok:true } or { ok:false, reason:'not_found'|'not_owner'|'not_running', status }.
 */
export async function finishSyncRun(q, { syncRunId, deviceId, status, recordCounts, uploadId, errorMessage }) {
  const { rowCount } = await q(
    `UPDATE sync_runs
        SET status = $1, record_counts = $2, upload_id = $3, error_message = $4, completed_at = NOW()
      WHERE id = $5 AND device_id = $6 AND status = 'running'`,
    [status, recordCounts ? JSON.stringify(recordCounts) : null, uploadId || null,
      errorMessage ? String(errorMessage).slice(0, 1000) : null, syncRunId, deviceId]
  );
  if (rowCount > 0) return { ok: true };
  const { rows } = await q(`SELECT device_id, status FROM sync_runs WHERE id = $1`, [syncRunId]);
  if (!rows[0]) return { ok: false, reason: 'not_found' };
  if (rows[0].device_id !== deviceId) return { ok: false, reason: 'not_owner' };
  return { ok: false, reason: 'not_running', status: rows[0].status };
}

/** Ingest warnings that describe the company's data rather than a lost or failed import. */
export const ADVISORY_SYNC_WARNING_CODES = Object.freeze(new Set([
  'inventory_collection_empty',
  'groups_empty',
  'warehouses_empty',
]));

/** A sync is a verified success only when no warning reports lost or failed data. */
export function isVerifiedSyncSuccess(warnings) {
  return (Array.isArray(warnings) ? warnings : []).every((w) => ADVISORY_SYNC_WARNING_CODES.has(w?.code));
}
