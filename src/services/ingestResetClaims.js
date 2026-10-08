/**
 * Durable "reset once per upload" claims (findings X8, X12).
 *
 * Some ingest paths replace a set of rows (a voucher's flat stock/ledger lines, a company's legacy
 * bill snapshot) by deleting before inserting. When that set spans several chunks of one upload,
 * only the first chunk may delete; later chunks append. The claim lives in the database, inside the
 * caller's transaction, so it survives restarts, is shared by every worker, and is released when
 * the caller rolls back. A retry of the chunk that made the claim may reset again (same chunk key),
 * which keeps chunk retries idempotent.
 *
 * Without an upload id the caller resets every time (older clients; unchanged behaviour).
 */
export const RESET_CLAIM_RETENTION_SECONDS = 2 * 24 * 60 * 60;

/**
 * @param {{ query: Function }} client open transaction
 * @returns {Promise<string[]>} the keys this call may reset
 */
export async function claimResets(client, { uploadId, companyId, kind, keys, chunkKey = null }) {
  const list = [...new Set((keys || []).map((k) => String(k ?? '')))];
  if (!list.length) return [];
  if (!uploadId || companyId == null) return list;
  const { rows } = await client.query(
    `INSERT INTO ingest_reset_claims (upload_id, company_id, kind, item_key, chunk_key)
     SELECT $1, $2, $3, k, $5 FROM unnest($4::text[]) AS k
     ON CONFLICT (upload_id, company_id, kind, item_key) DO UPDATE
       SET claimed_at = ingest_reset_claims.claimed_at
       WHERE ingest_reset_claims.chunk_key IS NOT DISTINCT FROM EXCLUDED.chunk_key
     RETURNING item_key`,
    [String(uploadId), companyId, kind, list, chunkKey]
  );
  return rows.map((r) => r.item_key);
}

export async function sweepOldResetClaims(q) {
  const { rowCount } = await q(
    `DELETE FROM ingest_reset_claims WHERE claimed_at < NOW() - make_interval(secs => $1)`,
    [RESET_CLAIM_RETENTION_SECONDS]
  );
  return rowCount || 0;
}
