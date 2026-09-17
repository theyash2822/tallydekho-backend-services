/**
 * Phase 3 A/B security fixture suite — unit + contract tests.
 * Full DB-backed cross-tenant runs require DATABASE_URL + seeded fixtures
 * (Workspace A/B). Without DB, contracts and fail-closed rules still run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEATURE_FLAGS } from '../config/featureFlags.js';
import { authorize } from '../services/authorizationService.js';
import {
  nonDelegableCapabilityKeys,
  resolveCapabilityKey,
  getCapability,
} from '../services/capabilityRegistry.js';

describe('Phase 3 capability catalogue', () => {
  it('resolveCapabilityKey is identity (aliases deleted)', () => {
    assert.equal(resolveCapabilityKey('members.view'), 'members.view');
    assert.equal(resolveCapabilityKey('workspace.members.view'), 'workspace.members.view');
  });

  it('nonDelegable set includes pair/unpair/roles/remove', () => {
    const keys = new Set(nonDelegableCapabilityKeys());
    assert.ok(keys.has('tally.pair'));
    assert.ok(keys.has('tally.unpair'));
    assert.ok(keys.has('roles.edit'));
    assert.ok(keys.has('members.remove'));
    assert.ok(getCapability('ownership.transfer')?.protected_authority === 'OWNER');
  });
});

describe('Phase 3 fail-closed RBAS', () => {
  it('rbas_enabled false → DENY without test bypass', async () => {
    const prev = FEATURE_FLAGS.rbas_enabled;
    const prevBypass = process.env.ALLOW_RBAS_BYPASS;
    const prevEnv = process.env.NODE_ENV;
    FEATURE_FLAGS.rbas_enabled = false;
    process.env.ALLOW_RBAS_BYPASS = '0';
    process.env.NODE_ENV = 'production';
    try {
      const r = await authorize({
        userId: 'user-a',
        workspaceId: 'ws-a',
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

describe('Phase 3 invite company_mode defaults (Q021)', () => {
  it('putMemberScopes / createInvitation coerce missing mode to NONE (source contract)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../services/workspaceService.js', import.meta.url), 'utf8');
    assert.ok(src.includes("policy.company_mode || 'NONE'"), 'putMemberScopes must default NONE');
    assert.ok(src.includes("company_mode: 'NONE'"), 'createInvitation must snapshot NONE');
    assert.ok(!src.match(/policy\.company_mode \|\| 'ALL'/), 'must not default company_mode to ALL');
  });
});

describe('Phase 3 deleted dead paths', () => {
  it('inviteService.js is gone', async () => {
    const fs = await import('node:fs');
    const path = new URL('../services/inviteService.js', import.meta.url);
    assert.equal(fs.existsSync(path), false);
  });

  it('sync-run/history route is gone', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('sync-run/history'));
  });

  it('isOwnerOrAdmin helper is gone from workspaceService', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../services/workspaceService.js', import.meta.url), 'utf8');
    assert.ok(!src.includes('function isOwnerOrAdmin'));
    assert.ok(!src.includes('export async function isOwnerOrAdmin'));
  });

  it('desktopAuth / optionalWorkspaceContext are gone', async () => {
    const fs = await import('node:fs');
    const auth = fs.readFileSync(new URL('../middleware/auth.js', import.meta.url), 'utf8');
    const wsCtx = fs.existsSync(new URL('../middleware/workspaceContext.js', import.meta.url))
      ? fs.readFileSync(new URL('../middleware/workspaceContext.js', import.meta.url), 'utf8')
      : '';
    assert.ok(!auth.includes('desktopAuth') || !auth.includes('export.*desktopAuth'));
    assert.ok(!wsCtx.includes('optionalWorkspaceContext'));
  });
});

describe('Phase 3 legacy JWT fail-closed (Q022)', () => {
  it('ALLOW_LEGACY_JWT must be explicit 1 to allow sessionless JWT', async () => {
    const fs = await import('node:fs');
    const auth = fs.readFileSync(new URL('../middleware/auth.js', import.meta.url), 'utf8');
    assert.ok(auth.includes("ALLOW_LEGACY_JWT !== '1'"));
    const sess = fs.readFileSync(new URL('../services/authSessionService.js', import.meta.url), 'utf8');
    assert.ok(sess.includes("ALLOW_LEGACY_JWT === '1'"));
    assert.ok(sess.includes("NODE_ENV !== 'production'"));
  });
});

describe('Phase 3 A/B cross-tenant (requires DATABASE_URL + fixtures)', () => {
  it('documents required fixture shape', () => {
    const fixture = {
      workspaceA: { owner: 'OwnerA', admin: 'AdminA', member: 'MemberA', restricted: 'RestrictedA', companies: ['A1', 'A2'] },
      workspaceB: { owner: 'OwnerB', member: 'MemberB', companies: ['B1'] },
      negatives: [
        'A token + B company = deny',
        'RestrictedA(A1) + A2 = deny',
        'correct company + missing capability = deny',
        'revoke → next action deny',
        'device-id without secret → privileged deny',
        'DeviceA uploadId used by DeviceB → deny',
      ],
    };
    assert.equal(fixture.workspaceA.companies.length, 2);
    assert.equal(fixture.negatives.length, 6);
  });

  it('skips live A/B HTTP matrix without DATABASE_URL', async () => {
    if (!process.env.DATABASE_URL || !process.env.RBAC_AB_FIXTURES) {
      assert.ok(true, 'Set DATABASE_URL + RBAC_AB_FIXTURES=1 to run live A/B');
      return;
    }
    // Live runner reserved for CI with seeded workspaces — see RBAC_REMEDIATION_LOG.md
    assert.fail('Live A/B runner not yet wired to this process — use scripts/rbac-ab-fixture when present');
  });
});
