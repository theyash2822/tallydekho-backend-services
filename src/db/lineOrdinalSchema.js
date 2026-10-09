/**
 * R2 / X5 — repeated stock lines. Tally allows the same item/godown/batch on several lines
 * of one voucher; keyed by content alone they collapse into one row. With a line ordinal
 * (the line's position among identical lines of its voucher, assigned by the desktop from
 * Tally's export order) each source line is its own row and a replay stays the same rows.
 *
 * The column and the ordinal key are additive (boot adds them everywhere). Dropping the old
 * content keys is what lets two identical lines coexist, so boot only does that on an empty
 * database; a database with data needs the supervised script
 * scripts/x5-line-ordinal-cutover.mjs (preflight first). Rows collapsed in the past cannot be
 * split again: they keep ordinal 0 and are corrected by the next sync of their voucher.
 */
export const LINE_ORDINAL_KEYS = [
  {
    table: 'stock_transactions',
    constraint: 'uq_stock_tx_line',
    cols: '(company_id, stock_guid, voucher_guid, warehouse, type, line_ordinal)',
    replaces: ['uq_stock_tx_company_id_compound', 'stock_transactions_unique'],
  },
  {
    table: 'voucher_inventory_items',
    constraint: 'uq_vii_line',
    cols: '(company_id, voucher_guid, stock_item_name, godown_name, batch_name, line_ordinal)',
    replaces: ['uq_vii_company_id_compound', 'voucher_inventory_items_unique'],
  },
];

/**
 * Boot, every database: the ordinal column and ordinal key. Additive — every existing row
 * has ordinal 0, so the new key cannot collide, and all writers can name it as their
 * ON CONFLICT target. While the old content keys remain, writers merge identical lines at
 * ordinal 0, which both keys accept.
 */
export async function ensureLineOrdinalKeys(client) {
  for (const { table, constraint, cols } of LINE_ORDINAL_KEYS) {
    await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS line_ordinal INTEGER NOT NULL DEFAULT 0`);
    if (!(await constraintExists((t, p) => client.query(t, p), table, constraint))) {
      await client.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} UNIQUE ${cols}`);
    }
  }
}

const constraintExists = async (q, table, name) =>
  (await q(`SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass($1) AND conname = $2`, [table, name])).rows.length > 0;

/** True when every table uses the ordinal key and none of the old content keys remain. */
export async function lineOrdinalCutoverComplete(q) {
  for (const { table, constraint, replaces } of LINE_ORDINAL_KEYS) {
    if (!(await constraintExists(q, table, constraint))) return false;
    for (const old of replaces) if (await constraintExists(q, table, old)) return false;
  }
  return true;
}

/** Row counts and new-key collisions (always 0 while every row has ordinal 0). Read-only. */
export async function lineOrdinalPreflight(q) {
  const out = [];
  for (const { table } of LINE_ORDINAL_KEYS) {
    const { rows } = await q(`SELECT COUNT(*)::bigint AS n, COUNT(*) FILTER (WHERE line_ordinal <> 0)::bigint AS ordinal_rows FROM ${table}`);
    out.push({ table, rows: Number(rows[0].n), ordinalRows: Number(rows[0].ordinal_rows) });
  }
  return out;
}

/** Ensures the ordinal keys, then drops the content keys. Run inside the caller's transaction. */
export async function applyLineOrdinalCutover(client) {
  await ensureLineOrdinalKeys(client);
  for (const { table, replaces } of LINE_ORDINAL_KEYS) {
    for (const old of replaces) await client.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${old}`);
  }
}

export async function lineOrdinalTablesEmpty(q) {
  for (const { table } of LINE_ORDINAL_KEYS) {
    const { rows } = await q(`SELECT EXISTS (SELECT 1 FROM ${table}) AS has`);
    if (rows[0].has) return false;
  }
  return true;
}
