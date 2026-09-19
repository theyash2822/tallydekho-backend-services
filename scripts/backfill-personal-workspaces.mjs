#!/usr/bin/env node
/**
 * Give every existing user a personal workspace.
 *
 * This used to run inside initSchema() on every boot, which walked the whole
 * users table before the server could accept a request — the RBAC harness had
 * to switch it off to stay inside the test timeout. Live traffic never needed
 * it: login and workspace resolution both call ensurePersonalWorkspace(), so a
 * user without a workspace gets one the moment they act. It remains here for
 * environments that want the rows present up front.
 *
 * Inspect-only by default; CONFIRM=1 writes.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-personal-workspaces.mjs
 *   DATABASE_URL=... CONFIRM=1 node scripts/backfill-personal-workspaces.mjs
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';
import { backfillPersonalWorkspaces } from '../src/services/workspaceService.js';

const CONFIRM = process.env.CONFIRM === '1';

async function main() {
  const { rows } = await query(
    `SELECT count(*)::int AS missing
       FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM workspaces w
         WHERE w.owner_user_id = u.id AND w.workspace_type = 'PERSONAL'
      )`
  );
  const missing = rows[0]?.missing ?? 0;
  const { rows: totals } = await query(`SELECT count(*)::int AS n FROM users`);

  console.log(`mode:  ${CONFIRM ? 'BACKFILL (CONFIRM=1)' : 'INSPECT ONLY'}`);
  console.log(`users: ${totals[0]?.n ?? 0}`);
  console.log(`users without a personal workspace: ${missing}`);

  if (!CONFIRM) {
    console.log('\ninspect only — re-run with CONFIRM=1 to create them');
    process.exit(0);
  }
  if (!missing) {
    console.log('\nnothing to do');
    process.exit(0);
  }

  await backfillPersonalWorkspaces();

  const { rows: after } = await query(
    `SELECT count(*)::int AS missing
       FROM users u
      WHERE NOT EXISTS (
        SELECT 1 FROM workspaces w
         WHERE w.owner_user_id = u.id AND w.workspace_type = 'PERSONAL'
      )`
  );
  console.log(`\nremaining without a personal workspace: ${after[0]?.missing ?? 0}`);
  process.exit((after[0]?.missing ?? 0) === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
