import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { pickRetentionDeletes } from '../utils/tallyLineage.js';
import {
  createUploadAuthorization,
  createDownloadAuthorization,
  deleteObject,
  inspectStoredObject,
} from './objectStore.js';

const now = () => Math.floor(Date.now() / 1000);

export async function createBackupSession({
  workspace,
  deviceId,
  sizeBytes,
  sha256,
  desktopVersion,
  tallyVersion,
  companyManifest,
}) {
  if (!/^[0-9a-f]{64}$/i.test(String(sha256 || '')) || !(Number(sizeBytes) > 0)) {
    throw backupError('BACKUP_MANIFEST_INVALID', 'Backup size and SHA-256 are required', 400);
  }
  const backupId = uuid();
  const ts = now();
  await sweepAbandonedBackups(workspace.id, ts).catch(() => {});
  const upload = await createUploadAuthorization({
    workspaceId: workspace.id,
    backupId,
    sizeBytes,
  });
  await query(
    `INSERT INTO workspace_backups
       (id, workspace_id, setup_generation, source_device_id, status, object_key, size_bytes, sha256,
        format_version, desktop_version, tally_version, company_manifest_json, created_at)
     VALUES ($1,$2,$3,$4,'UPLOADING',$5,$6,$7,'1',$8,$9,$10,$11)`,
    [
      backupId, workspace.id, workspace.setup_generation || 1, deviceId,
      upload.objectKey, Number(sizeBytes), String(sha256).toLowerCase(),
      desktopVersion || null, tallyVersion || null,
      JSON.stringify(companyManifest || []), ts,
    ]
  );
  await audit(workspace.id, null, 'backup.upload_session', { backupId });
  return { backupId, upload };
}

export const UPLOAD_ABANDON_SECONDS = 6 * 60 * 60;

const backupError = (code, message, httpStatus) => Object.assign(new Error(message), { code, httpStatus });

/**
 * Verify what was actually stored (N6): size and SHA-256 of the stored bytes must equal what the
 * session declared before the upload. The client's completion claim alone proves nothing.
 * Idempotent: an AVAILABLE backup is returned as is; FAILED/ABANDONED stay terminal.
 */
export async function completeBackup(workspaceId, backupId, { sizeBytes, sha256 } = {}, { deviceId = null, inspect = inspectStoredObject } = {}) {
  const { rows } = await query(
    `SELECT * FROM workspace_backups WHERE id = $1 AND workspace_id = $2`,
    [backupId, workspaceId]
  );
  const backup = rows[0];
  if (!backup) throw backupError('NOT_FOUND', 'Backup session not found', 404);
  if (deviceId && backup.source_device_id && backup.source_device_id !== deviceId) {
    throw backupError('NOT_FOUND', 'Backup session not found', 404);
  }
  if (backup.status === 'AVAILABLE') return backup;
  if (backup.status !== 'UPLOADING' && backup.status !== 'VERIFYING') {
    throw backupError('BACKUP_NOT_UPLOADING', `Backup is ${backup.status}`, 409);
  }
  const declaredSha = backup.sha256 || null;
  const declaredSize = backup.size_bytes != null ? Number(backup.size_bytes) : null;
  if ((sha256 && declaredSha && sha256 !== declaredSha) || (sizeBytes && declaredSize && Number(sizeBytes) !== declaredSize)) {
    await query(`UPDATE workspace_backups SET status = 'FAILED' WHERE id = $1 AND status IN ('UPLOADING','VERIFYING')`, [backupId]);
    throw backupError('BACKUP_CHECKSUM_MISMATCH', 'Checksum mismatch', 400);
  }
  await query(`UPDATE workspace_backups SET status = 'VERIFYING' WHERE id = $1 AND status = 'UPLOADING'`, [backupId]);
  const stored = await inspect(backup.object_key);
  const expectedSha = declaredSha || sha256 || null;
  const expectedSize = declaredSize ?? (sizeBytes ? Number(sizeBytes) : null);
  const problem = !stored ? 'BACKUP_OBJECT_MISSING'
    : !expectedSha ? 'BACKUP_CHECKSUM_UNKNOWN'
    : stored.sha256 !== expectedSha ? 'BACKUP_CHECKSUM_MISMATCH'
    : expectedSize != null && stored.size !== expectedSize ? 'BACKUP_SIZE_MISMATCH'
    : null;
  if (problem) {
    if (problem === 'BACKUP_OBJECT_MISSING') {
      // Upload may still be in flight; stay UPLOADING so a later completion can verify.
      await query(`UPDATE workspace_backups SET status = 'UPLOADING' WHERE id = $1 AND status = 'VERIFYING'`, [backupId]);
      throw backupError(problem, 'Backup upload not found yet', 409);
    }
    await query(`UPDATE workspace_backups SET status = 'FAILED' WHERE id = $1 AND status = 'VERIFYING'`, [backupId]);
    await deleteObject(backup.object_key).catch(() => {});
    await audit(workspaceId, null, 'backup.verify_failed', { backupId, code: problem });
    throw backupError(problem, 'Stored backup did not match what was uploaded', 400);
  }
  const ts = now();
  const { rows: done } = await query(
    `UPDATE workspace_backups SET status = 'AVAILABLE', completed_at = $2, size_bytes = $3, sha256 = $4
     WHERE id = $1 AND status = 'VERIFYING' RETURNING *`,
    [backupId, ts, stored.size, stored.sha256]
  );
  if (!done[0]) {
    const { rows: cur } = await query('SELECT * FROM workspace_backups WHERE id = $1', [backupId]);
    if (cur[0]?.status === 'AVAILABLE') return cur[0];
    throw backupError('BACKUP_NOT_UPLOADING', `Backup is ${cur[0]?.status || 'missing'}`, 409);
  }
  await enforceRetention(workspaceId);
  await audit(workspaceId, null, 'backup.completed', { backupId });
  return done[0];
}

