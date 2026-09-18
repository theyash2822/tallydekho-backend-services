/**
 * Phase 6 verification — exit non-zero if ADMIN membership model remains.
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

async function main() {
  const failures = [];

  const { rows: adminRows } = await query(
    `SELECT COUNT(*)::int AS n FROM workspace_memberships WHERE membership_type = 'ADMIN'`
  );
  if (adminRows[0].n > 0) failures.push(`membership_type=ADMIN rows remaining: ${adminRows[0].n}`);

  const { rows: missingRole } = await query(`
    SELECT COUNT(*)::int AS n FROM workspaces w
    WHERE NOT EXISTS (
      SELECT 1 FROM workspace_roles r WHERE r.workspace_id = w.id AND r.system_key = 'ADMIN'
    )
  `);
  if (missingRole[0].n > 0) failures.push(`workspaces missing ADMIN role: ${missingRole[0].n}`);

  const { rows: adminEquiv } = await query(`
    SELECT COUNT(*)::int AS n
    FROM workspace_memberships m
    JOIN workspace_roles r ON r.id = m.role_id
    WHERE m.membership_type = 'MEMBER' AND r.system_key = 'ADMIN' AND m.status = 'ACTIVE'
  `);

  const { rows: badAdmin } = await query(`
    SELECT COUNT(*)::int AS n
    FROM workspace_memberships m
    JOIN workspace_roles r ON r.id = m.role_id
    WHERE r.system_key = 'ADMIN' AND m.membership_type NOT IN ('MEMBER', 'OWNER')
  `);
  if (badAdmin[0].n > 0) failures.push(`ADMIN role on invalid membership_type: ${badAdmin[0].n}`);

  const { rows: orphanRole } = await query(`
    SELECT COUNT(*)::int AS n
    FROM workspace_memberships m
    WHERE m.role_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspace_roles r WHERE r.id = m.role_id)
  `);
  if (orphanRole[0].n > 0) failures.push(`orphan role_id assignments: ${orphanRole[0].n}`);

  console.log(JSON.stringify({
    adminMemberships: adminRows[0].n,
    workspacesMissingAdminRole: missingRole[0].n,
    activeMemberWithAdminRole: adminEquiv[0].n,
    orphanRoleAssignments: orphanRole[0].n,
  }, null, 2));

  if (failures.length) {
    console.error('VERIFY FAIL:');
    for (const f of failures) console.error(' -', f);
    process.exit(1);
  }
  console.log('OK: Phase 6 ADMIN membership invariants hold');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
