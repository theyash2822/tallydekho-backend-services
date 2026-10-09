/**
 * Last verified successful sync for a device, in epoch seconds (null if none).
 * companies.synced_at is written only when an upload completes with verified success
 * (routes/ingest.js /ingest/complete). devices.last_seen is registration/heartbeat
 * time and must never be reported as a sync.
 */
export async function lastSuccessfulSyncSecs(q, deviceId, workspaceId = null) {
  if (!deviceId) return null;
  const { rows } = await q(
    `SELECT MAX(synced_at) AS at FROM companies
      WHERE device_id = $1 AND ($2::text IS NULL OR workspace_id::text = $2::text)`,
    [deviceId, workspaceId == null ? null : String(workspaceId)],
  );
  const at = Number(rows[0]?.at);
  return Number.isFinite(at) && at > 0 ? at : null;
}

export const secsToIso = (secs) => (secs ? new Date(Number(secs) * 1000).toISOString() : null);
