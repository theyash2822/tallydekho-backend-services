#!/usr/bin/env node
/**
 * Company Identity — child constraint migration REHEARSAL.
 *
 * Measures the step that was still "unknown" before production approval:
 * bringing child tables from "company_id nullable, no FK" to
 * "company_id NOT NULL + FK RESTRICT + composite UNIQUE".
 *
 * DESTRUCTIVE: with RESHAPE=1 it strips the target back to the pre-Phase-3D
 * shape so the migration can be timed. Disposable clones only — it refuses to
 * run against a database stamped production or staging.
 *
 * The production tool is scripts/cid-child-constraint-cutover.mjs; both share
 * scripts/lib/cidChildMigration.mjs so production runs what was measured here.
 *
 * Usage:
 *   DATABASE_URL=postgres://.../td_cid_rehearsal \
 *   RESHAPE=1 MODE=safe BATCH_SIZE=5000 CONFIRM=1 \
 *     node scripts/cid-child-constraint-rehearsal.mjs
 *
 *   MODE        safe (default) | naive — naive is what initSchema does today
 *   BATCH_SIZE  rows per backfill statement (0 = one large UPDATE)
 *   RESHAPE=1   strip back to pre-Phase-3D first
 *   CONFIRM=1   required to execute; otherwise reports current shape only
 */
import 'dotenv/config';
import pg from 'pg';
import {
  CHILD_TABLES,
  backfill,
  createTimer,
  deploymentEnv,
  migrateNaive,
  migrateSafe,
  presentTables,
  reportShape,
  shape,
  stats,
} from './lib/cidChildMigration.mjs';

const { Client } = pg;

const MODE = (process.env.MODE || 'safe').toLowerCase();
const RESHAPE = process.env.RESHAPE === '1' || process.env.RESHAPE_ONLY === '1';
/** Leave the clone pre-3D so the operator cutover script can be exercised on it. */
const RESHAPE_ONLY = process.env.RESHAPE_ONLY === '1';
const CONFIRM = process.env.CONFIRM === '1';
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 0);

// A misspelled selector silently running the wrong pattern would invalidate the
// measurement, so reject near-misses instead of falling back to the default.
for (const wrong of ['METHOD', 'MIGRATION_MODE', 'STRATEGY']) {
  if (process.env[wrong]) {
    console.error(`${wrong} is not a recognised option — did you mean MODE=${process.env[wrong]}?`);
    process.exit(1);
  }
}

if (!['naive', 'safe'].includes(MODE)) {
  console.error(`MODE must be naive or safe (got ${MODE})`);
  process.exit(1);
}

