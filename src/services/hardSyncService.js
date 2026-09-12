import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { membershipCount, isOwnerOrAdmin } from './workspaceService.js';
import { purgeCompaniesForHardSync } from './companyPurge.js';

const now = () => Math.floor(Date.now() / 1000);
const TTL = 24 * 60 * 60;

export async function createHardSyncRequest({
  workspaceId,
  deviceId,
  operation = 'REBUILD',
  oldGuid = null,
  newGuid = null,
  companyManifest = [],
}) {
  const { rows: open } = await query(
    `SELECT * FROM hard_sync_requests
     WHERE workspace_id = $1 AND device_id = $2 AND status IN ('PENDING','APPROVED')
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, deviceId]
  );
  if (open[0]?.status === 'APPROVED') {
    return { request: open[0], autoApproved: true, alreadyApproved: true };
  }
  if (open[0]?.status === 'PENDING') {
    return { request: open[0], autoApproved: false };
  }

  const members = await membershipCount(workspaceId);
  const auto = members <= 1;
  const id = uuid();
  const ts = now();
  const status = auto ? 'APPROVED' : 'PENDING';
  await query(
    `INSERT INTO hard_sync_requests
       (id, workspace_id, device_id, operation, status, old_guid, new_guid, company_manifest_json, created_at, decided_at, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      id, workspaceId, deviceId, operation, status,
      oldGuid, newGuid, JSON.stringify(companyManifest || []),
      ts, auto ? ts : null, ts + TTL,
    ]
  );
  await audit(workspaceId, null, 'hard_sync.request', { id, operation, auto });
  const { rows } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [id]);
  return { request: rows[0], autoApproved: auto };
}

export async function approveHardSync({ requestId, userId, workspaceId }) {
  const allowed = await isOwnerOrAdmin(userId, workspaceId);
  if (!allowed) {
    const err = new Error('Not authorized');
    err.code = 'WORKSPACE_ACCESS_DENIED';
    err.httpStatus = 403;
    throw err;
  }
  const { rows } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [requestId]);
  const reqRow = rows[0];
  if (!reqRow || reqRow.workspace_id !== workspaceId) {
    const err = new Error('Request not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (reqRow.status === 'APPROVED' || reqRow.status === 'EXECUTED') {
    const err = new Error('Already approved');
    err.code = 'HARD_SYNC_ALREADY_APPROVED';
    err.httpStatus = 409;
    throw err;
  }
  if (reqRow.status !== 'PENDING') {
    const err = new Error('Request is not pending');
    err.code = 'HARD_SYNC_REJECTED';
    err.httpStatus = 409;
    throw err;
  }
  await query(
    `UPDATE hard_sync_requests SET status = 'APPROVED', approved_by_user_id = $2, decided_at = $3 WHERE id = $1`,
    [requestId, userId, now()]
  );
  await audit(workspaceId, userId, 'hard_sync.approved', { requestId });
  const { rows: next } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [requestId]);
  return next[0];
}

export async function rejectHardSync({ requestId, userId, workspaceId }) {
  const allowed = await isOwnerOrAdmin(userId, workspaceId);
  if (!allowed) {
    const err = new Error('Not authorized');
    err.code = 'WORKSPACE_ACCESS_DENIED';
    err.httpStatus = 403;
    throw err;
  }
  await query(
    `UPDATE hard_sync_requests SET status = 'REJECTED', approved_by_user_id = $2, decided_at = $3
     WHERE id = $1 AND status = 'PENDING'`,
    [requestId, userId, now()]
  );
  await audit(workspaceId, userId, 'hard_sync.rejected', { requestId });
}

export async function listPendingHardSync(workspaceId) {
  const { rows } = await query(
    `SELECT * FROM hard_sync_requests WHERE workspace_id = $1 AND status = 'PENDING' ORDER BY created_at DESC`,
    [workspaceId]
  );
  return rows;
}

export async function getHardSyncRequest(id) {
  const { rows } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [id]);
  const row = rows[0];
  if (row?.status === 'PENDING' && row.expires_at && Number(row.expires_at) < now()) {
    await query(`UPDATE hard_sync_requests SET status = 'EXPIRED', decided_at = $2 WHERE id = $1 AND status = 'PENDING'`, [id, now()]);
    return { ...row, status: 'EXPIRED' };
  }
  return row || null;
}

export async function consumeApprovedHardSync(workspaceId, deviceId, companies, guidReplacement) {
  const { rows } = await query(
    `SELECT * FROM hard_sync_requests
     WHERE workspace_id = $1 AND device_id = $2 AND status = 'APPROVED'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, deviceId]
  );
  const reqRow = rows[0];
  const members = await membershipCount(workspaceId);
  if (!reqRow && members > 1) {
    const err = new Error('Owner/Admin approval is required before Hard Sync.');
    err.code = 'HARD_SYNC_APPROVAL_REQUIRED';
    err.httpStatus = 403;
    throw err;
  }

  const guids = (companies || []).map((c) => c.guid).filter(Boolean);
  if (reqRow?.operation === 'GUID_REPLACEMENT' && reqRow.old_guid) {
    await purgeCompaniesForHardSync([reqRow.old_guid, ...guids]);
    await query(
      `UPDATE companies SET guid = $2 WHERE guid = $1 AND workspace_id = $3`,
      [reqRow.old_guid, reqRow.new_guid || guids[0], workspaceId]
    ).catch(() => {});
    await query(
      `UPDATE workspace_tally_lineage_companies SET status = 'REPLACED'
       WHERE workspace_id = $1 AND tally_company_guid = $2`,
      [workspaceId, reqRow.old_guid]
    );
  } else if (guids.length) {
    await purgeCompaniesForHardSync(guids);
  }

  if (reqRow) {
    await query(`UPDATE hard_sync_requests SET status = 'EXECUTED' WHERE id = $1`, [reqRow.id]);
  }
  return reqRow;
}
