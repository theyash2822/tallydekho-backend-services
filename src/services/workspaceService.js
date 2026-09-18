import { createHash, randomBytes } from 'crypto';
import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';
import { ensureBillingAccount, getServiceRate, deductCredits, getBillingOverview, getWallet } from './billingService.js';
import { seedBuiltinRoles } from './roleService.js';
import { getEffectiveAccess, loadMembership, assertCapability } from './authorizationService.js';
import { ensureDemoCompany, filterCompaniesByPairingStatus } from './demoDataService.js';
import { sendOwnershipConfirmEmail, sendLifecycleConfirmEmail } from './email.js';
import { purgeCompanyTallyData } from './companyPurge.js';
import { unpairDevice } from './deviceBinding.js';
import { getWorkspaceSocket } from '../socket/workspaceEmit.js';
import { purgeWorkspaceCloudBackups } from './backupService.js';

const now = () => Math.floor(Date.now() / 1000);
const DAY_SEC = 24 * 60 * 60;
const RESET_PHRASE = 'RESET WORKSPACE';
const CLOSE_PHRASE = 'CLOSE WORKSPACE';

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function makeConfirmToken() {
  return randomBytes(24).toString('hex');
}

function personalName(user) {
  const base = (user?.name || '').trim();
  if (base) return `${base}'s Workspace`;
  return 'My Workspace';
}

async function ensureOwnerSeat(workspaceId, userId, membershipId) {
  // CRITICAL: never promote invitees / members. Only the workspace owner_user_id
  // may hold membership_type OWNER + the OWNER seat.
  const { rows: wsRows } = await query(`SELECT owner_user_id FROM workspaces WHERE id = $1 LIMIT 1`, [
    workspaceId,
  ]);
  if (!wsRows[0] || Number(wsRows[0].owner_user_id) !== Number(userId)) {
    console.warn(
      `[workspace] ensureOwnerSeat skipped — user=${userId} is not owner of workspace=${workspaceId}`
    );
    return null;
  }

  const { rows: seats } = await query(
    `SELECT id FROM workspace_seats
     WHERE workspace_id = $1 AND seat_kind = 'OWNER' LIMIT 1`,
    [workspaceId]
  );
  let seatId = seats[0]?.id;
  const ts = now();
  if (!seatId) {
    seatId = uuid();
    await query(
      `INSERT INTO workspace_seats (id, workspace_id, seat_kind, status, assigned_user_id, created_at)
       VALUES ($1,$2,'OWNER','ASSIGNED',$3,$4)`,
      [seatId, workspaceId, userId, ts]
    );
  } else {
    await query(
      `UPDATE workspace_seats SET status = 'ASSIGNED', assigned_user_id = $2 WHERE id = $1`,
      [seatId, userId]
    );
  }
  await query(
    `UPDATE workspace_memberships
     SET role_id = NULL, seat_id = $2, membership_type = 'OWNER'
     WHERE id = $1 AND user_id = $3`,
    [membershipId, seatId, userId]
  );
  await query(
    `INSERT INTO membership_scope_policy
       (membership_id, company_mode, fy_mode, ledger_mode, godown_mode, cost_centre_mode)
     VALUES ($1,'ALL','ALL','ALL','ALL','ALL')
     ON CONFLICT (membership_id) DO UPDATE SET
       company_mode = 'ALL', fy_mode = 'ALL', ledger_mode = 'ALL',
       godown_mode = 'ALL', cost_centre_mode = 'ALL'`,
    [membershipId]
  );
  return seatId;
}

async function bootstrapWorkspaceExtras(workspaceId, userId, membershipId) {
  await ensureBillingAccount(userId);
  await seedBuiltinRoles(workspaceId);
  await ensureOwnerSeat(workspaceId, userId, membershipId);
}

/**
 * Ensures personal base workspace + billing + builtin roles + OWNER seat.
 * Owner membership has role_id null (protected authority, not a role).
 * On re-call after register, refreshes workspace name from user.name.
 */
export async function ensurePersonalWorkspace(userId) {
  // Must match the caller's OWN base workspace only.
  // Bug (2026-09-17): joining any is_base workspace where the user is an ACTIVE
  // member (e.g. invited into Owner's personal WS) then ran ensureOwnerSeat and
  // promoted invitees to OWNER — clearing role_id and stealing the OWNER seat.
  const { rows: existing } = await query(
    `SELECT w.*, m.id AS membership_id FROM workspaces w
     JOIN workspace_memberships m ON m.workspace_id = w.id
     WHERE m.user_id = $1
       AND m.status = 'ACTIVE'
       AND w.is_base = TRUE
       AND w.owner_user_id = $1
     ORDER BY w.created_at ASC LIMIT 1`,
    [userId]
  );
  if (existing[0]) {
    const ws = existing[0];
    await bootstrapWorkspaceExtras(ws.id, userId, ws.membership_id);
    const { rows: users } = await query('SELECT id, name FROM users WHERE id = $1', [userId]);
    if (!users[0]) {
      const err = new Error('User not found');
      err.code = 'USER_NOT_FOUND';
      err.httpStatus = 401;
      throw err;
    }
    const expected = personalName(users[0]);
    if (users[0]?.name && ws.name !== expected && ws.name === 'My Workspace') {
      await query(`UPDATE workspaces SET name = $2, updated_at = $3 WHERE id = $1`, [ws.id, expected, now()]);
      ws.name = expected;
    }
    await ensureDemoCompany(userId, ws.id).catch((e) =>
      console.warn('[workspace] demo seed skipped:', e.message)
    );
    const { rows } = await query('SELECT * FROM workspaces WHERE id = $1', [ws.id]);
    return rows[0];
  }

  const { rows: users } = await query('SELECT id, name FROM users WHERE id = $1', [userId]);
  const user = users[0];
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    err.httpStatus = 401;
    throw err;
  }

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
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,'OWNER',NULL,'ACTIVE',$4)`,
    [membershipId, workspaceId, userId, ts]
  );
  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, lineage_id, connection_status, updated_at)
     VALUES ($1,$2,$3,'UNPAIRED',$4)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [uuid(), workspaceId, uuid(), ts]
  );
  await bootstrapWorkspaceExtras(workspaceId, userId, membershipId);
  await audit(workspaceId, userId, 'workspace.bootstrap', { name: personalName(user) });
  await ensureDemoCompany(userId, workspaceId).catch((e) =>
    console.warn('[workspace] demo seed skipped:', e.message)
  );
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


/** Fail closed if membershipId is not in this workspace (prevents cross-WS scope IDOR). */
async function assertMembershipInWorkspace(membershipId, workspaceId) {
  const { rows } = await query(
    `SELECT id FROM workspace_memberships WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [membershipId, workspaceId]
  );
  if (!rows[0]) {
    const err = new Error('Member not found in this workspace');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
}

export function workspacePublicView(workspace) {
  if (!workspace) return null;
  return {
    id: workspace.id,
    name: workspace.name,
    tallyConnection: workspace.tally_connection,
    lifecycleStatus: workspace.lifecycle_status,
    setupGeneration: workspace.setup_generation,
    isBase: workspace.is_base,
  };
}

export async function listWorkspacesForUser(userId) {
  const { rows } = await query(
    `SELECT w.*, m.membership_type, m.status AS membership_status, m.role_id,
            b.connection_status AS binding_status,
            r.system_key AS role_system_key, r.display_name AS role_display_name
     FROM workspaces w
     JOIN workspace_memberships m ON m.workspace_id = w.id
     LEFT JOIN workspace_tally_bindings b ON b.workspace_id = w.id
     LEFT JOIN workspace_roles r ON r.id = m.role_id
     WHERE m.user_id = $1 AND m.status IN ('ACTIVE','SUSPENDED')
       AND w.lifecycle_status = 'ACTIVE'
     ORDER BY w.is_base DESC, w.created_at ASC`,
    [userId]
  );
  const mapped = rows.map((w) => {
    const view = workspacePublicView(w);
    const tallyConnection = w.binding_status || w.tally_connection || view.tallyConnection;
    return {
      ...view,
      tallyConnection,
      membershipType: w.membership_type,
      membershipStatus: w.membership_status,
      roleId: w.role_id,
      roleSystemKey: w.role_system_key || null,
      roleDisplayName: w.role_display_name || null,
    };
  });

  // OWNER workspaces + MEMBER invites (admin-equivalent = MEMBER + ADMIN role)
  return mapped.filter((w) => {
    const mt = String(w.membershipType || '').toUpperCase();
    return mt === 'OWNER' || mt === 'MEMBER';
  });
}

export async function getWorkspaceContext(userId, workspaceId) {
  const workspace = await getWorkspaceById(workspaceId);
  if (!workspace) return null;
  const access = await getEffectiveAccess(userId, workspaceId);
  if (!access.membership || access.membership.status === 'SUSPENDED') {
    return { workspace: workspacePublicView(workspace), access, denied: true };
  }
  const { rows: binding } = await query(
    `SELECT connection_status, active_device_id, lineage_id FROM workspace_tally_bindings
     WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId]
  );
  const pairingStatus = binding[0]?.connection_status || workspace.tally_connection || 'UNPAIRED';

  // Unpaired → ensure one Demo Company with full sample data (owner-bound seed)
  if (String(pairingStatus).toUpperCase() !== 'CONNECTED') {
    await ensureDemoCompany(workspace.owner_user_id || userId, workspaceId).catch((e) =>
      console.warn('[context] ensureDemoCompany:', e.message)
    );
  }

  const { rows: companiesRaw } = await query(
    `SELECT guid, name, gstin, is_active FROM companies
     WHERE workspace_id = $1
     ORDER BY name ASC`,
    [workspaceId]
  );
  let companies = companiesRaw;

  if (String(pairingStatus).toUpperCase() === 'CONNECTED') {
    // Live books: apply member company scope, then hide Demo
    if (access.membership?.membership_type !== 'OWNER') {
      const mode = access.scopes?.policy?.company_mode || 'NONE';
      if (mode === 'NONE') companies = [];
      else if (mode === 'SELECTED') {
        const allowed = new Set(access.scopes?.companies || []);
        companies = companiesRaw.filter((c) => allowed.has(c.guid));
      }
      // ALL: keep companiesRaw; never treat undefined/empty as ALL
    }
    companies = filterCompaniesByPairingStatus(companies, pairingStatus);
  } else {
    // UNPAIRED / RECONNECTING: Demo only — ignore company scope so every member sees it
    companies = filterCompaniesByPairingStatus(companiesRaw, pairingStatus);
  }

  return {
    workspace: workspacePublicView(workspace),
    access: {
      membershipType: access.membership.membership_type,
      membershipStatus: access.membership.status,
      role: access.role,
      capabilities: access.capabilities,
      entryMode: access.entryMode,
      sensitivePolicies: access.sensitivePolicies,
      scopes: access.scopes,
    },
    companies,
    pairing: await (async () => {
      const { buildTallyStatusPayload } = await import('./workspacePairingService.js');
      const payload = await buildTallyStatusPayload(workspaceId, userId);
      return {
        ...payload,
        // aliases used by older clients
        status: payload.status,
        activeDeviceId: payload.activeDeviceId,
        lineageId: binding[0]?.lineage_id || payload.lineageId || null,
      };
    })(),
  };
}

export async function renameWorkspace(userId, workspaceId, name) {
  const m = await loadMembership(userId, workspaceId);
  if (!m || m.status !== 'ACTIVE' || m.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can rename workspace');
    err.code = 'WORKSPACE_ACCESS_DENIED';
    err.httpStatus = 403;
    throw err;
  }
  const trimmed = String(name || '').trim();
  if (trimmed.length < 2) {
    const err = new Error('Name must be at least 2 characters');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  await query(
    `UPDATE workspaces SET name = $2, updated_at = $3 WHERE id = $1`,
    [workspaceId, trimmed, now()]
  );
  await audit(workspaceId, userId, 'workspace.renamed', { name: trimmed });
  return getWorkspaceById(workspaceId);
}

export async function createAdditionalWorkspace(userId, name) {
  const rate = await getServiceRate('ADDITIONAL_WORKSPACE');
  const cost = rate ? Number(rate.credits) : 1000;
  await ensureBillingAccount(userId);

  const trimmed = String(name || '').trim() || 'Additional Workspace';
  const workspaceId = uuid();
  const membershipId = uuid();
  const ts = now();

  await deductCredits({
    userId,
    amount: cost,
    kind: 'ADDITIONAL_WORKSPACE',
    reference: workspaceId,
    workspaceId,
    meta: { rateKey: 'ADDITIONAL_WORKSPACE', version: rate?.version },
  });

  await query(
    `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status,
       tally_connection, setup_generation, is_base, created_at, updated_at)
     VALUES ($1,$2,$3,'PERSONAL','ACTIVE','ACTIVE','UNPAIRED',1,FALSE,$4,$4)`,
    [workspaceId, trimmed, userId, ts]
  );
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,'OWNER',NULL,'ACTIVE',$4)`,
    [membershipId, workspaceId, userId, ts]
  );
  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, lineage_id, connection_status, updated_at)
     VALUES ($1,$2,$3,'UNPAIRED',$4)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [uuid(), workspaceId, uuid(), ts]
  );
  await bootstrapWorkspaceExtras(workspaceId, userId, membershipId);
  await audit(workspaceId, userId, 'workspace.created_paid', { name: trimmed, credits: cost });
  return getWorkspaceById(workspaceId);
}

