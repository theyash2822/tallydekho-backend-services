import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { pickRetentionDeletes } from '../utils/tallyLineage.js';
import {
  createUploadAuthorization,
  createDownloadAuthorization,
  deleteObject,
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
  const backupId = uuid();
  const ts = now();
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
      upload.objectKey, sizeBytes || null, sha256 || null,
      desktopVersion || null, tallyVersion || null,
      JSON.stringify(companyManifest || []), ts,
    ]
  );
  await audit(workspace.id, null, 'backup.upload_session', { backupId });
  return { backupId, upload };
}

export async function completeBackup(workspaceId, backupId, { sizeBytes, sha256 } = {}) {
  const { rows } = await query(
    `SELECT * FROM workspace_backups WHERE id = $1 AND workspace_id = $2`,
    [backupId, workspaceId]
  );
  const backup = rows[0];
  if (!backup) {
    const err = new Error('Backup session not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (backup.status === 'AVAILABLE') return backup;
  if (sha256 && backup.sha256 && backup.sha256 !== sha256) {
    await query(`UPDATE workspace_backups SET status = 'FAILED' WHERE id = $1`, [backupId]);
    const err = new Error('Checksum mismatch');
    err.code = 'BACKUP_CHECKSUM_MISMATCH';
    err.httpStatus = 400;
    throw err;
  }
  const ts = now();
  await query(
    `UPDATE workspace_backups SET status = 'AVAILABLE', completed_at = $2,
       size_bytes = COALESCE($3, size_bytes), sha256 = COALESCE($4, sha256)
     WHERE id = $1`,
    [backupId, ts, sizeBytes || null, sha256 || null]
  );
  await enforceRetention(workspaceId);
  await audit(workspaceId, null, 'backup.completed', { backupId });
  const { rows: next } = await query('SELECT * FROM workspace_backups WHERE id = $1', [backupId]);
  return next[0];
}

export async function failBackup(workspaceId, backupId) {
  await query(
    `UPDATE workspace_backups SET status = 'FAILED' WHERE id = $1 AND workspace_id = $2 AND status <> 'AVAILABLE'`,
    [backupId, workspaceId]
  );
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
