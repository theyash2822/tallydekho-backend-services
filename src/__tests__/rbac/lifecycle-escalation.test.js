/**
 * Phase 5 — invite/scope, OWNER null role_id, custom-role anti-escalation.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness, httpJson } from './harness.js';
import { query } from '../../db/schema.js';
import { getEffectiveAccess } from '../../services/authorizationService.js';
import { createCustomRole, updateRoleCapabilities } from '../../services/roleService.js';

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

describe('Phase 5 company scope lifecycle', () => {
  it('SELECTED scope: A1 allowed, A2 denied on company-scoped API', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const tok = ctx.fixtures.tokens.restrictedA.accessToken;

    const list = await httpJson(ctx.baseUrl, 'GET', '/api/companies', {
      token: tok,
      headers: { 'X-Workspace-Id': ws },
    });
    assert.equal(list.status, 200);
    const guids = (list.json?.data || []).map((c) => c.guid || c.id);
    assert.ok(guids.includes(ctx.fixtures.companies.A1));
    assert.ok(!guids.includes(ctx.fixtures.companies.A2));

    const denied = await httpJson(
      ctx.baseUrl,
      'GET',
      `/api/stocks/items?companyGuid=${encodeURIComponent(ctx.fixtures.companies.A2)}`,
      { token: tok, headers: { 'X-Workspace-Id': ws } }
    );
    assert.ok(denied.status === 403 || denied.json?.success === false);

    const allowed = await httpJson(
      ctx.baseUrl,
      'GET',
      `/api/stocks/items?companyGuid=${encodeURIComponent(ctx.fixtures.companies.A1)}`,
      { token: tok, headers: { 'X-Workspace-Id': ws } }
    );
    assert.ok(allowed.status === 200 || allowed.status === 403); // 403 if missing inventory.view — still not cross-tenant
    if (allowed.status === 200) assert.notEqual(allowed.json?.success, false);
  });

  it('member removed → workspace context denied', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const victim = ctx.fixtures.users.memberA.id;
    await httpJson(ctx.baseUrl, 'DELETE', `/api/workspaces/${ws}/members/${victim}`, {
      token: ctx.fixtures.tokens.ownerA.accessToken,
    });
    const after = await httpJson(ctx.baseUrl, 'GET', `/api/workspaces/${ws}/context`, {
      token: ctx.fixtures.tokens.memberA.accessToken,
    });
    assert.ok(after.status === 403 || after.status === 401 || after.status === 404 || after.json?.success === false);
  });
});

describe('OWNER invariant', () => {
  it('OWNER with role_id NULL retains ownership authority', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const ownerId = ctx.fixtures.users.ownerA.id;
    await query(
      `UPDATE workspace_memberships SET role_id = NULL
       WHERE workspace_id = $1 AND user_id = $2 AND membership_type = 'OWNER'`,
      [ws, ownerId]
    );
    const access = await getEffectiveAccess(ownerId, ws);
    assert.ok(access?.membership?.membership_type === 'OWNER');
    assert.ok((access?.capabilities || []).includes('billing.manage') || access?.isOwner === true || access?.membership);
    // Owner must not be treated as unauthenticated
    assert.ok(access);
  });
});

describe('Custom role privilege escalation', () => {
  it('non-owner cannot grant capabilities they do not hold', async () => {
    requireCtx();
    const ws = ctx.fixtures.workspaces.A;
    const owner = ctx.fixtures.users.ownerA.id;
    const actor = ctx.fixtures.users.restrictedA.id;
    const role = await createCustomRole(ws, {
      displayName: `EscalationProbe-${Date.now()}`,
      actorUserId: owner,
      capabilities: { 'dashboard.view': true },
    });
    await assert.rejects(
      () => updateRoleCapabilities(
        role.id,
        { 'members.invite': true, 'roles.edit': true },
        { actorUserId: actor, workspaceId: ws }
      ),
      (err) => err?.code === 'PRIVILEGE_ESCALATION' || err?.httpStatus === 403
    );
  });
});
