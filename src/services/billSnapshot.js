/**
 * Bill Outstanding snapshot swap.
 *
 * A staged desktop upload (chunk header `Bill-Snapshot-Mode: staged`) parks its
 * bill rows in bill_outstanding_staging. On /ingest/complete the desktop reports
 * one summary per company: { companyGuid, status, snapshotComplete, rowCount }.
 *
 *   SUCCESS + complete + staged count matches → replace the company's bills
 *     (rowCount 0 clears them).
 *   anything else → keep the previous bills untouched.
 *
 * Staging is always discarded afterwards. Uploads from older desktops never send
 * the header and keep the legacy first-chunk purge in ingestProcessor.
 */
import { getClient, query } from '../db/schema.js';

export const STAGED_MODE = 'staged';
const STAGE_BATCH = 500;
const BILL_COLUMNS = [
  'voucher_guid', 'company_guid', 'ledger_name', 'bill_name', 'bill_date', 'due_date',
  'amount', 'pending_amount', 'bill_type', 'alter_id', 'synced_at',
];

export function isStagedMode(value) {
  return String(value || '').trim().toLowerCase() === STAGED_MODE;
}

/**
 * Per-company summaries from the /ingest/complete body, keyed by company GUID.
 * Malformed entries are dropped, which means "keep previous bills" for that company.
 * @returns {Map<string, { status: string, snapshotComplete: boolean, rowCount: number, tdlStatus: string|null, tdlVersion: string|null }>}
 */
export function parseBillSnapshots(body) {
  const out = new Map();
  const list = Array.isArray(body?.billSnapshots) ? body.billSnapshots : [];
  for (const s of list) {
    const guid = String(s?.companyGuid || '').trim();
    const rowCount = Number(s?.rowCount);
    if (!guid || typeof s?.status !== 'string' || !Number.isInteger(rowCount) || rowCount < 0) continue;
    out.set(guid, {
      status: s.status,
      snapshotComplete: s.snapshotComplete === true,
      rowCount,
      tdlStatus: typeof s.tdlStatus === 'string' ? s.tdlStatus : null,
      tdlVersion: typeof s.tdlVersion === 'string' ? s.tdlVersion : null,
    });
  }
  return out;
}

/**
 * Replace this chunk's staged rows (idempotent across chunk retries).
 * `rows` carry every received bill row; rows the live table would skip have skipped=true
 * so the staged total can be checked against the desktop's rowCount.
 */
export async function stageBillRows(client, { uploadId, companyId, chunkKey, rows }) {
  // A retry can arrive while the first attempt of the same chunk is still running.
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('bill_staging:' || $1::text || ':' || $2::text || ':' || $3::text))`,
    [uploadId, companyId, chunkKey]
  );
  await client.query(
    'DELETE FROM bill_outstanding_staging WHERE upload_id=$1 AND company_id=$2 AND chunk_key=$3',
    [uploadId, companyId, chunkKey]
  );
  const cols = ['upload_id', 'company_id', 'chunk_key', 'skipped', ...BILL_COLUMNS];
  for (let i = 0; i < rows.length; i += STAGE_BATCH) {
    const batch = rows.slice(i, i + STAGE_BATCH);
    const params = [];
    const tuples = batch.map((r) => {
      const values = [uploadId, companyId, chunkKey, !!r.skipped, ...BILL_COLUMNS.map((c) => r[c] ?? null)];
      const start = params.length;
      params.push(...values);
      return `(${values.map((_, j) => `$${start + j + 1}`).join(',')})`;
    });
    await client.query(
      `INSERT INTO bill_outstanding_staging (${cols.join(',')}) VALUES ${tuples.join(',')}`,
      params
    );
  }
  return rows.length;
}

/**
 * Decide and apply one company's snapshot on an open transaction.
 * @returns {Promise<{ action: 'replaced'|'cleared'|'preserved', reason: string|null, staged: number, expected: number|null, removed: number, inserted: number }>}
 */
export async function applyBillSnapshot(client, { uploadId, companyId, summary }) {
  // Lock before counting: a retried /ingest/complete must see the staging the first call already consumed.
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('bill_outstanding:' || $1::text))`, [companyId]);
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS total FROM bill_outstanding_staging WHERE upload_id=$1 AND company_id=$2`,
    [uploadId, companyId]
  );
  const staged = rows[0]?.total ?? 0;
  const expected = summary ? summary.rowCount : null;
  const result = { action: 'preserved', reason: null, staged, expected, removed: 0, inserted: 0 };

  if (!summary) {
    result.reason = 'no_snapshot_summary';
  } else if (summary.status !== 'SUCCESS' || summary.snapshotComplete !== true) {
    result.reason = summary.status === 'SUCCESS' ? 'snapshot_not_complete' : summary.status;
  } else if (staged !== summary.rowCount) {
    result.reason = 'staged_count_mismatch';
  } else {
    const del = await client.query('DELETE FROM bill_outstanding WHERE company_id=$1', [companyId]);
    const ins = await client.query(
      `INSERT INTO bill_outstanding (${BILL_COLUMNS.join(',')}, company_id)
       SELECT ${BILL_COLUMNS.join(',')}, company_id FROM bill_outstanding_staging
        WHERE upload_id=$1 AND company_id=$2 AND skipped = FALSE
        ORDER BY id`,
      [uploadId, companyId]
    );
    result.removed = del.rowCount || 0;
    result.inserted = ins.rowCount || 0;
    result.action = summary.rowCount === 0 ? 'cleared' : 'replaced';
  }

  await client.query(
    'DELETE FROM bill_outstanding_staging WHERE upload_id=$1 AND company_id=$2',
    [uploadId, companyId]
  );
  return result;
}

/** applyBillSnapshot in its own transaction. Any error rolls back and keeps the previous bills. */
export async function applyBillSnapshotTx({ uploadId, companyId, summary }) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await applyBillSnapshot(client, { uploadId, companyId, summary });
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    await query(
      'DELETE FROM bill_outstanding_staging WHERE upload_id=$1 AND company_id=$2',
      [uploadId, companyId]
    ).catch(() => {});
    return { action: 'preserved', reason: `swap_failed: ${err.message}`, staged: null, expected: summary?.rowCount ?? null, removed: 0, inserted: 0 };
  } finally {
    client.release();
  }
}

/** Uploads that never reached /ingest/complete leave staging behind. */
export async function cleanupStaleBillStaging(maxAgeHours = 24) {
  const { rowCount } = await query(
    `DELETE FROM bill_outstanding_staging WHERE created_at < NOW() - ($1::int * INTERVAL '1 hour')`,
    [maxAgeHours]
  );
  return rowCount || 0;
}
