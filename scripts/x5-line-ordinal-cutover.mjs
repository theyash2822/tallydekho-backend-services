#!/usr/bin/env node
/**
 * R2 / X5 — repeated stock lines: content keys → line-ordinal keys.
 *
 *   stock_transactions       UNIQUE (company_id, stock_guid, voucher_guid, warehouse, type)
 *                         →  UNIQUE (…, line_ordinal)
 *   voucher_inventory_items  UNIQUE (company_id, voucher_guid, stock_item_name, godown_name, batch_name)
 *                         →  UNIQUE (…, line_ordinal)
 *
 * Every existing row has line_ordinal 0, so the new keys cannot collide. Lines merged in the
 * past cannot be split here: they are corrected when their voucher is next synced by a
 * desktop that sends line ordinals. Restart the backend afterwards so ingest switches mode.
 *
 * Usage:
 *   node scripts/x5-line-ordinal-cutover.mjs            # preflight only (default)
 *   CONFIRM=1 node scripts/x5-line-ordinal-cutover.mjs  # apply in one transaction
 *
 * Env:
 *   CONFIRM=1             apply (otherwise preflight only)
 *   LOCK_TIMEOUT_MS=5000  fail fast instead of queueing behind long transactions
 *   ALLOW_PRODUCTION=1    required if NODE_ENV=production
 */
import 'dotenv/config';
import { getClient, query } from '../src/db/schema.js';
import { applyLineOrdinalCutover, lineOrdinalCutoverComplete, lineOrdinalPreflight } from '../src/db/lineOrdinalSchema.js';

const CONFIRM = process.env.CONFIRM === '1';
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION !== '1') {
    throw new Error('NODE_ENV=production: set ALLOW_PRODUCTION=1 after a verified backup');
  }
  const q = (t, p) => query(t, p);
  if (await lineOrdinalCutoverComplete(q)) {
    console.log('[X5] already applied — nothing to do');
    return;
  }
  console.log('[X5] preflight', JSON.stringify(await lineOrdinalPreflight(q)));
  if (!CONFIRM) {
    console.log('[X5] dry run: set CONFIRM=1 to apply');
    return;
  }
  const client = await getClient();
  const started = process.hrtime.bigint();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = ${Math.max(100, LOCK_TIMEOUT_MS)}`);
    await applyLineOrdinalCutover(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log(`[X5] applied in ${Math.round(Number(process.hrtime.bigint() - started) / 1e6)}ms — restart the backend`);
  console.log('[X5] after', JSON.stringify(await lineOrdinalPreflight(q)), 'complete:', await lineOrdinalCutoverComplete(q));
}

main().then(() => process.exit(0), (err) => {
  console.error('[X5] failed:', err.message);
  process.exit(1);
});
