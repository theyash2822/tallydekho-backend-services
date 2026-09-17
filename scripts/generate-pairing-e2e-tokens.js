#!/usr/bin/env node
/**
 * TEST-ONLY: generate short-lived JWT tokens for Pairing Stabilization E2E.
 *
 * Usage:
 *   PAIRING_E2E=1 node scripts/generate-pairing-e2e-tokens.js
 *
 * Optional env (defaults verified against DB before use):
 *   E2E_OWNER_USER_ID=177
 *   E2E_ADMIN_USER_ID=178
 *   E2E_MEMBER_USER_ID=
 *   E2E_WORKSPACE_ID=
 *   E2E_TOKEN_TTL=20m
 *   BASE_URL=http://192.168.29.243:3001   (printed for convenience only)
 *
 * Safety:
 * - Requires PAIRING_E2E=1
 * - Refuses NODE_ENV=production
 * - Script only (no HTTP route)
 * - Never prints JWT_SECRET
 * - Does not write tokens to application logs
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';
import { query } from '../src/db/schema.js';

function die(msg) {
  console.error(`[pairing-e2e-tokens] ${msg}`);
  process.exit(1);
}

if (process.env.PAIRING_E2E !== '1') {
  die('Refusing to run: set PAIRING_E2E=1');
}
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') {
  die('Refusing to run when NODE_ENV=production');
}
if (!process.env.JWT_SECRET) {
  die('JWT_SECRET missing from environment');
}

const TTL = process.env.E2E_TOKEN_TTL || '20m';
const OWNER_ID = Number(process.env.E2E_OWNER_USER_ID || 177);
const ADMIN_ID = Number(process.env.E2E_ADMIN_USER_ID || 178);
const MEMBER_ID = process.env.E2E_MEMBER_USER_ID
  ? Number(process.env.E2E_MEMBER_USER_ID)
  : null;
const WORKSPACE_HINT = process.env.E2E_WORKSPACE_ID || '';
const BASE_URL = process.env.BASE_URL || process.env.API_BASE_URL || 'http://192.168.29.243:3001';

function signUser(userId) {
  // Same shape as middleware/auth generateToken consumers expect
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: TTL });
}

async function loadUser(id) {
  const { rows } = await query(
    `SELECT id, name, mobile, email FROM users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function resolveWorkspace(ownerId) {
  if (WORKSPACE_HINT) {
    const { rows } = await query(
      `SELECT id, name, owner_user_id, is_base, tally_connection
       FROM workspaces WHERE id = $1 LIMIT 1`,
      [WORKSPACE_HINT]
    );
    return rows[0] || null;
  }
  const { rows } = await query(
    `SELECT id, name, owner_user_id, is_base, tally_connection
     FROM workspaces
     WHERE owner_user_id = $1
     ORDER BY is_base DESC NULLS LAST, created_at ASC NULLS LAST
     LIMIT 1`,
    [ownerId]
  );
  return rows[0] || null;
}

async function membershipRole(userId, workspaceId) {
  const { rows } = await query(
    `SELECT m.membership_type, m.status, r.system_key, r.display_name
     FROM workspace_memberships m
     LEFT JOIN workspace_roles r ON r.id = m.role_id
     WHERE m.workspace_id = $1 AND m.user_id = $2
     LIMIT 1`,
    [workspaceId, userId]
  );
  return rows[0] || null;
}

async function main() {
  const owner = await loadUser(OWNER_ID);
  if (!owner) die(`Owner user ${OWNER_ID} not found`);

  const workspace = await resolveWorkspace(OWNER_ID);
  if (!workspace) die(`No workspace found for owner ${OWNER_ID}`);
  if (Number(workspace.owner_user_id) !== OWNER_ID) {
    die(`Workspace ${workspace.id} owner_user_id=${workspace.owner_user_id} ≠ E2E_OWNER_USER_ID=${OWNER_ID}`);
  }

  const ownerMem = await membershipRole(OWNER_ID, workspace.id);
  if (!ownerMem || ownerMem.status !== 'ACTIVE') {
    die(`Owner ${OWNER_ID} is not an ACTIVE member of workspace ${workspace.id}`);
  }
  if (ownerMem.membership_type !== 'OWNER' && ownerMem.system_key !== 'OWNER') {
    // Accept OWNER membership_type as authoritative
    if (ownerMem.membership_type !== 'OWNER') {
      die(`User ${OWNER_ID} membership_type=${ownerMem.membership_type} (expected OWNER)`);
    }
  }

  const admin = await loadUser(ADMIN_ID);
  let adminUserId = ADMIN_ID;
  let adminMem = null;
  if (admin) {
    adminMem = await membershipRole(ADMIN_ID, workspace.id);
  }
  const adminOk =
    adminMem &&
    adminMem.status === 'ACTIVE' &&
    String(adminMem.system_key || '').toUpperCase() === 'ADMIN';

  if (!adminOk) {
    // Auto-discover an ACTIVE ADMIN on this workspace (do not assume E2E_ADMIN_USER_ID)
    const { rows: admins } = await query(
      `SELECT m.user_id, m.membership_type, m.status, r.system_key, r.display_name
       FROM workspace_memberships m
       LEFT JOIN workspace_roles r ON r.id = m.role_id
       WHERE m.workspace_id = $1 AND m.status = 'ACTIVE'
         AND UPPER(COALESCE(r.system_key,'')) = 'ADMIN'
       ORDER BY m.user_id ASC
       LIMIT 1`,
      [workspace.id]
    );
    if (!admins[0]) {
      die(
        `No ACTIVE Admin (role.system_key=ADMIN) on workspace ${workspace.id}. ` +
          `Configured E2E_ADMIN_USER_ID=${ADMIN_ID} ` +
          (adminMem
            ? `has membership_type=${adminMem.membership_type} system_key=${adminMem.system_key}`
            : 'not a member')
      );
    }
    adminUserId = Number(admins[0].user_id);
    adminMem = admins[0];
    console.error(
      `[pairing-e2e-tokens] WARN: E2E_ADMIN_USER_ID=${ADMIN_ID} is not system_key=ADMIN on this workspace; ` +
        `using verified Admin user_id=${adminUserId}`
    );
  }

  const adminUser = await loadUser(adminUserId);
  if (!adminUser) die(`Admin user ${adminUserId} not found`);

  let memberToken = null;
  let memberInfo = null;
  if (MEMBER_ID) {
    const member = await loadUser(MEMBER_ID);
    if (!member) die(`Member user ${MEMBER_ID} not found`);
    const mem = await membershipRole(MEMBER_ID, workspace.id);
    if (!mem || mem.status !== 'ACTIVE') {
      die(`Member ${MEMBER_ID} is not an ACTIVE member of workspace ${workspace.id}`);
    }
    if (['OWNER', 'ADMIN'].includes(String(mem.system_key || '').toUpperCase())
      || mem.membership_type === 'OWNER') {
      die(`User ${MEMBER_ID} is Owner/Admin — pick a true Member for E2E_MEMBER_USER_ID`);
    }
    memberToken = signUser(MEMBER_ID);
    memberInfo = {
      userId: MEMBER_ID,
      membership_type: mem.membership_type,
      system_key: mem.system_key,
    };
  }

  const out = {
    baseUrl: BASE_URL,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    tallyConnection: workspace.tally_connection,
    tokenTtl: TTL,
    owner: {
      userId: OWNER_ID,
      name: owner.name,
      membership_type: ownerMem.membership_type,
    },
    admin: {
      userId: adminUserId,
      name: adminUser.name,
      membership_type: adminMem.membership_type,
      system_key: adminMem.system_key,
      configuredE2eAdminUserId: ADMIN_ID,
      usedConfiguredAdmin: adminUserId === ADMIN_ID,
    },
    member: memberInfo,
    // Tokens last — stdout only for shell export; never logged by app
    OWNER_TOKEN: signUser(OWNER_ID),
    ADMIN_TOKEN: signUser(adminUserId),
    MEMBER_TOKEN: memberToken,
    shellExport: null,
  };

  out.shellExport = [
    `export BASE_URL='${BASE_URL}'`,
    `export WORKSPACE_ID='${workspace.id}'`,
    `export OWNER_TOKEN='${out.OWNER_TOKEN}'`,
    `export ADMIN_TOKEN='${out.ADMIN_TOKEN}'`,
    memberToken ? `export MEMBER_TOKEN='${memberToken}'` : '# MEMBER_TOKEN unset',
    'export PAIRING_E2E=1',
  ].join('\n');

  // Machine-readable JSON to stdout (caller captures). No secret/JWT_SECRET fields.
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => die(e.message || String(e)));
