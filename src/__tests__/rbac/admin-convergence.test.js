/**
 * Phase 6 — ADMIN membership → MEMBER + ADMIN role convergence tests.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness } from './harness.js';
import { query } from '../../db/schema.js';
import { authorize, getEffectiveAccess, isAdminRole } from '../../services/authorizationService.js';
import { getCapability } from '../../services/capabilityRegistry.js';

let ctx;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') {
      ctx = null;
      return;
    }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

function requireCtx() {
  if (!ctx) throw new Error('RBAC harness not initialized');
}

describe('Phase 6 admin role convergence', () => {
  it('OWNER_OR_ADMIN_ROLE policy replaces OWNER_ADMIN', () => {
    assert.equal(getCapability('tally.pair')?.protected_authority, 'OWNER_OR_ADMIN_ROLE');
  });

  it('isAdminRole true only for ADMIN system_key', () => {
    assert.equal(isAdminRole({ system_key: 'ADMIN' }), true);
    assert.equal(isAdminRole({ system_key: 'VIEWER' }), false);
    assert.equal(isAdminRole(null), false);
  });

  it('OWNER retains owner-only authority', async () => {
    requireCtx();
    const r = await authorize({
      userId: ctx.fixtures.users.ownerA.id,
      workspaceId: ctx.fixtures.workspaces.A,
      capability: 'billing.manage',
    });
    assert.equal(r.decision, 'ALLOW');
  });

  it('MEMBER + ADMIN role has tally.pair; MEMBER + VIEWER does not', async () => {
    requireCtx();
    const admin = await authorize({
      userId: ctx.fixtures.users.adminA.id,
      workspaceId: ctx.fixtures.workspaces.A,
      capability: 'tally.pair',
    });
    assert.equal(admin.decision, 'ALLOW');
    const member = await authorize({
      userId: ctx.fixtures.users.memberA.id,
      workspaceId: ctx.fixtures.workspaces.A,
      capability: 'tally.pair',
    });
    assert.equal(member.decision, 'DENY');
  });

  it('MEMBER without role fails closed', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const uid = ctx.fixtures.users.restrictedA.id;
    const { rows: before } = await query(
      `SELECT role_id FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2`,
      [ws, uid]
    );
    await query(
      `UPDATE workspace_memberships SET role_id = NULL WHERE workspace_id = $1 AND user_id = $2`,
      [ws, uid]
    );
    try {
      const r = await authorize({
        userId: uid,
        workspaceId: ws,
        capability: 'dashboard.view',
      });
      assert.equal(r.decision, 'DENY');
      assert.equal(r.reason, 'NO_ROLE');
    } finally {
      await query(
        `UPDATE workspace_memberships SET role_id = $3 WHERE workspace_id = $1 AND user_id = $2`,
        [ws, uid, before[0]?.role_id]
      );
    }
  });

  it('fixtures never use membership_type ADMIN', async () => {
    requireCtx();
    const { rows } = await query(
      `SELECT membership_type FROM workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2`,
      [ctx.fixtures.workspaces.A, ctx.fixtures.users.adminA.id]
    );
    assert.equal(rows[0]?.membership_type, 'MEMBER');
    const access = await getEffectiveAccess(ctx.fixtures.users.adminA.id, ctx.fixtures.workspaces.A);
    assert.equal(access.role?.systemKey, 'ADMIN');
  });

  it('assigning ADMIN role keeps membership_type MEMBER', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const { rows: roles } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'ADMIN' LIMIT 1`,
      [ws]
    );
    const { changeMemberRole } = await import('../../services/workspaceService.js');
    const result = await changeMemberRole(
      ctx.fixtures.users.ownerA.id,
      ws,
      ctx.fixtures.users.memberA.id,
      roles[0].id
    );
    assert.equal(result.membershipType, 'MEMBER');
    assert.equal(result.roleSystemKey, 'ADMIN');
    const { rows: mem } = await query(
      `SELECT membership_type, role_id FROM workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2`,
      [ws, ctx.fixtures.users.memberA.id]
    );
    assert.equal(mem[0].membership_type, 'MEMBER');
    assert.equal(mem[0].role_id, roles[0].id);
    const { rows: adminType } = await query(
      `SELECT COUNT(*)::int AS n FROM workspace_memberships WHERE membership_type = 'ADMIN'`
    );
    assert.equal(adminType[0].n, 0);
  });
});
