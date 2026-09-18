#!/usr/bin/env node
/**
 * Verify company_id ownership consistency (Company Identity Phase 3E+).
 *
 * Post-3E rules:
 *   - companies.guid is EXTERNAL Tally identity and is only unique per workspace.
 *     A resolvable NULL company_id must therefore be resolved workspace-scoped,
 *     never by `companies.guid = t.company_guid` alone.
 *   - A table without a company_guid column is fully migrated; that is a PASS
 *     condition, not a reason to skip the table.
 *   - Absent tables are reported as ABSENT (older DB) and counted.
 *   - Any unexpected query error FAILS the run — this script must never
 *     silently pass because a check could not execute.
 *
 * Exit non-zero on:
 *   - company_id pointing at a missing companies.id
 *   - company_id set but company_guid mismatch vs companies.guid
 *   - company_guid that resolves to more than one company while company_id IS NULL
 *   - (STRICT_NULL=1) workspace-resolvable rows still holding company_id NULL
 *   - any check error
 *
 * Usage:
 *   STRICT_NULL=1 node scripts/verify-company-id-backfill.mjs
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const STRICT_NULL = process.env.STRICT_NULL === '1';

/**
 * Tables carrying internal company ownership.
 * `via` describes how a NULL company_id may be resolved to ONE company:
 *   'workspace' → table has workspace_id
 *   'device'    → table has device_id → devices.workspace_id
 *   'upload'    → table has upload_id → ingest_uploads.device_id → devices.workspace_id
 *   'none'      → no tenant context on the row; guid alone is NOT authoritative
 */
const TABLES = [
  ['ai_insights_cache', 'none'], ['app_masters', 'none'], ['app_vouchers', 'none'],
  ['barcode_generate_jobs', 'none'], ['barcode_import_jobs', 'none'], ['batch_allocations', 'none'],
  ['bill_outstanding', 'none'], ['company_compliance_config', 'none'],
  ['company_inventory_settings', 'none'], ['company_print_profile', 'none'],
  ['company_years', 'none'], ['cost_centres', 'none'], ['currencies', 'none'],
  ['e_invoice_details', 'none'], ['e_way_bill_details', 'none'],
  ['financial_year_summaries', 'none'], ['groups', 'none'], ['gst_voucher_details', 'none'],
  ['ingest_uploads', 'device'], ['integrations', 'none'], ['inventory_barcode_settings', 'none'],
  ['invoice_pdf_versions', 'none'], ['kpi_ar_ap_snapshots', 'none'], ['kpi_loans_snapshots', 'none'],
  ['ledger_fy_balances', 'none'], ['ledgers', 'none'], ['member_company_access', 'none'],
  ['payment_mode_posting_map', 'workspace'], ['raw_tally_records', 'none'],
  ['stock_adjustments', 'none'], ['stock_barcodes', 'none'], ['stock_categories', 'none'],
  ['stock_fy_valuation', 'none'], ['stock_transactions', 'none'], ['stocks', 'none'],
  ['sync_log', 'device'], ['sync_runs', 'upload'], ['tally_country_master', 'none'],
  ['tally_state_master', 'none'], ['tax_transactions', 'none'], ['tdk_reference_counters', 'none'],
  ['units', 'none'], ['voucher_inventory_items', 'none'], ['voucher_items', 'none'],
  ['voucher_ledger_entries', 'none'], ['voucher_line_taxes', 'none'], ['voucher_types', 'none'],
  ['vouchers', 'none'], ['warehouses', 'none'], ['write_queue', 'workspace'],
];

async function columnsOf(table) {
  const { rows } = await query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

async function count(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0].c;
}

