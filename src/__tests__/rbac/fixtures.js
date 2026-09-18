/**
 * Automatic Workspace A/B security fixtures for Phase 4 integration tests.
 */
import { v4 as uuid } from 'uuid';
import { query } from '../../db/schema.js';
import { createAuthSession } from '../../services/authSessionService.js';
import { hashSecret } from '../../services/deviceCredential.js';
import { seedBuiltinRoles } from '../../services/roleService.js';
import { putMemberScopes } from '../../services/workspaceService.js';

const now = () => Math.floor(Date.now() / 1000);

async function insertUser(mobile, name) {
  const { rows } = await query(
    `INSERT INTO users (mobile, name, created_at, updated_at)
     VALUES ($1,$2,$3,$3) RETURNING id, mobile, name`,
    [mobile, name, now()]
  );
  return rows[0];
}

async function createWorkspace(ownerUserId, name, { isBase = true } = {}) {
  const workspaceId = uuid();
  const membershipId = uuid();
  const ts = now();
  await query(
    `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status,
       tally_connection, setup_generation, is_base, created_at, updated_at)
     VALUES ($1,$2,$3,'PERSONAL','ACTIVE','ACTIVE','CONNECTED',1,$4,$5,$5)`,
    [workspaceId, name, ownerUserId, isBase, ts]
  );
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,'OWNER',NULL,'ACTIVE',$4)`,
    [membershipId, workspaceId, ownerUserId, ts]
  );
  await query(
    `INSERT INTO workspace_tally_bindings (id, workspace_id, lineage_id, connection_status, updated_at)
     VALUES ($1,$2,$3,'CONNECTED',$4)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [uuid(), workspaceId, uuid(), ts]
  );
  await seedBuiltinRoles(workspaceId);
  return { workspaceId, ownerMembershipId: membershipId };
}

async function addMember(workspaceId, userId, { membershipType = 'MEMBER', systemKey = 'VIEWER' } = {}) {
  const { rows: roles } = await query(
    `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = $2 LIMIT 1`,
    [workspaceId, systemKey]
  );
  const roleId = roles[0]?.id || null;
  const membershipId = uuid();
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)`,
    [membershipId, workspaceId, userId, membershipType, roleId, now()]
  );
  return { membershipId, roleId };
}

async function insertCompany(guid, workspaceId, name) {
  await query(
    `INSERT INTO companies (guid, workspace_id, name, formal_name, is_active, synced_at, created_at)
     VALUES ($1,$2,$3,$3,TRUE,$4,$4)
     ON CONFLICT (workspace_id, guid) DO UPDATE SET is_active = TRUE`,
    [guid, workspaceId, name, now()]
  );
}

async function insertDevice(deviceId, workspaceId, secretPlain) {
  const hash = await hashSecret(secretPlain);
  await query(
    `INSERT INTO devices (device_id, name, paired, workspace_id, device_secret_hash, binding_status, last_seen, created_at)
     VALUES ($1,$2,TRUE,$3,$4,'ACTIVE',$5,$5)
     ON CONFLICT (device_id) DO UPDATE SET
       workspace_id = EXCLUDED.workspace_id,
       paired = TRUE,
       device_secret_hash = EXCLUDED.device_secret_hash,
       binding_status = 'ACTIVE'`,
    [deviceId, `Device ${deviceId}`, workspaceId, hash, now()]
  );
  await query(
    `UPDATE workspace_tally_bindings SET active_device_id = $2, connection_status = 'CONNECTED', updated_at = $3
     WHERE workspace_id = $1`,
    [workspaceId, deviceId, now()]
  ).catch(() => {});
  return { deviceId, secret: secretPlain };
}

async function sessionFor(user) {
  const s = await createAuthSession(user.id, { clientType: 'rbac-test' });
  return { accessToken: s.accessToken, refreshToken: s.refreshToken, sessionId: s.sessionId, userId: user.id };
}

export async function seedAbFixtures() {
  const suffix = cryptoRandom();
  const ownerA = await insertUser(`9000000001${suffix}`, 'Owner A');
  const adminA = await insertUser(`9000000002${suffix}`, 'Admin A');
  const memberA = await insertUser(`9000000003${suffix}`, 'Member A');
  const restrictedA = await insertUser(`9000000004${suffix}`, 'Restricted A');
  const ownerB = await insertUser(`9000000005${suffix}`, 'Owner B');
  const memberB = await insertUser(`9000000006${suffix}`, 'Member B');

  const wsA = await createWorkspace(ownerA.id, 'Workspace A');
  const wsB = await createWorkspace(ownerB.id, 'Workspace B');

  const adminMem = await addMember(wsA.workspaceId, adminA.id, { membershipType: 'MEMBER', systemKey: 'ADMIN' });
  const memberMem = await addMember(wsA.workspaceId, memberA.id, { membershipType: 'MEMBER', systemKey: 'VIEWER' });
  const restrictedMem = await addMember(wsA.workspaceId, restrictedA.id, { membershipType: 'MEMBER', systemKey: 'VIEWER' });
  await addMember(wsB.workspaceId, memberB.id, { membershipType: 'MEMBER', systemKey: 'VIEWER' });

  const companyA1 = `company-a1-${suffix}`;
  const companyA2 = `company-a2-${suffix}`;
  const companyB1 = `company-b1-${suffix}`;
  await insertCompany(companyA1, wsA.workspaceId, 'Company A1');
  await insertCompany(companyA2, wsA.workspaceId, 'Company A2');
  await insertCompany(companyB1, wsB.workspaceId, 'Company B1');

  await putMemberScopes(restrictedMem.membershipId, {
    policy: { company_mode: 'SELECTED', fy_mode: 'NONE', ledger_mode: 'NONE', godown_mode: 'NONE', cost_centre_mode: 'NONE' },
    companies: [companyA1],
  }, wsA.workspaceId);

  // Member A: ALL companies but viewer caps only (no tally.pair)
  await putMemberScopes(memberMem.membershipId, {
    policy: { company_mode: 'ALL', fy_mode: 'NONE', ledger_mode: 'NONE', godown_mode: 'NONE', cost_centre_mode: 'NONE' },
    companies: [],
  }, wsA.workspaceId);

  const deviceA = await insertDevice(`device-a-${suffix}`, wsA.workspaceId, `secret-a-${suffix}`);
  const deviceB = await insertDevice(`device-b-${suffix}`, wsB.workspaceId, `secret-b-${suffix}`);

  // Default sync authority for company A1 → device A (CID-Q003)
  await query(
    `UPDATE companies SET device_id = $1 WHERE guid = $2 AND workspace_id = $3`,
    [deviceA.deviceId, companyA1, wsA.workspaceId]
  );

  return {
    suffix,
    workspaces: { A: wsA.workspaceId, B: wsB.workspaceId },
    companies: { A1: companyA1, A2: companyA2, B1: companyB1 },
    devices: { A: deviceA, B: deviceB },
    memberships: {
      adminA: adminMem.membershipId,
      memberA: memberMem.membershipId,
      restrictedA: restrictedMem.membershipId,
    },
    tokens: {
      ownerA: await sessionFor(ownerA),
      adminA: await sessionFor(adminA),
      memberA: await sessionFor(memberA),
      restrictedA: await sessionFor(restrictedA),
      ownerB: await sessionFor(ownerB),
      memberB: await sessionFor(memberB),
    },
    users: { ownerA, adminA, memberA, restrictedA, ownerB, memberB },
  };
}

function cryptoRandom() {
  return Math.floor(Math.random() * 1e6).toString().padStart(6, '0');
}
