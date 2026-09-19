#!/usr/bin/env node
/**
 * Apply the referential and uniqueness guarantees in src/db/integrityConstraints.js
 * to a controlled environment, and report on the one table with no readers.
 *
 * Boot convergence applies the same list, so this exists for environments where
 * schema change is a reviewed step rather than a side effect of starting up.
 *
 * Inspect-only by default.
 *   CONFIRM=1           apply constraints, indexes and NOT NULLs
 *   DROP_DEAD_TABLES=1  additionally drop tax_ledger_rules, after writing its
 *                       rows to /tmp so the data is recoverable
 *
 * Usage:
 *   DATABASE_URL=... node scripts/schema-integrity-hardening.mjs
 *   DATABASE_URL=... CONFIRM=1 node scripts/schema-integrity-hardening.mjs
 */
import 'dotenv/config';
import fs from 'node:fs';
import { query, getClient } from '../src/db/schema.js';
import {
  FOREIGN_KEYS,
  COMPOSITE_FOREIGN_KEYS,
  UNIQUE_INDEXES,
  LOOKUP_INDEXES,
  REDUNDANT_INDEXES,
  NOT_NULL_COLUMNS,
  STATUS_CHECKS,
  applyIntegrityConstraints,
} from '../src/db/integrityConstraints.js';

const CONFIRM = process.env.CONFIRM === '1';
const DROP_DEAD_TABLES = process.env.DROP_DEAD_TABLES === '1';

/** Zero references anywhere in the repository; 28 rows of rules nothing reads. */
const DEAD_TABLES = ['tax_ledger_rules'];

async function count(sql, params = []) {
  const { rows } = await query(sql, params);
  return Number(rows[0]?.n || 0);
}

async function tableExists(name) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name]
  );
  return rows.length > 0;
}

async function reportPreconditions() {
  console.log('preconditions');

  for (const [name, table, column, references] of FOREIGN_KEYS) {
    if (!(await tableExists(table))) {
      console.log(`  ${name}: table ${table} absent`);
      continue;
    }
    const target = references.split(' ')[0];
    const dangling = await count(
      `SELECT count(*)::int AS n FROM ${table} t
        WHERE t.${column} IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM ${target} p WHERE p.id = t.${column})`
    );
    console.log(`  ${name}: dangling rows = ${dangling}${dangling ? '  ← blocks the FK' : ''}`);
  }

  for (const fk of COMPOSITE_FOREIGN_KEYS) {
    if (!(await tableExists(fk.table))) continue;
    const { rows } = await query(fk.orphanSql);
    console.log(`  ${fk.name}: rows with no parent voucher = ${rows[0].n}${rows[0].n ? '  ← blocks the FK' : ''}`);
  }

  for (const [name, table, columns, where] of UNIQUE_INDEXES) {
    if (!(await tableExists(table))) continue;
    const col = columns.replace(/[()]/g, '');
    const dupes = await count(
      `SELECT count(*)::int AS n FROM (
         SELECT ${col} FROM ${table} WHERE ${where} GROUP BY ${col} HAVING count(*) > 1
       ) d`
    );
    console.log(`  ${name}: duplicate values = ${dupes}${dupes ? '  ← blocks the unique index' : ''}`);
  }

  for (const [table, column] of NOT_NULL_COLUMNS) {
    if (!(await tableExists(table))) continue;
    const nulls = await count(`SELECT count(*)::int AS n FROM ${table} WHERE ${column} IS NULL`);
    console.log(`  ${table}.${column}: NULL rows = ${nulls}${nulls ? '  ← blocks NOT NULL' : ''}`);
  }

  for (const [name, table, column, values] of STATUS_CHECKS) {
    if (!(await tableExists(table))) continue;
    const { rows } = await query(
      `SELECT DISTINCT ${column} AS v FROM ${table}
        WHERE ${column} IS NOT NULL AND ${column} <> ALL($1::text[])`,
      [values]
    );
    const unknown = rows.map((r) => r.v);
    console.log(
      `  ${name}: values outside the vocabulary = ${unknown.length}` +
        (unknown.length ? ` (${unknown.join(', ')})  ← blocks the CHECK` : '')
    );
  }

  console.log('\ndead tables');
  for (const table of DEAD_TABLES) {
    if (!(await tableExists(table))) {
      console.log(`  ${table}: already dropped`);
      continue;
    }
    const rows = await count(`SELECT count(*)::int AS n FROM ${table}`);
    console.log(`  ${table}: ${rows} rows, zero references in src/ scripts/ or tests`);
  }

  console.log(`\nwill also drop redundant index: ${REDUNDANT_INDEXES.join(', ')}`);
  console.log(`will ensure lookup indexes: ${LOOKUP_INDEXES.map((i) => i[0]).join(', ')}`);
}

async function dropDeadTables(client) {
  for (const table of DEAD_TABLES) {
    if (!(await tableExists(table))) continue;
    const { rows } = await client.query(`SELECT * FROM ${table}`);
    const dump = `/tmp/td-dead-table-${table}-${Date.now()}.json`;
    fs.writeFileSync(dump, JSON.stringify(rows, null, 2));
    await client.query(`DROP TABLE ${table}`);
    console.log(`  dropped ${table} (${rows.length} rows saved to ${dump})`);
  }
}

async function main() {
  await reportPreconditions();

  console.log(`\nmode: ${CONFIRM ? 'APPLY (CONFIRM=1)' : 'INSPECT ONLY'}`);
  if (!CONFIRM) {
    console.log('inspect only — re-run with CONFIRM=1 to apply');
    console.log('add DROP_DEAD_TABLES=1 to also drop the tables listed above');
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');
    console.log('\nchanges');
    await applyIntegrityConstraints(client, (line) => console.log(`  ${line}`));
    if (DROP_DEAD_TABLES) await dropDeadTables(client);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  const applied = await count(
    `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = ANY($1::text[])`,
    [FOREIGN_KEYS.map((f) => f[0])]
  );
  console.log(`\nforeign keys present: ${applied}/${FOREIGN_KEYS.length}`);
  process.exit(applied === FOREIGN_KEYS.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
