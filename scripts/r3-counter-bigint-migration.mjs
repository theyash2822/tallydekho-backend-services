#!/usr/bin/env node
/**
 * R3 / 01 — widen Tally change-counter columns (alter_id) from INTEGER to BIGINT.
 *
 * Ingest keeps counters exact (src/utils/tallyCounters.js). INTEGER holds up to 2,147,483,647;
 * a larger counter fails its batch explicitly (it is never truncated). Run this only if the
 * supported Tally build is shown to emit larger counters. It rewrites each table, so run it
 * in a maintenance window after a verified backup.
 *
 *   node scripts/r3-counter-bigint-migration.mjs            # preflight (default): types + max values
 *   CONFIRM=1 node scripts/r3-counter-bigint-migration.mjs  # apply
 *   ALLOW_PRODUCTION=1 is required when NODE_ENV=production
 */
import 'dotenv/config';
import { getClient, query } from '../src/db/schema.js';

const CONFIRM = process.env.CONFIRM === '1';
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);

async function integerCounterColumns() {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND column_name = 'alter_id' AND data_type = 'integer'
      ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('NODE_ENV=production: set ALLOW_PRODUCTION=1 after a verified backup');
  }
  const tables = await integerCounterColumns();
  const report = [];
  for (const t of tables) {
    const { rows } = await query(`SELECT COUNT(*)::bigint AS n, COALESCE(MAX(alter_id), 0)::bigint AS max FROM ${t}`);
    report.push({ table: t, rows: Number(rows[0].n), maxAlterId: String(rows[0].max) });
  }
  console.log('[01] INTEGER alter_id columns', JSON.stringify(report));
  if (!tables.length) return console.log('[01] nothing to do');
  if (!CONFIRM) return console.log('[01] dry run: set CONFIRM=1 to apply');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${Math.max(100, LOCK_TIMEOUT_MS)}`);
    for (const t of tables) await client.query(`ALTER TABLE ${t} ALTER COLUMN alter_id TYPE BIGINT`);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log('[01] applied:', tables.join(', '));
}

main().then(() => process.exit(0), (err) => {
  console.error('[01] failed:', err.message);
  process.exit(1);
});
