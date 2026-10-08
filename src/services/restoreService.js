import { v4 as uuid } from 'uuid';
import { query, getClient } from '../db/schema.js';
import { audit } from './auditService.js';
import { generateShortCode, hashSecret, verifySecret, hashToken, generateDeviceSecret } from './deviceCredential.js';
import { listAvailableBackups, getBackup, downloadAuthFor } from './backupService.js';
import { getWorkspaceById } from './workspaceService.js';
import { assertCapability } from './authorizationService.js';
import { lineageMatchesBackupManifest, lineageMatchesRestoredFolders } from '../utils/tallyLineage.js';

const now = () => Math.floor(Date.now() / 1000);
const REQUEST_TTL = 30 * 60;
const SESSION_TTL = 2 * 60 * 60;
// A lost completion acknowledgement may be retried for this long after COMPLETED.
const ACK_RETRY_TTL = 24 * 60 * 60;
export const CODE_ATTEMPT_WINDOW = 15 * 60;
export const CODE_ATTEMPT_MAX = 10;

const restoreError = (code, message, httpStatus) => Object.assign(new Error(message), { code, httpStatus });

/**
 * The short code is shown to the Owner/Admin; the restore token stays on the requesting Desktop
 * and is required for status, download and completion (N5). Device ids are public identifiers.
 */
export async function createRestoreRequest(newDeviceId) {
  if (!newDeviceId) throw restoreError('DEVICE_ID_REQUIRED', 'Device id required', 400);
  const code = generateShortCode(6);
  const restoreToken = generateDeviceSecret();
  const id = uuid();
  const ts = now();
  const codeHash = hashToken(code);
  await query(
    `UPDATE restore_sessions SET status = 'SUPERSEDED' WHERE new_device_id = $1 AND status = 'PENDING'`,
    [newDeviceId]
  );
  await query(
    `INSERT INTO restore_sessions
       (id, new_device_id, status, request_code_hash, request_code_hint, request_secret_hash, expires_at, created_at)
     VALUES ($1,$2,'PENDING',$3,$4,$5,$6,$7)`,
    [id, newDeviceId, codeHash, code.slice(-2), hashToken(restoreToken), ts + REQUEST_TTL, ts]
  );
  return { restoreRequestId: id, code, restoreToken, expiresAt: ts + REQUEST_TTL };
}

