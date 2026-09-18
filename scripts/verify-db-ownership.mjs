#!/usr/bin/env node
/**
 * Report — and optionally repair — application objects owned by the wrong role.
 *
 * Postgres gives ownership to whoever runs CREATE. `initSchema()` issues
 * `CREATE TABLE IF NOT EXISTS` on every boot, so a maintenance script run as a
 * superuser used to leave new tables owned by that superuser while the app
 * connects as the application role. The app then could not ALTER its own table;
 * RBAC tests failed with "must be owner of table demo_simulated_entries" and
 * someone fixed it by hand. `adoptSchemaOwner()` in src/db/schema.js stops new
 * drift; this script proves there is none and repairs what predates it.
 *
 * Safety:
 *   - reports only by default; CONFIRM=1 required to reassign
 *   - repairs application objects only, never anything owned by a system role
 *   - exits non-zero while drift remains, so CI can gate on it
 *
 * Usage:
 *   DATABASE_URL=... node scripts/verify-db-ownership.mjs
 *   DATABASE_URL=... CONFIRM=1 node scripts/verify-db-ownership.mjs
 *   DATABASE_URL=... DB_APP_ROLE=tallydekho CONFIRM=1 node scripts/verify-db-ownership.mjs
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const CONFIRM = process.env.CONFIRM === '1';
const ANCHOR = 'users';

const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Roles Postgres manages itself — never reassign these. */
const SYSTEM_ROLES = new Set(['postgres', 'pg_database_owner']);

async function resolveExpectedOwner() {
  const configured = process.env.DB_APP_ROLE?.trim();
  if (configured) return { owner: configured, source: 'DB_APP_ROLE' };
  const { rows } = await query(
    `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
    [ANCHOR]
  );
  if (rows[0]?.tableowner) return { owner: rows[0].tableowner, source: `owner of ${ANCHOR}` };

  // No anchor: fall back to whoever owns the most public tables.
  const { rows: majority } = await query(
    `SELECT tableowner, count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'
      GROUP BY 1 ORDER BY n DESC LIMIT 1`
  );
  if (majority[0]?.tableowner) return { owner: majority[0].tableowner, source: 'majority owner' };
  return { owner: null, source: 'empty schema' };
}

/**
 * Every ownable application object in `public`.
 *
 * Objects an extension installed (pgvector alone contributes ~118 functions)
 * are owned by whoever ran CREATE EXTENSION and are maintained by the
 * extension, not by us — `pg_depend.deptype = 'e'` excludes them. Indexes
 * follow their table, so reassigning the table is enough.
 */
const DRIFT_SQL = `
  WITH extension_member AS (
    SELECT objid, classid FROM pg_depend WHERE deptype = 'e'
  )
  SELECT kind, name, owner FROM (
    SELECT CASE c.relkind WHEN 'r' THEN 'TABLE' WHEN 'p' THEN 'TABLE'
                          WHEN 'v' THEN 'VIEW'  WHEN 'm' THEN 'MATVIEW'
                          WHEN 'S' THEN 'SEQUENCE' END AS kind,
           c.relname AS name,
           pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r','p','v','m','S')
       AND NOT EXISTS (
         SELECT 1 FROM extension_member e
          WHERE e.objid = c.oid AND e.classid = 'pg_class'::regclass
       )
    UNION ALL
    SELECT 'FUNCTION', p.proname, pg_get_userbyid(p.proowner)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM extension_member e
          WHERE e.objid = p.oid AND e.classid = 'pg_proc'::regclass
       )
  ) obj
  WHERE owner <> $1
  ORDER BY kind, name
`;

async function drift(expected) {
  const { rows } = await query(DRIFT_SQL, [expected]);
  return rows;
}

async function main() {
  const { owner: expected, source } = await resolveExpectedOwner();
  if (!expected) {
    console.log('schema has no application objects — nothing to verify');
    process.exit(0);
  }

  const { rows: who } = await query(`SELECT current_user AS me`);
  console.log(`mode:           ${CONFIRM ? 'REPAIR (CONFIRM=1)' : 'REPORT ONLY'}`);
  console.log(`connected as:   ${who[0].me}`);
  console.log(`expected owner: ${expected}  (${source})\n`);

  let rows = await drift(expected);
  if (!rows.length) {
    console.log('no ownership drift — every public object is owned by the application role');
    process.exit(0);
  }

  console.log(`drifted objects: ${rows.length}`);
  for (const r of rows) console.log(`  ${r.kind.padEnd(9)} ${r.name.padEnd(42)} owner=${r.owner}`);

  const systemOwned = rows.filter((r) => SYSTEM_ROLES.has(r.owner));
  if (systemOwned.length) {
    console.log(`\n${systemOwned.length} object(s) owned by a system role are reported but never reassigned.`);
  }

  if (!CONFIRM) {
    console.log('\nreport only — re-run with CONFIRM=1 to reassign');
    process.exit(1);
  }

  const repairable = rows.filter((r) => !SYSTEM_ROLES.has(r.owner) && r.kind !== 'SEQUENCE' && r.kind !== 'FUNCTION');
  for (const r of repairable) {
    const kind = r.kind === 'MATVIEW' ? 'MATERIALIZED VIEW' : r.kind;
    await query(`ALTER ${kind} ${quoteIdent(r.name)} OWNER TO ${quoteIdent(expected)}`);
    console.log(`  reassigned ${r.kind} ${r.name}`);
  }

  rows = await drift(expected);
  const remaining = rows.filter((r) => !SYSTEM_ROLES.has(r.owner));
  console.log(`\nremaining drift: ${remaining.length}`);
  process.exit(remaining.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
