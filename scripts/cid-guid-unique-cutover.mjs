#!/usr/bin/env node
/**
 * Company Identity — companies GUID uniqueness cutover executor.
 *
 *   global UNIQUE (guid)  →  UNIQUE (workspace_id, guid)
 *
 * `companies.guid` is the EXTERNAL Tally company identity and is only unique
 * within a workspace. `companies.id` is the internal identity. This script
 * performs the constraint swap with preflight guards, an explicit lock timeout,
 * and measured timings so production lock exposure is known in advance.
 *
 * The column is never renamed. Desktop keeps sending Tally GUIDs.
 *
 * Usage:
 *   node scripts/cid-guid-unique-cutover.mjs                 # dry run (default)
 *   CONFIRM=1 node scripts/cid-guid-unique-cutover.mjs       # apply
 *   CONFIRM=1 ROLLBACK=1 node ...                            # back to global UNIQUE(guid)
 *
 * Env:
 *   CONFIRM=1              apply (otherwise dry run only)
 *   ROLLBACK=1             reverse direction (requires zero duplicate guids)
 *   LOCK_TIMEOUT_MS=5000   fail fast instead of queueing behind long transactions
 *   FORCE_DROP_GUID_FKS=1  drop FKs that still reference companies(guid)
 *   ALLOW_PRODUCTION=1     required if NODE_ENV=production
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const CONFIRM = process.env.CONFIRM === '1';
const ROLLBACK = process.env.ROLLBACK === '1';
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);
const FORCE_DROP_GUID_FKS = process.env.FORCE_DROP_GUID_FKS === '1';

const GLOBAL_CON = 'companies_guid_key';
const COMPOSITE_CON = 'companies_workspace_guid_key';

const ms = (t) => `${Math.round(Number(process.hrtime.bigint() - t) / 1e6)}ms`;

async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0];
}

async function uniques() {
  const { rows } = await query(`
    SELECT conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE conrelid = 'companies'::regclass AND contype = 'u'
    ORDER BY conname
  `);
  return rows;
}

async function guidFks() {
  const { rows } = await query(`
    SELECT conname, conrelid::regclass::text AS child, pg_get_constraintdef(oid) AS def
    FROM pg_constraint
    WHERE confrelid = 'companies'::regclass AND contype = 'f'
      AND pg_get_constraintdef(oid) ILIKE '%(guid)%'
    ORDER BY conname
  `);
  return rows;
}

async function preflight() {
  const problems = [];

  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION !== '1') {
    problems.push('NODE_ENV=production without ALLOW_PRODUCTION=1');
  }

  const db = await one(
    `SELECT current_database() AS db, current_user AS usr,
            (SELECT setting FROM pg_settings WHERE name = 'server_version') AS ver`
  );
  console.log(`target: ${db.db} as ${db.usr} (postgres ${db.ver})`);

  const wsNull = await one(`SELECT COUNT(*)::int AS c FROM companies WHERE workspace_id IS NULL`);
  console.log(`companies.workspace_id NULL: ${wsNull.c}`);
  if (wsNull.c > 0) problems.push(`companies.workspace_id NULL rows = ${wsNull.c}`);

  const dupWs = await one(`
    SELECT COUNT(*)::int AS c FROM (
      SELECT workspace_id, guid FROM companies
      GROUP BY workspace_id, guid HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`duplicate (workspace_id, guid) groups: ${dupWs.c}`);
  if (dupWs.c > 0) problems.push(`duplicate (workspace_id, guid) groups = ${dupWs.c}`);

  const dupGuid = await one(`
    SELECT COUNT(*)::int AS c FROM (
      SELECT guid FROM companies GROUP BY guid HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`duplicate guid groups (expected >0 only after cutover): ${dupGuid.c}`);
  if (ROLLBACK && dupGuid.c > 0) {
    problems.push(
      `cannot restore global UNIQUE(guid): ${dupGuid.c} guid(s) exist in multiple workspaces`
    );
  }

  const cons = await uniques();
  console.log('current UNIQUE constraints:');
  for (const c of cons) console.log(`  ${c.conname} = ${c.def}`);

  const fks = await guidFks();
  if (fks.length) {
    console.log('FKs referencing companies(guid):');
    for (const f of fks) console.log(`  ${f.conname} on ${f.child} = ${f.def}`);
    if (!FORCE_DROP_GUID_FKS) {
      problems.push(
        `${fks.length} FK(s) reference companies(guid) — rerun with FORCE_DROP_GUID_FKS=1 after review`
      );
    }
  } else {
    console.log('FKs referencing companies(guid): none');
  }

  const rows = await one(`SELECT COUNT(*)::int AS c FROM companies`);
  console.log(`companies row count: ${rows.c}`);

  return { problems, cons, fks };
}

async function main() {
  const direction = ROLLBACK ? 'ROLLBACK → UNIQUE(guid)' : 'FORWARD → UNIQUE(workspace_id, guid)';
  console.log(`=== CID GUID uniqueness cutover: ${direction} ===`);
  console.log(CONFIRM ? 'mode: APPLY' : 'mode: DRY RUN (set CONFIRM=1 to apply)');

  const { problems, cons, fks } = await preflight();

  const hasGlobal = cons.some((c) => c.def.replace(/\s/g, '') === 'UNIQUE(guid)');
  const hasComposite = cons.some((c) => /workspace_id/.test(c.def) && /guid/.test(c.def));

  if (!ROLLBACK && hasComposite && !hasGlobal) {
    console.log('already cut over — nothing to do');
    process.exit(0);
  }
  if (ROLLBACK && hasGlobal && !hasComposite) {
    console.log('already rolled back — nothing to do');
    process.exit(0);
  }

  if (problems.length) {
    console.error('PREFLIGHT FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
  }
  console.log('preflight OK');

  if (!CONFIRM) {
    console.log('dry run complete — no changes made');
    process.exit(0);
  }

  const started = process.hrtime.bigint();
  const timings = [];
  const step = async (label, sql) => {
    const t = process.hrtime.bigint();
    await query(sql);
    const took = ms(t);
    timings.push([label, took]);
    console.log(`  ${label}: ${took}`);
  };

  try {
    await query('BEGIN');
    await query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);

    if (fks.length && FORCE_DROP_GUID_FKS) {
      for (const f of fks) {
        await step(
          `drop FK ${f.conname} on ${f.child}`,
          `ALTER TABLE ${f.child} DROP CONSTRAINT ${f.conname}`
        );
      }
    }

    if (ROLLBACK) {
      await step(
        `drop ${COMPOSITE_CON}`,
        `ALTER TABLE companies DROP CONSTRAINT IF EXISTS ${COMPOSITE_CON}`
      );
      await step(
        `add ${GLOBAL_CON}`,
        `ALTER TABLE companies ADD CONSTRAINT ${GLOBAL_CON} UNIQUE (guid)`
      );
    } else {
      await step(
        `drop ${GLOBAL_CON}`,
        `ALTER TABLE companies DROP CONSTRAINT IF EXISTS ${GLOBAL_CON}`
      );
      await step(
        `add ${COMPOSITE_CON}`,
        `ALTER TABLE companies ADD CONSTRAINT ${COMPOSITE_CON} UNIQUE (workspace_id, guid)`
      );
    }

    await query('COMMIT');
  } catch (e) {
    await query('ROLLBACK').catch(() => {});
    console.error(`MIGRATION FAILED (rolled back): ${e.message}`);
    if (e.code === '55P03' || /lock timeout/i.test(e.message)) {
      console.error('lock timeout — retry during a quiet window or raise LOCK_TIMEOUT_MS');
    }
    process.exit(1);
  }

  console.log(`total: ${ms(started)}`);
  console.log('post-state UNIQUE constraints:');
  for (const c of await uniques()) console.log(`  ${c.conname} = ${c.def}`);
  console.log('cutover OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
