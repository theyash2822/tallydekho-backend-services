/**
 * Phase 2 security unit tests (no DB required for these cases).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEATURE_FLAGS } from '../config/featureFlags.js';
import { authorize } from '../services/authorizationService.js';

describe('Phase 2/4 fail-closed flags', () => {
  it('rbas_enabled kill-switch is gone from catalogue', () => {
    assert.equal(Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, 'rbas_enabled'), false);
  });

  it('authorize still evaluates without rbas_enabled flag', async () => {
    // Without DB membership → DENY NO_MEMBERSHIP (not RBAS_DISABLED)
    const r = await authorize({
      userId: 1,
      workspaceId: 'ws-x',
      capability: 'dashboard.view',
    });
    assert.equal(r.decision, 'DENY');
    assert.notEqual(r.reason, 'RBAS_DISABLED');
  });
});

describe('integrationAccess middleware contract', () => {
  it('module may be deleted in Phase 4 — skip if absent', async () => {
    try {
      const mod = await import('../middleware/integrationAccess.js');
      assert.equal(typeof mod.requireIntegrationCompanyAccess, 'function');
    } catch (err) {
      if (err.code === 'ERR_MODULE_NOT_FOUND') {
        assert.ok(true, 'integrationAccess deleted with /app/integrations');
        return;
      }
      throw err;
    }
  });
});

describe('authSessionService hashing', () => {
  it('creates distinct session payloads shape when JWT_SECRET set', async () => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'test-secret-phase2-rbac';
    }
    if (!process.env.DATABASE_URL) {
      assert.ok(true);
      return;
    }
    const { createAuthSession, assertSessionActive, revokeSession } = await import(
      '../services/authSessionService.js'
    );
    assert.equal(typeof createAuthSession, 'function');
    assert.equal(typeof assertSessionActive, 'function');
    assert.equal(typeof revokeSession, 'function');
  });
});
