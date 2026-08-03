// ── Parent voucher type derivation ───────────────────────────────────────────
// Tally lets a company rename its voucher types ("Sales GST", "TAX INVOICE",
// "Sales Return"), so `vouchers.voucher_type_parent` holds the built-in parent
// every report and guard filters on.
//
// SimplifiedVoucher.xml omits VOUCHERTYPENAME, so the ingest falls back to the
// literal 'Voucher'. That placeholder must never be stored as a parent — it once
// flattened every row in the table to 'Voucher', which silently emptied the GST
// classification and made Credit Note reject valid Sales invoices.
//
// The JS function and the SQL expression below must stay in sync: the ingest
// writes with the former, the boot-time repair heals rows with the latter.

const PARENT_RULES = [
  [/credit note|sales return/, 'Credit Note'],
  [/debit note|purchase return/, 'Debit Note'],
  [/sales order/, 'Sales Order'],
  [/purchase order/, 'Purchase Order'],
  [/delivery note/, 'Delivery Note'],
  [/receipt note/, 'Receipt Note'],
  [/sales|invoice|retail/, 'Sales'],
  [/purchase/, 'Purchase'],
  [/stock journal/, 'Stock Journal'],
  [/journal|adjustment/, 'Journal'],
  [/payment/, 'Payment'],
  [/receipt/, 'Receipt'],
  [/contra/, 'Contra'],
];

/** @returns {string|null} built-in parent, or null when the type is the 'Voucher' placeholder */
export function deriveVoucherTypeParent(voucherType) {
  if (!voucherType) return null;
  const vt = String(voucherType).trim().toLowerCase();
  if (!vt || vt === 'voucher') return null;
  for (const [pattern, parent] of PARENT_RULES) {
    if (pattern.test(vt)) return parent;
  }
  return voucherType;
}

/** Same mapping as SQL, applied to a `voucher_type` column reference. */
export const voucherTypeParentSql = (col = 'voucher_type') => `
  CASE
    WHEN ${col} IS NULL OR LOWER(TRIM(${col})) IN ('', 'voucher') THEN NULL
    WHEN ${col} ~* 'credit note|sales return'     THEN 'Credit Note'
    WHEN ${col} ~* 'debit note|purchase return'   THEN 'Debit Note'
    WHEN ${col} ~* 'sales order'                  THEN 'Sales Order'
    WHEN ${col} ~* 'purchase order'               THEN 'Purchase Order'
    WHEN ${col} ~* 'delivery note'                THEN 'Delivery Note'
    WHEN ${col} ~* 'receipt note'                 THEN 'Receipt Note'
    WHEN ${col} ~* 'sales|invoice|retail'         THEN 'Sales'
    WHEN ${col} ~* 'purchase'                     THEN 'Purchase'
    WHEN ${col} ~* 'stock journal'                THEN 'Stock Journal'
    WHEN ${col} ~* 'journal|adjustment'           THEN 'Journal'
    WHEN ${col} ~* 'payment'                      THEN 'Payment'
    WHEN ${col} ~* 'receipt'                      THEN 'Receipt'
    WHEN ${col} ~* 'contra'                       THEN 'Contra'
    ELSE ${col}
  END`;

/**
 * Heals rows whose parent is missing or still carries the 'Voucher' placeholder.
 * Idempotent — matches nothing once the table is clean. Takes one parameter:
 * a company_guid to scope the repair, or null for every company.
 */
export const REPAIR_VOUCHER_TYPE_PARENT_SQL = `
  UPDATE vouchers
     SET voucher_type_parent = ${voucherTypeParentSql('voucher_type')}
   WHERE COALESCE(voucher_type_parent, 'Voucher') = 'Voucher'
     AND COALESCE(voucher_type, 'Voucher') <> 'Voucher'
     AND ($1::text IS NULL OR company_guid = $1)`;
