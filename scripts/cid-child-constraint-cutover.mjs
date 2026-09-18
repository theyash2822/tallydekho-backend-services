#!/usr/bin/env node
/**
 * Company Identity — child ownership cutover (OPERATOR TOOL).
 *
 * Brings child tables to "company_id NOT NULL + FK RESTRICT + composite UNIQUE"
 * using the pattern measured by scripts/cid-child-constraint-rehearsal.mjs.
 * Forward only — it cannot null out or drop anything.
 *
 * Two separable stages, because they have very different risk profiles:
 *
 *   STAGE=backfill   data change, minutes, ONLINE. Short batched statements, safe
 *                    to run days before the window; idempotent and resumable.
 *   STAGE=constraints  DDL, seconds. Scans run under SHARE UPDATE EXCLUSIVE
 *                    (reads and writes continue); only metadata changes take a
 *                    brief exclusive lock.
 *
 * Usage:
 *   DATABASE_URL=... STAGE=backfill CONFIRM=1 node scripts/cid-child-constraint-cutover.mjs
 *   DATABASE_URL=... STAGE=constraints CONFIRM=1 node scripts/cid-child-constraint-cutover.mjs
 *
 *   BATCH_SIZE       rows per backfill statement (default 5000)
 *   LOCK_TIMEOUT_MS  default 5000 — fail fast rather than queue behind a lock
 *   TABLES           comma-separated subset, e.g. TABLES=vouchers,ledgers
 *
 * Without CONFIRM=1 this is a read-only report. Never run it as part of a deploy.
 */
import 'dotenv/config';
import pg from 'pg';
import {
  CHILD_TABLES,
  backfill,
  createTimer,
  deploymentEnv,
  migrateSafe,
  presentTables,
  reportLockBlockers,
  reportShape,
  shape,
  stats,
} from './lib/cidChildMigration.mjs';

const { Client } = pg;

const STAGE = (process.env.STAGE || 'report').toLowerCase();
const CONFIRM = process.env.CONFIRM === '1';
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5000);
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);
const ONLY = (process.env.TABLES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (!['report', 'backfill', 'constraints'].includes(STAGE)) {
  console.error(`STAGE must be report, backfill or constraints (got ${STAGE})`);
  process.exit(1);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required — never guess the target database');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: info } = await client.query(
    'SELECT current_database() AS db, version() AS v, pg_size_pretty(pg_database_size(current_database())) AS size'
  );
  console.log(`database : ${info[0].db} (${info[0].size})`);
  console.log(`postgres : ${info[0].v.split(' ').slice(0, 2).join(' ')}`);
  console.log(`db stamp : ${await deploymentEnv(client)}`);
  console.log(`stage    : ${STAGE}${CONFIRM ? '' : ' (dry run)'}`);

  let tables = await presentTables(client, CHILD_TABLES);
  if (ONLY.length) tables = tables.filter((t) => ONLY.includes(t.table));
  if (!tables.length) {
    console.error('no target tables selected');
    process.exit(1);
  }

  console.log('\n── current shape ─────────────────────────────────────────────');
  await reportShape(client, tables);

  const pending = [];
  for (const entry of tables) {
    const st = await stats(client, entry.table);
    const sh = await shape(client, entry.table);
    if (Number(st.null_cid) > 0) pending.push({ ...entry, nulls: Number(st.null_cid) });
    else if (sh.nullable === 'YES' || Number(sh.fks) === 0) pending.push({ ...entry, nulls: 0 });
  }

  if (!pending.length) {
    console.log('\nnothing to do — every target table is already NOT NULL with an FK');
    await client.end();
    process.exit(0);
  }

  console.log('\n── pending ───────────────────────────────────────────────────');
  for (const p of pending) {
    console.log(`  ${p.table.padEnd(26)} null company_id=${p.nulls}`);
  }

  if (STAGE === 'report' || !CONFIRM) {
    console.log('\nDRY RUN — set STAGE=backfill or STAGE=constraints with CONFIRM=1 to execute.');
    await client.end();
    process.exit(0);
  }

  const timer = createTimer();

  if (STAGE === 'backfill') {
    console.log(`\n── backfill company_id (batched ${BATCH_SIZE}, online) ───────`);
    // Deliberately no lock_timeout change: these are ordinary short UPDATEs.
    await client.query('SET statement_timeout = 0');
    for (const entry of pending) {
      const res = await timer.timed(`${entry.table}: backfill`, () =>
        backfill(client, entry.table, BATCH_SIZE)
      );
      console.log(`             rows=${res.rowCount}${res.batches ? ` batches=${res.batches}` : ''}`);
    }

    console.log('\n── remaining NULL company_id ─────────────────────────────────');
    let residual = 0;
    for (const { table } of pending) {
      const st = await stats(client, table);
      if (Number(st.null_cid) > 0) {
        console.log(`  ${table}: ${st.null_cid} rows still NULL`);
        residual += Number(st.null_cid);
      }
    }
    const { total } = timer.summary();
    console.log(`\nbackfill total: ${(total / 1000).toFixed(2)} s`);
    if (residual > 0) {
      console.error(
        `\n${residual} row(s) could not be resolved to a company. Run the orphan ` +
          'remediation and strict verifier before the constraint stage:\n' +
          '  node scripts/remediate-company-identity-orphans.mjs\n' +
          '  node scripts/verify-company-id-backfill.mjs'
      );
      await client.end();
      process.exit(1);
    }
    console.log('all target tables fully owned by company_id — constraint stage can proceed');
    await client.end();
    process.exit(0);
  }

  // STAGE=constraints
  console.log('\n── lock blockers ─────────────────────────────────────────────');
  await reportLockBlockers(client, 30);

  for (const { table } of pending) {
    const st = await stats(client, table);
    if (Number(st.null_cid) > 0) {
      console.error(
        `\nREFUSING: ${table} still has ${st.null_cid} NULL company_id rows. ` +
          'Run STAGE=backfill first.'
      );
      await client.end();
      process.exit(1);
    }
  }

  console.log(`\n── constraint migration (lock_timeout=${LOCK_TIMEOUT_MS}ms) ────`);
  // CREATE INDEX CONCURRENTLY cannot run inside a transaction block, so each
  // statement is autocommitted. Every step is individually idempotent-safe to
  // retry after a lock timeout.
  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('SET statement_timeout = 0');

  for (const entry of pending) {
    try {
      await migrateSafe(client, entry, timer);
    } catch (err) {
      console.error(`\nFAILED on ${entry.table}: ${err.message}`);
      if (/lock timeout|canceling statement due to lock timeout/i.test(err.message)) {
        console.error(
          'A concurrent transaction held the table. No partial state was committed for ' +
            'this step; resolve the blocker and re-run — completed tables are skipped.'
        );
      }
      await client.end();
      process.exit(1);
    }
  }

  console.log('\n── final shape ───────────────────────────────────────────────');
  for (const { table } of pending) {
    const s = await shape(client, table);
    console.log(`  ${table.padEnd(26)} nullable=${s.nullable} fks=${s.fks} uniques=${s.uniques}`);
  }

  const { total, slowest } = timer.summary();
  console.log('\n── summary ───────────────────────────────────────────────────');
  console.log(`DDL total      : ${(total / 1000).toFixed(2)} s`);
  console.log('slowest steps  :');
  for (const t of slowest) console.log(`  ${t.ms.toFixed(0).padStart(7)} ms  ${t.label}`);
  console.log('\nnext: node scripts/verify-company-id-backfill.mjs');

  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
