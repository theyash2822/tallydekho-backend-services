import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { ensurePersonalWorkspace } from './workspaceService.js';
import { generateDeviceSecret, hashSecret } from './deviceCredential.js';

const now = () => Math.floor(Date.now() / 1000);

export class BindingError extends Error {
  constructor(code, message, httpStatus = 409) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export async function pairDeviceToWorkspace({ device, userId }) {
  const workspace = await ensurePersonalWorkspace(userId);

  if (device.paired && device.user_id && device.user_id !== userId) {
    throw new BindingError(
      'DEVICE_ALREADY_PAIRED',
      'This Tally Desktop is already connected to another TallyDekho workspace.',
      409
    );
  }

  if (device.workspace_id && device.workspace_id !== workspace.id && device.paired) {
    throw new BindingError(
      'DEVICE_ALREADY_PAIRED',
      'This Tally Desktop is already connected to another TallyDekho workspace.',
      409
    );
  }

  const { rows: bound } = await query(
    `SELECT device_id FROM devices
     WHERE workspace_id = $1 AND paired = TRUE AND device_id <> $2
     LIMIT 1`,
    [workspace.id, device.device_id]
  );
  if (bound[0]) {
    throw new BindingError(
      'DEVICE_ALREADY_PAIRED',
      'This TallyDekho workspace already has a connected Tally Desktop.',
      409
    );
  }

  const secret = generateDeviceSecret();
  const secretHash = await hashSecret(secret);
  const ts = now();

  await query(
    `UPDATE devices SET
       user_id = $1,
       workspace_id = $2,
       paired = TRUE,
       binding_status = 'ACTIVE',
       device_secret_hash = $3,
       credential_claimed_at = NULL,
       last_seen = $4
     WHERE device_id = $5`,
    [userId, workspace.id, secretHash, ts, device.device_id]
  );

  await query(
    `UPDATE companies SET user_id = $1, workspace_id = $2, is_active = TRUE WHERE device_id = $3`,
    [userId, workspace.id, device.device_id]
  ).catch(() => {});

  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, active_device_id, lineage_id, connection_status, first_bound_at, last_verified_at, updated_at)
     VALUES ($1,$2,$3,$4,'RECONNECTING',$5,$5,$5)
     ON CONFLICT (workspace_id) DO UPDATE SET
       active_device_id = EXCLUDED.active_device_id,
       connection_status = 'RECONNECTING',
       last_verified_at = EXCLUDED.last_verified_at,
       updated_at = EXCLUDED.updated_at`,
    [uuid(), workspace.id, device.device_id, uuid(), ts]
  );

  await query(
    `UPDATE workspaces SET tally_connection = 'RECONNECTING', updated_at = $2 WHERE id = $1`,
    [workspace.id, ts]
  );

  await audit(workspace.id, userId, 'tally.pair', { deviceId: device.device_id });

  return { workspace, deviceSecret: secret };
}

export async function unpairDevice(deviceId, actorUserId = null) {
  const { rows } = await query('SELECT * FROM devices WHERE device_id = $1', [deviceId]);
  const device = rows[0];
  if (!device) return { newCode: null, userId: null, workspaceId: null };

  const newCode = String(Math.floor(100000 + Math.random() * 900000));
  await query(
    `UPDATE devices SET
       paired = FALSE,
       user_id = NULL,
       workspace_id = NULL,
       binding_status = 'REVOKED',
       device_secret_hash = NULL,
       credential_claimed_at = NULL,
       pairing_code = $2
     WHERE device_id = $1`,
    [deviceId, newCode]
  );

  if (device.workspace_id) {
    await query(
      `UPDATE workspace_tally_bindings SET active_device_id = NULL, connection_status = 'UNPAIRED', updated_at = $2
       WHERE workspace_id = $1 AND active_device_id = $3`,
      [device.workspace_id, now(), deviceId]
    );
    await query(
      `UPDATE workspaces SET tally_connection = 'UNPAIRED', updated_at = $2 WHERE id = $1`,
      [device.workspace_id, now()]
    );
    await audit(device.workspace_id, actorUserId || device.user_id, 'tally.unpair', { deviceId });
  }

  return { newCode, userId: device.user_id, workspaceId: device.workspace_id };
}

export async function markFirstSyncConnected(workspaceId, deviceId, companies = []) {
  const ts = now();
  await query(
    `UPDATE workspace_tally_bindings SET connection_status = 'CONNECTED', last_verified_at = $2, updated_at = $2
     WHERE workspace_id = $1`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspaces SET tally_connection = 'CONNECTED', updated_at = $2 WHERE id = $1`,
    [workspaceId, ts]
  );
  for (const c of companies) {
    const guid = c.guid || c.GUID;
    if (!guid) continue;
    await query(
      `INSERT INTO workspace_tally_lineage_companies
         (workspace_id, tally_company_guid, company_name, first_seen_at, last_seen_at, status)
       VALUES ($1,$2,$3,$4,$4,'ACTIVE')
       ON CONFLICT (workspace_id, tally_company_guid) DO UPDATE SET
         company_name = COALESCE(EXCLUDED.company_name, workspace_tally_lineage_companies.company_name),
         last_seen_at = EXCLUDED.last_seen_at,
         status = 'ACTIVE'`,
      [workspaceId, guid, c.name || c.NAME || null, ts]
    );
  }
}

export async function getKnownLineageGuids(workspaceId) {
  const { rows } = await query(
    `SELECT tally_company_guid FROM workspace_tally_lineage_companies
     WHERE workspace_id = $1 AND status = 'ACTIVE'`,
    [workspaceId]
  );
  return rows.map((r) => r.tally_company_guid);
}
