import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';

const now = () => Math.floor(Date.now() / 1000);

function personalName(user) {
  const base = (user?.name || '').trim();
  if (base) return `${base}'s Workspace`;
  return 'My Workspace';
}

export async function ensurePersonalWorkspace(userId) {
  const { rows: existing } = await query(
    `SELECT w.* FROM workspaces w
     JOIN workspace_memberships m ON m.workspace_id = w.id
     WHERE m.user_id = $1 AND m.status = 'ACTIVE' AND w.is_base = TRUE
     ORDER BY w.created_at ASC LIMIT 1`,
    [userId]
  );
  if (existing[0]) return existing[0];

  const { rows: users } = await query('SELECT id, name FROM users WHERE id = $1', [userId]);
  const user = users[0];
  if (!user) throw new Error('User not found');

  const workspaceId = uuid();
  const membershipId = uuid();
  const ts = now();
  await query(
    `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status,
       tally_connection, setup_generation, is_base, created_at, updated_at)
     VALUES ($1,$2,$3,'PERSONAL','ACTIVE','ACTIVE','UNPAIRED',1,TRUE,$4,$4)`,
    [workspaceId, personalName(user), userId, ts]
  );
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, status, joined_at)
     VALUES ($1,$2,$3,'OWNER','ACTIVE',$4)`,
    [membershipId, workspaceId, userId, ts]
  );
  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, lineage_id, connection_status, updated_at)
     VALUES ($1,$2,$3,'UNPAIRED',$4)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [uuid(), workspaceId, uuid(), ts]
  );
  await audit(workspaceId, userId, 'workspace.bootstrap', { name: personalName(user) });
  const { rows } = await query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0];
}

export async function backfillPersonalWorkspaces() {
  const { rows: users } = await query('SELECT id FROM users');
  for (const u of users) {
    try {
      const ws = await ensurePersonalWorkspace(u.id);
      await query(
        `UPDATE companies SET workspace_id = $1 WHERE user_id = $2 AND workspace_id IS NULL`,
        [ws.id, u.id]
      );
      await query(
        `UPDATE devices SET workspace_id = $1
         WHERE user_id = $2 AND paired = TRUE AND workspace_id IS NULL`,
        [ws.id, u.id]
      );
      await query(
        `UPDATE workspace_tally_bindings SET active_device_id = d.device_id, connection_status = 'CONNECTED', updated_at = $3
         FROM devices d
         WHERE workspace_tally_bindings.workspace_id = $1
           AND d.user_id = $2 AND d.paired = TRUE
           AND workspace_tally_bindings.active_device_id IS NULL`,
        [ws.id, u.id, now()]
      ).catch(() => {});
      await query(
        `UPDATE workspaces SET tally_connection = 'CONNECTED', updated_at = $2
         WHERE id = $1 AND EXISTS (
           SELECT 1 FROM devices WHERE workspace_id = $1 AND paired = TRUE
         )`,
        [ws.id, now()]
      ).catch(() => {});
    } catch (err) {
      console.warn('[workspace] backfill user', u.id, err.message);
    }
  }
}

export async function getWorkspaceForUser(userId) {
  return ensurePersonalWorkspace(userId);
}

export async function getWorkspaceById(workspaceId) {
  const { rows } = await query('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0] || null;
}

export async function membershipCount(workspaceId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM workspace_memberships
     WHERE workspace_id = $1 AND status = 'ACTIVE'`,
    [workspaceId]
  );
  return rows[0]?.n || 0;
}

export async function isOwnerOrAdmin(userId, workspaceId) {
  const { rows } = await query(
    `SELECT membership_type, status FROM workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE' LIMIT 1`,
    [workspaceId, userId]
  );
  const m = rows[0];
  if (!m) return false;
  if (m.membership_type === 'OWNER') return true;
  if (m.membership_type === 'ADMIN') return true;
  return false;
}

export function workspacePublicView(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    tallyConnection: workspace.tally_connection,
    lifecycleStatus: workspace.lifecycle_status,
    setupGeneration: workspace.setup_generation,
  };
}
