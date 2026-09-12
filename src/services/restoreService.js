import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { generateShortCode, hashSecret, verifySecret, hashToken, generateDeviceSecret } from './deviceCredential.js';
import { listAvailableBackups, getBackup, downloadAuthFor } from './backupService.js';
import { getWorkspaceById, isOwnerOrAdmin } from './workspaceService.js';
import { lineageMatchesBackupManifest, lineageMatchesRestoredFolders } from '../utils/tallyLineage.js';

const now = () => Math.floor(Date.now() / 1000);
const REQUEST_TTL = 30 * 60;
const SESSION_TTL = 2 * 60 * 60;

export async function createRestoreRequest(newDeviceId) {
  const code = generateShortCode(6);
  const id = uuid();
  const ts = now();
  const codeHash = hashToken(code);
  await query(
    `INSERT INTO restore_sessions
       (id, new_device_id, status, request_code_hash, request_code_hint, expires_at, created_at)
     VALUES ($1,$2,'PENDING',$3,$4,$5,$6)`,
    [id, newDeviceId, codeHash, code.slice(-2), ts + REQUEST_TTL, ts]
  );
  return { restoreRequestId: id, code, expiresAt: ts + REQUEST_TTL };
}

export async function getRestoreRequestForDevice(deviceId) {
  const { rows } = await query(
    `SELECT * FROM restore_sessions WHERE new_device_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [deviceId]
  );
  return rows[0] || null;
}

export async function approveRestore({ userId, workspaceId, code, backupId }) {
  const allowed = await isOwnerOrAdmin(userId, workspaceId);
  if (!allowed) {
    const err = new Error('Not authorized');
    err.code = 'WORKSPACE_ACCESS_DENIED';
    err.httpStatus = 403;
    throw err;
  }
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) {
    const err = new Error('Workspace not found');
    err.code = 'WORKSPACE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const backup = await getBackup(workspaceId, backupId);
  if (!backup) {
    const err = new Error('Backup not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const codeHash = hashToken(String(code || '').toUpperCase());
  const { rows } = await query(
    `SELECT * FROM restore_sessions
     WHERE request_code_hash = $1 AND status = 'PENDING' AND expires_at > $2
     ORDER BY created_at DESC LIMIT 1`,
    [codeHash, now()]
  );
  const session = rows[0];
  if (!session) {
    const err = new Error('Restore request not found or expired');
    err.code = 'RESTORE_SESSION_EXPIRED';
    err.httpStatus = 404;
    throw err;
  }

  const token = generateDeviceSecret();
  const tokenHash = hashToken(token);
  await query(
    `UPDATE restore_sessions SET
       workspace_id = $2, backup_id = $3, approved_by_user_id = $4, status = 'APPROVED',
       token_hash = $5, expires_at = $6
     WHERE id = $1`,
    [session.id, workspaceId, backupId, userId, tokenHash, now() + SESSION_TTL]
  );
  await query(
    `UPDATE devices SET binding_status = 'RESTORE_PENDING', workspace_id = $2 WHERE device_id = $1`,
    [session.new_device_id, workspaceId]
  );
  await query(
    `UPDATE workspaces SET tally_connection = 'RESTORE_PENDING', updated_at = $2 WHERE id = $1`,
    [workspaceId, now()]
  );
  await audit(workspaceId, userId, 'restore.approved', { sessionId: session.id, backupId });
  return { sessionId: session.id, deviceId: session.new_device_id };
}

export async function rejectRestore({ userId, workspaceId, sessionId }) {
  const allowed = await isOwnerOrAdmin(userId, workspaceId);
  if (!allowed) {
    const err = new Error('Not authorized');
    err.code = 'WORKSPACE_ACCESS_DENIED';
    err.httpStatus = 403;
    throw err;
  }
  const { rows } = await query(`SELECT * FROM restore_sessions WHERE id = $1`, [sessionId]);
  const session = rows[0];
  if (!session) {
    const err = new Error('Restore request not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (session.status !== 'PENDING') {
    const err = new Error('Restore request is not pending');
    err.code = 'RESTORE_SESSION_EXPIRED';
    err.httpStatus = 409;
    throw err;
  }
  await query(`UPDATE restore_sessions SET status = 'REJECTED' WHERE id = $1`, [sessionId]);
  await audit(workspaceId, userId, 'restore.rejected', { sessionId });
  return { sessionId, status: 'REJECTED' };
}

export async function restoreStatusForDevice(deviceId) {
  const session = await getRestoreRequestForDevice(deviceId);
  if (!session) return { status: 'NONE' };
  if (session.status === 'PENDING') {
    return {
      status: 'RESTORE_APPROVAL_REQUIRED',
      restoreRequestId: session.id,
      expiresAt: session.expires_at,
    };
  }
  if (session.status === 'REJECTED') {
    return { status: 'RESTORE_REJECTED', restoreRequestId: session.id };
  }
  if (session.status === 'APPROVED' || session.status === 'DOWNLOADING') {
    const backup = session.backup_id && session.workspace_id
      ? await getBackup(session.workspace_id, session.backup_id)
      : null;
    let download = null;
    if (backup) download = await downloadAuthFor(backup);
    return {
      status: 'APPROVED',
      restoreRequestId: session.id,
      workspaceId: session.workspace_id,
      backup: backup ? {
        id: backup.id,
        sha256: backup.sha256,
        sizeBytes: backup.size_bytes,
        manifest: backup.company_manifest_json,
        desktopVersion: backup.desktop_version,
        tallyVersion: backup.tally_version,
        setupGeneration: backup.setup_generation,
      } : null,
      download,
    };
  }
  return { status: session.status, restoreRequestId: session.id };
}

export async function completeRestore({ deviceId, ok, lineageGuids = [], restoredFolders = [] }) {
  const session = await getRestoreRequestForDevice(deviceId);
  if (!session || !['APPROVED', 'DOWNLOADING'].includes(session.status)) {
    const err = new Error('No approved restore session');
    err.code = 'RESTORE_SESSION_EXPIRED';
    err.httpStatus = 409;
    throw err;
  }
  if (!ok) {
    await query(`UPDATE restore_sessions SET status = 'FAILED' WHERE id = $1`, [session.id]);
    return { activated: false };
  }

  const backup = session.backup_id && session.workspace_id
    ? await getBackup(session.workspace_id, session.backup_id)
    : null;
  const folders = lineageMatchesRestoredFolders(backup?.company_manifest_json, restoredFolders);
  if (!folders.ok) {
    await query(`UPDATE restore_sessions SET status = 'FAILED' WHERE id = $1`, [session.id]);
    const err = new Error('Restored Tally folders do not match the approved backup.');
    err.code = folders.code || 'TALLY_DATA_MISMATCH';
    err.httpStatus = 409;
    throw err;
  }
  const match = lineageMatchesBackupManifest(backup?.company_manifest_json, lineageGuids);
  if (!match.ok) {
    await query(`UPDATE restore_sessions SET status = 'FAILED' WHERE id = $1`, [session.id]);
    const err = new Error('Restored Tally data does not match the approved backup.');
    err.code = match.code || 'TALLY_DATA_MISMATCH';
    err.httpStatus = 409;
    throw err;
  }

  const { rows: old } = await query(
    `SELECT device_id FROM devices WHERE workspace_id = $1 AND paired = TRUE AND device_id <> $2`,
    [session.workspace_id, deviceId]
  );

  const secret = generateDeviceSecret();
  const { hashSecret: hash } = await import('./deviceCredential.js');
  const secretHash = await hash(secret);

  await query(
    `UPDATE devices SET
       paired = TRUE, binding_status = 'ACTIVE', workspace_id = $2,
       user_id = (SELECT owner_user_id FROM workspaces WHERE id = $2),
       device_secret_hash = $3, credential_claimed_at = NULL
     WHERE device_id = $1`,
    [deviceId, session.workspace_id, secretHash]
  );

  for (const row of old) {
    await query(
      `UPDATE devices SET paired = FALSE, binding_status = 'REVOKED', device_secret_hash = NULL, workspace_id = NULL
       WHERE device_id = $1`,
      [row.device_id]
    );
  }

  await query(
    `UPDATE workspace_tally_bindings SET active_device_id = $2, connection_status = 'CONNECTED', last_verified_at = $3, updated_at = $3
     WHERE workspace_id = $1`,
    [session.workspace_id, deviceId, now()]
  );
  await query(
    `UPDATE workspaces SET tally_connection = 'CONNECTED', updated_at = $2 WHERE id = $1`,
    [session.workspace_id, now()]
  );
  await query(
    `UPDATE restore_sessions SET status = 'COMPLETED', completed_at = $2 WHERE id = $1`,
    [session.id, now()]
  );
  await audit(session.workspace_id, session.approved_by_user_id, 'restore.completed', { deviceId, lineageGuids });
  return { activated: true, deviceSecret: secret, workspaceId: session.workspace_id };
}

export async function listWorkspaceApprovals(workspaceId) {
  const backups = await listAvailableBackups(workspaceId, 3);
  return { backups, restoreRequests: [] };
}

export { verifySecret, hashSecret };
