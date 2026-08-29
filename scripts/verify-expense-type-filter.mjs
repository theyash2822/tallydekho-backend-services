#!/usr/bin/env node
/**
 * Verify Expense Register Direct vs Indirect filter (DB + optional live API).
 *
 * Usage:
 *   node scripts/verify-expense-type-filter.mjs
 *   node scripts/verify-expense-type-filter.mjs --company=<guid>
 *   node scripts/verify-expense-type-filter.mjs --api   # also hit localhost:3001
 */
import 'dotenv/config';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const CTE = `
WITH RECURSIVE expense_groups AS (
  SELECT g.name,
         CASE WHEN g.name ~* '^Direct Expenses?$' THEN 'Direct' ELSE 'Indirect' END AS root_type
    FROM groups g
   WHERE g.company_guid = $1
     AND (g.name ~* '^Direct Expenses?$' OR g.name ~* '^Indirect Expenses?$')
  UNION ALL
  SELECT child.name, eg.root_type
    FROM groups child
    JOIN expense_groups eg
      ON LOWER(TRIM(COALESCE(child.parent, ''))) = LOWER(TRIM(eg.name))
   WHERE child.company_guid = $1
)`;

const args = process.argv.slice(2);
const companyArg = args.find((a) => a.startsWith('--company='))?.split('=')[1];
const hitApi = args.includes('--api');
const baseUrl = process.env.VERIFY_API_URL || 'http://127.0.0.1:3001';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function countByType(guid) {
  const { rows } = await pool.query(
    `${CTE}
     SELECT eg.root_type, COUNT(DISTINCT v.guid)::int AS c
     FROM vouchers v
     JOIN voucher_ledger_entries vle ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
     JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
     WHERE v.company_guid = $1
       AND v.is_cancelled = FALSE
       AND vle.dr_cr = 'Dr'
       AND v.date IS NOT NULL AND v.date != ''
     GROUP BY eg.root_type`,
    [guid]
  );
  const out = { Direct: 0, Indirect: 0 };
  for (const r of rows) out[r.root_type] = r.c;
  return out;
}

/** Classic bug: ILIKE '%Direct Expense%' matches "Indirect Expenses". */
async function countOldIlikeBug(guid) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(DISTINCT v.guid) FILTER (WHERE l.parent ILIKE '%Direct Expense%')::int AS "Direct",
       COUNT(DISTINCT v.guid) FILTER (WHERE l.parent ILIKE '%Indirect Expense%')::int AS "Indirect"
     FROM vouchers v
     JOIN voucher_ledger_entries vle ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
     WHERE v.company_guid = $1 AND v.is_cancelled = FALSE AND vle.dr_cr = 'Dr'`,
    [guid]
  );
  return rows[0];
}

async function pickCompany() {
  if (companyArg) {
    const { rows } = await pool.query('SELECT guid, name, user_id FROM companies WHERE guid=$1', [companyArg]);
    if (!rows[0]) throw new Error(`Company not found: ${companyArg}`);
    return rows[0];
  }
  const { rows } = await pool.query('SELECT guid, name, user_id FROM companies ORDER BY name');
  let best = null;
  let bestScore = -1;
  for (const c of rows) {
    const t = await countByType(c.guid);
    const score = (t.Direct > 0 ? 10 : 0) + (t.Indirect > 0 ? 10 : 0) + t.Direct + t.Indirect;
    if (score > bestScore) {
      bestScore = score;
      best = { ...c, counts: t };
    }
  }
  return best;
}

async function apiList(token, guid, types) {
  const q = new URLSearchParams({ companyGuid: guid, limit: '100' });
  if (types) q.set('types', types);
  const res = await fetch(`${baseUrl}/api/expenses?${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  return { status: res.status, count: (body?.data || []).length, meta: body?.meta, types: [...new Set((body?.data || []).map((r) => r.expense_type))] };
}

async function main() {
  const company = await pickCompany();
  if (!company) {
    console.log('No companies found.');
    process.exit(1);
  }
  const guid = company.guid;
  const fixed = company.counts || (await countByType(guid));
  const old = await countOldIlikeBug(guid);
  const all = fixed.Direct + fixed.Indirect;
  const diverge = fixed.Direct !== fixed.Indirect;

  console.log('══════════════════════════════════════════════════');
  console.log('Expense Type filter verification');
  console.log('══════════════════════════════════════════════════');
  console.log(`Company: ${company.name}`);
  console.log(`GUID:    ${guid}`);
  console.log('');
  console.log('FIXED (recursive CTE / root_type):');
  console.log(`  All=${all}  Direct=${fixed.Direct}  Indirect=${fixed.Indirect}  diverge=${diverge}`);
  console.log('OLD BUG (ILIKE %Direct Expense%):');
  console.log(`  Direct=${old.Direct}  Indirect=${old.Indirect}  diverge=${old.Direct !== old.Indirect}`);
  if (old.Direct === old.Indirect && all > 0) {
    console.log('  ⚠ Old ILIKE makes Direct==Indirect (substring match on Indirect Expenses).');
  }
  console.log('');

  if (!diverge && all === 0) {
    console.log('RESULT: no expense Dr vouchers under Direct/Indirect tree for this company.');
    process.exit(2);
  }
  if (!diverge) {
    console.log('RESULT: Direct and Indirect counts are equal (both may be populated the same).');
    console.log('        Still OK if root_type assignment is correct per row.');
  } else {
    console.log('RESULT: OK — Direct and Indirect diverge in DB-backed counts.');
  }

  if (hitApi) {
    if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET required for --api');
    const token = jwt.sign(
      { userId: company.user_id, companyGuid: guid },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );
    console.log('');
    console.log(`Live API ${baseUrl}:`);
    for (const t of [null, 'Direct', 'Indirect']) {
      const r = await apiList(token, guid, t);
      console.log(`  types=${t || 'ALL'} → status=${r.status} count=${r.count} expense_types=${JSON.stringify(r.types)} meta.type=${r.meta?.type}`);
    }
    const d = await apiList(token, guid, 'Direct');
    const i = await apiList(token, guid, 'Indirect');
    if (d.count === i.count && all > 0 && diverge) {
      console.log('FAIL: API Direct count equals Indirect despite DB divergence.');
      process.exit(3);
    }
    console.log('API check OK.');
  }

  await pool.end();
  process.exit(diverge || all > 0 ? 0 : 2);
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch { /* ignore */ }
  process.exit(1);
});