async function check(table, via, cols) {
  const issues = [];
  const hasGuid = cols.has('company_guid');

  issues.push(
    ...(await (async () => {
      const c = await count(`
        SELECT COUNT(*)::int AS c FROM ${table} t
        WHERE t.company_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.id = t.company_id)
      `);
      return c > 0 ? [`orphan_company_id=${c}`] : [];
    })())
  );

  if (hasGuid) {
    const mismatch = await count(`
      SELECT COUNT(*)::int AS c FROM ${table} t
      JOIN companies c ON c.id = t.company_id
      WHERE t.company_guid IS NOT NULL AND t.company_guid IS DISTINCT FROM c.guid
    `);
    if (mismatch > 0) issues.push(`guid_mismatch=${mismatch}`);

    // Duplicate external GUID + no internal owner and no tenant context to
    // disambiguate = unsafe to backfill by guid.
    const noTenantContext = {
      workspace: 'AND t.workspace_id IS NULL',
      device:
        'AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device_id = t.device_id AND d.workspace_id IS NOT NULL)',
      upload:
        `AND NOT EXISTS (
           SELECT 1 FROM ingest_uploads u
           JOIN devices d ON d.device_id = u.device_id
           WHERE u.id = t.upload_id AND d.workspace_id IS NOT NULL
         )`,
      none: '',
    }[via];
    const ambiguous = await count(`
      SELECT COUNT(*)::int AS c FROM ${table} t
      WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
        AND (SELECT COUNT(*) FROM companies c WHERE c.guid = t.company_guid) > 1
        ${noTenantContext}
    `);
    if (ambiguous > 0) issues.push(`ambiguous_guid_no_owner=${ambiguous}`);

    if (STRICT_NULL) {
      let resolvable;
      if (via === 'workspace') {
        resolvable = await count(`
          SELECT COUNT(*)::int AS c FROM ${table} t
          WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM companies c
              WHERE c.guid = t.company_guid AND c.workspace_id = t.workspace_id
            )
        `);
      } else if (via === 'device') {
        resolvable = await count(`
          SELECT COUNT(*)::int AS c FROM ${table} t
          JOIN devices d ON d.device_id = t.device_id
          WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM companies c
              WHERE c.guid = t.company_guid AND c.workspace_id = d.workspace_id
            )
        `);
      } else if (via === 'upload') {
        resolvable = await count(`
          SELECT COUNT(*)::int AS c FROM ${table} t
          JOIN ingest_uploads u ON u.id = t.upload_id
          JOIN devices d ON d.device_id = u.device_id
          WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM companies c
              WHERE c.guid = t.company_guid AND c.workspace_id = d.workspace_id
            )
        `);
      } else {
        // No tenant context: only an unambiguous single-company GUID is resolvable.
        resolvable = await count(`
          SELECT COUNT(*)::int AS c FROM ${table} t
          WHERE t.company_id IS NULL AND t.company_guid IS NOT NULL
            AND (SELECT COUNT(*) FROM companies c WHERE c.guid = t.company_guid) = 1
        `);
      }
      if (resolvable > 0) issues.push(`backfillable_null=${resolvable}`);
    }
  }

  return issues;
}

async function main() {
  let failed = 0;
  let absent = 0;
  let errored = 0;

  for (const [table, via] of TABLES) {
    const cols = await columnsOf(table);
    if (cols.size === 0) {
      absent += 1;
      console.log(`ABSENT ${table} (table not present in this database)`);
      continue;
    }
    if (!cols.has('company_id')) {
      failed += 1;
      console.error(`FAIL ${table}: company_id column missing`);
      continue;
    }
    try {
      const issues = await check(table, via, cols);
      if (issues.length) {
        failed += 1;
        console.error(`FAIL ${table}: ${issues.join(', ')}`);
      } else {
        console.log(`OK ${table}${cols.has('company_guid') ? '' : ' (company_guid retired)'}`);
      }
    } catch (e) {
      errored += 1;
      console.error(`ERROR ${table}: ${e.message}`);
    }
  }

  const wsNull = await count(
    `SELECT COUNT(*)::int AS c FROM companies WHERE workspace_id IS NULL`
  );
  console.log(`companies.workspace_id NULL rows: ${wsNull}`);
  if (wsNull > 0) failed += 1;

  const badWsFk = await count(`
    SELECT COUNT(*)::int AS c FROM companies c
    WHERE c.workspace_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = c.workspace_id)
  `);
  console.log(`companies.workspace_id dangling FK rows: ${badWsFk}`);
  if (badWsFk > 0) failed += 1;

  const dupWsGuid = await count(`
    SELECT COUNT(*)::int AS c FROM (
      SELECT workspace_id, guid FROM companies
      GROUP BY workspace_id, guid HAVING COUNT(*) > 1
    ) x
  `);
  console.log(`companies duplicate (workspace_id, guid) groups: ${dupWsGuid}`);
  if (dupWsGuid > 0) failed += 1;

  console.log(`summary: failed=${failed} errored=${errored} absent=${absent}`);
  if (failed || errored) {
    console.error('verify-company-id-backfill FAILED');
    process.exit(1);
  }
  console.log('verify-company-id-backfill OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
