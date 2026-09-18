#!/usr/bin/env node
/**
 * Report table sizes and row counts so staging can be sized to match production.
 *
 * Reads metadata and COUNT(*) only — no business data ever leaves the database,
 * so the output is safe to paste into a runbook or issue.
 *
 *   DATABASE_URL=... node scripts/collect-table-sizes.mjs
 *   DATABASE_URL=... EXACT=0 node scripts/collect-table-sizes.mjs   # planner estimates, no scans
 *
 * EXACT=1 (default) runs COUNT(*) per table, which is accurate but scans.
 * On a busy production box prefer EXACT=0 first — the estimates are enough to
 * size staging, and it costs nothing.
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const exact = process.env.EXACT !== '0';

// Tables whose volume drives the child NOT NULL / FK migration timing.
const MIGRATION_CRITICAL = new Set([
  'voucher_ledger_entries',
  'vouchers',
  'batch_allocations',
  'stock_transactions',
  'voucher_inventory_items',
  'bill_outstanding',
  'ledgers',
  'stocks',
]);

/** Table names come from pg_class, but quote them anyway rather than trusting that. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function lpad(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

const client = new pg.Client({ connectionString: url });
await client.connect();

try {
  const { rows: meta } = await client.query(`
    SELECT current_database() AS db,
           pg_size_pretty(pg_database_size(current_database())) AS size,
           (SELECT setting FROM pg_settings WHERE name = 'server_version') AS version
  `);
  console.log(`database      : ${meta[0].db}`);
  console.log(`server version: ${meta[0].version}`);
  console.log(`total size    : ${meta[0].size}`);
  console.log(`row counts    : ${exact ? 'exact (COUNT(*))' : 'planner estimate'}`);

  const { rows: tables } = await client.query(`
    SELECT c.relname AS table,
           pg_total_relation_size(c.oid)                AS total_bytes,
           pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
           pg_size_pretty(pg_relation_size(c.oid))       AS heap,
           pg_size_pretty(pg_indexes_size(c.oid))        AS indexes,
           c.reltuples::bigint                           AS est_rows
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = 'public'
     ORDER BY pg_total_relation_size(c.oid) DESC
  `);

  const counts = new Map();
  if (exact) {
    for (const t of tables) {
      const { rows } = await client.query(
        `SELECT count(*)::bigint AS n FROM public.${quoteIdent(t.table)}`
      );
      counts.set(t.table, rows[0].n);
    }
  }

  const rowsOf = (t) => (exact ? counts.get(t.table) : t.est_rows);

  console.log(`\n${pad('table', 34)}${lpad('rows', 12)}${lpad('total', 10)}${lpad('heap', 10)}${lpad('indexes', 10)}`);
  console.log('-'.repeat(76));
  let shown = 0;
  for (const t of tables) {
    const critical = MIGRATION_CRITICAL.has(t.table);
    // Keep the report readable: everything material, plus every critical table.
    if (!critical && shown >= 30 && Number(t.total_bytes) < 1024 * 1024) continue;
    console.log(
      `${critical ? '*' : ' '}${pad(t.table, 33)}${lpad(rowsOf(t), 12)}` +
        `${lpad(t.total, 10)}${lpad(t.heap, 10)}${lpad(t.indexes, 10)}`
    );
    shown += 1;
  }
  console.log('\n* = drives child NOT NULL / FK migration timing');

  console.log('\n── migration-critical summary ─────────────────────────────');
  let missing = [];
  for (const name of MIGRATION_CRITICAL) {
    const t = tables.find((x) => x.table === name);
    if (!t) {
      missing.push(name);
      continue;
    }
    console.log(`  ${pad(name, 30)} ${lpad(rowsOf(t), 12)} rows  ${lpad(t.total, 10)}`);
  }
  if (missing.length) {
    console.log(`  absent in this database: ${missing.join(', ')}`);
  }

  console.log('\n── company_id readiness ───────────────────────────────────');
  for (const name of MIGRATION_CRITICAL) {
    const { rows: col } = await client.query(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'company_id'`,
      [name]
    );
    if (!col.length) {
      console.log(`  ${pad(name, 30)} no company_id column`);
      continue;
    }
    const { rows: nulls } = await client.query(
      `SELECT count(*)::bigint AS n FROM public.${name} WHERE company_id IS NULL`
    );
    console.log(
      `  ${pad(name, 30)} nullable=${pad(col[0].is_nullable, 4)} null company_id=${nulls[0].n}`
    );
  }
} finally {
  await client.end();
}
