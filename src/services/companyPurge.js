/**
 * Hard-sync rebuild: purge Tally projection data for a company GUID.
 * Keeps the companies row + app-layer tables (write_queue, app_vouchers, settings).
 * Normal sync must NEVER call this.
 */
import { getClient } from '../db/schema.js';

/** Tables that store synced Tally projection data (delete order: children → parents). */
const TALLY_PROJECTION_TABLES = [
  'voucher_ledger_entries',
  'voucher_inventory_items',
  'voucher_items',
  'batch_allocations',
  'gst_voucher_details',
  'bill_outstanding',
  'tax_transactions',
  'e_invoice_details',
  'e_way_bill_details',
  'stock_transactions',
  'vouchers',
  'ledger_fy_balances',
  'ledgers',
  'stock_fy_valuation',
  'stocks',
  'groups',
  'warehouses',
  'units',
  'currencies',
  'voucher_types',
  'stock_categories',
  'company_years',
  'raw_tally_records',
  'financial_year_summaries',
  'ai_insights_cache',
  // Intentionally NOT purged (app-layer / settings):
  // stock_barcodes, barcode_import_jobs, write_queue, app_vouchers,
  // company_inventory_settings, inventory_barcode_settings, companies
];

/**
 * @param {string} companyGuid
 * @returns {Promise<{ companyGuid: string, deleted: Record<string, number> }>}
 */
export async function purgeCompanyTallyData(companyGuid) {
  if (!companyGuid || typeof companyGuid !== 'string') {
    throw new Error('companyGuid required');
  }

  const client = await getClient();
  const deleted = {};

  try {
    await client.query('BEGIN');

    for (const table of TALLY_PROJECTION_TABLES) {
      try {
        const res = await client.query(
          `DELETE FROM ${table} WHERE company_guid = $1`,
          [companyGuid]
        );
        deleted[table] = res.rowCount || 0;
      } catch (err) {
        // Table may not exist on older DBs — skip, don't abort rebuild
        if (err.code === '42P01') {
          deleted[table] = 0;
          continue;
        }
        throw err;
      }
    }

    await client.query('COMMIT');
    console.log(`[PURGE] Hard-sync rebuild wiped tally data for ${companyGuid}`, deleted);
    return { companyGuid, deleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[PURGE] Failed for ${companyGuid}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Purge multiple selected companies (hard sync only).
 * @param {string[]} companyGuids
 */
export async function purgeCompaniesForHardSync(companyGuids) {
  const guids = [...new Set((companyGuids || []).filter(Boolean))];
  const results = [];
  for (const guid of guids) {
    results.push(await purgeCompanyTallyData(guid));
  }
  return results;
}
