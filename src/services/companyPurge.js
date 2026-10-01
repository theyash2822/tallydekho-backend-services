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
  'voucher_line_taxes',
  'batch_allocations',
  'gst_voucher_details',
  'bill_outstanding',
  'bill_outstanding_staging',
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
 * Bills are only ever replaced by a confirmed complete snapshot from the desktop
 * (services/billSnapshot.js), so a hard sync that cannot fetch them keeps the old ones.
 */
const BILL_SNAPSHOT_TABLES = new Set(['bill_outstanding', 'bill_outstanding_staging']);

export function purgeTablesFor({ keepBillOutstanding = false } = {}) {
  return keepBillOutstanding
    ? TALLY_PROJECTION_TABLES.filter((t) => !BILL_SNAPSHOT_TABLES.has(t))
    : [...TALLY_PROJECTION_TABLES];
}

/**
 * @param {number|string} companyId
 * @param {{ companyGuid?: string, keepBillOutstanding?: boolean }} [meta]
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

    for (const table of purgeTablesFor(meta)) {
      // A failed statement aborts the whole transaction unless rolled back to a savepoint.
      await client.query('SAVEPOINT purge_table');
      try {
        const res = await client.query(
          `DELETE FROM ${table} WHERE company_id = $1`,
          [id]
        );
        deleted[table] = res.rowCount || 0;
        await client.query('RELEASE SAVEPOINT purge_table');
      } catch (err) {
        // Table may not exist on older DBs / column missing on transitional tables — skip
        if (err.code === '42P01' || err.code === '42703') {
          await client.query('ROLLBACK TO SAVEPOINT purge_table');
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
 * @param {{ workspaceId?: string, companyId?: number|string, keepBillOutstanding?: boolean }} [opts]
 */
export async function purgeCompanyTallyData(companyGuid, opts = {}) {
  const keepBillOutstanding = !!opts.keepBillOutstanding;
  if (opts.companyId != null) {
    return purgeCompanyTallyDataById(opts.companyId, { companyGuid, keepBillOutstanding });
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
  return purgeCompanyTallyDataById(rows[0].id, { companyGuid: rows[0].guid, keepBillOutstanding });
}

/**
 * Purge multiple selected companies (hard sync only). Bills are kept by default:
 * the desktop replaces them per company only after a successful bill fetch.
 * @param {string[]} companyGuids
 * @param {string} workspaceId
 * @param {{ keepBillOutstanding?: boolean }} [opts]
 */
export async function purgeCompaniesForHardSync(companyGuids, workspaceId, opts = {}) {
  if (!workspaceId) {
    throw new Error('workspaceId required for hard-sync purge');
  }
  const keepBillOutstanding = opts.keepBillOutstanding !== false;
  const guids = [...new Set((companyGuids || []).filter(Boolean))];
  const results = [];
  for (const guid of guids) {
    results.push(await purgeCompanyTallyData(guid, { workspaceId, keepBillOutstanding }));
  }
  return results;
}