/** Strip back to the pre-Phase-3D shape so the migration can be measured. */
async function reshape(client, tables) {
  console.log('\n── reshaping to pre-Phase-3D shape ───────────────────────────');
  for (const { table } of tables) {
    await client.query(`ALTER TABLE ${table} ALTER COLUMN company_id DROP NOT NULL`);
    const { rows: cons } = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = to_regclass($1) AND contype IN ('f','u','c')
          AND pg_get_constraintdef(oid) ILIKE '%company_id%'`,
      [table]
    );
    for (const { conname } of cons) {
      await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${conname}"`);
    }
    const { rows: idx } = await client.query(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = $1 AND indexdef ILIKE '%company_id%'`,
      [table]
    );
    for (const { indexname } of idx) {
      await client.query(`DROP INDEX IF EXISTS "${indexname}"`);
    }
    // Pre-3D rows carried ownership in company_guid only.
    await client.query(`UPDATE ${table} SET company_id = NULL WHERE company_id IS NOT NULL`);
    // Report the verified state rather than the UPDATE's row count, which is 0
    // when the column was already NULL from an earlier reshape.
    const st = await stats(client, table);
    console.log(
      `  ${table}: ${st.null_cid}/${st.rows} rows now NULL, constraints/indexes dropped`
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: dbInfo } = await client.query('SELECT current_database() AS db, version() AS v');
  const env = await deploymentEnv(client);
  console.log(`database : ${dbInfo[0].db}`);
  console.log(`postgres : ${dbInfo[0].v.split(' ').slice(0, 2).join(' ')}`);
  console.log(`db stamp : ${env}`);
  console.log(`mode     : ${MODE}${RESHAPE ? ' (with reshape)' : ''}`);
  console.log(`backfill : ${BATCH_SIZE ? `batched (${BATCH_SIZE} rows/statement)` : 'single statement'}`);

  if (env === 'production' || env === 'staging') {
    console.error(
      `\nREFUSING: this database is stamped "${env}". This rehearsal is destructive and ` +
        'is only for disposable clones. Use scripts/cid-child-constraint-cutover.mjs instead.'
    );
    process.exit(1);
  }

  const tables = await presentTables(client, CHILD_TABLES);

  console.log('\n── current shape ─────────────────────────────────────────────');
  await reportShape(client, tables);

  if (!CONFIRM) {
    console.log('\nDRY RUN — pass CONFIRM=1 to execute the rehearsal.');
    await client.end();
    process.exit(0);
  }

  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('SET statement_timeout = 0');

  if (RESHAPE) await reshape(client, tables);

  if (RESHAPE_ONLY) {
    console.log('\nRESHAPE_ONLY=1 — target left in the pre-Phase-3D shape.');
    console.log('Exercise the operator tool against it:');
    console.log('  STAGE=backfill CONFIRM=1 node scripts/cid-child-constraint-cutover.mjs');
    console.log('  STAGE=constraints CONFIRM=1 node scripts/cid-child-constraint-cutover.mjs');
    await client.end();
    process.exit(0);
  }

  const timer = createTimer();

  console.log('\n── phase 1: company_id backfill ──────────────────────────────');
  for (const { table } of tables) {
    await timer.timed(`${table}: backfill company_id`, () => backfill(client, table, BATCH_SIZE));
  }

  console.log('\n── phase 2: verify no residual NULL company_id ───────────────');
  let blocked = false;
  for (const { table } of tables) {
    const st = await stats(client, table);
    if (Number(st.null_cid) > 0) {
      console.log(`  BLOCKED ${table}: ${st.null_cid} rows still NULL — NOT NULL would fail`);
      blocked = true;
    }
  }
  if (blocked) {
    console.error('\nresidual NULL company_id — resolve before constraint migration');
    await client.end();
    process.exit(1);
  }
  console.log('  all target tables fully owned by company_id');

  console.log(`\n── phase 3: constraint migration (${MODE}) ────────────────────`);
  for (const entry of tables) {
    if (MODE === 'naive') await migrateNaive(client, entry, timer);
    else await migrateSafe(client, entry, timer);
  }

  console.log('\n── final shape ───────────────────────────────────────────────');
  for (const { table } of tables) {
    const s = await shape(client, table);
    console.log(`  ${table.padEnd(26)} nullable=${s.nullable} fks=${s.fks} uniques=${s.uniques}`);
  }

  const { total, slowest } = timer.summary();
  console.log('\n── summary ───────────────────────────────────────────────────');
  console.log(`mode           : ${MODE}`);
  console.log(`backfill       : ${BATCH_SIZE ? `batched ${BATCH_SIZE}` : 'single statement'}`);
  console.log(`steps          : ${timer.timings.length}`);
  console.log(`total          : ${(total / 1000).toFixed(2)} s`);
  const ddl = timer.timings.filter((t) => !t.label.includes('backfill'));
  const ddlTotal = ddl.reduce((s, t) => s + t.ms, 0);
  const worstDdl = Math.max(...ddl.map((t) => t.ms));
  console.log(`DDL total      : ${(ddlTotal / 1000).toFixed(2)} s (slowest single step ${worstDdl.toFixed(0)} ms)`);
  console.log('slowest steps  :');
  for (const t of slowest) console.log(`  ${t.ms.toFixed(0).padStart(7)} ms  ${t.label}`);

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
