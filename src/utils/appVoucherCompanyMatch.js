/**
 * Match an app_vouchers row for one company whether it was stored with the
 * numeric company id, the Tally guid, or the legacy mistake (numeric id
 * written into company_guid and company_id left null).
 *
 * paramRef is a SQL placeholder such as `$1`. alias is `av` or `''`.
 */
export function appVoucherCompanyMatchSql(alias, paramRef) {
  const p = alias ? `${alias}.` : '';
  return `(${p}company_id::text = ${paramRef}::text OR ${p}company_guid = ${paramRef}::text)`;
}

/** Join vouchers ↔ app_vouchers on the same company, including legacy rows. */
export function voucherToAppCompanyJoinSql(voucherAlias = 'v', appAlias = 'av') {
  return `(
    ${voucherAlias}.company_id = ${appAlias}.company_id
    OR ${appAlias}.company_guid = ${voucherAlias}.company_id::text
    OR (${voucherAlias}.company_guid IS NOT NULL AND ${voucherAlias}.company_guid = ${appAlias}.company_guid)
  )`;
}
