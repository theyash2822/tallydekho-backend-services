/**
 * Hard-sync rebuild: purge Tally projection data for a company by internal id.
 * Keeps the companies row + app-layer tables (write_queue, app_vouchers, settings).
 * Normal sync must NEVER call this.
 *
 * Ownership is companies.id — never delete by company_guid alone (cross-tenant safe).
 */
import { getClient, query } from '../db/schema.js';

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
 * @param {number|string} companyId
 * @param {{ companyGuid?: string }} [meta]
 * @returns {Promise<{ companyId: number, companyGuid: string|null, deleted: Record<string, number> }>}
 */
export async function purgeCompanyTallyDataById(companyId, meta = {}) {
  const id = Number(companyId);
  if (!Number.isFinite(id)) {
    throw new Error('companyId required');
  }

  const client = await getClient();
  const deleted = {};
  const companyGuid = meta.companyGuid ?? null;

  try {
    await client.query('BEGIN');

    for (const table of TALLY_PROJECTION_TABLES) {
      try {
        const res = await client.query(
          `DELETE FROM ${table} WHERE company_id = $1`,
          [id]
        );
        deleted[table] = res.rowCount || 0;
      } catch (err) {
        // Table may not exist on older DBs — skip, don't abort rebuild
        if (err.code === '42P01') {
          deleted[table] = 0;
          continue;
        }
        // Column may be missing on transitional tables — skip
        if (err.code === '42703') {
          deleted[table] = 0;
          continue;
        }
        throw err;
      }
    }

    await client.query('COMMIT');
    console.log(`[PURGE] Hard-sync rebuild wiped tally data for company_id=${id}`, deleted);
    return { companyId: id, companyGuid, deleted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(`[PURGE] Failed for company_id=${id}:`, err.message);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve workspace-scoped company then purge by id.
 * @param {string} companyGuid
 * @param {{ workspaceId?: string, companyId?: number|string }} [opts]
 */
export async function purgeCompanyTallyData(companyGuid, opts = {}) {
  if (opts.companyId != null) {
    return purgeCompanyTallyDataById(opts.companyId, { companyGuid });
  }
  if (!companyGuid || typeof companyGuid !== 'string') {
    throw new Error('companyGuid required');
  }
  if (!opts.workspaceId) {
    throw new Error('workspaceId required with companyGuid for purge');
  }
  const { rows } = await query(
    `SELECT id, guid FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
    [companyGuid, opts.workspaceId]
  );
  if (!rows[0]) {
    return { companyId: null, companyGuid, deleted: {} };
  }
  return purgeCompanyTallyDataById(rows[0].id, { companyGuid: rows[0].guid });
}

/**
 * Purge multiple selected companies (hard sync only).
 * @param {string[]} companyGuids
 * @param {string} workspaceId
 */
export async function purgeCompaniesForHardSync(companyGuids, workspaceId) {
  if (!workspaceId) {
    throw new Error('workspaceId required for hard-sync purge');
  }
  const guids = [...new Set((companyGuids || []).filter(Boolean))];
  const results = [];
  for (const guid of guids) {
    results.push(await purgeCompanyTallyData(guid, { workspaceId }));
  }
  return results;
}
