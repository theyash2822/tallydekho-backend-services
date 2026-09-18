#!/usr/bin/env node
/**
 * Deployment A verification — companies.user_id / devices.user_id removal preconditions.
 * EXIT NON-ZERO if invariants fail. Never soft-warn and succeed.
 *
 * Usage: DATABASE_URL=... node scripts/verify-rbac-legacy-column-removal.mjs
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });
let failed = false;

function fail(msg) {
  console.error('FAIL:', msg);
  failed = true;
}

async function main() {
  const { rows: nullWs } = await pool.query(
    `SELECT count(*)::int AS n FROM companies WHERE workspace_id IS NULL AND is_active IS DISTINCT FROM FALSE`
  );
  if (nullWs[0].n > 0) {
    fail(`${nullWs[0].n} active/unknown companies have NULL workspace_id`);
  } else {
    console.log('OK: no active companies with NULL workspace_id');
  }

  const { rows: pairedNoWs } = await pool.query(
    `SELECT count(*)::int AS n FROM devices WHERE paired = TRUE AND (workspace_id IS NULL OR workspace_id = '')`
  );
  if (pairedNoWs[0].n > 0) {
    fail(`${pairedNoWs[0].n} paired devices lack workspace_id`);
  } else {
    console.log('OK: paired devices have workspace_id');
  }

  // Ownership must be unambiguous WITHIN a workspace. It is deliberately not
  // unique across workspaces: two tenants may each connect a Tally company
  // carrying the same GUID, which is the whole point of Company Identity Phase 3E
  // (UNIQUE(guid) was replaced by UNIQUE(workspace_id, guid)).
  //
  // This check previously grouped by guid alone. Post-3E that reports every
  // legitimately shared GUID as corruption — 42 of them locally — and would have
  // blocked Deployment B for a condition the architecture now requires.
  const { rows: dup } = await pool.query(
    `SELECT workspace_id, guid, count(*)::int AS n
       FROM companies
      GROUP BY workspace_id, guid
     HAVING count(*) > 1`
  );
  if (dup.length) fail(`duplicate (workspace_id, guid) pairs: ${dup.length}`);
  else console.log('OK: company identity is unique within each workspace');

  await pool.end();
  if (failed) process.exit(1);
  console.log('All legacy-column removal invariants passed (Deployment A).');
  console.log('Deployment B (DROP COLUMN) is a separate reviewed migration — see migrations/prep-drop-legacy-user-id.md');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
