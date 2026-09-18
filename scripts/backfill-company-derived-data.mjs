#!/usr/bin/env node
/**
 * One-time repairs for data Tally's XML export leaves incomplete.
 *
 * Both of these used to be authenticated-only HTTP routes
 * (POST /api/admin/backfill-stock-voucher-types, POST /api/admin/backfill-gst).
 * They are bulk maintenance UPDATEs with no product caller, so they moved here
 * rather than staying reachable by any logged-in user.
 *
 *   stock-voucher-types  SimplifiedVoucher.xml omits VOUCHERTYPENAME, which
 *                        leaves stock_transactions.voucher_type NULL and breaks
 *                        the transaction-type filter.
 *   gst                  Recompute gst_voucher_details CGST/SGST/IGST/taxable
 *                        from the voucher's ledger entries.
 *
 * Safety:
 *   - dry-run by default; CONFIRM=1 required to write
 *   - COMPANY_ID scopes to one company; without it every company is processed
 *   - one transaction
 *
 * Usage:
 *   DATABASE_URL=... node scripts/backfill-company-derived-data.mjs
 *   DATABASE_URL=... TASK=gst COMPANY_ID=123 CONFIRM=1 node scripts/backfill-company-derived-data.mjs
 */
import 'dotenv/config';
import { query, getClient } from '../src/db/schema.js';

const CONFIRM = process.env.CONFIRM === '1';
const TASK = String(process.env.TASK || 'all').toLowerCase();
const COMPANY_ID = process.env.COMPANY_ID ? Number(process.env.COMPANY_ID) : null;

if (COMPANY_ID != null && !Number.isFinite(COMPANY_ID)) {
  console.error('COMPANY_ID must be numeric');
  process.exit(2);
}
if (!['all', 'stock-voucher-types', 'gst'].includes(TASK)) {
  console.error('TASK must be one of: all, stock-voucher-types, gst');
  process.exit(2);
}

const scope = COMPANY_ID != null ? 'st.company_id = $1' : 'TRUE';
const gstScope = COMPANY_ID != null ? 'v.company_id = $1' : 'TRUE';
const args = COMPANY_ID != null ? [COMPANY_ID] : [];

const STOCK_VOUCHER_TYPES_SQL = `
  UPDATE stock_transactions st
  SET voucher_type = v.voucher_type
  FROM vouchers v
  WHERE st.voucher_guid = v.guid
    AND st.company_id = v.company_id
    AND ${scope}
    AND (st.voucher_type IS NULL OR st.voucher_type = '')
    AND v.voucher_type IS NOT NULL AND v.voucher_type != ''`;

const GST_SQL = `
  UPDATE gst_voucher_details gvd
  SET cgst_amount=sub.cgst, sgst_amount=sub.sgst, igst_amount=sub.igst, taxable_amount=sub.taxable
  FROM (
    SELECT v.guid as voucher_guid, v.company_id,
      COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' THEN ABS(vle.amount) ELSE 0 END),0) as cgst,
      COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%UTGST%' THEN ABS(vle.amount) ELSE 0 END),0) as sgst,
      COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0) as igst,
      GREATEST(0, COALESCE(SUM(CASE WHEN vle.dr_cr='Dr' THEN ABS(vle.amount) ELSE 0 END),0) -
        COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0)) as taxable
    FROM vouchers v
    JOIN voucher_ledger_entries vle ON vle.voucher_guid = v.guid AND vle.company_id = v.company_id
    WHERE ${gstScope}
    GROUP BY v.guid, v.company_id
    HAVING SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END) > 0
  ) sub
  WHERE gvd.voucher_guid = sub.voucher_guid AND gvd.company_id = sub.company_id`;

async function countCandidates() {
  const out = {};
  if (TASK === 'all' || TASK === 'stock-voucher-types') {
    const { rows } = await query(
      `SELECT count(*)::int AS n
         FROM stock_transactions st
         JOIN vouchers v ON v.guid = st.voucher_guid AND v.company_id = st.company_id
        WHERE ${scope}
          AND (st.voucher_type IS NULL OR st.voucher_type = '')
          AND v.voucher_type IS NOT NULL AND v.voucher_type != ''`,
      args
    );
    out.stockVoucherTypes = rows[0].n;
  }
  if (TASK === 'all' || TASK === 'gst') {
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM gst_voucher_details gvd
        WHERE ${COMPANY_ID != null ? 'gvd.company_id = $1' : 'TRUE'}`,
      args
    );
    out.gstRows = rows[0].n;
  }
  return out;
}

async function main() {
  console.log(`mode : ${CONFIRM ? 'APPLY (CONFIRM=1)' : 'DRY RUN'}`);
  console.log(`task : ${TASK}`);
  console.log(`scope: ${COMPANY_ID != null ? `company_id=${COMPANY_ID}` : 'ALL COMPANIES'}\n`);

  const candidates = await countCandidates();
  for (const [k, v] of Object.entries(candidates)) console.log(`  ${k.padEnd(20)} ${v}`);

  if (!CONFIRM) {
    console.log('\ndry run — re-run with CONFIRM=1 to apply');
    process.exit(0);
  }

  const client = await getClient();
  const applied = {};
  try {
    await client.query('BEGIN');
    if (TASK === 'all' || TASK === 'stock-voucher-types') {
      const r = await client.query(STOCK_VOUCHER_TYPES_SQL, args);
      applied.stockVoucherTypes = r.rowCount;
    }
    if (TASK === 'all' || TASK === 'gst') {
      const r = await client.query(GST_SQL, args);
      applied.gst = r.rowCount;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  console.log('\napplied:');
  for (const [k, v] of Object.entries(applied)) console.log(`  ${k.padEnd(20)} ${v} rows`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
