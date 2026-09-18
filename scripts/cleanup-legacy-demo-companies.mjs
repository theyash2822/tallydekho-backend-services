#!/usr/bin/env node
/**
 * Remove the legacy per-workspace Demo companies.
 *
 * Demo used to be seeded once per workspace: 484 copies of the same fixture,
 * each with a GUID derived from its workspace id. The canonical model replaces
 * them with a single Demo company owned by the reserved system workspace, so
 * the old copies are dead weight — hidden from every UI, but still carrying tens
 * of thousands of voucher rows.
 *
 * Safety, in order of importance:
 *   - inspect-only by default; CONFIRM=1 is required to delete anything
 *   - a candidate must carry the legacy GUID scheme AND is_demo, and must NOT be
 *     the canonical company. Name is never a criterion: "Demo Traders" is a real
 *     company someone may have created in Tally
 *   - aborts if a candidate shows any sign of user-created data
 *   - deletes by company_id, never by Tally GUID, and inside one transaction
 *
 * Usage:
 *   DATABASE_URL=... node scripts/cleanup-legacy-demo-companies.mjs            # inspect
 *   DATABASE_URL=... CONFIRM=1 node scripts/cleanup-legacy-demo-companies.mjs  # delete
 */
import 'dotenv/config';
import { query, getClient } from '../src/db/schema.js';
import { CANONICAL_DEMO_GUID, SYSTEM_DEMO_WORKSPACE_ID } from '../src/services/demoDataService.js';

const CONFIRM = process.env.CONFIRM === '1';
const LEGACY_GUID_PREFIX = 'dddddddd-dddd-4ddd-8ddd-';

/** Every table carrying company_id, read from the live schema so it cannot drift. */
async function companyOwnedTables() {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'company_id' AND table_schema = 'public'
      ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

/**
 * Legacy demo companies: the reserved GUID prefix, flagged is_demo, and not the
 * canonical row. Both conditions are required — the prefix alone would also
 * match the canonical company, and is_demo alone would match it too.
 */
async function findCandidates() {
  const { rows } = await query(
    `SELECT id, guid, workspace_id, name
       FROM companies
      WHERE is_demo = TRUE
        AND guid LIKE $1 || '%'
        AND guid <> $2
      ORDER BY id`,
    [LEGACY_GUID_PREFIX, CANONICAL_DEMO_GUID]
  );
  return rows;
}

/**
 * Refuse to delete anything a user may have touched.
 *
 * The forensic audit found Demo was read-only and held zero write_queue rows,
 * but that was a snapshot. Re-prove it here rather than trusting it, because the
 * cost of being wrong is deleting someone's work.
 */
async function findUserData(ids) {
  if (!ids.length) return [];
  const problems = [];

  const { rows: wq } = await query(
    `SELECT company_id, count(*)::int AS n FROM write_queue
      WHERE company_id = ANY($1::bigint[]) GROUP BY company_id`,
    [ids]
  );
  for (const r of wq) problems.push(`company ${r.company_id}: ${r.n} write_queue rows`);

  const { rows: am } = await query(
    `SELECT company_id, count(*)::int AS n FROM app_masters
      WHERE company_id = ANY($1::bigint[]) GROUP BY company_id`,
    [ids]
  );
  for (const r of am) problems.push(`company ${r.company_id}: ${r.n} app_masters rows`);

  const { rows: av } = await query(
    `SELECT company_id, count(*)::int AS n FROM app_vouchers
      WHERE company_id = ANY($1::bigint[]) GROUP BY company_id`,
    [ids]
  );
  for (const r of av) problems.push(`company ${r.company_id}: ${r.n} app_vouchers rows`);

  // A legacy demo should never have been attached to a Desktop.
  const { rows: dev } = await query(
    `SELECT id, device_id FROM companies
      WHERE id = ANY($1::bigint[]) AND device_id IS NOT NULL`,
    [ids]
  );
  for (const r of dev) problems.push(`company ${r.id}: bound to device ${r.device_id}`);

  return problems;
}

async function main() {
  const tables = await companyOwnedTables();
  const candidates = await findCandidates();
  const ids = candidates.map((c) => Number(c.id));

  console.log(`mode              : ${CONFIRM ? 'DELETE (CONFIRM=1)' : 'INSPECT ONLY'}`);
  console.log(`company-owned tables discovered: ${tables.length}`);
  console.log(`legacy demo companies          : ${candidates.length}`);

  const { rows: canonical } = await query(
    `SELECT id, workspace_id FROM companies WHERE guid = $1 LIMIT 1`,
    [CANONICAL_DEMO_GUID]
  );
  console.log(
    `canonical demo                 : ${
      canonical[0] ? `id=${canonical[0].id} workspace=${canonical[0].workspace_id}` : 'NOT SEEDED YET'
    }`
  );

  if (!candidates.length) {
    console.log('\nnothing to remove.');
    process.exit(0);
  }

  // The canonical company must exist before the old ones go, or unpaired users
  // would have no Demo at all between the two steps.
  if (!canonical[0]) {
    console.error('\nREFUSING: canonical Demo company does not exist yet.');
    console.error('Seed it first, then re-run — otherwise unpaired users lose Demo entirely.');
    process.exit(2);
  }
  if (canonical[0].workspace_id !== SYSTEM_DEMO_WORKSPACE_ID) {
    console.error(`\nREFUSING: canonical Demo is owned by ${canonical[0].workspace_id}, expected ${SYSTEM_DEMO_WORKSPACE_ID}.`);
    process.exit(2);
  }

  console.log('\nrows that would be removed, by table:');
  let total = 0;
  for (const t of tables) {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM ${JSON.stringify(t).replace(/"/g, '"')} WHERE company_id = ANY($1::bigint[])`,
      [ids]
    );
    const n = rows[0].n;
    if (n > 0) {
      console.log(`  ${t.padEnd(34)} ${n}`);
      total += n;
    }
  }
  console.log(`  ${'companies'.padEnd(34)} ${candidates.length}`);
  console.log(`  total child rows: ${total}`);

  const problems = await findUserData(ids);
  if (problems.length) {
    console.error('\nREFUSING: candidates carry user-created data:');
    for (const p of problems.slice(0, 20)) console.error(`  ${p}`);
    console.error('\nNothing was deleted. Investigate these rows before cleanup.');
    process.exit(3);
  }
  console.log('\nuser-data check: clean (no write_queue, app_masters, app_vouchers or device binding)');

  if (!CONFIRM) {
    console.log('\ninspect only — re-run with CONFIRM=1 to delete');
    process.exit(0);
  }

  const realBefore = await query(`SELECT count(*)::int AS n FROM companies WHERE is_demo = FALSE`);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Children first, then the companies themselves. Deleting by company_id is
    // deliberate: keying on the Tally GUID would reach every workspace that
    // shares it, which is the bug class this codebase has already been bitten by.
    for (const t of tables) {
      await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::bigint[])`, [ids]);
    }
    await client.query(`DELETE FROM companies WHERE id = ANY($1::bigint[])`, [ids]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  const realAfter = await query(`SELECT count(*)::int AS n FROM companies WHERE is_demo = FALSE`);
  const remaining = await findCandidates();

  console.log('\ndeleted.');
  console.log(`legacy demo companies remaining: ${remaining.length}`);
  console.log(`real companies before/after    : ${realBefore.rows[0].n} / ${realAfter.rows[0].n}`);
  if (realBefore.rows[0].n !== realAfter.rows[0].n) {
    console.error('ALARM: real company count changed. Investigate immediately.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
