import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import {
  allKeys,
  getCapability,
  adminProtectedKeys,
  defaultKeysForTemplate,
  defaultSensitiveForTemplate,
  allSensitivePolicyKeys,
  BUILTIN_ROLE_DEFS,
  ownerOnlyKeys,
  ownerAdminKeys,
  nonDelegableCapabilityKeys,
} from './capabilityRegistry.js';
import { audit } from './auditService.js';

const now = () => Math.floor(Date.now() / 1000);

async function setCapabilities(roleId, grantsMap) {
  const keys = allKeys();
  for (const key of keys) {
    const granted = !!grantsMap[key];
    await query(
      `INSERT INTO role_capabilities (role_id, capability_key, granted)
       VALUES ($1,$2,$3)
       ON CONFLICT (role_id, capability_key) DO UPDATE SET granted = EXCLUDED.granted`,
      [roleId, key, granted]
    );
  }
}

async function setSensitivePolicies(roleId, policiesMap) {
  for (const key of allSensitivePolicyKeys()) {
    const granted = policiesMap[key] !== false;
    await query(
      `INSERT INTO role_sensitive_policies (role_id, policy_key, granted)
       VALUES ($1,$2,$3)
       ON CONFLICT (role_id, policy_key) DO UPDATE SET granted = EXCLUDED.granted`,
      [roleId, key, granted]
    );
  }
}

async function insertBuiltinRole(workspaceId, def) {
  const roleId = uuid();
  const ts = now();
  await query(
    `INSERT INTO workspace_roles
       (id, workspace_id, system_key, display_name, entry_mode, is_builtin, is_editable, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,TRUE,$6,$7,$7)`,
    [roleId, workspaceId, def.system_key, def.display_name, def.entry_mode, def.is_editable, ts]
  );
  const { rows } = await query(
    `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = $2 LIMIT 1`,
    [workspaceId, def.system_key]
  );
  const id = rows[0]?.id || roleId;

  const grantedKeys = new Set(defaultKeysForTemplate(def.system_key));
  const grants = Object.fromEntries(allKeys().map((k) => [k, grantedKeys.has(k)]));
  await setCapabilities(id, grants);
  await setSensitivePolicies(id, defaultSensitiveForTemplate(def.system_key));
  return id;
}

/**
 * Seeds Admin/Accountant/Sales/Collection/Viewer/Auditor. Idempotent by system_key.
 */
