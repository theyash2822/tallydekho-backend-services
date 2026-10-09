/**
 * Post-ingest stock convergence.
 * Opening Balance transactions are the source for stocks.opening_*.
 * Parent vouchers are the source for stock_transactions.voucher_type.
 */
import { query } from '../db/schema.js';
import { currentUploadId, currentChunkKey, ingestCompanyCtx } from './ingestCompanyDualWrite.js';
import { RESET_MARKER } from '../services/voucherWatermarks.js';

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

/**
 * Upload-wide running totals (collection_counts._cumulative[xml]) — summed across chunks,
 * unlike recordCollectionStat which keeps the last chunk. Used by voucher watermarks.
 */
export async function addCollectionTotals(xml, { saved = 0, rejected = 0 }) {
  const uploadId = currentUploadId();
  if (!uploadId || !xml) return;
  const chunkKey = currentChunkKey();
  const store = ingestCompanyCtx.getStore();
  try {
    if (chunkKey && store) {
      // Replay-safe: this chunk's contribution is stored under its key (accumulated for
      // this application only) and the totals are re-summed, so re-applying the same
      // chunk after a crash overwrites its share instead of adding it again.
      const acc = (store.chunkTotals ||= new Map());
      const cur = acc.get(xml) || { saved: 0, rejected: 0 };
      cur.saved += Math.max(0, Number(saved) || 0);
      cur.rejected += Math.max(0, Number(rejected) || 0);
      acc.set(xml, cur);
      await query(
        `WITH cur AS (
           SELECT COALESCE(collection_counts, '{}'::jsonb) AS cc FROM ingest_uploads WHERE id = $1 FOR UPDATE
         ), nxt AS (
           SELECT jsonb_set(
                    jsonb_set(cc, '{_chunks}', COALESCE(cc->'_chunks', '{}'::jsonb)),
                    ARRAY['_chunks', $2::text],
                    COALESCE(cc->'_chunks'->$2::text, '{}'::jsonb)
                      || jsonb_build_object($5::text, jsonb_build_object('saved', $3::bigint, 'rejected', $4::bigint))
                  ) AS cc
             FROM cur
         ), summed AS (
           SELECT nxt.cc,
                  (SELECT COALESCE(SUM((v->>'saved')::bigint), 0) FROM jsonb_each(nxt.cc->'_chunks'->$2::text) e(k, v)) AS s,
                  (SELECT COALESCE(SUM((v->>'rejected')::bigint), 0) FROM jsonb_each(nxt.cc->'_chunks'->$2::text) e(k, v)) AS r
             FROM nxt
         )
         UPDATE ingest_uploads u
            SET collection_counts = jsonb_set(
                  jsonb_set(summed.cc, '{_cumulative}', COALESCE(summed.cc->'_cumulative', '{}'::jsonb)),
                  ARRAY['_cumulative', $2::text],
                  jsonb_build_object('saved', summed.s, 'rejected', summed.r)
                )
           FROM summed
          WHERE u.id = $1`,
        [uploadId, String(xml), cur.saved, cur.rejected, chunkKey]
      );
      return;
    }
    await query(
      `UPDATE ingest_uploads
          SET collection_counts = jsonb_set(
                COALESCE(collection_counts, '{}'::jsonb),
                '{_cumulative}',
                COALESCE(collection_counts->'_cumulative', '{}'::jsonb) || jsonb_build_object(
                  $2::text, jsonb_build_object(
                    'saved',    COALESCE((collection_counts->'_cumulative'->$2->>'saved')::bigint, 0) + $3::bigint,
                    'rejected', COALESCE((collection_counts->'_cumulative'->$2->>'rejected')::bigint, 0) + $4::bigint
                  )
                )
              )
        WHERE id = $1`,
      [uploadId, String(xml), Math.max(0, Number(saved) || 0), Math.max(0, Number(rejected) || 0)]
    );
  } catch (e) {
    console.warn('[INGEST] collection totals persist failed:', e.message);
    // A lost rejection or reset marker would let voucher watermarks advance past missing rows.
    if (Number(rejected) > 0 || xml === RESET_MARKER) throw e;
  }
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
