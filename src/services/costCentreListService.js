/**
 * Resolve company cost centres for Team Access / scope UI.
 * Order: cost_centres masters → allocation tables → voucher columns → ledger groups.
 * Best-effort upsert of discovered rows into cost_centres for next request.
 */
import { query } from '../db/schema.js';

const VOUCHER_NAME_CANDIDATES = ['cost_centre_name', 'costcentre_name', 'cost_centre', 'costcentre'];
const VOUCHER_GUID_CANDIDATES = ['cost_centre_guid', 'costcentre_guid'];

async function tableColumns(tableName) {
  try {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1`,
      [tableName]
    );
    return new Set(rows.map((r) => String(r.column_name).toLowerCase()));
  } catch {
    return null;
  }
}

function pickColumn(cols, candidates) {
  if (!cols) return null;
  for (const c of candidates) {
    if (cols.has(c)) return c;
  }
  return null;
}

async function fromCostCentresTable(companyId) {
  try {
    const { rows } = await query(
      `SELECT guid, name, parent_name FROM cost_centres
       WHERE company_id=$1 AND (is_active IS TRUE OR is_active IS NULL)
       ORDER BY name`,
      [companyId]
    );
    return rows;
  } catch {
    return [];
  }
}

async function fromAllocationTables(companyId) {
  const fallbackSqls = [
    `SELECT DISTINCT cost_centre_guid AS guid, cost_centre_name AS name, NULL::text AS parent_name
     FROM voucher_cost_centre_allocations
     WHERE company_id=$1 AND cost_centre_guid IS NOT NULL
     ORDER BY 2`,
    `SELECT DISTINCT cost_centre_guid AS guid, cost_centre_name AS name, NULL::text AS parent_name
     FROM voucher_cost_allocations
     WHERE company_id=$1 AND cost_centre_guid IS NOT NULL
     ORDER BY 2`,
  ];
  for (const sql of fallbackSqls) {
    try {
      const { rows } = await query(sql, [companyId]);
      if (rows.length) return rows;
    } catch {
      /* table missing */
    }
  }
  return [];
}

async function fromVoucherColumns(companyId) {
  const cols = await tableColumns('vouchers');
  const nameCol = pickColumn(cols, VOUCHER_NAME_CANDIDATES);
  if (!nameCol) {
    // information_schema unavailable or no known columns — try/catch common shapes
    const trySqls = [
      `SELECT DISTINCT COALESCE(cost_centre_guid, cost_centre_name) AS guid,
              COALESCE(cost_centre_name, cost_centre_guid) AS name,
              NULL::text AS parent_name
       FROM vouchers
       WHERE company_id=$1
         AND (cost_centre_name IS NOT NULL OR cost_centre_guid IS NOT NULL)
       ORDER BY 2`,
      `SELECT DISTINCT cost_centre AS guid, cost_centre AS name, NULL::text AS parent_name
       FROM vouchers
       WHERE company_id=$1 AND cost_centre IS NOT NULL AND TRIM(cost_centre) <> ''
       ORDER BY 2`,
      `SELECT DISTINCT costcentre AS guid, costcentre AS name, NULL::text AS parent_name
       FROM vouchers
       WHERE company_id=$1 AND costcentre IS NOT NULL AND TRIM(costcentre) <> ''
       ORDER BY 2`,
    ];
    for (const sql of trySqls) {
      try {
        const { rows } = await query(sql, [companyId]);
        if (rows.length) return rows;
      } catch {
        /* column missing */
      }
    }
    return [];
  }

  const guidCol = pickColumn(cols, VOUCHER_GUID_CANDIDATES);
  const guidExpr = guidCol ? `COALESCE(${guidCol}, ${nameCol})` : nameCol;
  const nameExpr = nameCol;
  try {
    const { rows } = await query(
      `SELECT DISTINCT ${guidExpr} AS guid, ${nameExpr} AS name, NULL::text AS parent_name
       FROM vouchers
       WHERE company_id=$1
         AND ${nameCol} IS NOT NULL
         AND TRIM(${nameCol}::text) <> ''
       ORDER BY 2`,
      [companyId]
    );
    return rows;
  } catch {
    return [];
  }
}

async function fromLedgers(companyId) {
  try {
    const { rows } = await query(
      `SELECT guid, name, parent AS parent_name
       FROM ledgers
       WHERE company_id=$1
         AND (
           parent ILIKE '%cost centre%' OR parent ILIKE '%cost center%'
           OR name ILIKE '%cost centre%' OR name ILIKE '%cost center%'
         )
       ORDER BY name`,
      [companyId]
    );
    return rows;
  } catch {
    return [];
  }
}

async function upsertDiscovered(companyId, rows) {
  if (!rows?.length || companyId == null) return;
  const { rows: co } = await query('SELECT guid FROM companies WHERE id=$1 LIMIT 1', [companyId]);
  const companyGuid = co[0]?.guid;
  if (!companyGuid) return;
  for (const row of rows) {
    const guid = row.guid || row.name;
    const name = row.name || row.guid;
    if (!guid || !name) continue;
    try {
      await query(
        `INSERT INTO cost_centres (guid, company_guid, name, parent_name, is_active, company_id)
         VALUES ($1,$2,$3,$4,TRUE,$5)
         ON CONFLICT (company_id, guid) DO UPDATE SET
           name=EXCLUDED.name, parent_name=COALESCE(EXCLUDED.parent_name, cost_centres.parent_name),
           company_id=COALESCE(EXCLUDED.company_id, cost_centres.company_id)`,
        [String(guid), companyGuid, String(name), row.parent_name || null, companyId]
      );
    } catch { /* ignore */ }
  }
}

/**
 * @param {number|string} companyId
 * @returns {Promise<Array<{ guid: string, name: string, parent_name: string|null }>>}
 */
export async function listCostCentresForCompany(companyId) {
  let rows = await fromCostCentresTable(companyId);
  if (rows.length) return rows;

  rows = await fromAllocationTables(companyId);
  if (!rows.length) rows = await fromVoucherColumns(companyId);
  if (!rows.length) rows = await fromLedgers(companyId);

  if (rows.length) {
    upsertDiscovered(companyId, rows).catch(() => {});
  }
  return rows;
}
