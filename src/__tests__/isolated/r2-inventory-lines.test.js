// R2 / X5 + X3 + bill allocations, through processIngestedData on the isolated DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { processIngestedData, resetLineOrdinalModeForTests } = await import('../../controllers/ingestProcessor.js');
const { IngestBatchError } = await import('../../utils/ingestCompanyDualWrite.js');
const { applyLineOrdinalCutover, lineOrdinalCutoverComplete } = await import('../../db/lineOrdinalSchema.js');

// The isolated copy gets the X5 keys the way boot gives them to an empty database.
{
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyLineOrdinalCutover(client);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
  resetLineOrdinalModeForTests();
}
test.after(() => pool.end());

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(`INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`, [guid, `Synthetic ${guid}`, workspaceId]);
  return { guid, id: rows[0].id };
}
const stock = (co, v, item, qty, ordinal, godown = 'Main') => ({
  XML: 'StockTransaction.xml', COMPANY_GUID: co.guid, GUID: v, STOCKITEMNAME: item, GODOWNNAME: godown,
  ACTUALQTY: `${qty} Nos`, RATE: '10', AMOUNT: String(qty * 10), _FINANCIAL_YEAR: '2025-2026',
  ...(ordinal == null ? {} : { _LINE_ORDINAL: ordinal }),
});
const vii = (co, v, item, qty, ordinal) => ({
  XML: 'VoucherInventoryDetail.xml', COMPANY_GUID: co.guid, VOUCHERGUID: v, STOCKITEMNAME: item, GODOWNNAME: 'Main', BATCHNAME: '',
  ACTUALQTY: `${qty} Nos`, BILLEDQTY: `${qty} Nos`, RATE: '10', AMOUNT: String(qty * 10), _LINE_ORDINAL: ordinal,
});
const stockRows = async (co, v) => (await q(
  `SELECT stock_guid, qty::float AS qty, line_ordinal FROM stock_transactions WHERE company_id = $1 AND voucher_guid = $2 ORDER BY stock_guid, line_ordinal`,
  [co.id, v])).rows;
const run = (co, rows, uploadId, chunkKey) => processIngestedData('records', rows, co.guid, null, null, { companyId: co.id, uploadId, chunkKey });

test('X5: the database uses the ordinal keys', async () => {
  assert.equal(await lineOrdinalCutoverComplete(q), true);
});

test('X5: two identical stock lines stay two rows; replay stays two; split chunks assemble', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-v1`;
  const up = uniq('up');
  const lines = [stock(co, v, 'Widget', 2, 0), stock(co, v, 'Widget', 2, 1), stock(co, v, 'Bolt', 1, 0)];
  await run(co, lines, up, 'st:0');
  assert.deepEqual((await stockRows(co, v)).map((r) => [r.stock_guid, r.qty, r.line_ordinal]), [['Bolt', 1, 0], ['Widget', 2, 0], ['Widget', 2, 1]]);
  await run(co, lines, up, 'st:0');
  assert.equal((await stockRows(co, v)).length, 3, 'replay is not 4 or 6');

  const v2 = `${co.guid}-v2`;
  const up2 = uniq('up');
  await run(co, [stock(co, v2, 'Widget', 5, 0)], up2, 'st:0');
  await run(co, [stock(co, v2, 'Widget', 5, 1)], up2, 'st:1');
  assert.deepEqual((await stockRows(co, v2)).map((r) => r.line_ordinal), [0, 1], 'a voucher split across chunks keeps both lines');
});

test('X5: a later snapshot with fewer lines replaces the set (no stale ordinals)', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-v1`;
  await run(co, [stock(co, v, 'Widget', 2, 0), stock(co, v, 'Widget', 2, 1)], uniq('up'), 'st:0');
  await run(co, [stock(co, v, 'Widget', 3, 0)], uniq('up'), 'st:0');
  assert.deepEqual((await stockRows(co, v)).map((r) => [r.qty, r.line_ordinal]), [[3, 0]]);
});

test('X5: rows from an older desktop (no ordinals) are still merged, not lost', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-v1`;
  await run(co, [stock(co, v, 'Widget', 2, null), stock(co, v, 'Widget', 3, null)], uniq('up'), 'st:0');
  assert.deepEqual((await stockRows(co, v)).map((r) => [r.qty, r.line_ordinal]), [[5, 0]]);
});

test('X5/X3: a six-line voucher persists all six lines', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-v6`;
  const six = [
    stock(co, v, 'Widget', 1, 0), stock(co, v, 'Widget', 1, 1), stock(co, v, 'Widget', 1, 2),
    stock(co, v, 'Bolt', 4, 0), stock(co, v, 'Bolt', 4, 1), stock(co, v, 'Nut', 7, 0),
  ];
  await run(co, six, uniq('up'), 'st:0');
  const rows = await stockRows(co, v);
  assert.equal(rows.length, 6);
  assert.equal(rows.reduce((t, r) => t + r.qty, 0), 18);
});

test('X5: identical voucher-inventory lines stay distinct', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-vi`;
  await processIngestedData('records', [vii(co, v, 'Widget', 2, 0), vii(co, v, 'Widget', 2, 1)], co.guid, null, null, { companyId: co.id });
  const { rows } = await q(`SELECT line_ordinal, actual_qty::float AS qty FROM voucher_inventory_items WHERE company_id = $1 AND voucher_guid = $2 ORDER BY line_ordinal`, [co.id, v]);
  assert.deepEqual(rows.map((r) => [r.line_ordinal, r.qty]), [[0, 2], [1, 2]]);
});

const voucherWithBills = (v, bills) => ({
  GUID: v, VoucherNumber: 'R-1', VoucherTypeName: 'Receipt', Date: '20250501', PartyLedgerName: 'Synthetic Customer',
  ALLLEDGERENTRIES: [
    { LEDGERNAME: 'Synthetic Customer', ISPARTYLEDGER: 'Yes', AMOUNT: '150', BILLALLOCATIONS: bills },
    { LEDGERNAME: 'Cash', AMOUNT: '-150' },
  ],
});

test('bill allocations: two allocations to the same bill keep both amounts', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-r1`;
  await processIngestedData('vouchers', [voucherWithBills(v, [
    { NAME: 'INV-7', BILLTYPE: 'Agst Ref', AMOUNT: '100' },
    { NAME: 'INV-7', BILLTYPE: 'Agst Ref', AMOUNT: '50' },
  ])], co.guid, null, null, { companyId: co.id });
  const { rows } = await q(`SELECT bill_name, amount::float AS amount FROM voucher_bill_allocations WHERE company_id = $1 AND voucher_guid = $2`, [co.id, v]);
  assert.deepEqual(rows, [{ bill_name: 'INV-7', amount: 150 }]);
});

test('X3: a failing bill-allocation write fails the voucher instead of committing it without bills', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-r2`;
  await q(`ALTER TABLE voucher_bill_allocations ADD CONSTRAINT x3_fault_bill CHECK (bill_name <> 'X3-FAIL') NOT VALID`);
  try {
    await assert.rejects(
      processIngestedData('vouchers', [voucherWithBills(v, [{ NAME: 'X3-FAIL', BILLTYPE: 'Agst Ref', AMOUNT: '150' }])], co.guid, null, null, { companyId: co.id }),
      (err) => err instanceof IngestBatchError,
    );
    const { rows } = await q(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND guid = $2`, [co.id, v]);
    assert.equal(rows[0].n, 0);
  } finally {
    await q('ALTER TABLE voucher_bill_allocations DROP CONSTRAINT IF EXISTS x3_fault_bill');
  }
});
