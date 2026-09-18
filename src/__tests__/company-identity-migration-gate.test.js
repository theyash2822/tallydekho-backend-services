/**
 * Company Identity — destructive migration must not ride along with a deploy.
 *
 * initSchema() runs on every server boot. The Phase 3D/3E cutover drops
 * global UNIQUE(companies.guid), drops member_company_access.company_guid and
 * deletes rows lacking an internal owner, so in production it has to be an
 * operator-supervised step with a verified backup.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cidDestructiveMigrationsAllowed } from '../db/schema.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function withEnv(env, fn) {
  const prev = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe('Company Identity destructive migration gate', () => {
  it('production boot does not auto-apply the cutover', () => {
    withEnv({ NODE_ENV: 'production', CID_ALLOW_DESTRUCTIVE_MIGRATION: undefined }, () => {
      assert.equal(cidDestructiveMigrationsAllowed(), false);
    });
  });

  it('production requires explicit CID_ALLOW_DESTRUCTIVE_MIGRATION opt-in', () => {
    withEnv({ NODE_ENV: 'production', CID_ALLOW_DESTRUCTIVE_MIGRATION: '1' }, () => {
      assert.equal(cidDestructiveMigrationsAllowed(), true);
    });
  });

  it('dev/test still converge automatically', () => {
    for (const env of ['development', 'test', undefined]) {
      withEnv({ NODE_ENV: env, CID_ALLOW_DESTRUCTIVE_MIGRATION: undefined }, () => {
        assert.equal(cidDestructiveMigrationsAllowed(), true);
      });
    }
  });

  it('the cutover is isolated behind the gate, not inlined in initSchema', () => {
    const src = fs.readFileSync(path.join(root, 'db/schema.js'), 'utf8');
    assert.ok(src.includes('if (cidDestructiveMigrationsAllowed()) {'));
    assert.ok(src.includes('await applyCidConstraintCutover(client)'));
    // The destructive statements must live inside the gated function only.
    const gated = src.slice(src.indexOf('async function applyCidConstraintCutover'));
    assert.ok(gated.includes('companies_guid_key'));
    assert.ok(gated.includes('companies_workspace_guid_key'));
    assert.ok(gated.includes('DROP COLUMN IF EXISTS company_guid'));
  });

  it('operator cutover + smoke scripts exist for the supervised path', () => {
    const scripts = path.join(root, '..', 'scripts');
    for (const f of ['cid-guid-unique-cutover.mjs', 'cid-duplicate-guid-smoke.mjs']) {
      assert.ok(fs.existsSync(path.join(scripts, f)), `${f} missing`);
    }
    const cutover = fs.readFileSync(path.join(scripts, 'cid-guid-unique-cutover.mjs'), 'utf8');
    assert.ok(cutover.includes('CONFIRM'), 'cutover must require explicit confirmation');
    assert.ok(cutover.includes('lock_timeout'), 'cutover must bound lock waits');
  });

  it('every destructive step the boot path performs has an operator script', () => {
    const scripts = path.join(root, '..', 'scripts');
    // companies UNIQUE swap · child NOT NULL/FK/UNIQUE · config/master/MCA
    const required = {
      'cid-guid-unique-cutover.mjs': ['companies_workspace_guid_key'],
      'cid-child-constraint-cutover.mjs': ['STAGE', 'migrateSafe', 'reportLockBlockers'],
      // The child DDL itself lives in the module shared with the rehearsal, so
      // production executes exactly what was measured.
      'lib/cidChildMigration.mjs': ['SET NOT NULL', 'FOREIGN KEY', 'NOT VALID', 'CONCURRENTLY'],
      'cid-config-master-cutover.mjs': [
        'member_company_access',
        'company_guid',
        'tdk_reference_counters',
        'CONFIRM_DELETE',
      ],
    };
    for (const [file, needles] of Object.entries(required)) {
      const full = path.join(scripts, file);
      assert.ok(fs.existsSync(full), `${file} missing — boot flag would be the only path`);
      const src = fs.readFileSync(full, 'utf8');
      for (const needle of needles) {
        assert.ok(src.includes(needle), `${file} must cover ${needle}`);
      }
    }
  });

  it('rows-destroying steps are never implicit in the operator scripts', () => {
    const src = fs.readFileSync(
      path.join(root, '..', 'scripts', 'cid-config-master-cutover.mjs'),
      'utf8'
    );
    // Each DELETE must be reachable only behind the explicit delete opt-in.
    for (const table of ['tdk_reference_counters', 'member_company_access']) {
      assert.match(
        src,
        new RegExp(`CONFIRM_DELETE[\\s\\S]*${table}|${table}[\\s\\S]{0,2000}CONFIRM_DELETE`),
        `${table} pruning must be gated by CONFIRM_DELETE`
      );
    }
  });

  it('legacy-column verification treats a shared GUID as normal, not corruption', () => {
    const src = fs.readFileSync(
      path.join(root, '..', 'scripts', 'verify-rbac-legacy-column-removal.mjs'),
      'utf8'
    );

    // Two tenants may each connect a Tally company carrying the same GUID; that
    // is what Phase 3E exists to support. Grouping by guid alone reported every
    // shared GUID as a failure — 42 locally — and would have blocked Deployment B
    // on a condition the architecture now requires.
    assert.match(
      src,
      /GROUP BY workspace_id, guid/,
      'uniqueness must be scoped to the workspace'
    );
    assert.ok(
      !/GROUP BY guid\b/.test(src),
      'grouping by guid alone reinstates the pre-3E global-uniqueness assumption'
    );
  });

  it('the ADMIN membership migration inspects unless CONFIRM=1', () => {
    const src = fs.readFileSync(
      path.join(root, '..', 'scripts', 'migrate-admin-membership-to-role.mjs'),
      'utf8'
    );

    // This script rewrites membership rows and installs a CHECK constraint. It
    // used to apply by default and hold back only on DRY_RUN=1, so forgetting the
    // flag migrated production. Safety must come from the default, not recall.
    assert.match(
      src,
      /const dryRun\s*=\s*process\.env\.CONFIRM\s*!==\s*'1'/,
      'absence of CONFIRM=1 must mean inspect-only'
    );

    // The membership rewrite has to sit after the early exit, or the guard is
    // decorative.
    const exitAt = src.indexOf('skipping membership_type UPDATE');
    const updateAt = src.search(/UPDATE workspace_memberships\s+SET membership_type\s*=\s*'MEMBER'/);
    assert.ok(exitAt > -1, 'inspect-only path must exit before mutating');
    assert.ok(updateAt > -1, 'expected the membership_type rewrite');
    assert.ok(exitAt < updateAt, 'the mutation must be unreachable in inspect-only mode');

    // Same for the constraint that makes the change hard to walk back.
    const checkAt = src.indexOf("CHECK (membership_type IN ('OWNER', 'MEMBER'))");
    assert.ok(checkAt > exitAt, 'the CHECK constraint must also be gated');
  });

  it('the staging template never enables the destructive boot flag', () => {
    const template = fs.readFileSync(path.join(root, '..', '.env.staging.example'), 'utf8');
    const active = template
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .find((l) => l.startsWith('CID_ALLOW_DESTRUCTIVE_MIGRATION'));
    assert.equal(active, undefined, 'staging must not opt into destructive boot migrations');
    assert.match(template, /APP_ENV=staging/);
    assert.match(template, /NODE_ENV=production/);
  });

  it('preflight verification resolves ownership workspace-scoped, never by guid alone', () => {
    const verify = fs.readFileSync(
      path.join(root, '..', 'scripts', 'verify-company-id-backfill.mjs'),
      'utf8'
    );
    assert.ok(verify.includes('c.workspace_id = t.workspace_id'));
    assert.ok(verify.includes('ambiguous_guid_no_owner'));
    // A failed check must never be reported as a pass.
    assert.ok(verify.includes('ERROR ${table}'));
    assert.ok(!verify.includes('SKIP ${table}'));
  });
});