export async function seedBuiltinRoles(workspaceId) {
  const seeded = [];
  for (const def of BUILTIN_ROLE_DEFS) {
    const { rows: existing } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = $2 LIMIT 1`,
      [workspaceId, def.system_key]
    );
    if (existing[0]) {
      // Refresh grants so older workspaces pick up new catalogue keys (e.g. members.remove)
      await refreshBuiltinRoleCapabilities(existing[0].id, def.system_key);
      seeded.push(existing[0].id);
      continue;
    }
    const id = await insertBuiltinRole(workspaceId, def);
    if (id) seeded.push(id);
  }
  return seeded;
}

/** Ensure builtin role has template keys that are missing only (seed-once additive).
 * NEVER overwrite granted=FALSE after Owner/Admin edits a role.
 */
export async function refreshBuiltinRoleCapabilities(roleId, systemKey) {
  if (!roleId || !systemKey) return;
  const wanted = new Set(defaultKeysForTemplate(systemKey));
  if (String(systemKey).toUpperCase() === 'ADMIN') {
    for (const k of ownerAdminKeys()) wanted.add(k);
  }
  for (const key of wanted) {
    await query(
      `INSERT INTO role_capabilities (role_id, capability_key, granted)
       VALUES ($1,$2,TRUE)
       ON CONFLICT (role_id, capability_key) DO NOTHING`,
      [roleId, key]
    );
  }
}

export async function listRoles(workspaceId) {
  const { rows } = await query(
    `SELECT * FROM workspace_roles WHERE workspace_id = $1
     ORDER BY is_builtin DESC, system_key NULLS LAST, created_at ASC`,
    [workspaceId]
  );
  return rows;
}

export async function getRole(roleId) {
  if (!roleId) return null;
  const { rows } = await query(`SELECT * FROM workspace_roles WHERE id = $1`, [roleId]);
  const role = rows[0] || null;
  if (!role) return null;

  const { rows: caps } = await query(
    `SELECT capability_key, granted FROM role_capabilities WHERE role_id = $1`,
    [roleId]
  );
  const { rows: policies } = await query(
    `SELECT policy_key, granted FROM role_sensitive_policies WHERE role_id = $1`,
    [roleId]
  );
  return {
    ...role,
    name: role.display_name,
    is_system: !!role.is_builtin,
    capabilities: Object.fromEntries(caps.map((c) => [c.capability_key, !!c.granted])),
    sensitivePolicies: Object.fromEntries(policies.map((p) => [p.policy_key, !!p.granted])),
  };
}

export async function getGrantedCapabilityKeys(roleId) {
  if (!roleId) return new Set();
  const { rows } = await query(
    `SELECT capability_key FROM role_capabilities WHERE role_id = $1 AND granted = TRUE`,
    [roleId]
  );
  return new Set(rows.map((r) => r.capability_key));
}

/**
 * Update capability grants. Admin system_key always forces OWNER_OR_ADMIN_ROLE protected keys granted.
 * Anti-escalation: actor may only grant capabilities they themselves hold (OWNER exempt).
 */
export async function updateRoleCapabilities(roleId, grantsMap = {}, { actorUserId, workspaceId } = {}) {
  const role = await getRole(roleId);
  if (!role) {
    const err = new Error('Role not found');
    err.code = 'ROLE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const next = { ...(role.capabilities || {}), ...grantsMap };
  for (const key of Object.keys(next)) {
    if (!getCapability(key)) delete next[key];
  }
  // Custom roles cannot receive high-risk / non-delegable capabilities
  if (role.system_key !== 'ADMIN') {
    for (const k of nonDelegableCapabilityKeys()) next[k] = false;
  }
  if (role.system_key === 'ADMIN') {
    for (const k of adminProtectedKeys()) next[k] = true;
  }
  for (const k of ownerOnlyKeys()) next[k] = false;

  if (actorUserId && workspaceId) {
    const { getEffectiveAccess } = await import('./authorizationService.js');
    const access = await getEffectiveAccess(actorUserId, workspaceId);
    const mt = access?.membership?.membership_type;
    if (mt !== 'OWNER') {
      const held = new Set(access?.capabilities || []);
      for (const [k, granted] of Object.entries(next)) {
        if (granted && !held.has(k)) {
          const err = new Error(`Cannot grant capability you do not hold: ${k}`);
          err.code = 'PRIVILEGE_ESCALATION';
          err.httpStatus = 403;
          throw err;
        }
      }
    }
  }

  await setCapabilities(roleId, next);
  await query(`UPDATE workspace_roles SET updated_at = $2 WHERE id = $1`, [roleId, now()]);
  return getRole(roleId);
}

export async function updateSensitivePolicies(roleId, policiesMap = {}) {
  const role = await getRole(roleId);
  if (!role) {
    const err = new Error('Role not found');
    err.code = 'ROLE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const next = { ...(role.sensitivePolicies || {}), ...policiesMap };
  await setSensitivePolicies(roleId, next);
  await query(`UPDATE workspace_roles SET updated_at = $2 WHERE id = $1`, [roleId, now()]);
  return getRole(roleId);
}

export async function updateEntryMode(roleId, entryMode) {
  const allowed = new Set(['REGULAR', 'OPTIONAL', 'BOTH']);
  if (!allowed.has(entryMode)) {
    const err = new Error('entry_mode must be REGULAR|OPTIONAL|BOTH');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  await query(
    `UPDATE workspace_roles SET entry_mode = $2, updated_at = $3 WHERE id = $1`,
    [roleId, entryMode, now()]
  );
  return getRole(roleId);
}

export async function updateRoleMeta(roleId, { displayName, entryMode, capabilities, sensitivePolicies, actorUserId, workspaceId } = {}) {
  const role = await getRole(roleId);
  if (!role) {
    const err = new Error('Role not found');
    err.code = 'ROLE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (displayName != null && String(displayName).trim()) {
    await query(
      `UPDATE workspace_roles SET display_name = $2, updated_at = $3 WHERE id = $1`,
      [roleId, String(displayName).trim(), now()]
    );
  }
  if (entryMode != null) await updateEntryMode(roleId, entryMode);
  if (capabilities && typeof capabilities === 'object') {
    await updateRoleCapabilities(roleId, capabilities, { actorUserId, workspaceId });
  }
  if (sensitivePolicies && typeof sensitivePolicies === 'object') {
    await updateSensitivePolicies(roleId, sensitivePolicies);
  }
  return getRole(roleId);
}

export async function createCustomRole(workspaceId, { displayName, entryMode = 'BOTH', capabilities = {}, sensitivePolicies = {}, actorUserId } = {}) {
  const name = String(displayName || '').trim();
  if (!name) {
    const err = new Error('display_name required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const roleId = uuid();
  const ts = now();
  await query(
    `INSERT INTO workspace_roles
       (id, workspace_id, system_key, display_name, entry_mode, is_builtin, is_editable, created_at, updated_at)
     VALUES ($1,$2,NULL,$3,$4,FALSE,TRUE,$5,$5)`,
    [roleId, workspaceId, name, entryMode, ts]
  );
  const grants = Object.fromEntries(allKeys().map((k) => [k, !!capabilities[k]]));
  for (const k of ownerOnlyKeys()) grants[k] = false;
  for (const k of nonDelegableCapabilityKeys()) grants[k] = false;
  if (actorUserId) {
    const { getEffectiveAccess } = await import('./authorizationService.js');
    const access = await getEffectiveAccess(actorUserId, workspaceId);
    const mt = access?.membership?.membership_type;
    if (mt !== 'OWNER') {
      const held = new Set(access?.capabilities || []);
      for (const k of Object.keys(grants)) {
        if (grants[k] && !held.has(k)) grants[k] = false;
      }
    }
  }
  await setCapabilities(roleId, grants);
  await setSensitivePolicies(roleId, {
    ...Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, false])),
    ...sensitivePolicies,
  });
  await audit(workspaceId, null, 'role.created', { roleId, displayName: name });
  return getRole(roleId);
}

export async function deleteRole(roleId, workspaceId) {
  const role = await getRole(roleId);
  if (!role || role.workspace_id !== workspaceId) {
    const err = new Error('Role not found');
    err.code = 'ROLE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (role.is_builtin || role.system_key) {
    const err = new Error('Cannot delete builtin role');
    err.code = 'ROLE_BUILTIN';
    err.httpStatus = 400;
    throw err;
  }
  const { rows: used } = await query(
    `SELECT id FROM workspace_memberships WHERE role_id = $1 AND status IN ('ACTIVE','SUSPENDED') LIMIT 1`,
    [roleId]
  );
  if (used[0]) {
    const err = new Error('Cannot delete role while memberships use it');
    err.code = 'ROLE_IN_USE';
    err.httpStatus = 409;
    throw err;
  }
  await query(`DELETE FROM workspace_roles WHERE id = $1`, [roleId]);
  await audit(workspaceId, null, 'role.deleted', { roleId });
  return true;
}

