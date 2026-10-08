// P4 X8/X12 durable first-chunk resets on the disposable cluster only. Synthetic rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { claimResets } = await import('../../services/ingestResetClaims.js');
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

async function inTx(fn, commit = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return r;
  } finally {
    client.release();
  }
}

test.after(async () => {
  await pool.end().catch(() => {});
});

test('claims are durable across connections, released on rollback, re-granted to the same chunk only', async () => {
  const co = await makeCompany();
  const uploadId = uniq('up');
  const base = { uploadId, companyId: co.id, kind: 'stock_transactions' };

  const rolledBack = await inTx((c) => claimResets(c, { ...base, keys: ['v1'], chunkKey: 'c0' }), false);
  assert.deepEqual(rolledBack, ['v1']);
  // Rolled back → a different chunk (e.g. after a restart) still gets the first reset.
  assert.deepEqual(await inTx((c) => claimResets(c, { ...base, keys: ['v1', 'v2'], chunkKey: 'c1' })), ['v1', 'v2']);
  // Separate connection = another worker / after restart: later chunk appends.
  assert.deepEqual(await inTx((c) => claimResets(c, { ...base, keys: ['v1', 'v3'], chunkKey: 'c2' })), ['v3']);
  // Retry of the claiming chunk may reset again (idempotent chunk retry).
  assert.deepEqual((await inTx((c) => claimResets(c, { ...base, keys: ['v1', 'v2'], chunkKey: 'c1' }))).sort(), ['v1', 'v2']);
  // New upload resets again; no upload id keeps legacy behaviour.
  assert.deepEqual(await inTx((c) => claimResets(c, { ...base, uploadId: uniq('up'), keys: ['v1'], chunkKey: 'c9' })), ['v1']);
  assert.deepEqual(await inTx((c) => claimResets(c, { ...base, uploadId: null, keys: ['v1'] })), ['v1']);
});

const stockLine = (co, voucher, item, qty) => ({
  GUID: voucher, COMPANY_GUID: co.guid, XML: 'StockTransaction.xml', VOUCHERTYPENAME: 'Sales',
  STOCKITEMNAME: item, StockItemName: item, Date: '20250601', DATE: '20250601',
  BilledQty: `${qty} Nos`, BILLEDQTY: `${qty} Nos`, Rate: '10', RATE: '10', Amount: `${qty * 10}`, AMOUNT: `${qty * 10}`,
  _FINANCIAL_YEAR: '2025-2026',
});

const ledgerLine = (co, voucher, name, amount) => ({
  Guid: voucher, COMPANY_GUID: co.guid, XML: 'LedgerTransaction.xml', LedgerName: name, Amount: String(amount),
});

test('a voucher whose flat lines span two chunks keeps every line', async () => {
  const co = await makeCompany();
  const uploadId = uniq('up');
  const v = `${co.guid}-v1`;
  const opts = (chunkKey) => ({ companyId: co.id, uploadId, chunkKey });

  await processIngestedData('records', [stockLine(co, v, 'Widget A', 1)], co.guid, null, null, opts('st:0'));
  await processIngestedData('records', [stockLine(co, v, 'Widget B', 2)], co.guid, null, null, opts('st:1'));
  await processIngestedData('records', [ledgerLine(co, v, 'Sales', 10)], co.guid, null, null, opts('lt:0'));
  await processIngestedData('records', [ledgerLine(co, v, 'Cash', -10)], co.guid, null, null, opts('lt:1'));

  const st = await q('SELECT COUNT(*)::int AS n FROM stock_transactions WHERE company_id = $1 AND voucher_guid = $2', [co.id, v]);
  assert.equal(st.rows[0].n, 2, 'both stock lines survive the second chunk');
  const vi = await q('SELECT ledger_name FROM voucher_items WHERE company_id = $1 AND voucher_guid = $2 ORDER BY ledger_name', [co.id, v]);
  assert.deepEqual(vi.rows.map((r) => r.ledger_name), ['Cash', 'Sales'], 'both ledger lines survive the second chunk');
});