export async function getRestoreRequestForDevice(deviceId) {
  const { rows } = await query(
    `SELECT * FROM restore_sessions WHERE new_device_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [deviceId]
  );
  return rows[0] || null;
}

/** The device's latest session, only when the caller holds that session's restore token. */
async function sessionForToken(deviceId, restoreToken) {
  const session = await getRestoreRequestForDevice(deviceId);
  if (!session) return { session: null };
  if (!session.request_secret_hash || !restoreToken || hashToken(String(restoreToken)) !== session.request_secret_hash) {
    return { session: null, denied: true };
  }
  return { session };
}

export async function approveRestore({ userId, workspaceId, code, backupId }) {
  let allowed = true;
  try {
    await assertCapability(userId, workspaceId, 'tally.restore_replace');
  } catch {
    allowed = false;
  }
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
  const ts = now();
  const { rows: attempts } = await query(
    `SELECT COUNT(*)::int AS n FROM restore_code_attempts WHERE user_id = $1 AND attempted_at > $2`,
    [userId, ts - CODE_ATTEMPT_WINDOW]
  );
  if (attempts[0].n >= CODE_ATTEMPT_MAX) {
    throw restoreError('RESTORE_CODE_RATE_LIMITED', 'Too many restore code attempts. Try again in 15 minutes.', 429);
  }
  const codeHash = hashToken(String(code || '').toUpperCase());
  const { rows } = await query(
    `SELECT * FROM restore_sessions
     WHERE request_code_hash = $1 AND status = 'PENDING' AND expires_at > $2
     ORDER BY created_at DESC LIMIT 1`,
    [codeHash, ts]
  );
  const session = rows[0];
  if (!session) {
    await query(`INSERT INTO restore_code_attempts (user_id, attempted_at) VALUES ($1, $2)`, [userId, ts]);
    throw restoreError('RESTORE_SESSION_EXPIRED', 'Restore request not found or expired', 404);
  }

  const token = generateDeviceSecret();
  const tokenHash = hashToken(token);
  const { rowCount } = await query(
    `UPDATE restore_sessions SET
       workspace_id = $2, backup_id = $3, approved_by_user_id = $4, status = 'APPROVED',
       token_hash = $5, expires_at = $6
     WHERE id = $1 AND status = 'PENDING'`,
    [session.id, workspaceId, backupId, userId, tokenHash, ts + SESSION_TTL]
  );
  if (!rowCount) throw restoreError('RESTORE_SESSION_EXPIRED', 'Restore request was already decided', 409);
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
  let allowed = true;
  try {
    await assertCapability(userId, workspaceId, 'tally.restore_replace');
  } catch {
    allowed = false;
  }
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

export async function restoreStatusForDevice(deviceId, restoreToken) {
  const { session, denied } = await sessionForToken(deviceId, restoreToken);
  if (denied) return { status: 'RESTORE_TOKEN_REQUIRED' };
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
  if ((session.status === 'APPROVED' || session.status === 'DOWNLOADING') && Number(session.expires_at) <= now()) {
    await query(`UPDATE restore_sessions SET status = 'EXPIRED' WHERE id = $1 AND status IN ('APPROVED','DOWNLOADING')`, [session.id]);
    return { status: 'EXPIRED', restoreRequestId: session.id };
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

async function rotateRestoredDeviceSecret(deviceId, workspaceId) {
  const secret = generateDeviceSecret();
  const secretHash = await hashSecret(secret);
  await query(
    `UPDATE devices SET device_secret_hash = $3, credential_claimed_at = NULL
      WHERE device_id = $1 AND workspace_id = $2 AND binding_status = 'ACTIVE'`,
    [deviceId, workspaceId, secretHash]
  );
  return secret;
}

/**
 * Restore completion (N1/N5). Requires the restore token. A repeated completion after COMPLETED
 * (the first acknowledgement was lost) re-issues the device credential instead of failing, so the
 * Desktop that already restored its files can finish; nothing else is re-run.
 */
export async function completeRestore({ deviceId, restoreToken, ok, lineageGuids = [], restoredFolders = [] }) {
  const { session, denied } = await sessionForToken(deviceId, restoreToken);
  if (denied) throw restoreError('RESTORE_TOKEN_REQUIRED', 'Restore token required', 403);
  if (session?.status === 'COMPLETED' && ok && Number(session.completed_at) + ACK_RETRY_TTL > now()) {
    const secret = await rotateRestoredDeviceSecret(deviceId, session.workspace_id);
    await audit(session.workspace_id, session.approved_by_user_id, 'restore.ack_retried', { deviceId });
    return { activated: true, deviceSecret: secret, workspaceId: session.workspace_id, repeated: true };
  }
  if (!session || !['APPROVED', 'DOWNLOADING'].includes(session.status) || Number(session.expires_at) <= now()) {
    throw restoreError('RESTORE_SESSION_EXPIRED', 'No approved restore session', 409);
  }
  if (!ok) {
    await query(`UPDATE restore_sessions SET status = 'FAILED' WHERE id = $1 AND status IN ('APPROVED','DOWNLOADING')`, [session.id]);
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

  const secret = generateDeviceSecret();
  const secretHash = await hashSecret(secret);

  // One transaction: a failure part-way leaves the session APPROVED/DOWNLOADING so the
  // Desktop's pending acknowledgement can complete it, instead of a stuck COMPLETING row.
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const { rowCount: claimed } = await client.query(
      `UPDATE restore_sessions SET status = 'COMPLETING' WHERE id = $1 AND status IN ('APPROVED','DOWNLOADING')`,
      [session.id]
    );
    if (!claimed) throw restoreError('RESTORE_SESSION_EXPIRED', 'Restore completion already in progress', 409);

    const { rows: old } = await client.query(
      `SELECT device_id FROM devices WHERE workspace_id = $1 AND paired = TRUE AND device_id <> $2`,
      [session.workspace_id, deviceId]
    );
    await client.query(
      `UPDATE devices SET
         paired = TRUE, binding_status = 'ACTIVE', workspace_id = $2,
         device_secret_hash = $3, credential_claimed_at = NULL
       WHERE device_id = $1`,
      [deviceId, session.workspace_id, secretHash]
    );
    for (const row of old) {
      await client.query(
        `UPDATE devices SET paired = FALSE, binding_status = 'REVOKED', device_secret_hash = NULL, workspace_id = NULL
         WHERE device_id = $1`,
        [row.device_id]
      );
    }
    await client.query(
      `UPDATE workspace_tally_bindings SET active_device_id = $2, connection_status = 'CONNECTED', last_verified_at = $3, updated_at = $3
       WHERE workspace_id = $1`,
      [session.workspace_id, deviceId, now()]
    );
    await client.query(
      `UPDATE workspaces SET tally_connection = 'CONNECTED', updated_at = $2 WHERE id = $1`,
      [session.workspace_id, now()]
    );
    // Restored Tally data carries older AlterIds than the voucher watermarks: re-fetch every FY.
    await client.query(
      `DELETE FROM voucher_sync_watermarks WHERE company_id IN (SELECT id FROM companies WHERE workspace_id = $1)`,
      [session.workspace_id]
    );
    await client.query(
      `UPDATE restore_sessions SET status = 'COMPLETED', completed_at = $2 WHERE id = $1`,
      [session.id, now()]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await audit(session.workspace_id, session.approved_by_user_id, 'restore.completed', { deviceId, lineageGuids });
  return { activated: true, deviceSecret: secret, workspaceId: session.workspace_id };
}

export async function listWorkspaceApprovals(workspaceId) {
  const backups = await listAvailableBackups(workspaceId, 3);
  return { backups, restoreRequests: [] };
}

export { verifySecret, hashSecret };
