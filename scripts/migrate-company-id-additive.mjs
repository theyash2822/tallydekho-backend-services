#!/usr/bin/env node
/**
 * Company Identity Phase 2 — additive company_id backfill (local/staging).
 * Deterministic while UNIQUE(companies.guid) holds.
 *
 * Usage:
 *   DRY_RUN=1 node scripts/migrate-company-id-additive.mjs
 *   node scripts/migrate-company-id-additive.mjs
 *
 * Does NOT run in production unless operator explicitly sets DATABASE_URL
 * and coordinates with RBAC ops-tail closeout.
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const DRY = process.env.DRY_RUN === '1';

const TABLES = [
  'ai_insights_cache', 'app_masters', 'app_vouchers', 'barcode_generate_jobs', 'barcode_import_jobs',
  'batch_allocations', 'bill_outstanding', 'company_compliance_config', 'company_inventory_settings',
  'company_print_profile', 'company_years', 'cost_centres', 'currencies', 'e_invoice_details',
  'e_way_bill_details', 'financial_year_summaries', 'groups', 'gst_voucher_details', 'ingest_uploads',
  'integrations', 'inventory_barcode_settings', 'invoice_pdf_versions', 'kpi_ar_ap_snapshots',
  'kpi_loans_snapshots', 'ledger_fy_balances', 'ledgers', 'member_company_access',
  'payment_mode_posting_map', 'raw_tally_records', 'stock_adjustments', 'stock_barcodes',
  'stock_categories', 'stock_fy_valuation', 'stock_transactions', 'stocks', 'sync_log', 'sync_runs',
  'tally_country_master', 'tally_state_master', 'tax_transactions', 'tdk_reference_counters',
  'units', 'voucher_inventory_items', 'voucher_items', 'voucher_ledger_entries', 'voucher_line_taxes',
  'voucher_types', 'vouchers', 'warehouses', 'write_queue',
];

async function ensureColumns() {
  await query(`CREATE INDEX IF NOT EXISTS idx_companies_workspace ON companies (workspace_id)`);
  for (const table of TABLES) {
    await query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS company_id BIGINT`).catch(() => {});
    await query(`CREATE INDEX IF NOT EXISTS idx_${table}_company_id ON ${table} (company_id)`).catch(() => {});
  }
}

async function backfillTable(table) {
  const countSql = `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE company_guid IS NOT NULL)::int AS with_guid,
      COUNT(*) FILTER (WHERE company_id IS NOT NULL)::int AS already,
      COUNT(*) FILTER (
        WHERE company_guid IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.guid = ${table}.company_guid)
      )::int AS orphans
    FROM ${table}
  `;
  const { rows: pre } = await query(countSql);
  const stats = pre[0];
  if (DRY) {
    return { table, ...stats, updated: 0, dry: true };
  }
  const { rowCount } = await query(`
    UPDATE ${table} t
    SET company_id = c.id
    FROM companies c
    WHERE t.company_guid = c.guid
      AND (t.company_id IS NULL OR t.company_id IS DISTINCT FROM c.id)
  `);
  const { rows: post } = await query(countSql);
  return { table, ...post[0], updated: rowCount || 0, dry: false, orphans_pre: stats.orphans };
}

async function main() {
  console.log(DRY ? 'DRY_RUN=1 — no writes' : 'APPLYING backfill');
  await ensureColumns();
  const results = [];
  let businessOrphans = 0;
  const business = new Set([
    'ledgers', 'vouchers', 'voucher_items', 'voucher_ledger_entries', 'stocks', 'stock_transactions',
    'warehouses', 'groups', 'units', 'currencies', 'voucher_types', 'cost_centres', 'company_years',
  ]);
  for (const table of TABLES) {
    try {
      const r = await backfillTable(table);
      results.push(r);
      if (business.has(table) && (r.orphans_pre ?? r.orphans) > 0) {
        businessOrphans += r.orphans_pre ?? r.orphans;
      }
      console.log(
        `${table}: total=${r.total} already=${r.already} orphans=${r.orphans_pre ?? r.orphans} updated=${r.updated}`
      );
    } catch (e) {
      console.warn(`${table}: SKIP ${e.message}`);
      results.push({ table, error: e.message });
    }
  }
  if (businessOrphans > 0 && process.env.ALLOW_ORPHANS !== '1') {
    console.error(`FAIL: business-child orphans=${businessOrphans}. Set ALLOW_ORPHANS=1 to proceed after review.`);
    process.exit(2);
  }
  console.log('DONE', results.length, 'tables');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
