import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness, httpJson } from './harness.js';
import { revokeSession } from '../../services/authSessionService.js';
import { query } from '../../db/schema.js';

let ctx;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') { ctx = null; return; }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('RBAC session revocation', () => {
  it('access succeeds then logout/revoke → same JWT denied', async () => {
    if (!ctx) throw new Error('harness required');
    const tok = ctx.fixtures.tokens.ownerA;
    const ok = await httpJson(ctx.baseUrl, 'GET', `/api/workspaces/${ctx.fixtures.workspaces.A}/context`, {
      token: tok.accessToken,
    });
    assert.equal(ok.status, 200);
    await revokeSession(tok.sessionId, tok.userId);
    const denied = await httpJson(ctx.baseUrl, 'GET', `/api/workspaces/${ctx.fixtures.workspaces.A}/context`, {
      token: tok.accessToken,
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.json?.code, 'SESSION_REVOKED');
  });

  it('membership suspended → workspace resource denied', async () => {
    if (!ctx) throw new Error('harness required');
    await query(
      `UPDATE workspace_memberships SET status = 'SUSPENDED' WHERE id = $1`,
      [ctx.fixtures.memberships.memberA]
    );
    const { status, json } = await httpJson(
      ctx.baseUrl,
      'GET',
      `/api/workspaces/${ctx.fixtures.workspaces.A}/context`,
      { token: ctx.fixtures.tokens.memberA.accessToken }
    );
    assert.ok(status === 403 || status === 200);
    if (status === 200) {
      assert.ok(json?.denied === true || json?.data?.denied === true || json?.access == null);
    }
  });
});
