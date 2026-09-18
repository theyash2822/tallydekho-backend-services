/**
 * Phase 6 — convert membership_type=ADMIN → MEMBER + workspace builtin ADMIN role.
 *
 * Usage:
 *   node scripts/migrate-admin-membership-to-role.mjs              # inspect only
 *   CONFIRM=1 node scripts/migrate-admin-membership-to-role.mjs    # apply
 *
 * Fails if any ADMIN membership's workspace lacks builtin ADMIN role.
 *
 * Inspecting is the default. This script rewrites membership rows in place, so
 * running it bare against production by mistake — while exploring, or from a
 * half-remembered command — must not be able to mutate anything. Every other
 * destructive operator script here requires CONFIRM=1, and this one was the
 * exception: it applied by default and only skipped writes when DRY_RUN=1 was
 * remembered. DRY_RUN is still accepted so older runbooks keep working.
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';
import { seedBuiltinRoles } from '../src/services/roleService.js';

const dryRun = process.env.CONFIRM !== '1' || process.env.DRY_RUN === '1';

async function main() {
  const { rows: before } = await query(
    `SELECT COUNT(*)::int AS n FROM workspace_memberships WHERE membership_type = 'ADMIN'`
  );
  console.log(`ADMIN memberships before: ${before[0].n}`);

  // Seed missing ADMIN roles for any workspace that has ADMIN members
  const { rows: needSeed } = await query(`
    SELECT DISTINCT m.workspace_id
    FROM workspace_memberships m
    WHERE m.membership_type = 'ADMIN'
      AND NOT EXISTS (
        SELECT 1 FROM workspace_roles r
        WHERE r.workspace_id = m.workspace_id AND r.system_key = 'ADMIN'
      )
  `);
  if (needSeed.length) {
    console.error(`FAIL: ${needSeed.length} workspace(s) with ADMIN members lack ADMIN role`);
    for (const r of needSeed) console.error(' ', r.workspace_id);
    process.exit(2);
  }

  // Hygiene: seed ADMIN role for workspaces missing it (no ADMIN members)
  const { rows: missingRoles } = await query(`
    SELECT w.id FROM workspaces w
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_roles r WHERE r.workspace_id = w.id AND r.system_key = 'ADMIN'
    )
  `);
  if (!dryRun) {
    for (const w of missingRoles) {
      await seedBuiltinRoles(w.id);
      console.log(`seeded builtin roles for workspace ${w.id}`);
    }
  } else if (missingRoles.length) {
    console.log(`DRY_RUN: would seed builtin roles for ${missingRoles.length} workspace(s)`);
  }

  // Ensure every ADMIN row has role_id pointing at workspace ADMIN role
  const { rows: nullRole } = await query(`
    SELECT m.id, m.workspace_id FROM workspace_memberships m
    WHERE m.membership_type = 'ADMIN' AND m.role_id IS NULL
  `);
  if (nullRole.length && !dryRun) {
    for (const m of nullRole) {
      const { rows: roles } = await query(
        `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'ADMIN' LIMIT 1`,
        [m.workspace_id]
      );
      if (!roles[0]) {
        console.error('FAIL: no ADMIN role for', m.workspace_id);
        process.exit(2);
      }
      await query(`UPDATE workspace_memberships SET role_id = $2 WHERE id = $1`, [m.id, roles[0].id]);
    }
    console.log(`backfilled role_id for ${nullRole.length} ADMIN membership(s)`);
  }

  // Align role_id to workspace ADMIN when pointing elsewhere (should be 0)
  if (!dryRun) {
    const { rowCount } = await query(`
      UPDATE workspace_memberships m
      SET role_id = r.id
      FROM workspace_roles r
      WHERE m.membership_type = 'ADMIN'
        AND r.workspace_id = m.workspace_id
        AND r.system_key = 'ADMIN'
        AND (m.role_id IS DISTINCT FROM r.id)
    `);
    if (rowCount) console.log(`realigned role_id on ${rowCount} row(s)`);
  }

  if (dryRun) {
    console.log('inspect only: skipping membership_type UPDATE');
    console.log('re-run with CONFIRM=1 to apply');
    process.exit(0);
  }

  const upd = await query(`
    UPDATE workspace_memberships
    SET membership_type = 'MEMBER'
    WHERE membership_type = 'ADMIN'
    RETURNING id
  `);
  console.log(`Converted to MEMBER: ${upd.rowCount}`);

  // Drop CHECK if present and add OWNER|MEMBER only
  await query(`
    ALTER TABLE workspace_memberships DROP CONSTRAINT IF EXISTS workspace_memberships_membership_type_check
  `).catch(() => {});
  await query(`
    ALTER TABLE workspace_memberships
    ADD CONSTRAINT workspace_memberships_membership_type_check
    CHECK (membership_type IN ('OWNER', 'MEMBER'))
  `).catch((err) => {
    console.warn('CHECK constraint note:', err.message);
  });

  const { rows: after } = await query(
    `SELECT membership_type, COUNT(*)::int AS n FROM workspace_memberships GROUP BY 1 ORDER BY 1`
  );
  console.log('After:', after);
  const rem = after.find((r) => r.membership_type === 'ADMIN');
  if (rem?.n) {
    console.error('FAIL: ADMIN rows remain', rem.n);
    process.exit(1);
  }
  console.log('OK: membership_type=ADMIN rows = 0');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