/** Desktop reports an upload it gave up on. Only the device that created the session may fail it. */
export async function failBackup(workspaceId, backupId, deviceId = null) {
  const { rows } = await query(
    `UPDATE workspace_backups SET status = 'FAILED'
      WHERE id = $1 AND workspace_id = $2 AND status IN ('UPLOADING','VERIFYING')
        AND ($3::text IS NULL OR source_device_id = $3)
      RETURNING object_key`,
    [backupId, workspaceId, deviceId]
  );
  if (rows[0]) await deleteObject(rows[0].object_key).catch(() => {});
  return { failed: rows.length > 0 };
}

/** Upload sessions nobody completed become ABANDONED and their partial objects are removed. */
export async function sweepAbandonedBackups(workspaceId, nowSec = now()) {
  const { rows } = await query(
    `UPDATE workspace_backups SET status = 'ABANDONED'
      WHERE workspace_id = $1 AND status = 'UPLOADING' AND created_at < $2
      RETURNING object_key`,
    [workspaceId, nowSec - UPLOAD_ABANDON_SECONDS]
  );
  for (const r of rows) await deleteObject(r.object_key).catch(() => {});
  return rows.length;
}

export async function listAvailableBackups(workspaceId, limit = 3) {
  const { rows } = await query(
    `SELECT id, workspace_id, setup_generation, source_device_id, status, size_bytes, sha256,
            format_version, desktop_version, tally_version, company_manifest_json, created_at, completed_at
     FROM workspace_backups
     WHERE workspace_id = $1 AND status = 'AVAILABLE' AND deleted_at IS NULL
     ORDER BY completed_at DESC
     LIMIT $2`,
    [workspaceId, limit]
  );
  return rows;
}

export async function getBackup(workspaceId, backupId) {
  const { rows } = await query(
    `SELECT * FROM workspace_backups WHERE id = $1 AND workspace_id = $2 AND status = 'AVAILABLE' AND deleted_at IS NULL`,
    [backupId, workspaceId]
  );
  return rows[0] || null;
}

export async function downloadAuthFor(backup) {
  return createDownloadAuthorization({ objectKey: backup.object_key });
}

export async function purgeWorkspaceCloudBackups(workspaceId) {
  const { rows } = await query(
    `SELECT id, object_key FROM workspace_backups
     WHERE workspace_id = $1 AND deleted_at IS NULL`,
    [workspaceId]
  );
  const ts = now();
  for (const b of rows) {
    await deleteObject(b.object_key).catch(() => {});
    await query(
      `UPDATE workspace_backups SET deleted_at = $2, status = 'DELETED' WHERE id = $1`,
      [b.id, ts]
    );
  }
  return rows.length;
}

async function enforceRetention(workspaceId) {
  const { rows } = await query(
    `SELECT id, object_key, completed_at, created_at FROM workspace_backups
     WHERE workspace_id = $1 AND status = 'AVAILABLE' AND deleted_at IS NULL`,
    [workspaceId]
  );
  const extras = pickRetentionDeletes(rows, 3);
  const ts = now();
  for (const b of extras) {
    await deleteObject(b.object_key);
    await query(
      `UPDATE workspace_backups SET deleted_at = $2, status = 'DELETED' WHERE id = $1`,
      [b.id, ts]
    );
  }
}
