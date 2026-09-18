#!/usr/bin/env node
/**
 * Company Identity orphan remediation (local / staging — never production without approval).
 *
 * Post-3E ownership rules:
 * - Internal ownership is `company_id`. `company_guid` is external Tally identity and is
 *   only unique per workspace, so an orphan is defined by MISSING INTERNAL OWNER,
 *   not by "no companies row with this guid".
 * - A NULL company_id may only be resolved with tenant context
 *   (row workspace_id, or device_id → devices.workspace_id). Never guid alone.
 * - Never invent ownership: unresolvable rows are either disposable (deleted) or
 *   escalated for manual review.
 *
 * Actions:
 *   ingest_uploads → backfill company_id from device workspace + guid;
 *                    delete unresolvable non-complete/complete upload records (disposable).
 *   warehouses     → delete rows with no resolvable internal owner (disposable projection).
 *
 * Usage:
 *   DRY_RUN=1 node scripts/remediate-company-identity-orphans.mjs
 *   node scripts/remediate-company-identity-orphans.mjs
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const DRY = process.env.DRY_RUN === '1';

/** Rows whose company_id points at a company that no longer exists. */
async function danglingOwner(table) {
  const { rows } = await query(`
    SELECT COUNT(*)::int AS c FROM ${table} t
    WHERE t.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.company_id)
  `);
  return rows[0].c;
}

async function main() {
  // ── 1. ingest_uploads: resolvable via device workspace ────────────────────
  const { rows: iuResolvable } = await query(`
    SELECT t.id, c.id AS resolved_company_id
    FROM ingest_uploads t
    JOIN devices d ON d.device_id = t.device_id
    JOIN companies c ON c.guid = t.company_guid AND c.workspace_id = d.workspace_id
    WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
  `);

  const { rows: iuUnresolvable } = await query(`
    SELECT t.id, t.status, t.company_guid
    FROM ingest_uploads t
    WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM devices d
        JOIN companies c ON c.guid = t.company_guid AND c.workspace_id = d.workspace_id
        WHERE d.device_id = t.device_id
      )
  `);

  // ── 2. warehouses: no internal owner and not workspace-resolvable ─────────
  const { rows: whOrphan } = await query(`
    SELECT t.id, t.company_guid, t.name
    FROM warehouses t
    WHERE t.company_id IS NULL
      AND (
        t.company_guid IS NULL
        OR (SELECT COUNT(*) FROM companies c WHERE c.guid = t.company_guid) = 0
      )
  `);

  // ── 3. warehouses with an ambiguous guid and no owner → manual review ─────
  const { rows: whAmbiguous } = await query(`
    SELECT COUNT(*)::int AS c FROM warehouses t
    WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
      AND (SELECT COUNT(*) FROM companies c WHERE c.guid = t.company_guid) > 1
  `);

  console.log(
    `ingest_uploads: backfillable=${iuResolvable.length} unresolvable=${iuUnresolvable.length}`
  );
  console.log(`warehouses: orphan=${whOrphan.length} ambiguous_no_owner=${whAmbiguous[0].c}`);

  for (const table of ['ingest_uploads', 'warehouses', 'ledgers', 'vouchers', 'stocks']) {
    const c = await danglingOwner(table);
    console.log(`dangling company_id ${table}=${c}`);
    if (c > 0) {
      console.error(`FAIL: ${table} has company_id values with no companies row — manual review`);
      process.exit(2);
    }
  }

  if (whAmbiguous[0].c > 0) {
    console.error('FAIL: warehouses with duplicate external GUID and no company_id — manual review');
    process.exit(2);
  }

  if (DRY) {
    console.log('DRY_RUN — no writes');
    process.exit(0);
  }

  if (iuResolvable.length) {
    const { rowCount } = await query(
      `UPDATE ingest_uploads t
         SET company_id = c.id
        FROM devices d, companies c
       WHERE d.device_id = t.device_id
         AND c.guid = t.company_guid
         AND c.workspace_id = d.workspace_id
         AND t.company_id IS NULL
         AND t.company_guid IS NOT NULL`
    );
    console.log(`backfilled ingest_uploads.company_id=${rowCount}`);
  }

  if (iuUnresolvable.length) {
    const ids = iuUnresolvable.map((r) => r.id);
    const { rowCount } = await query(
      `DELETE FROM ingest_uploads WHERE id = ANY($1::text[])`,
      [ids]
    );
    console.log(`deleted unresolvable ingest_uploads=${rowCount}`);
  }

  if (whOrphan.length) {
    const ids = whOrphan.map((r) => r.id);
    const { rowCount } = await query(
      `DELETE FROM warehouses WHERE id = ANY($1::int[])`,
      [ids]
    );
    console.log(`deleted orphan warehouses=${rowCount}`);
  }

  // ── Post-check: no business table may hold a row without an internal owner ─
  let remaining = 0;
  for (const table of ['warehouses', 'ledgers', 'vouchers', 'stocks']) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS c FROM ${table} WHERE company_id IS NULL`
    );
    console.log(`post ${table} company_id NULL=${rows[0].c}`);
    remaining += rows[0].c;
  }
  const { rows: iuLeft } = await query(
    `SELECT COUNT(*)::int AS c FROM ingest_uploads
     WHERE company_id IS NULL AND company_guid IS NOT NULL`
  );
  console.log(`post ingest_uploads unowned-with-guid=${iuLeft[0].c}`);
  remaining += iuLeft[0].c;

  if (remaining > 0) {
    console.error(`FAIL remaining rows without internal owner=${remaining}`);
    process.exit(2);
  }
  console.log('orphan remediation OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
