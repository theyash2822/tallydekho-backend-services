/**
 * app_masters — lifecycle tracking for non-voucher Tally writes
 * (party/ledger, bank, warehouse, stock item).
 *
 * Posted rule (unlike vouchers): books_impact_status flips to 'posted'
 * only after ingest confirms the master exists in the synced table.
 */
import { query } from '../db/schema.js';

export const MASTER_ENTRY_TYPES = ['party', 'bank', 'warehouse', 'item', 'alter_stock_item'];

/**
 * Insert app_masters row right after write_queue insert.
 * Always regular — masters have no optional voucher semantics.
 */
export async function insertAppMaster({
  companyGuid,
  userId,
  writeQueueId,
  masterType,
  masterName,
  payload,
}) {
  if (!writeQueueId || !companyGuid || !masterName) return null;
  try {
    const { rows } = await query(
      `INSERT INTO app_masters
         (company_guid, user_id, write_queue_id, master_type, master_name,
          tally_sync_status, books_impact_status, payload, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'queued','not_posted',$6,
               EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
       ON CONFLICT (write_queue_id) DO UPDATE SET
         master_name = EXCLUDED.master_name,
         payload     = EXCLUDED.payload,
         updated_at  = EXTRACT(EPOCH FROM NOW())::BIGINT
       RETURNING id`,
      [
        companyGuid,
        userId || null,
        writeQueueId,
        masterType,
        String(masterName).trim(),
        payload != null ? JSON.stringify(payload) : null,
      ]
    );
    return rows[0]?.id || null;
  } catch (e) {
    console.warn('[app_masters] insert failed:', e.message);
    return null;
  }
}

/** Mark master push failed (keeps not_posted). */
export async function markAppMasterFailed(writeQueueId, errorMessage) {
  if (!writeQueueId) return;
  await query(
    `UPDATE app_masters
        SET tally_sync_status   = 'failed',
            books_impact_status = 'not_posted',
            sync_error          = $2,
            updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE write_queue_id = $1`,
    [writeQueueId, String(errorMessage || '').slice(0, 500)]
  ).catch(() => {});
}

/**
 * Tally accepted the write — pushed, but NOT posted until ingest confirms.
 */
export async function markAppMasterPushed(writeQueueId) {
  if (!writeQueueId) return;
  await query(
    `UPDATE app_masters
        SET tally_sync_status = CASE
              WHEN tally_sync_status = 'synced' THEN 'synced'
              ELSE 'pushed'
            END,
            sync_error = NULL,
            updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE write_queue_id = $1
        AND books_impact_status = 'not_posted'`,
    [writeQueueId]
  ).catch(() => {});
}

/**
 * After ingest saves a master, confirm matching pending app_masters rows.
 * @param {string} companyGuid
 * @param {string} name — Tally master name
 * @param {string[]} masterTypes — e.g. ['party','bank'] for ledgers
 * @param {string|null} tallyGuid
 */
export async function confirmAppMasterFromIngest(companyGuid, name, masterTypes, tallyGuid = null) {
  if (!companyGuid || !name || !masterTypes?.length) return 0;
  try {
    const { rowCount } = await query(
      `UPDATE app_masters
          SET tally_guid          = COALESCE($4, tally_guid),
              tally_sync_status   = 'synced',
              books_impact_status = 'posted',
              sync_error          = NULL,
              updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE company_id=$1
          AND LOWER(master_name) = LOWER($2)
          AND master_type = ANY($3::text[])
          AND books_impact_status = 'not_posted'`,
      [companyGuid, String(name).trim(), masterTypes, tallyGuid || null]
    );
    return rowCount || 0;
  } catch (e) {
    console.warn('[app_masters] confirm failed:', e.message);
    return 0;
  }
}

/**
 * One-time / startup backfill of historical write_queue master rows + posted status.
 */
export async function backfillAppMasters(client) {
  const q = client?.query?.bind(client) || query;

  await q(`
    INSERT INTO app_masters
      (company_guid, user_id, write_queue_id, master_type, master_name,
       tally_sync_status, books_impact_status, payload, sync_error, created_at, updated_at)
    SELECT
      wq.company_id,
      wq.user_id,
      wq.id,
      wq.entry_type,
      COALESCE(NULLIF(TRIM(wq.entry_label), ''), 'Unknown'),
      CASE
        WHEN wq.status = 'success' THEN 'pushed'
        WHEN wq.status = 'failed'  THEN 'failed'
        WHEN wq.status IN ('pending','processing','desktop_offline') THEN 'queued'
        ELSE 'queued'
      END,
      'not_posted',
      wq.payload,
      wq.error_message,
      wq.created_at,
      COALESCE(wq.updated_at, wq.created_at)
    FROM write_queue wq
    WHERE wq.entry_type IN ('party','bank','warehouse','item','alter_stock_item')
      AND NOT EXISTS (
        SELECT 1 FROM app_masters am WHERE am.write_queue_id = wq.id
      )
  `).catch((e) => console.warn('[app_masters] backfill insert:', e.message));

  // Party / bank → posted when real Tally ledger GUID exists (company-prefixed)
  await q(`
    UPDATE app_masters am
       SET tally_guid          = l.guid,
           tally_sync_status   = 'synced',
           books_impact_status = 'posted',
           updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
      FROM ledgers l
     WHERE am.company_id = l.company_id
       AND LOWER(am.master_name) = LOWER(l.name)
       AND am.master_type IN ('party','bank')
       AND am.books_impact_status = 'not_posted'
       AND l.guid LIKE am.company_id || '%'
  `).catch((e) => console.warn('[app_masters] ledger posted backfill:', e.message));

  // Warehouse → posted when warehouse row has a Tally GUID
  await q(`
    UPDATE app_masters am
       SET tally_guid          = w.guid,
           tally_sync_status   = 'synced',
           books_impact_status = 'posted',
           updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
      FROM warehouses w
     WHERE am.company_id = w.company_id
       AND LOWER(am.master_name) = LOWER(w.name)
       AND am.master_type = 'warehouse'
       AND am.books_impact_status = 'not_posted'
       AND w.guid IS NOT NULL
       AND TRIM(w.guid) <> ''
  `).catch((e) => console.warn('[app_masters] warehouse posted backfill:', e.message));

  // Stock item / alter → posted when stock has company-prefixed GUID (real Tally)
  // OR any stocks row that is not a random UUID placeholder from immediate insert
  // (Tally GUIDs are typically companyGuid-########).
  await q(`
    UPDATE app_masters am
       SET tally_guid          = s.guid,
           tally_sync_status   = 'synced',
           books_impact_status = 'posted',
           updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
      FROM stocks s
     WHERE am.company_id = s.company_id
       AND LOWER(am.master_name) = LOWER(s.name)
       AND am.master_type IN ('item','alter_stock_item')
       AND am.books_impact_status = 'not_posted'
       AND (
         s.guid LIKE am.company_id || '%'
         OR s.guid LIKE '%' || am.company_id
       )
  `).catch((e) => console.warn('[app_masters] stock posted backfill:', e.message));
}
