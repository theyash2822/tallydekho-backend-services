/**
 * Post-ingest stock convergence.
 * Opening Balance transactions are the source for stocks.opening_*.
 * Parent vouchers are the source for stock_transactions.voucher_type.
 */
import { query } from '../db/schema.js';
import { currentUploadId } from './ingestCompanyDualWrite.js';

export async function reconcileStockOpeningsFromTransactions(companyId) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid)) return { updated: 0 };
  const { rowCount } = await query(
    `UPDATE stocks s
        SET opening_qty = src.qty,
            opening_rate = src.rate,
            opening_value = src.value
       FROM (
         SELECT st.company_id,
                st.stock_guid,
                SUM(ABS(st.qty)) AS qty,
                CASE
                  WHEN SUM(ABS(st.qty)) = 0 THEN 0
                  ELSE SUM(COALESCE(st.value, ABS(st.qty) * COALESCE(st.rate, 0)))
                       / NULLIF(SUM(ABS(st.qty)), 0)
                END AS rate,
                SUM(COALESCE(st.value, ABS(st.qty) * COALESCE(st.rate, 0))) AS value
           FROM stock_transactions st
          WHERE st.company_id = $1
            AND st.voucher_type = 'Opening Balance'
          GROUP BY st.company_id, st.stock_guid
       ) src
      WHERE s.company_id = src.company_id
        AND s.name = src.stock_guid`,
    [cid]
  );
  console.log(`[INGEST] Stock opening reconcile: updated ${rowCount} stocks for company_id=${cid}`);
  return { updated: rowCount || 0 };
}

export async function backfillStockMovementVoucherTypes(companyId) {
  const cid = Number(companyId);
  if (!Number.isFinite(cid)) return { updated: 0 };
  const { rowCount } = await query(
    `UPDATE stock_transactions st
        SET voucher_type = v.voucher_type
       FROM vouchers v
      WHERE st.voucher_guid = v.guid
        AND st.company_id = v.company_id
        AND st.company_id = $1
        AND (st.voucher_type IS NULL OR st.voucher_type = '')
        AND v.voucher_type IS NOT NULL
        AND v.voucher_type <> ''`,
    [cid]
  );
  console.log(`[INGEST] Movement voucher_type backfill: ${rowCount} rows for company_id=${cid}`);
  return { updated: rowCount || 0 };
}

export async function recordCollectionStat(xml, patch) {
  const uploadId = currentUploadId();
  if (!uploadId || !xml || !patch || typeof patch !== 'object') return;
  try {
    await query(
      `UPDATE ingest_uploads
          SET collection_counts = jsonb_set(
                COALESCE(collection_counts, '{}'::jsonb),
                ARRAY[$2],
                COALESCE(collection_counts->$2, '{}'::jsonb) || $3::jsonb
              )
        WHERE id = $1`,
      [uploadId, String(xml), JSON.stringify(patch)]
    );
  } catch (e) {
    console.warn('[INGEST] collection_counts persist failed:', e.message);
  }
}