export async function listMembers(workspaceId) {
  const { rows } = await query(
    `SELECT m.*, u.name AS user_name, u.mobile AS user_mobile,
            r.system_key AS role_system_key, r.display_name AS role_display_name
     FROM workspace_memberships m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN workspace_roles r ON r.id = m.role_id
     WHERE m.workspace_id = $1 AND m.status IN ('ACTIVE','SUSPENDED')
     ORDER BY m.membership_type = 'OWNER' DESC, m.joined_at ASC`,
    [workspaceId]
  );
  return rows;
}

export async function listSeats(workspaceId) {
  const { rows } = await query(
    `SELECT * FROM workspace_seats WHERE workspace_id = $1 ORDER BY created_at ASC`,
    [workspaceId]
  );
  return rows;
}

export async function purchaseSeat(userId, workspaceId) {
  const mem = await loadMembership(userId, workspaceId);
  if (!mem || mem.status !== 'ACTIVE' || mem.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can purchase seats');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const rate = await getServiceRate('SEAT_MONTHLY');
  const cost = rate ? Number(rate.credits) : 100;
  await deductCredits({
    userId,
    amount: cost,
    kind: 'SEAT_MONTHLY',
    reference: workspaceId,
    workspaceId,
    meta: { rateKey: 'SEAT_MONTHLY' },
  });
  const seatId = uuid();
  const ts = now();
  const periodEnd = ts + 30 * 24 * 60 * 60;
  await query(
    `INSERT INTO workspace_seats (id, workspace_id, seat_kind, status, period_start, period_end, created_at)
     VALUES ($1,$2,'PAID','AVAILABLE',$3,$4,$3)`,
    [seatId, workspaceId, ts, periodEnd]
  );
  await audit(workspaceId, userId, 'seat.purchased', { seatId, credits: cost });
  const { rows } = await query(`SELECT * FROM workspace_seats WHERE id = $1`, [seatId]);
  return rows[0];
}

export async function getMemberScopes(membershipId, workspaceId = null) {
  if (workspaceId) {
    await assertMembershipInWorkspace(membershipId, workspaceId);
  }
  const { rows: policy } = await query(
    `SELECT * FROM membership_scope_policy WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: companies } = await query(
    `SELECT c.guid AS company_guid, mca.company_id
       FROM member_company_access mca
       JOIN companies c ON c.id = mca.company_id
      WHERE mca.membership_id = $1`,
    [membershipId]
  );
  const { rows: fys } = await query(
    `SELECT fy_key FROM member_fy_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: ledgers } = await query(
    `SELECT ledger_guid, ledger_name FROM member_ledger_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: godowns } = await query(
    `SELECT godown_guid, godown_name FROM member_godown_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: ccs } = await query(
    `SELECT cost_centre_guid, cost_centre_name FROM member_cost_centre_access WHERE membership_id = $1`,
    [membershipId]
  );
  return {
    policy: policy[0] || null,
    companies: companies.map((r) => r.company_guid),
    financialYears: fys.map((r) => r.fy_key),
    ledgers,
    godowns,
    costCentres: ccs,
  };
}

export async function putMemberScopes(membershipId, scopes = {}, workspaceId = null) {
  if (workspaceId) {
    await assertMembershipInWorkspace(membershipId, workspaceId);
  }
  const policy = scopes.policy || scopes;
  await query(
    `INSERT INTO membership_scope_policy
       (membership_id, company_mode, fy_mode, ledger_mode, godown_mode, cost_centre_mode)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (membership_id) DO UPDATE SET
       company_mode = EXCLUDED.company_mode,
       fy_mode = EXCLUDED.fy_mode,
       ledger_mode = EXCLUDED.ledger_mode,
       godown_mode = EXCLUDED.godown_mode,
       cost_centre_mode = EXCLUDED.cost_centre_mode`,
    [
      membershipId,
      policy.company_mode || 'NONE',
      policy.fy_mode || 'NONE',
      policy.ledger_mode || 'NONE',
      policy.godown_mode || 'NONE',
      policy.cost_centre_mode || 'NONE',
    ]
  );

  if (Array.isArray(scopes.companies)) {
    await query(`DELETE FROM member_company_access WHERE membership_id = $1`, [membershipId]);
    for (const guid of scopes.companies) {
      if (!workspaceId) {
        const err = new Error('workspaceId required to set company scopes');
        err.code = 'WORKSPACE_REQUIRED';
        err.httpStatus = 400;
        throw err;
      }
      const { rows: cos } = await query(
        `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
        [guid, workspaceId]
      );
      if (!cos[0]?.id) {
        const err = new Error(`Company ${guid} not in workspace`);
        err.code = 'COMPANY_SCOPE_DENIED';
        err.httpStatus = 403;
        throw err;
      }
      await query(
        `INSERT INTO member_company_access (membership_id, company_id)
         VALUES ($1,$2)
         ON CONFLICT (membership_id, company_id) DO NOTHING`,
        [membershipId, cos[0].id]
      );
    }
  }
  if (Array.isArray(scopes.financialYears)) {
    await query(`DELETE FROM member_fy_access WHERE membership_id = $1`, [membershipId]);
    for (const fy of scopes.financialYears) {
      await query(
        `INSERT INTO member_fy_access (membership_id, fy_key) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [membershipId, fy]
      );
    }
  }
  if (Array.isArray(scopes.ledgers)) {
    await query(`DELETE FROM member_ledger_access WHERE membership_id = $1`, [membershipId]);
    for (const L of scopes.ledgers) {
      const guid = typeof L === 'string' ? L : L.ledger_guid;
      const name = typeof L === 'string' ? null : L.ledger_name || null;
      if (!guid) continue;
      await query(
        `INSERT INTO member_ledger_access (membership_id, ledger_guid, ledger_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [membershipId, guid, name]
      );
    }
  }
  if (Array.isArray(scopes.godowns)) {
    await query(`DELETE FROM member_godown_access WHERE membership_id = $1`, [membershipId]);
    for (const G of scopes.godowns) {
      const guid = typeof G === 'string' ? G : G.godown_guid;
      const name = typeof G === 'string' ? null : G.godown_name || null;
      if (!guid) continue;
      await query(
        `INSERT INTO member_godown_access (membership_id, godown_guid, godown_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [membershipId, guid, name]
      );
    }
  }
  if (Array.isArray(scopes.costCentres)) {
    await query(`DELETE FROM member_cost_centre_access WHERE membership_id = $1`, [membershipId]);
    for (const C of scopes.costCentres) {
      const guid = typeof C === 'string' ? C : C.cost_centre_guid;
      const name = typeof C === 'string' ? null : C.cost_centre_name || null;
      if (!guid) continue;
      await query(
        `INSERT INTO member_cost_centre_access (membership_id, cost_centre_guid, cost_centre_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [membershipId, guid, name]
      );
    }
  }
  return getMemberScopes(membershipId);
}

export async function createInvitation({ workspaceId, invitedByUserId, mobile, roleId, scopes }) {
  const { getConnectionStatus } = await import('./workspacePairingService.js');
  const conn = await getConnectionStatus(workspaceId);
  if (conn !== 'CONNECTED') {
    const err = new Error(
      'Connect Tally and complete the first sync before inviting new members.'
    );
    err.code = 'TALLY_CONNECTION_REQUIRED_FOR_INVITE';
    err.httpStatus = 403;
    throw err;
  }

  const digits = String(mobile || '').replace(/\D/g, '');
  const cleanMobile = digits.length > 10 ? digits.slice(-10) : digits;
  if (cleanMobile.length < 10) {
    const err = new Error('Valid mobile required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  // Existing users only — match 10-digit or E.164 (+91…) stored mobiles
  const { rows: users } = await query(
    `SELECT id FROM users
     WHERE regexp_replace(COALESCE(mobile,''), '\\D', '', 'g') = $1
        OR RIGHT(regexp_replace(COALESCE(mobile,''), '\\D', '', 'g'), 10) = $1
     LIMIT 1`,
    [cleanMobile]
  );
  const inviteeUserId = users[0]?.id;
  if (!inviteeUserId) {
    const err = new Error('Invitee must already have a TallyDekho account (request OTP / sign in first)');
    err.code = 'INVITEE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }

  const { rows: existing } = await query(
    `SELECT id, status, membership_type FROM workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [workspaceId, inviteeUserId]
  );
  if (existing[0] && ['ACTIVE', 'SUSPENDED'].includes(existing[0].status)) {
    const err = new Error('User is already a member of this workspace');
    err.code = 'ALREADY_MEMBER';
    err.httpStatus = 409;
    throw err;
  }
  const { rows: pendingInv } = await query(
    `SELECT id FROM workspace_invitations
     WHERE workspace_id = $1 AND invitee_user_id = $2 AND status = 'PENDING' AND expires_at > $3
     LIMIT 1`,
    [workspaceId, inviteeUserId, now()]
  );
  if (pendingInv[0]) {
    const err = new Error('An invitation is already pending for this user');
    err.code = 'INVITE_ALREADY_PENDING';
    err.httpStatus = 409;
    throw err;
  }

  const { rows: seats } = await query(
    `UPDATE workspace_seats SET status = 'RESERVED'
     WHERE id = (
       SELECT id FROM workspace_seats
       WHERE workspace_id = $1 AND status = 'AVAILABLE' AND seat_kind = 'PAID'
       ORDER BY created_at ASC LIMIT 1
     )
     RETURNING id`,
    [workspaceId]
  );
  const reservedSeatId = seats[0]?.id || null;
  if (!reservedSeatId) {
    const err = new Error('No available seat — purchase a seat before inviting');
    err.code = 'NO_SEAT_AVAILABLE';
    err.httpStatus = 409;
    throw err;
  }

  // RBAC-Q021: never coerce missing/empty company selection to ALL.
  // Ordinary invites default to company_mode=NONE; ALL only when explicitly set
  // and the assigned role is OWNER/ADMIN-style privileged.
  let scopeSnapshot = scopes || null;
  if (scopeSnapshot && typeof scopeSnapshot === 'object') {
    const policy = { ...(scopeSnapshot.policy || {}) };
    let companyMode = String(policy.company_mode || 'NONE').toUpperCase();
    if (!['NONE', 'SELECTED', 'ALL'].includes(companyMode)) companyMode = 'NONE';
    if (companyMode === 'ALL') {
      let allowAll = false;
      if (roleId) {
        const { rows: roleRows } = await query(
          `SELECT system_key, membership_type FROM workspace_roles WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
          [roleId, workspaceId]
        );
        const sk = String(roleRows[0]?.system_key || '').toUpperCase();
        allowAll = sk === 'OWNER' || sk === 'ADMIN';
      }
      if (!allowAll) companyMode = 'NONE';
    }
    if (companyMode === 'SELECTED') {
      const list = Array.isArray(scopeSnapshot.companies) ? scopeSnapshot.companies.filter(Boolean) : [];
      if (list.length === 0) companyMode = 'NONE';
      scopeSnapshot = { ...scopeSnapshot, companies: list, policy: { ...policy, company_mode: companyMode } };
    } else {
      scopeSnapshot = {
        ...scopeSnapshot,
        companies: companyMode === 'ALL' ? scopeSnapshot.companies : [],
        policy: { ...policy, company_mode: companyMode },
      };
    }
  } else {
    scopeSnapshot = { companies: [], policy: { company_mode: 'NONE' } };
  }

  const inviteId = uuid();
  const ts = now();
  const expiresAt = ts + 48 * 60 * 60; // 48h TTL
  await query(
    `INSERT INTO workspace_invitations
       (id, workspace_id, invitee_user_id, role_id, reserved_seat_id, status, expires_at,
        invited_by_user_id, created_at, scope_snapshot_json)
     VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$8,$9)`,
    [
      inviteId, workspaceId, inviteeUserId, roleId || null, reservedSeatId,
      expiresAt, invitedByUserId, ts, JSON.stringify(scopeSnapshot),
    ]
  );
  await audit(workspaceId, invitedByUserId, 'invitation.created', { inviteId, inviteeUserId, roleId });
  const { rows } = await query(`SELECT * FROM workspace_invitations WHERE id = $1`, [inviteId]);
  return rows[0];
}

export async function listMyInvitations(userId) {
  const { rows } = await query(
    `SELECT i.id, i.workspace_id, i.invitee_user_id, i.role_id, i.status,
            i.expires_at, i.created_at, i.invited_by_user_id,
            w.name AS workspace_name, r.display_name AS role_display_name
     FROM workspace_invitations i
     JOIN workspaces w ON w.id = i.workspace_id
     LEFT JOIN workspace_roles r ON r.id = i.role_id
     WHERE i.invitee_user_id = $1 AND i.status = 'PENDING' AND i.expires_at > $2
     ORDER BY i.created_at DESC`,
    [userId, now()]
  );
  // Never ship scope_snapshot_json to clients — nested objects have caused RN
  // "Objects are not valid as a React child" crashes if accidentally rendered.
  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    workspace_name: r.workspace_name || 'Workspace',
    role_id: r.role_id,
    role_display_name: r.role_display_name || 'Member',
    status: r.status,
    expires_at: r.expires_at,
    created_at: r.created_at,
    invited_by_user_id: r.invited_by_user_id,
  }));
}

/** Pending invitations sent for a workspace (Owner/Admin Team Access). */
export async function listWorkspaceInvitations(workspaceId) {
  const { rows } = await query(
    `SELECT i.id, i.workspace_id, i.invitee_user_id, i.role_id, i.status,
            i.expires_at, i.created_at, i.invited_by_user_id, i.reserved_seat_id,
            r.display_name AS role_display_name,
            u.name AS invitee_name, u.mobile AS invitee_mobile,
            inviter.name AS invited_by_name
     FROM workspace_invitations i
     LEFT JOIN workspace_roles r ON r.id = i.role_id
     LEFT JOIN users u ON u.id = i.invitee_user_id
     LEFT JOIN users inviter ON inviter.id = i.invited_by_user_id
     WHERE i.workspace_id = $1 AND i.status = 'PENDING' AND i.expires_at > $2
     ORDER BY i.created_at DESC`,
    [workspaceId, now()]
  );
  return rows.map((r) => ({
    id: r.id,
    workspace_id: r.workspace_id,
    invitee_user_id: r.invitee_user_id,
    invitee_name: r.invitee_name || null,
    invitee_mobile: r.invitee_mobile || null,
    role_id: r.role_id,
    role_display_name: r.role_display_name || 'Member',
    status: r.status,
    expires_at: r.expires_at,
    created_at: r.created_at,
    invited_by_user_id: r.invited_by_user_id,
    invited_by_name: r.invited_by_name || null,
  }));
}

export async function revokeWorkspaceInvitation(actorUserId, workspaceId, invitationId) {
  await assertCapability(actorUserId, workspaceId, 'members.invite');

  const { rows } = await query(
    `SELECT * FROM workspace_invitations
     WHERE id = $1 AND workspace_id = $2 AND status = 'PENDING' LIMIT 1`,
    [invitationId, workspaceId]
  );
  const inv = rows[0];
  if (!inv) {
    const err = new Error('Invitation not found or not pending');
    err.code = 'INVITATION_INVALID';
    err.httpStatus = 404;
    throw err;
  }
  const ts = now();
  await query(
    `UPDATE workspace_invitations SET status = 'REVOKED', revoked_at = $2 WHERE id = $1`,
    [invitationId, ts]
  );
  if (inv.reserved_seat_id) {
    await query(
      `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL WHERE id = $1`,
      [inv.reserved_seat_id]
    );
  }
  await audit(workspaceId, actorUserId, 'invitation.revoked', { invitationId });
  return true;
}

export async function acceptInvitation(userId, invitationId) {
  const { rows } = await query(
    `SELECT * FROM workspace_invitations WHERE id = $1 AND invitee_user_id = $2 LIMIT 1`,
    [invitationId, userId]
  );
  const inv = rows[0];
  if (!inv || inv.status !== 'PENDING') {
    const err = new Error('Invitation not found or not pending');
    err.code = 'INVITATION_INVALID';
    err.httpStatus = 404;
    throw err;
  }
  if (inv.expires_at < now()) {
    const err = new Error('Invitation expired');
    err.code = 'INVITATION_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  if (!inv.reserved_seat_id) {
    const err = new Error('Invitation has no reserved seat');
    err.code = 'NO_SEAT_AVAILABLE';
    err.httpStatus = 409;
    throw err;
  }
  const ts = now();
  // Never demote/overwrite an existing OWNER via invite accept
  const { rows: existingMem } = await query(
    `SELECT id, membership_type, status, seat_id FROM workspace_memberships
     WHERE workspace_id = $1 AND user_id = $2 LIMIT 1`,
    [inv.workspace_id, userId]
  );
  if (existingMem[0]?.membership_type === 'OWNER') {
    const err = new Error('Owner cannot accept an invite into their own workspace as a member');
    err.code = 'CANNOT_DEMOTE_OWNER';
    err.httpStatus = 409;
    throw err;
  }
  if (existingMem[0] && ['ACTIVE', 'SUSPENDED'].includes(existingMem[0].status)) {
    const err = new Error('User is already a member of this workspace');
    err.code = 'ALREADY_MEMBER';
    err.httpStatus = 409;
    throw err;
  }
  // Admin-equivalent invite → MEMBER + builtin ADMIN role_id (never membership_type ADMIN)
  const membershipType = 'MEMBER';
  if (inv.role_id) {
    const { rows: roleRows } = await query(
      `SELECT system_key FROM workspace_roles WHERE id = $1 LIMIT 1`,
      [inv.role_id]
    );
    if (!roleRows[0]) {
      const err = new Error('Invitation role no longer exists');
      err.code = 'ROLE_NOT_FOUND';
      err.httpStatus = 409;
      throw err;
    }
  }
  const membershipId = uuid();
  // Free prior seat if re-joining after REMOVED with a stale seat pointer
  if (existingMem[0]?.seat_id && existingMem[0].seat_id !== inv.reserved_seat_id) {
    await query(
      `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL WHERE id = $1`,
      [existingMem[0].seat_id]
    );
  }
  await query(
    `INSERT INTO workspace_memberships
       (id, workspace_id, user_id, membership_type, role_id, status, seat_id, joined_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6,$7)
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET
       status = 'ACTIVE',
       membership_type = EXCLUDED.membership_type,
       role_id = EXCLUDED.role_id,
       seat_id = EXCLUDED.seat_id,
       removed_at = NULL, suspended_at = NULL`,
    [membershipId, inv.workspace_id, userId, membershipType, inv.role_id, inv.reserved_seat_id, ts]
  );
  const { rows: mem } = await query(
    `SELECT id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
    [inv.workspace_id, userId]
  );
  const mid = mem[0]?.id || membershipId;
  if (inv.reserved_seat_id) {
    await query(
      `UPDATE workspace_seats SET status = 'ASSIGNED', assigned_user_id = $2 WHERE id = $1`,
      [inv.reserved_seat_id, userId]
    );
  }
  if (inv.scope_snapshot_json) {
    const snap = typeof inv.scope_snapshot_json === 'string'
      ? JSON.parse(inv.scope_snapshot_json)
      : inv.scope_snapshot_json;
    await putMemberScopes(mid, snap);
  } else {
    await putMemberScopes(mid, { policy: { company_mode: 'NONE', fy_mode: 'NONE', ledger_mode: 'NONE', godown_mode: 'NONE', cost_centre_mode: 'NONE' } });
  }
  await query(
    `UPDATE workspace_invitations SET status = 'ACCEPTED', accepted_at = $2 WHERE id = $1`,
    [invitationId, ts]
  );
  await audit(inv.workspace_id, userId, 'invitation.accepted', { invitationId });
  return { workspaceId: inv.workspace_id, membershipId: mid };
}

export async function declineInvitation(userId, invitationId) {
  const { rows } = await query(
    `SELECT * FROM workspace_invitations WHERE id = $1 AND invitee_user_id = $2 LIMIT 1`,
    [invitationId, userId]
  );
  const inv = rows[0];
  if (!inv || inv.status !== 'PENDING') {
    const err = new Error('Invitation not found or not pending');
    err.code = 'INVITATION_INVALID';
    err.httpStatus = 404;
    throw err;
  }
  const ts = now();
  await query(
    `UPDATE workspace_invitations SET status = 'DECLINED', declined_at = $2 WHERE id = $1`,
    [invitationId, ts]
  );
  if (inv.reserved_seat_id) {
    await query(
      `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL WHERE id = $1`,
      [inv.reserved_seat_id]
    );
  }
  await audit(inv.workspace_id, userId, 'invitation.declined', { invitationId });
  return true;
}

export async function suspendMember(actorUserId, workspaceId, targetUserId) {
  await assertCapability(actorUserId, workspaceId, 'members.suspend');

  const target = await loadMembership(targetUserId, workspaceId);
  if (!target) {
    const err = new Error('Member not found');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (target.membership_type === 'OWNER') {
    const err = new Error('Cannot suspend Owner');
    err.code = 'CANNOT_SUSPEND_OWNER';
    err.httpStatus = 400;
    throw err;
  }
  await query(
    `UPDATE workspace_memberships SET status = 'SUSPENDED', suspended_at = $2 WHERE id = $1`,
    [target.id, now()]
  );
  await audit(workspaceId, actorUserId, 'member.suspended', { targetUserId });
  try {
    const { getWorkspaceSocket } = await import('../socket/workspaceEmit.js');
    const sock = getWorkspaceSocket?.();
    sock?.notifyWorkspace?.(targetUserId, 'membership_revoked', {
      userId: targetUserId,
      workspaceId,
      reason: 'SUSPENDED',
      message: 'Your membership was suspended',
    });
    sock?.notifyWorkspace?.(targetUserId, 'access_revoked', {
      userId: targetUserId,
      workspaceId,
      reason: 'SUSPENDED',
    });
    sock?.notifyWorkspaceRoom?.(workspaceId, 'membership_changed', {
      workspaceId,
      targetUserId,
      status: 'SUSPENDED',
    });
    sock?.revokeUserWorkspaceAccess?.(targetUserId, workspaceId, 'SUSPENDED');
  } catch {
    /* socket optional */
  }
  return true;
}

export async function unsuspendMember(actorUserId, workspaceId, targetUserId) {
  await assertCapability(actorUserId, workspaceId, 'members.unsuspend');

  await query(
    `UPDATE workspace_memberships SET status = 'ACTIVE', suspended_at = NULL
     WHERE workspace_id = $1 AND user_id = $2 AND status = 'SUSPENDED'`,
    [workspaceId, targetUserId]
  );
  await audit(workspaceId, actorUserId, 'member.unsuspended', { targetUserId });
  return true;
}

export async function removeMember(actorUserId, workspaceId, targetUserId) {
  await assertCapability(actorUserId, workspaceId, 'members.remove');

  const target = await loadMembership(targetUserId, workspaceId);
  if (!target) {
    const err = new Error('Member not found');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (target.membership_type === 'OWNER') {
    const err = new Error('Cannot remove Owner');
    err.code = 'CANNOT_REMOVE_OWNER';
    err.httpStatus = 400;
    throw err;
  }
  const ts = now();
  await query(
    `UPDATE workspace_memberships SET status = 'REMOVED', removed_at = $2 WHERE id = $1`,
    [target.id, ts]
  );
  if (target.seat_id) {
    await query(
      `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL WHERE id = $1`,
      [target.seat_id]
    );
  }
  await audit(workspaceId, actorUserId, 'member.removed', { targetUserId });
  try {
    const { getWorkspaceSocket } = await import('../socket/workspaceEmit.js');
    const sock = getWorkspaceSocket?.();
    sock?.notifyWorkspace?.(targetUserId, 'membership_revoked', {
      userId: targetUserId,
      workspaceId,
      reason: 'REMOVED',
      message: 'Your membership was removed',
    });
    sock?.notifyWorkspace?.(targetUserId, 'access_revoked', {
      userId: targetUserId,
      workspaceId,
      reason: 'REMOVED',
    });
    sock?.notifyWorkspaceRoom?.(workspaceId, 'membership_changed', {
      workspaceId,
      targetUserId,
      status: 'REMOVED',
    });
    sock?.revokeUserWorkspaceAccess?.(targetUserId, workspaceId, 'REMOVED');
  } catch {
    /* socket optional */
  }
  return true;
}

/**
 * Assign/change a member's role_id. membership_type stays MEMBER (OWNER never via this path).
 * Capability checked at route (members.role_assign).
 */
export async function changeMemberRole(actorUserId, workspaceId, targetUserId, roleId) {
  if (!roleId) {
    const err = new Error('roleId required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const target = await loadMembership(targetUserId, workspaceId);
  if (!target) {
    const err = new Error('Member not found');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (target.membership_type === 'OWNER') {
    const err = new Error('Cannot change Owner membership type or role via this endpoint');
    err.code = 'CANNOT_CHANGE_OWNER_ROLE';
    err.httpStatus = 400;
    throw err;
  }
  const { rows: roleRows } = await query(
    `SELECT id, system_key FROM workspace_roles WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [roleId, workspaceId]
  );
  if (!roleRows[0]) {
    const err = new Error('Role not found in this workspace');
    err.code = 'ROLE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const membershipType = 'MEMBER';
  const previousRoleId = target.role_id;
  await query(
    `UPDATE workspace_memberships SET role_id = $2, membership_type = $3 WHERE id = $1`,
    [target.id, roleId, membershipType]
  );
  await audit(workspaceId, actorUserId, 'member.role_changed', {
    targetUserId,
    previousRoleId,
    roleId,
    membershipType,
    roleSystemKey: roleRows[0].system_key,
  });
  return {
    membershipId: target.id,
    userId: targetUserId,
    roleId,
    previousRoleId,
    membershipType,
    roleSystemKey: roleRows[0].system_key,
  };
}

/**
 * Initiate ownership transfer: 3 unique confirm tokens, PENDING_CONFIRM, 24h confirm window.
 * Free/base workspaces require Owner wallet to hold ≥ ADDITIONAL_WORKSPACE credits (consumed on complete).
 */
export async function initiateOwnershipTransfer(actorUserId, workspaceId, { targetUserId, outgoingRoleId }) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can initiate ownership transfer');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const targetId = Number(targetUserId);
  if (!Number.isFinite(targetId) || targetId === actorUserId) {
    const err = new Error('targetUserId must be a different workspace member');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const target = await loadMembership(targetId, workspaceId);
  if (!target || target.status !== 'ACTIVE') {
    const err = new Error('Target must be an active workspace member');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (outgoingRoleId) {
    const { rows: roleRows } = await query(
      `SELECT id FROM workspace_roles WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [outgoingRoleId, workspaceId]
    );
    if (!roleRows[0]) {
      const err = new Error('outgoingRoleId not found in this workspace');
      err.code = 'ROLE_NOT_FOUND';
      err.httpStatus = 404;
      throw err;
    }
  }

  const { rows: active } = await query(
    `SELECT id FROM workspace_ownership_transfers
     WHERE workspace_id = $1 AND status IN ('PENDING_TARGET_ACCEPT','PENDING_EMAIL','PENDING_CONFIRM','PENDING_GRACE')
     LIMIT 1`,
    [workspaceId]
  );
  if (active[0]) {
    const err = new Error('An ownership transfer is already in progress');
    err.code = 'TRANSFER_IN_PROGRESS';
    err.httpStatus = 409;
    throw err;
  }

  const ws = await getWorkspaceById(workspaceId);
  const rate = await getServiceRate('ADDITIONAL_WORKSPACE');
  const reserveCredits = rate ? Number(rate.credits) : 1000;
  if (ws?.is_base) {
    await ensureBillingAccount(actorUserId);
    const wallet = await getWallet(actorUserId);
    const bal = Number(wallet?.balance_credits) || 0;
    if (bal < reserveCredits) {
      const err = new Error(
        `Free workspace ownership transfer requires ${reserveCredits} credits reserved on Owner wallet`
      );
      err.code = 'INSUFFICIENT_CREDITS';
      err.httpStatus = 402;
      throw err;
    }
  }

  const plainTokens = [makeConfirmToken(), makeConfirmToken(), makeConfirmToken()];
  const tokenRecords = plainTokens.map((t, i) => ({
    step: i + 1,
    hash: hashToken(t),
    used: false,
  }));
  const transferId = uuid();
  const ts = now();
  const expiresAt = ts + DAY_SEC;

  await query(
    `INSERT INTO workspace_ownership_transfers
       (id, workspace_id, from_user_id, target_user_id, outgoing_role_id, status,
        confirm_count, confirm_tokens_json, email_count, expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,'PENDING_CONFIRM',0,$6,0,$7,$8,$8)`,
    [
      transferId, workspaceId, actorUserId, targetId, outgoingRoleId || null,
      JSON.stringify(tokenRecords), expiresAt, ts,
    ]
  );

  const { rows: ownerRows } = await query(
    `SELECT email, name FROM users WHERE id = $1 LIMIT 1`,
    [actorUserId]
  );
  const ownerEmail = ownerRows[0]?.email || null;
  const apiBase = (process.env.PUBLIC_API_BASE || process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const confirmUrls = plainTokens.map(
    (t, i) => `${apiBase}/api/workspaces/${workspaceId}/transfer/${transferId}/confirm?token=${t}&step=${i + 1}`
  );

  let emailsSent = 0;
  if (ownerEmail) {
    for (let i = 0; i < plainTokens.length; i++) {
      const result = await sendOwnershipConfirmEmail({
        toEmail: ownerEmail,
        workspaceName: ws?.name,
        confirmUrl: confirmUrls[i],
        step: i + 1,
        total: 3,
      });
      if (result?.success) emailsSent += 1;
    }
    await query(
      `UPDATE workspace_ownership_transfers SET email_count = $2, updated_at = $3 WHERE id = $1`,
      [transferId, emailsSent, now()]
    );
  }

  await audit(workspaceId, actorUserId, 'ownership.transfer_initiated', {
    transferId,
    targetUserId: targetId,
    outgoingRoleId: outgoingRoleId || null,
    reserveCredits: ws?.is_base ? reserveCredits : 0,
    emailsSent,
  });

  const payload = {
    status: 'PENDING_CONFIRM',
    transferId,
    confirmCount: 0,
    expiresAt,
    emailsSent,
    confirmWindowHours: 24,
  };
  if (process.env.NODE_ENV !== 'production' || !ownerEmail || emailsSent === 0) {
    payload.confirmTokens = plainTokens;
    payload.confirmUrls = confirmUrls;
  }
  return payload;
}

/**
 * Optional: target member acknowledges transfer offer (MD allows Owner-driven flow via initiate).
 * If transfer is already PENDING_CONFIRM, returns current state.
 */
export async function acceptOwnershipTransferByTarget(targetUserId, workspaceId, transferId) {
  const { rows } = await query(
    `SELECT * FROM workspace_ownership_transfers
     WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [transferId, workspaceId]
  );
  const transfer = rows[0];
  if (!transfer) {
    const err = new Error('Transfer not found');
    err.code = 'TRANSFER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (Number(transfer.target_user_id) !== Number(targetUserId)) {
    const err = new Error('Only the designated target can accept this transfer');
    err.code = 'FORBIDDEN';
    err.httpStatus = 403;
    throw err;
  }
  if (transfer.status === 'PENDING_CONFIRM' || transfer.status === 'PENDING_GRACE') {
    return {
      transferId,
      status: transfer.status,
      confirmCount: Number(transfer.confirm_count) || 0,
      note: 'Transfer already past target-accept; Owner confirmations in progress',
    };
  }
  if (transfer.status !== 'PENDING_TARGET_ACCEPT') {
    const err = new Error(`Transfer is ${transfer.status}, cannot accept`);
    err.code = 'TRANSFER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  if (transfer.expires_at && transfer.expires_at < now()) {
    await query(
      `UPDATE workspace_ownership_transfers SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
      [transferId, now()]
    );
    const err = new Error('Transfer offer expired');
    err.code = 'TRANSFER_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }

  // Legacy PENDING_TARGET_ACCEPT rows: generate tokens + move to PENDING_CONFIRM
  const plainTokens = [makeConfirmToken(), makeConfirmToken(), makeConfirmToken()];
  const tokenRecords = plainTokens.map((t, i) => ({ step: i + 1, hash: hashToken(t), used: false }));
  const ts = now();
  const expiresAt = ts + DAY_SEC;
  await query(
    `UPDATE workspace_ownership_transfers
     SET status = 'PENDING_CONFIRM', confirm_tokens_json = $2, confirm_count = 0,
         expires_at = $3, updated_at = $4
     WHERE id = $1`,
    [transferId, JSON.stringify(tokenRecords), expiresAt, ts]
  );

  const ws = await getWorkspaceById(workspaceId);
  const { rows: ownerRows } = await query(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [transfer.from_user_id]
  );
  const ownerEmail = ownerRows[0]?.email || null;
  const apiBase = (process.env.PUBLIC_API_BASE || process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const confirmUrls = plainTokens.map(
    (t, i) => `${apiBase}/api/workspaces/${workspaceId}/transfer/${transferId}/confirm?token=${t}&step=${i + 1}`
  );
  let emailsSent = 0;
  if (ownerEmail) {
    for (let i = 0; i < plainTokens.length; i++) {
      const result = await sendOwnershipConfirmEmail({
        toEmail: ownerEmail,
        workspaceName: ws?.name,
        confirmUrl: confirmUrls[i],
        step: i + 1,
        total: 3,
      });
      if (result?.success) emailsSent += 1;
    }
    await query(
      `UPDATE workspace_ownership_transfers SET email_count = $2, updated_at = $3 WHERE id = $1`,
      [transferId, emailsSent, now()]
    );
  }
  await audit(workspaceId, targetUserId, 'ownership.transfer_target_accepted', { transferId, emailsSent });
  const payload = {
    transferId,
    status: 'PENDING_CONFIRM',
    confirmCount: 0,
    expiresAt,
    emailsSent,
    confirmWindowHours: 24,
  };
  if (process.env.NODE_ENV !== 'production' || !ownerEmail || emailsSent === 0) {
    payload.confirmTokens = plainTokens;
    payload.confirmUrls = confirmUrls;
  }
  return payload;
}

/**
 * Confirm one of the 3 ownership-transfer email tokens.
 * At 3 confirms → PENDING_GRACE with grace_ends_at = now+24h.
 */
export async function confirmOwnershipTransferEmail(transferId, token) {
  if (!token) {
    const err = new Error('token required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_ownership_transfers WHERE id = $1 LIMIT 1`,
    [transferId]
  );
  const transfer = rows[0];
  if (!transfer) {
    const err = new Error('Transfer not found');
    err.code = 'TRANSFER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (transfer.status === 'EXPIRED' || (transfer.expires_at && transfer.expires_at < now() && transfer.status === 'PENDING_CONFIRM')) {
    await query(
      `UPDATE workspace_ownership_transfers SET status = 'EXPIRED', updated_at = $2 WHERE id = $1 AND status = 'PENDING_CONFIRM'`,
      [transferId, now()]
    );
    const err = new Error('Confirm window expired');
    err.code = 'TRANSFER_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  if (transfer.status !== 'PENDING_CONFIRM') {
    const err = new Error(`Transfer is ${transfer.status}, cannot confirm`);
    err.code = 'TRANSFER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }

  let tokens = transfer.confirm_tokens_json;
  if (typeof tokens === 'string') tokens = JSON.parse(tokens);
  if (!Array.isArray(tokens)) tokens = [];
  const hashed = hashToken(token);
  const idx = tokens.findIndex((t) => t.hash === hashed && !t.used);
  if (idx < 0) {
    const err = new Error('Invalid or already used confirmation token');
    err.code = 'TOKEN_INVALID';
    err.httpStatus = 400;
    throw err;
  }
  tokens[idx].used = true;
  tokens[idx].usedAt = now();
  const confirmCount = tokens.filter((t) => t.used).length;
  const ts = now();

  if (confirmCount >= 3) {
    const graceEndsAt = ts + DAY_SEC;
    await query(
      `UPDATE workspace_ownership_transfers
       SET confirm_count = $2, confirm_tokens_json = $3, status = 'PENDING_GRACE',
           grace_ends_at = $4, updated_at = $5
       WHERE id = $1`,
      [transferId, confirmCount, JSON.stringify(tokens), graceEndsAt, ts]
    );
    await audit(transfer.workspace_id, transfer.from_user_id, 'ownership.transfer_grace_started', {
      transferId,
      graceEndsAt,
    });
    return {
      transferId,
      status: 'PENDING_GRACE',
      confirmCount,
      graceEndsAt,
      graceHours: 24,
    };
  }

  await query(
    `UPDATE workspace_ownership_transfers
     SET confirm_count = $2, confirm_tokens_json = $3, updated_at = $4
     WHERE id = $1`,
    [transferId, confirmCount, JSON.stringify(tokens), ts]
  );
  await audit(transfer.workspace_id, transfer.from_user_id, 'ownership.transfer_confirm', {
    transferId,
    confirmCount,
  });
  return { transferId, status: 'PENDING_CONFIRM', confirmCount, remaining: 3 - confirmCount };
}

export async function revokeOwnershipTransfer(actorUserId, workspaceId, transferId) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can revoke ownership transfer');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_ownership_transfers
     WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [transferId, workspaceId]
  );
  const transfer = rows[0];
  if (!transfer) {
    const err = new Error('Transfer not found');
    err.code = 'TRANSFER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (!['PENDING_TARGET_ACCEPT', 'PENDING_EMAIL', 'PENDING_CONFIRM', 'PENDING_GRACE'].includes(transfer.status)) {
    const err = new Error(`Cannot revoke transfer in status ${transfer.status}`);
    err.code = 'TRANSFER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  const ts = now();
  await query(
    `UPDATE workspace_ownership_transfers
     SET status = 'CANCELLED', cancelled_at = $2, updated_at = $2 WHERE id = $1`,
    [transferId, ts]
  );
  await audit(workspaceId, actorUserId, 'ownership.transfer_revoked', { transferId });
  return { transferId, status: 'CANCELLED' };
}

/**
 * Complete ownership transfer after grace (Owner or system/cron).
 * Flips Owner membership, assigns outgoing role, consumes 1000 credits if free/base.
 */
export async function completeOwnershipTransfer(actorUserId, workspaceId, transferId, { system = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM workspace_ownership_transfers
     WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [transferId, workspaceId]
  );
  const transfer = rows[0];
  if (!transfer) {
    const err = new Error('Transfer not found');
    err.code = 'TRANSFER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (transfer.status !== 'PENDING_GRACE') {
    const err = new Error('Transfer must be in PENDING_GRACE');
    err.code = 'TRANSFER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  if (transfer.grace_ends_at && transfer.grace_ends_at > now()) {
    const err = new Error('Grace period has not ended yet');
    err.code = 'GRACE_ACTIVE';
    err.httpStatus = 409;
    throw err;
  }
  if (!system) {
    const actor = await loadMembership(actorUserId, workspaceId);
    if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
      const err = new Error('Only Owner or system can complete ownership transfer');
      err.code = 'OWNER_ONLY';
      err.httpStatus = 403;
      throw err;
    }
    if (actorUserId !== transfer.from_user_id) {
      const err = new Error('Only the outgoing Owner can complete this transfer');
      err.code = 'OWNER_ONLY';
      err.httpStatus = 403;
      throw err;
    }
  }

  const ws = await getWorkspaceById(workspaceId);
  const fromId = transfer.from_user_id;
  const toId = transfer.target_user_id;
  const ts = now();

  if (ws?.is_base) {
    const rate = await getServiceRate('ADDITIONAL_WORKSPACE');
    const cost = rate ? Number(rate.credits) : 1000;
    await deductCredits({
      userId: fromId,
      amount: cost,
      kind: 'OWNERSHIP_TRANSFER_RESERVE',
      reference: transferId,
      workspaceId,
      meta: { rateKey: 'ADDITIONAL_WORKSPACE', transferId },
    });
  }

  const fromMem = await loadMembership(fromId, workspaceId);
  const toMem = await loadMembership(toId, workspaceId);
  if (!fromMem || !toMem || toMem.status !== 'ACTIVE') {
    const err = new Error('Memberships no longer valid for transfer');
    err.code = 'MEMBER_NOT_FOUND';
    err.httpStatus = 409;
    throw err;
  }

  // Outgoing Owner → member with selected role (or ADMIN builtin fallback)
  let outgoingRoleId = transfer.outgoing_role_id;
  if (!outgoingRoleId) {
    const { rows: adminRole } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'ADMIN' LIMIT 1`,
      [workspaceId]
    );
    outgoingRoleId = adminRole[0]?.id || null;
  }
  await query(
    `UPDATE workspace_memberships
     SET membership_type = 'MEMBER', role_id = $2, seat_id = NULL WHERE id = $1`,
    [fromMem.id, outgoingRoleId]
  );

  // Must flip owner_user_id BEFORE ensureOwnerSeat — that helper refuses anyone who is
  // not the current owner_user_id (guards invitee promotion). Doing seat first left
  // transfers with no OWNER membership after the 2026-09-17 seat guard.
  await query(
    `UPDATE workspaces SET owner_user_id = $2, updated_at = $3 WHERE id = $1`,
    [workspaceId, toId, ts]
  );
  await ensureOwnerSeat(workspaceId, toId, toMem.id);

  await query(
    `UPDATE workspace_ownership_transfers
     SET status = 'COMPLETED', completed_at = $2, updated_at = $2 WHERE id = $1`,
    [transferId, ts]
  );
  await audit(workspaceId, fromId, 'ownership.transfer_completed', {
    transferId,
    fromUserId: fromId,
    toUserId: toId,
    outgoingRoleId,
  });
  return {
    transferId,
    status: 'COMPLETED',
    fromUserId: fromId,
    toUserId: toId,
    outgoingRoleId,
  };
}

/** Alias */
export async function executeOwnershipTransfer(actorUserId, workspaceId, transferId, opts) {
  return completeOwnershipTransfer(actorUserId, workspaceId, transferId, opts);
}

/**
 * Reset (base only): create lifecycle request PENDING_CONFIRM; 3 phrase confirms → PENDING_GRACE 24h.
 */
export async function requestWorkspaceReset(actorUserId, workspaceId) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can request workspace reset');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) {
    const err = new Error('Workspace not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (!ws.is_base) {
    const err = new Error('Reset is only allowed on the base workspace');
    err.code = 'RESET_BASE_ONLY';
    err.httpStatus = 400;
    throw err;
  }
  const { rows: existing } = await query(
    `SELECT id FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'RESET'
       AND status IN ('PENDING_CONFIRM','PENDING_GRACE')
     LIMIT 1`,
    [workspaceId]
  );
  if (existing[0]) {
    const err = new Error('A reset request is already in progress');
    err.code = 'RESET_IN_PROGRESS';
    err.httpStatus = 409;
    throw err;
  }
  const ts = now();
  const requestId = uuid();
  const plainTokens = [makeConfirmToken(), makeConfirmToken(), makeConfirmToken()];
  const tokenRecords = plainTokens.map((t, i) => ({ step: i + 1, hash: hashToken(t), used: false }));
  await query(
    `UPDATE workspaces SET reset_requested_at = $2, updated_at = $2 WHERE id = $1`,
    [workspaceId, ts]
  );
  await query(
    `INSERT INTO workspace_lifecycle_requests
       (id, workspace_id, kind, actor_user_id, status, confirm_count, confirm_phrase,
        expires_at, meta_json, created_at, updated_at)
     VALUES ($1,$2,'RESET',$3,'PENDING_CONFIRM',0,$4,$5,$6,$7,$7)`,
    [
      requestId, workspaceId, actorUserId, RESET_PHRASE, ts + DAY_SEC,
      JSON.stringify({ confirmTokens: tokenRecords }), ts,
    ]
  );

  const { rows: ownerRows } = await query(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [actorUserId]);
  const ownerEmail = ownerRows[0]?.email || null;
  const apiBase = (process.env.PUBLIC_API_BASE || process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const confirmUrls = plainTokens.map(
    (t, i) => `${apiBase}/api/workspaces/${workspaceId}/reset/${requestId}/confirm?token=${t}&step=${i + 1}`
  );
  let emailsSent = 0;
  if (ownerEmail) {
    for (let i = 0; i < plainTokens.length; i++) {
      const result = await sendLifecycleConfirmEmail({
        toEmail: ownerEmail,
        workspaceName: ws?.name,
        confirmUrl: confirmUrls[i],
        step: i + 1,
        total: 3,
        kind: 'RESET',
      });
      if (result?.success) emailsSent += 1;
    }
  }

  await audit(workspaceId, actorUserId, 'workspace.reset_requested', {
    requestId,
    phrase: RESET_PHRASE,
    confirmsRequired: 3,
    emailsSent,
  });
  const payload = {
    status: 'PENDING_CONFIRM',
    requestId,
    confirmsRequired: 3,
    confirmPhrase: RESET_PHRASE,
    hours: 24,
    emailsSent,
  };
  if (process.env.NODE_ENV !== 'production' || !ownerEmail || emailsSent === 0) {
    payload.confirmTokens = plainTokens;
    payload.confirmUrls = confirmUrls;
  }
  return payload;
}

export async function confirmWorkspaceReset(actorUserId, workspaceId, phrase) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can confirm workspace reset');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'RESET' AND status = 'PENDING_CONFIRM'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('No pending reset confirmation');
    err.code = 'RESET_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.expires_at && req.expires_at < now()) {
    await query(
      `UPDATE workspace_lifecycle_requests SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
      [req.id, now()]
    );
    const err = new Error('Reset confirmation window expired');
    err.code = 'RESET_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  const expected = String(req.confirm_phrase || RESET_PHRASE).trim().toUpperCase();
  if (String(phrase || '').trim().toUpperCase() !== expected) {
    const err = new Error(`Confirmation phrase must be exactly: ${req.confirm_phrase || RESET_PHRASE}`);
    err.code = 'PHRASE_MISMATCH';
    err.httpStatus = 400;
    throw err;
  }
  const confirmCount = (Number(req.confirm_count) || 0) + 1;
  const ts = now();
  if (confirmCount >= 3) {
    const graceEndsAt = ts + DAY_SEC;
    await query(
      `UPDATE workspace_lifecycle_requests
       SET confirm_count = $2, status = 'PENDING_GRACE', grace_ends_at = $3, updated_at = $4
       WHERE id = $1`,
      [req.id, confirmCount, graceEndsAt, ts]
    );
    await audit(workspaceId, actorUserId, 'workspace.reset_grace_started', {
      requestId: req.id,
      graceEndsAt,
    });
    return {
      requestId: req.id,
      status: 'PENDING_GRACE',
      confirmCount,
      graceEndsAt,
      hours: 24,
    };
  }
  await query(
    `UPDATE workspace_lifecycle_requests SET confirm_count = $2, updated_at = $3 WHERE id = $1`,
    [req.id, confirmCount, ts]
  );
  await audit(workspaceId, actorUserId, 'workspace.reset_confirm', {
    requestId: req.id,
    confirmCount,
  });
  return {
    requestId: req.id,
    status: 'PENDING_CONFIRM',
    confirmCount,
    remaining: 3 - confirmCount,
  };
}

/**
 * Confirm reset via email token (preferred) — same 3-step → PENDING_GRACE.
 */
export async function confirmWorkspaceResetByToken(requestId, token) {
  if (!token) {
    const err = new Error('token required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests WHERE id = $1 AND kind = 'RESET' LIMIT 1`,
    [requestId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('Reset request not found');
    err.code = 'RESET_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.status !== 'PENDING_CONFIRM') {
    const err = new Error(`Reset is ${req.status}`);
    err.code = 'RESET_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  if (req.expires_at && req.expires_at < now()) {
    await query(
      `UPDATE workspace_lifecycle_requests SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
      [req.id, now()]
    );
    const err = new Error('Reset confirmation window expired');
    err.code = 'RESET_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  let meta = req.meta_json;
  if (typeof meta === 'string') meta = JSON.parse(meta);
  let tokens = meta?.confirmTokens || [];
  const hashed = hashToken(token);
  const idx = tokens.findIndex((t) => t.hash === hashed && !t.used);
  if (idx < 0) {
    const err = new Error('Invalid or already used confirmation token');
    err.code = 'TOKEN_INVALID';
    err.httpStatus = 400;
    throw err;
  }
  tokens[idx].used = true;
  tokens[idx].usedAt = now();
  const confirmCount = tokens.filter((t) => t.used).length;
  const ts = now();
  meta = { ...(meta || {}), confirmTokens: tokens };
  if (confirmCount >= 3) {
    const graceEndsAt = ts + DAY_SEC;
    await query(
      `UPDATE workspace_lifecycle_requests
       SET confirm_count = $2, status = 'PENDING_GRACE', grace_ends_at = $3,
           meta_json = $4, updated_at = $5
       WHERE id = $1`,
      [req.id, confirmCount, graceEndsAt, JSON.stringify(meta), ts]
    );
    await audit(req.workspace_id, req.actor_user_id, 'workspace.reset_grace_started', {
      requestId: req.id, graceEndsAt, via: 'email_token',
    });
    return { requestId: req.id, status: 'PENDING_GRACE', confirmCount, graceEndsAt, hours: 24 };
  }
  await query(
    `UPDATE workspace_lifecycle_requests
     SET confirm_count = $2, meta_json = $3, updated_at = $4 WHERE id = $1`,
    [req.id, confirmCount, JSON.stringify(meta), ts]
  );
  return {
    requestId: req.id,
    status: 'PENDING_CONFIRM',
    confirmCount,
    remaining: 3 - confirmCount,
  };
}

/**
 * Execute reset after grace: unpair devices, clear company bindings to Demo,
 * remove non-owner members, clear scopes, set UNPAIRED; keep wallet/owner/workspace.
 */
export async function executeWorkspaceReset(actorUserId, workspaceId, { system = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'RESET' AND status = 'PENDING_GRACE'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('No reset in grace period');
    err.code = 'RESET_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.grace_ends_at && req.grace_ends_at > now()) {
    const err = new Error('Grace period has not ended yet');
    err.code = 'GRACE_ACTIVE';
    err.httpStatus = 409;
    throw err;
  }
  if (!system) {
    const actor = await loadMembership(actorUserId, workspaceId);
    if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
      const err = new Error('Only Owner can execute workspace reset');
      err.code = 'OWNER_ONLY';
      err.httpStatus = 403;
      throw err;
    }
  }

  const ws = await getWorkspaceById(workspaceId);
  const ownerId = ws?.owner_user_id || req.actor_user_id;
  const ts = now();

  // Unpair all devices on this workspace
  const { rows: devices } = await query(
    `SELECT device_id FROM devices WHERE workspace_id = $1`,
    [workspaceId]
  );
  const sock = getWorkspaceSocket();
  for (const d of devices) {
    const unpaired = await unpairDevice(d.device_id, ownerId).catch(() => null);
    sock?.notifyDesktop?.(d.device_id, 'unpaired', {
      newCode: unpaired?.newCode || null,
      reason: 'WORKSPACE_RESET',
    });
    sock?.notifyDesktop?.(d.device_id, 'binding_revoked', { reason: 'WORKSPACE_RESET' });
  }
  sock?.notifyWorkspaceRoom?.(workspaceId, 'workspace_reset', { status: 'COMPLETED', requestId: req.id });

  const deletedBackups = await purgeWorkspaceCloudBackups(workspaceId).catch((e) => {
    console.warn('[reset] purgeWorkspaceCloudBackups:', e.message);
    return 0;
  });
  await query(
    `DELETE FROM workspace_tally_lineage_companies WHERE workspace_id = $1`,
    [workspaceId]
  ).catch(() => {});
  await query(
    `UPDATE restore_sessions SET status = 'FAILED'
     WHERE workspace_id = $1 AND status IN ('PENDING','APPROVED','DOWNLOADING')`,
    [workspaceId]
  ).catch(() => {});

  // Detach non-demo companies: purge tally data + clear workspace binding
  const { rows: companies } = await query(
    `SELECT id, guid, name FROM companies WHERE workspace_id = $1`,
    [workspaceId]
  );
  for (const c of companies) {
    const isDemo = /demo/i.test(c.name || '') || String(c.guid || '').startsWith('DEMO');
    if (!isDemo) {
      await purgeCompanyTallyData(c.guid, { workspaceId, companyId: c.id }).catch((e) => {
        console.warn('[reset] purgeCompanyTallyData:', e.message);
      });
      // CID-Q007: disconnect/reset must NOT null workspace ownership
      await query(
        `UPDATE companies SET is_active = FALSE, device_id = NULL WHERE id = $1 AND workspace_id = $2`,
        [c.id, workspaceId]
      ).catch(() => {});
    }
  }

  // Remove non-owner members + free seats
  const { rows: members } = await query(
    `SELECT id, user_id, seat_id, membership_type FROM workspace_memberships
     WHERE workspace_id = $1 AND status IN ('ACTIVE','SUSPENDED')`,
    [workspaceId]
  );
  for (const m of members) {
    if (m.membership_type === 'OWNER') continue;
    await query(
      `UPDATE workspace_memberships SET status = 'REMOVED', removed_at = $2 WHERE id = $1`,
      [m.id, ts]
    );
    if (m.seat_id) {
      await query(
        `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL WHERE id = $1`,
        [m.seat_id]
      );
    }
    await query(`DELETE FROM membership_scope_policy WHERE membership_id = $1`, [m.id]).catch(() => {});
    await query(`DELETE FROM member_company_access WHERE membership_id = $1`, [m.id]).catch(() => {});
    await query(`DELETE FROM member_fy_access WHERE membership_id = $1`, [m.id]).catch(() => {});
    await query(`DELETE FROM member_ledger_access WHERE membership_id = $1`, [m.id]).catch(() => {});
    await query(`DELETE FROM member_godown_access WHERE membership_id = $1`, [m.id]).catch(() => {});
    await query(`DELETE FROM member_cost_centre_access WHERE membership_id = $1`, [m.id]).catch(() => {});
  }

  // Cancel pending invites + release reserved seats
  await query(
    `UPDATE workspace_invitations SET status = 'REVOKED', revoked_at = $2
     WHERE workspace_id = $1 AND status = 'PENDING'`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspace_seats SET status = 'AVAILABLE', assigned_user_id = NULL
     WHERE workspace_id = $1 AND status = 'RESERVED'`,
    [workspaceId]
  );

  await query(
    `UPDATE workspace_tally_bindings
     SET active_device_id = NULL, connection_status = 'UNPAIRED', updated_at = $2
     WHERE workspace_id = $1`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspaces
     SET tally_connection = 'UNPAIRED', setup_generation = setup_generation + 1,
         reset_requested_at = NULL, updated_at = $2
     WHERE id = $1`,
    [workspaceId, ts]
  );

  // Re-ensure Demo company for Owner
  if (ownerId) {
    await ensureDemoCompany(ownerId, workspaceId, { force: true }).catch((e) => {
      console.warn('[reset] ensureDemoCompany:', e.message);
    });
  }

  await query(
    `UPDATE workspace_lifecycle_requests
     SET status = 'COMPLETED', completed_at = $2, updated_at = $2 WHERE id = $1`,
    [req.id, ts]
  );
  await audit(workspaceId, ownerId, 'workspace.reset_executed', {
    requestId: req.id,
    stub: false,
    devicesUnpaired: devices.length,
    companiesDetached: companies.length,
    backupsDeleted: deletedBackups,
  });
  return { status: 'COMPLETED', requestId: req.id, stub: false };
}

/**
 * Close (non-base): PENDING_GRACE 24h then execute purges memberships / marks CLOSED.
 */
export async function requestWorkspaceClose(actorUserId, workspaceId) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can request workspace close');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const ws = await getWorkspaceById(workspaceId);
  if (!ws) {
    const err = new Error('Workspace not found');
    err.code = 'NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (ws.is_base) {
    const err = new Error('Cannot close the base workspace — use reset instead');
    err.code = 'CLOSE_NON_BASE_ONLY';
    err.httpStatus = 400;
    throw err;
  }
  const { rows: existing } = await query(
    `SELECT id FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'CLOSE'
       AND status IN ('PENDING_CONFIRM','PENDING_GRACE')
     LIMIT 1`,
    [workspaceId]
  );
  if (existing[0]) {
    const err = new Error('A close request is already in progress');
    err.code = 'CLOSE_IN_PROGRESS';
    err.httpStatus = 409;
    throw err;
  }
  const ts = now();
  const requestId = uuid();
  const plainTokens = [makeConfirmToken(), makeConfirmToken(), makeConfirmToken()];
  const tokenRecords = plainTokens.map((t, i) => ({ step: i + 1, hash: hashToken(t), used: false }));
  await query(
    `UPDATE workspaces SET close_requested_at = $2, updated_at = $2 WHERE id = $1`,
    [workspaceId, ts]
  );
  await query(
    `INSERT INTO workspace_lifecycle_requests
       (id, workspace_id, kind, actor_user_id, status, confirm_count, confirm_phrase,
        expires_at, meta_json, created_at, updated_at)
     VALUES ($1,$2,'CLOSE',$3,'PENDING_CONFIRM',0,$4,$5,$6,$7,$7)`,
    [
      requestId, workspaceId, actorUserId, CLOSE_PHRASE, ts + DAY_SEC,
      JSON.stringify({ confirmTokens: tokenRecords }), ts,
    ]
  );

  const { rows: ownerRows } = await query(`SELECT email FROM users WHERE id = $1 LIMIT 1`, [actorUserId]);
  const ownerEmail = ownerRows[0]?.email || null;
  const apiBase = (process.env.PUBLIC_API_BASE || process.env.APP_URL || 'http://localhost:3001').replace(/\/$/, '');
  const confirmUrls = plainTokens.map(
    (t, i) => `${apiBase}/api/workspaces/${workspaceId}/close/${requestId}/confirm?token=${t}&step=${i + 1}`
  );
  let emailsSent = 0;
  if (ownerEmail) {
    for (let i = 0; i < plainTokens.length; i++) {
      const result = await sendLifecycleConfirmEmail({
        toEmail: ownerEmail,
        workspaceName: ws?.name,
        confirmUrl: confirmUrls[i],
        step: i + 1,
        total: 3,
        kind: 'CLOSE',
      });
      if (result?.success) emailsSent += 1;
    }
  }

  await audit(workspaceId, actorUserId, 'workspace.close_requested', {
    requestId, hours: 24, emailsSent,
  });
  const payload = {
    status: 'PENDING_CONFIRM',
    requestId,
    confirmsRequired: 3,
    hours: 24,
    emailsSent,
  };
  if (process.env.NODE_ENV !== 'production' || !ownerEmail || emailsSent === 0) {
    payload.confirmTokens = plainTokens;
    payload.confirmUrls = confirmUrls;
  }
  return payload;
}

export async function confirmWorkspaceClose(actorUserId, workspaceId, phrase) {
  const actor = await loadMembership(actorUserId, workspaceId);
  if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
    const err = new Error('Only Owner can confirm workspace close');
    err.code = 'OWNER_ONLY';
    err.httpStatus = 403;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'CLOSE' AND status = 'PENDING_CONFIRM'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('No pending close confirmation');
    err.code = 'CLOSE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.expires_at && req.expires_at < now()) {
    await query(
      `UPDATE workspace_lifecycle_requests SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
      [req.id, now()]
    );
    const err = new Error('Close confirmation window expired');
    err.code = 'CLOSE_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  const expected = String(req.confirm_phrase || CLOSE_PHRASE).trim().toUpperCase();
  if (String(phrase || '').trim().toUpperCase() !== expected) {
    const err = new Error(`Confirmation phrase must be exactly: ${req.confirm_phrase || CLOSE_PHRASE}`);
    err.code = 'PHRASE_MISMATCH';
    err.httpStatus = 400;
    throw err;
  }
  const confirmCount = (Number(req.confirm_count) || 0) + 1;
  const ts = now();
  if (confirmCount >= 3) {
    const graceEndsAt = ts + DAY_SEC;
    await query(
      `UPDATE workspace_lifecycle_requests
       SET confirm_count = $2, status = 'PENDING_GRACE', grace_ends_at = $3, updated_at = $4
       WHERE id = $1`,
      [req.id, confirmCount, graceEndsAt, ts]
    );
    await audit(workspaceId, actorUserId, 'workspace.close_grace_started', {
      requestId: req.id,
      graceEndsAt,
    });
    return {
      requestId: req.id,
      status: 'PENDING_GRACE',
      confirmCount,
      graceEndsAt,
      hours: 24,
    };
  }
  await query(
    `UPDATE workspace_lifecycle_requests SET confirm_count = $2, updated_at = $3 WHERE id = $1`,
    [req.id, confirmCount, ts]
  );
  await audit(workspaceId, actorUserId, 'workspace.close_confirm', {
    requestId: req.id,
    confirmCount,
  });
  return {
    requestId: req.id,
    status: 'PENDING_CONFIRM',
    confirmCount,
    remaining: 3 - confirmCount,
  };
}

export async function getActiveOwnershipTransfer(workspaceId) {
  const { rows } = await query(
    `SELECT id, workspace_id, from_user_id, target_user_id, outgoing_role_id, status,
            confirm_count, grace_ends_at, created_at, updated_at
     FROM workspace_ownership_transfers
     WHERE workspace_id = $1
       AND status IN ('PENDING_EMAIL','PENDING_CONFIRM','PENDING_GRACE','PENDING_ACCEPT')
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const row = rows[0];
  if (!row) return null;
  return { ...row, transferId: row.id };
}

export async function getWorkspaceLifecycleStatus(workspaceId) {
  const transfer = await getActiveOwnershipTransfer(workspaceId);
  const { rows } = await query(
    `SELECT id, kind, status, confirm_count, grace_ends_at, expires_at, created_at
     FROM workspace_lifecycle_requests
     WHERE workspace_id = $1
       AND status IN ('PENDING_CONFIRM','PENDING_GRACE')
     ORDER BY created_at DESC LIMIT 5`,
    [workspaceId]
  );
  return {
    transfer,
    requests: rows,
    status: rows[0]?.status || transfer?.status || null,
    kind: rows[0]?.kind || (transfer ? 'TRANSFER' : null),
    confirm_count: rows[0]?.confirm_count ?? transfer?.confirm_count,
    grace_ends_at: rows[0]?.grace_ends_at || transfer?.grace_ends_at,
  };
}

export async function confirmWorkspaceCloseByToken(requestId, token) {
  if (!token) {
    const err = new Error('token required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests WHERE id = $1 AND kind = 'CLOSE' LIMIT 1`,
    [requestId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('Close request not found');
    err.code = 'CLOSE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.status !== 'PENDING_CONFIRM') {
    const err = new Error(`Close is ${req.status}`);
    err.code = 'CLOSE_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  if (req.expires_at && req.expires_at < now()) {
    await query(
      `UPDATE workspace_lifecycle_requests SET status = 'EXPIRED', updated_at = $2 WHERE id = $1`,
      [req.id, now()]
    );
    const err = new Error('Close confirmation window expired');
    err.code = 'CLOSE_EXPIRED';
    err.httpStatus = 410;
    throw err;
  }
  let meta = req.meta_json;
  if (typeof meta === 'string') meta = JSON.parse(meta);
  let tokens = meta?.confirmTokens || [];
  const hashed = hashToken(token);
  const idx = tokens.findIndex((t) => t.hash === hashed && !t.used);
  if (idx < 0) {
    const err = new Error('Invalid or already used confirmation token');
    err.code = 'TOKEN_INVALID';
    err.httpStatus = 400;
    throw err;
  }
  tokens[idx].used = true;
  tokens[idx].usedAt = now();
  const confirmCount = tokens.filter((t) => t.used).length;
  const ts = now();
  meta = { ...(meta || {}), confirmTokens: tokens };
  if (confirmCount >= 3) {
    const graceEndsAt = ts + DAY_SEC;
    await query(
      `UPDATE workspace_lifecycle_requests
       SET confirm_count = $2, status = 'PENDING_GRACE', grace_ends_at = $3,
           meta_json = $4, updated_at = $5
       WHERE id = $1`,
      [req.id, confirmCount, graceEndsAt, JSON.stringify(meta), ts]
    );
    await audit(req.workspace_id, req.actor_user_id, 'workspace.close_grace_started', {
      requestId: req.id, graceEndsAt,
    });
    return { requestId: req.id, status: 'PENDING_GRACE', confirmCount, graceEndsAt, hours: 24 };
  }
  await query(
    `UPDATE workspace_lifecycle_requests
     SET confirm_count = $2, meta_json = $3, updated_at = $4 WHERE id = $1`,
    [req.id, confirmCount, JSON.stringify(meta), ts]
  );
  return {
    requestId: req.id,
    status: 'PENDING_CONFIRM',
    confirmCount,
    remaining: 3 - confirmCount,
  };
}

export async function executeWorkspaceClose(actorUserId, workspaceId, { system = false } = {}) {
  const { rows } = await query(
    `SELECT * FROM workspace_lifecycle_requests
     WHERE workspace_id = $1 AND kind = 'CLOSE' AND status = 'PENDING_GRACE'
     ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const req = rows[0];
  if (!req) {
    const err = new Error('No close in grace period');
    err.code = 'CLOSE_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (req.grace_ends_at && req.grace_ends_at > now()) {
    const err = new Error('Grace period has not ended yet');
    err.code = 'GRACE_ACTIVE';
    err.httpStatus = 409;
    throw err;
  }
  if (!system) {
    const actor = await loadMembership(actorUserId, workspaceId);
    if (!actor || actor.status !== 'ACTIVE' || actor.membership_type !== 'OWNER') {
      const err = new Error('Only Owner can execute workspace close');
      err.code = 'OWNER_ONLY';
      err.httpStatus = 403;
      throw err;
    }
  }

  const ws = await getWorkspaceById(workspaceId);
  if (ws?.is_base) {
    const err = new Error('Cannot close the base workspace');
    err.code = 'CLOSE_NON_BASE_ONLY';
    err.httpStatus = 400;
    throw err;
  }
  const ts = now();
  const ownerId = ws?.owner_user_id || req.actor_user_id;

  const { rows: devices } = await query(
    `SELECT device_id FROM devices WHERE workspace_id = $1`,
    [workspaceId]
  );
  const sock = getWorkspaceSocket();
  for (const d of devices) {
    const unpaired = await unpairDevice(d.device_id, ownerId).catch(() => null);
    sock?.notifyDesktop?.(d.device_id, 'unpaired', {
      newCode: unpaired?.newCode || null,
      reason: 'WORKSPACE_CLOSED',
    });
    sock?.notifyDesktop?.(d.device_id, 'binding_revoked', { reason: 'WORKSPACE_CLOSED' });
  }
  sock?.notifyWorkspaceRoom?.(workspaceId, 'workspace_closed', { status: 'COMPLETED' });

  await purgeWorkspaceCloudBackups(workspaceId).catch((e) => {
    console.warn('[close] purgeWorkspaceCloudBackups:', e.message);
  });
  await query(
    `DELETE FROM workspace_tally_lineage_companies WHERE workspace_id = $1`,
    [workspaceId]
  ).catch(() => {});
  await query(
    `UPDATE restore_sessions SET status = 'FAILED'
     WHERE workspace_id = $1 AND status IN ('PENDING','APPROVED','DOWNLOADING')`,
    [workspaceId]
  ).catch(() => {});

  const { rows: companies } = await query(
    `SELECT id, guid FROM companies WHERE workspace_id = $1`,
    [workspaceId]
  );
  for (const c of companies) {
    await purgeCompanyTallyData(c.guid, { workspaceId, companyId: c.id }).catch(() => {});
    // CID-Q007: close archives in-place — never steal/null ownership
    await query(
      `UPDATE companies SET is_active = FALSE, device_id = NULL WHERE id = $1 AND workspace_id = $2`,
      [c.id, workspaceId]
    ).catch(() => {});
  }

  await query(
    `UPDATE workspace_memberships SET status = 'REMOVED', removed_at = $2
     WHERE workspace_id = $1 AND status IN ('ACTIVE','SUSPENDED')`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspace_invitations SET status = 'REVOKED', revoked_at = $2
     WHERE workspace_id = $1 AND status = 'PENDING'`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspaces
     SET lifecycle_status = 'CLOSED', commercial_status = 'CLOSED',
         tally_connection = 'UNPAIRED', close_requested_at = NULL, updated_at = $2
     WHERE id = $1`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspace_tally_bindings
     SET active_device_id = NULL, connection_status = 'UNPAIRED', updated_at = $2
     WHERE workspace_id = $1`,
    [workspaceId, ts]
  );
  await query(
    `UPDATE workspace_lifecycle_requests
     SET status = 'COMPLETED', completed_at = $2, updated_at = $2 WHERE id = $1`,
    [req.id, ts]
  );
  await audit(workspaceId, ownerId, 'workspace.close_executed', {
    requestId: req.id,
    stub: false,
  });
  return { status: 'CLOSED', requestId: req.id, stub: false };
}

export async function getPaymentModeMap(workspaceId, companyGuid, userId) {
  const { resolveCompanyInWorkspace } = await import('./deviceCompanyResolution.js');
  const company = await resolveCompanyInWorkspace({ workspaceId, companyGuid });
  const { rows } = await query(
    `SELECT id, workspace_id, company_guid, company_id, payment_mode, ledger_guid, ledger_name
     FROM payment_mode_posting_map
     WHERE workspace_id = $1 AND company_id = $2
     ORDER BY payment_mode`,
    [workspaceId, company.id]
  );
  return rows;
}

/**
 * Replace payment-mode → ledger map for a company. Body: { mappings: [{ paymentMode, ledgerGuid, ledgerName }] }
 */
export async function putPaymentModeMap(workspaceId, companyGuid, userId, mappings) {
  const { resolveCompanyInWorkspace } = await import('./deviceCompanyResolution.js');
  const company = await resolveCompanyInWorkspace({ workspaceId, companyGuid });
  const list = Array.isArray(mappings) ? mappings : [];
  await query(
    `DELETE FROM payment_mode_posting_map WHERE workspace_id = $1 AND company_id = $2`,
    [workspaceId, company.id]
  );
  for (const m of list) {
    const paymentMode = String(m.paymentMode || m.payment_mode || '').trim();
    if (!paymentMode) continue;
    await query(
      `INSERT INTO payment_mode_posting_map
         (id, workspace_id, company_guid, company_id, payment_mode, ledger_guid, ledger_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (workspace_id, company_guid, payment_mode) DO UPDATE SET
         company_id = EXCLUDED.company_id,
         ledger_guid = EXCLUDED.ledger_guid,
         ledger_name = EXCLUDED.ledger_name`,
      [
        uuid(),
        workspaceId,
        company.guid,
        company.id,
        paymentMode,
        m.ledgerGuid || m.ledger_guid || null,
        m.ledgerName || m.ledger_name || null,
      ]
    );
  }
  await audit(workspaceId, userId, 'payment_mode_map.updated', {
    companyGuid,
    count: list.length,
  });
  return getPaymentModeMap(workspaceId, companyGuid, userId);
}

export async function listAudit(workspaceId, limit = 50) {
  const { rows } = await query(
    `SELECT a.*, u.name AS actor_name, u.mobile AS actor_mobile
     FROM workspace_audit_log a
     LEFT JOIN users u ON u.id = a.actor_user_id
     WHERE a.workspace_id = $1
     ORDER BY a.created_at DESC LIMIT $2`,
    [workspaceId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

/** Record that a user opened/switched into a workspace (Activity log). Rate-limited per hour. */
export async function recordWorkspaceEntered(userId, workspaceId) {
  if (!userId || !workspaceId) return false;
  const ts = now();
  const hourAgo = ts - 3600;
  const { rows: recent } = await query(
    `SELECT id FROM workspace_audit_log
     WHERE workspace_id = $1 AND actor_user_id = $2 AND event_type = 'workspace.entered'
       AND created_at >= $3
     LIMIT 1`,
    [workspaceId, userId, hourAgo]
  );
  if (recent[0]) return false;
  await audit(workspaceId, userId, 'workspace.entered', {});
  return true;
}

/**
 * Cron: complete ownership transfers + reset/close after grace period ends.
 */
export async function processWorkspaceGraceJobs() {
  const ts = now();
  const results = { transfers: [], resets: [], closes: [] };

  const { rows: transfers } = await query(
    `SELECT id, workspace_id, from_user_id FROM workspace_ownership_transfers
     WHERE status = 'PENDING_GRACE' AND grace_ends_at IS NOT NULL AND grace_ends_at <= $1
     ORDER BY grace_ends_at ASC LIMIT 50`,
    [ts]
  );
  for (const t of transfers) {
    try {
      const r = await completeOwnershipTransfer(t.from_user_id, t.workspace_id, t.id, { system: true });
      results.transfers.push({ id: t.id, ok: true, status: r.status });
    } catch (e) {
      results.transfers.push({ id: t.id, ok: false, error: e.message });
    }
  }

  const { rows: resets } = await query(
    `SELECT id, workspace_id, actor_user_id FROM workspace_lifecycle_requests
     WHERE kind = 'RESET' AND status = 'PENDING_GRACE'
       AND grace_ends_at IS NOT NULL AND grace_ends_at <= $1
     ORDER BY grace_ends_at ASC LIMIT 50`,
    [ts]
  );
  for (const r of resets) {
    try {
      const out = await executeWorkspaceReset(r.actor_user_id, r.workspace_id, { system: true });
      results.resets.push({ id: r.id, ok: true, status: out?.status || 'DONE' });
    } catch (e) {
      results.resets.push({ id: r.id, ok: false, error: e.message });
    }
  }

  const { rows: closes } = await query(
    `SELECT id, workspace_id, actor_user_id FROM workspace_lifecycle_requests
     WHERE kind = 'CLOSE' AND status = 'PENDING_GRACE'
       AND grace_ends_at IS NOT NULL AND grace_ends_at <= $1
     ORDER BY grace_ends_at ASC LIMIT 50`,
    [ts]
  );
  for (const c of closes) {
    try {
      const out = await executeWorkspaceClose(c.actor_user_id, c.workspace_id, { system: true });
      results.closes.push({ id: c.id, ok: true, status: out?.status || 'CLOSED' });
    } catch (e) {
      results.closes.push({ id: c.id, ok: false, error: e.message });
    }
  }

  return results;
}

export { getBillingOverview };
