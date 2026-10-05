/**
 * Per-FY voucher watermarks for incremental (normal) sync.
 *
 * The desktop asks Tally only for voucher rows with AlterId > watermark. The watermark
 * must never pass data we don't hold, so it is NOT simply MAX(vouchers.alter_id):
 *   - single-voucher post-write ingests store a voucher's real AlterId while older Tally
 *     entries (lower AlterIds) are still unsynced;
 *   - a full sync can silently miss rows (Tally request failed, batch rolled back).
 * Instead it only moves at /ingest/complete of a clean full sync, to the highest AlterId
 * Tally listed for that FY before the per-FY fetches ran. The effective value at
 * init-sync is min(stored watermark, MAX(alter_id) held), so a purge or deletion only
 * lowers it. No stored row → 0 (full FY fetch). Rows are dropped (→ full re-fetch) on
 * hard sync, workspace purge, Tally restore and master renames.
 * Only desktops that announce `watermarkSync` get these values; older ones keep the
 * legacy per-FY MAX because they still delta-fetch opening balances and stock items.
 */

const FY_RE = /^\d{4}-\d{4}$/;
// Saved rows are counted: every row sent must be saved and none rejected.
export const CHECKED_COLLECTIONS = ['AllVoucher.xml', 'StockTransaction.xml'];
// Only rolled-back / failed batches are recorded for these.
export const FAILURE_ONLY_COLLECTIONS = ['LedgerTransaction.xml', 'VoucherInventoryDetail.xml', 'GSTDetails.xml'];
// Set during an upload when a master rename was detected (old names live on in voucher rows).
export const RESET_MARKER = '_watermark_reset';

const toInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};

export async function readVoucherWatermarks(db, companyId) {
  const { rows } = await db.query(
    'SELECT fin_year, alter_id FROM voucher_sync_watermarks WHERE company_id = $1',
    [companyId]
  );
  return new Map(rows.map((r) => [r.fin_year, Number(r.alter_id)]));
}

/** Watermark sent to the desktop for one FY. */
export function effectiveWatermark(stored, heldMax) {
  if (stored == null) return 0;
  const held = toInt(heldMax) ?? 0;
  return Math.min(stored, held);
}

export async function clearVoucherWatermarks(db, companyId) {
  await db.query('DELETE FROM voucher_sync_watermarks WHERE company_id = $1', [companyId]);
}

/** Master GUIDs whose stored name differs from the incoming one (a rename in Tally). */
export async function findRenamedMasters(db, { table, companyId, rows }) {
  const incoming = new Map();
  for (const r of rows || []) {
    if (r?.guid && r?.name) incoming.set(String(r.guid), String(r.name));
  }
  if (!incoming.size) return [];
  const { rows: held } = await db.query(
    `SELECT guid, name FROM ${table} WHERE company_id = $1 AND guid = ANY($2::text[])`,
    [companyId, [...incoming.keys()]]
  );
  return held.filter((h) => h.name != null && incoming.get(h.guid) !== h.name).map((h) => h.guid);
}

/** body.voucherWatermarks: [{ companyGuid, years: [{ finYear, alterId }], sent: { 'AllVoucher.xml': n, ... } }] */
export function parseVoucherWatermarks(body) {
  const out = new Map();
  const list = Array.isArray(body?.voucherWatermarks) ? body.voucherWatermarks : [];
  for (const item of list) {
    const guid = typeof item?.companyGuid === 'string' ? item.companyGuid : null;
    if (!guid || !Array.isArray(item.years)) continue;
    const years = [];
    let valid = true;
    for (const y of item.years) {
      const alterId = toInt(y?.alterId);
      if (!FY_RE.test(String(y?.finYear || '')) || alterId == null) { valid = false; break; }
      years.push({ finYear: y.finYear, alterId });
    }
    const sent = {};
    for (const c of CHECKED_COLLECTIONS) {
      const n = toInt(item.sent?.[c]);
      if (n == null) valid = false;
      sent[c] = n;
    }
    if (valid) out.set(guid, { years, sent });
  }
  return out;
}

/**
 * Moves watermarks only when this upload provably saved every voucher row it carried.
 * @returns {{ action: 'advanced'|'kept', reason: string|null, years: number }}
 */
export async function applyVoucherWatermarks(db, { uploadId, companyId, summary, collectionCounts, outcome, nowSec }) {
  const kept = (reason) => ({ action: 'kept', reason, years: 0 });
  if (!summary) return kept('no_watermarks');
  if (outcome !== 'complete') return kept(`outcome_${outcome}`);
  const totals = collectionCounts?._cumulative || {};
  if (Number(totals[RESET_MARKER]?.saved) > 0) return kept('master_renamed');
  for (const c of CHECKED_COLLECTIONS) {
    const sent = summary.sent[c];
    if (!sent) continue;
    const stat = totals[c] || {};
    if (Number(stat.rejected) > 0) return kept(`rejected:${c}`);
    if (!(Number(stat.saved) >= sent)) return kept(`unsaved:${c}`);
  }
  for (const c of FAILURE_ONLY_COLLECTIONS) {
    if (Number(totals[c]?.rejected) > 0) return kept(`rejected:${c}`);
  }
  if (!summary.years.length) return kept('no_years');
  for (const { finYear, alterId } of summary.years) {
    await db.query(
      `INSERT INTO voucher_sync_watermarks (company_id, fin_year, alter_id, upload_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, fin_year) DO UPDATE SET
         alter_id = EXCLUDED.alter_id, upload_id = EXCLUDED.upload_id, updated_at = EXCLUDED.updated_at`,
      [companyId, finYear, alterId, uploadId || null, nowSec]
    );
  }
  return { action: 'advanced', reason: null, years: summary.years.length };
}
