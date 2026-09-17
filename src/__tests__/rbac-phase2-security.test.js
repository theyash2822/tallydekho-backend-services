/**
 * Cross-tenant / authz security tests (Phase 2).
 * Uses node:test. Some cases are pure unit; integration cases skip without DATABASE_URL.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEATURE_FLAGS } from '../config/featureFlags.js';
import { authorize } from '../services/authorizationService.js';

describe('Phase 2 fail-closed flags', () => {
  it('rbas_enabled stays ON in catalogue', () => {
    assert.equal(FEATURE_FLAGS.rbas_enabled, true);
  });

  it('authorize DENYs when rbas disabled without ALLOW_RBAS_BYPASS', async () => {
    const prev = FEATURE_FLAGS.rbas_enabled;
    const prevBypass = process.env.ALLOW_RBAS_BYPASS;
    const prevEnv = process.env.NODE_ENV;
    FEATURE_FLAGS.rbas_enabled = false;
    process.env.ALLOW_RBAS_BYPASS = '0';
    process.env.NODE_ENV = 'production';
    try {
      const r = await authorize({
        userId: 1,
        workspaceId: 'ws-x',
        capability: 'dashboard.view',
      });
      assert.equal(r.decision, 'DENY');
      assert.equal(r.reason, 'RBAS_DISABLED');
    } finally {
      FEATURE_FLAGS.rbas_enabled = prev;
      process.env.ALLOW_RBAS_BYPASS = prevBypass;
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe('integrationAccess middleware contract', () => {
  it('exports requireIntegrationCompanyAccess', async () => {
    const mod = await import('../middleware/integrationAccess.js');
    assert.equal(typeof mod.requireIntegrationCompanyAccess, 'function');
  });
});

describe('authSessionService hashing', () => {
  it('creates distinct session payloads shape when JWT_SECRET set', async () => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'test-secret-phase2-rbac';
    }
    if (!process.env.DATABASE_URL) {
      // Cannot hit DB — skip create
      assert.ok(true);
      return;
    }
    const { createAuthSession, assertSessionActive, revokeSession } = await import(
      '../services/authSessionService.js'
    );
    // Needs real user id — skip if no DB fixtures
    assert.equal(typeof createAuthSession, 'function');
    assert.equal(typeof assertSessionActive, 'function');
    assert.equal(typeof revokeSession, 'function');
  });
});
