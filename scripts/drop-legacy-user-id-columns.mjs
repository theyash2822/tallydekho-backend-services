#!/usr/bin/env node
/**
 * Deployment B of migrations/prep-drop-legacy-user-id.md — remove
 * companies.user_id and devices.user_id.
 *
 * Ownership moved to the workspace: a company belongs to companies.workspace_id
 * and a Desktop to its workspace binding. These two columns are what the old
 * single-user model used for authorization, and leaving them in place invites a
 * future query to reach for them again.
 *
 * Refuses to run while any row still carries a value, because a non-null column
 * means something is still writing it and the stop-write step is not finished.
 *
 * Inspect-only by default; CONFIRM=1 applies, inside one transaction.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/drop-legacy-user-id-columns.mjs
 *   DATABASE_URL=... CONFIRM=1 node scripts/drop-legacy-user-id-columns.mjs
 */
import 'dotenv/config';
import { query, getClient } from '../src/db/schema.js';

const CONFIRM = process.env.CONFIRM === '1';
const TARGETS = [
  ['companies', 'user_id'],
  ['devices', 'user_id'],
];

async function columnExists(table, column) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows.length > 0;
}

async function main() {
  const present = [];
  for (const [table, column] of TARGETS) {
    if (!(await columnExists(table, column))) {
      console.log(`${table}.${column}: already dropped`);
      continue;
    }
    const { rows } = await query(
      `SELECT count(*)::int AS total, count(${column})::int AS non_null FROM ${table}`
    );
    console.log(`${table}.${column}: rows=${rows[0].total} non_null=${rows[0].non_null}`);
    present.push({ table, column, nonNull: rows[0].non_null });
  }

  if (!present.length) {
    console.log('\nnothing to do');
    process.exit(0);
  }

  const blocking = present.filter((p) => p.nonNull > 0);
  if (blocking.length) {
    console.error('\nREFUSING: still populated — finish the stop-write step first:');
    for (const b of blocking) console.error(`  ${b.table}.${b.column} has ${b.nonNull} non-null rows`);
    process.exit(3);
  }

  console.log(`\nmode: ${CONFIRM ? 'DROP (CONFIRM=1)' : 'INSPECT ONLY'}`);
  if (!CONFIRM) {
    console.log('inspect only — re-run with CONFIRM=1 to drop');
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('DROP INDEX IF EXISTS idx_companies_user');
    for (const { table, column } of present) {
      await client.query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  let remaining = 0;
  for (const [table, column] of TARGETS) {
    if (await columnExists(table, column)) {
      console.error(`still present: ${table}.${column}`);
      remaining += 1;
    }
  }
  console.log(remaining ? '\nincomplete' : '\ndropped: companies.user_id, devices.user_id');
  process.exit(remaining ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
