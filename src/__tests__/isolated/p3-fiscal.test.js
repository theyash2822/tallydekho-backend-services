// P3 stock FY balances on the disposable cluster only (synthetic rows, unique ids per run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(
    `INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [guid, `Synthetic ${guid}`, workspaceId]
  );
  return { guid, id: rows[0].id };
}

const FYS = [
  { finYear: '2023-2024', begin: '20230401', end: '20240331', prev: '20230331' },
  { finYear: '2024-2025', begin: '20240401', end: '20250331', prev: '20240331' },
  { finYear: '2025-2026', begin: '20250401', end: '20260331', prev: '20250331' },
];

const balanceRow = (co, y, role, value) => {
  const date = role === 'closing' ? y.end : y.prev;
  return {
    NAME: 'Synthetic Widget', CLOSINGQTY: '2 Nos', CLOSINGRATE: '10.50', CLOSINGVALUE: `-${value}`,
    XML: 'StockFYBalance.xml', COMPANY_GUID: co.guid, FROM_DATE: date, TO_DATE: date,
    _FINANCIAL_YEAR: y.finYear, FY_BEGIN: y.begin, FY_END: y.end, BALANCE_DATE: date, BALANCE_ROLE: role,
  };
};

test.after(async () => {
  await schema.getPool().end().catch(() => {});
});

test('mixed-year, reordered StockFYBalance batch lands in the right FY and column; replay is idempotent', async () => {
  const co = await makeCompany();
  const batch = [
    balanceRow(co, FYS[2], 'closing', 600),
    balanceRow(co, FYS[0], 'opening', 100),
    balanceRow(co, FYS[1], 'closing', 400),
    balanceRow(co, FYS[2], 'opening', 400),
    balanceRow(co, FYS[0], 'closing', 200),
    balanceRow(co, FYS[1], 'opening', 200),
  ];
  for (let i = 0; i < 2; i++) {
    await processIngestedData('master', batch, co.guid, null, null, { companyId: co.id });
  }
  const { rows } = await q(
    `SELECT financial_year, opening_value::float AS o, closing_value::float AS c, closing_rate::float AS r
       FROM stock_fy_valuation WHERE company_id = $1 ORDER BY financial_year`,
    [co.id]
  );
  assert.deepEqual(rows.map((r) => [r.financial_year, r.o, r.c]), [
    ['2023-2024', 100, 200],
    ['2024-2025', 200, 400],
    ['2025-2026', 400, 600],
  ]);
  assert.equal(rows[0].r, 10.5);
});

test('a row whose role contradicts its date creates no phantom year row', async () => {
  const co = await makeCompany();
  const bad = { ...balanceRow(co, FYS[1], 'closing', 5), BALANCE_DATE: '20240331', _FINANCIAL_YEAR: '2099-2100' };
  await processIngestedData('master', [bad], co.guid, null, null, { companyId: co.id });
  const { rows } = await q(`SELECT COUNT(*)::int AS n FROM stock_fy_valuation WHERE company_id = $1`, [co.id]);
  assert.equal(rows[0].n, 0);
});
