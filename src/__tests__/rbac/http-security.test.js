/**
 * Mandatory A/B HTTP security matrix — fails closed if DB unavailable in CI.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness, httpJson } from './harness.js';

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
  if (!ctx) {
    throw new Error('RBAC harness not initialized (RBAC_UNIT_ONLY only allowed locally)');
  }
}

describe('RBAC HTTP A/B matrix', () => {
  it('no token → 401', async () => {
    requireCtx();
    const { status } = await httpJson(ctx.baseUrl, 'GET', `/api/workspaces/${ctx.fixtures.workspaces.A}/context`);
    assert.equal(status, 401);
  });

  it('User A + Workspace B context → denied', async () => {
    requireCtx();
    const { status, json } = await httpJson(
      ctx.baseUrl,
      'GET',
      `/api/workspaces/${ctx.fixtures.workspaces.B}/context`,
      { token: ctx.fixtures.tokens.ownerA.accessToken }
    );
    assert.ok(status === 403 || status === 404 || json?.denied === true || json?.success === false);
  });

  it('Owner A lists companies — only Workspace A companies', async () => {
    requireCtx();
    const { status, json } = await httpJson(ctx.baseUrl, 'GET', '/api/companies', {
      token: ctx.fixtures.tokens.ownerA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
    });
    assert.equal(status, 200);
    const list = json?.data?.companies || json?.companies || json?.data || [];
    const guids = (Array.isArray(list) ? list : []).map((c) => c.guid || c.id);
    assert.ok(guids.includes(ctx.fixtures.companies.A1), `A1 missing in ${JSON.stringify(guids)}`);
    assert.ok(!guids.includes(ctx.fixtures.companies.B1));
  });

  it('Owner A + Company B1 via companies list scope → not present (IDOR)', async () => {
    requireCtx();
    const { json } = await httpJson(ctx.baseUrl, 'GET', '/api/companies', {
      token: ctx.fixtures.tokens.ownerA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
    });
    const list = json?.data?.companies || json?.companies || json?.data || [];
    assert.ok(!(Array.isArray(list) ? list : []).some((c) => (c.guid || c.id) === ctx.fixtures.companies.B1));
  });

  it('Restricted A + Company A2 → denied by scope on companies list', async () => {
    requireCtx();
    const { status, json } = await httpJson(ctx.baseUrl, 'GET', '/api/companies', {
      token: ctx.fixtures.tokens.restrictedA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
    });
    assert.equal(status, 200);
    const list = json?.data?.companies || json?.companies || json?.data || [];
    const guids = (Array.isArray(list) ? list : []).map((c) => c.guid || c.id);
    assert.ok(guids.includes(ctx.fixtures.companies.A1), `A1 missing for restricted: ${JSON.stringify(guids)}`);
    assert.ok(!guids.includes(ctx.fixtures.companies.A2));
  });

  it('Member A lacks tally.pair → 403 on pair', async () => {
    requireCtx();
    const { status } = await httpJson(
      ctx.baseUrl,
      'POST',
      `/api/workspaces/${ctx.fixtures.workspaces.A}/tally/pair`,
      {
        token: ctx.fixtures.tokens.memberA.accessToken,
        body: { pairingCode: 'XXXXXX' },
      }
    );
    assert.equal(status, 403);
  });

  it('Owner A context positive control', async () => {
    requireCtx();
    const { status, json } = await httpJson(
      ctx.baseUrl,
      'GET',
      `/api/workspaces/${ctx.fixtures.workspaces.A}/context`,
      { token: ctx.fixtures.tokens.ownerA.accessToken }
    );
    assert.equal(status, 200);
    assert.ok(json?.data?.workspace?.id === ctx.fixtures.workspaces.A || json?.workspace?.id === ctx.fixtures.workspaces.A || json?.success !== false);
  });

  it('signed JWT without sessionId → rejected', async () => {
    requireCtx();
    const jwt = await import('jsonwebtoken');
    const legacy = jwt.default.sign({ userId: ctx.fixtures.users.ownerA.id }, process.env.JWT_SECRET, { expiresIn: '15m' });
    const prev = process.env.ALLOW_LEGACY_JWT;
    delete process.env.ALLOW_LEGACY_JWT;
    try {
      const { status, json } = await httpJson(
        ctx.baseUrl,
        'GET',
        `/api/workspaces/${ctx.fixtures.workspaces.A}/context`,
        { token: legacy }
      );
      assert.equal(status, 401);
      assert.equal(json?.code, 'SESSION_REQUIRED');
    } finally {
      if (prev !== undefined) process.env.ALLOW_LEGACY_JWT = prev;
    }
  });
});
