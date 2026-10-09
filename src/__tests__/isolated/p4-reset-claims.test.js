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

test('counts: merged repeated lines, empty rows and zero-qty openings are not rejections (watermark can advance)', async () => {
  const co = await makeCompany();
  const uploadId = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id) VALUES ($1, 'synthetic-dev')`, [uploadId]);
  const v = `${co.guid}-v2`;
  const opts = { companyId: co.id, uploadId, chunkKey: 'st:0' };
  const empty = { GUID: `${co.guid}-v3`, COMPANY_GUID: co.guid, XML: 'StockTransaction.xml', _FINANCIAL_YEAR: '2025-2026' };
  await processIngestedData('records', [
    stockLine(co, v, 'Widget A', 1), stockLine(co, v, 'Widget A', 2), stockLine(co, v, 'Widget B', 3), empty,
  ], co.guid, null, null, opts);
  await q(`INSERT INTO stocks (guid, company_guid, company_id, name) VALUES ($1,$2,$3,'Widget A')`, [`${co.guid}-s1`, co.guid, co.id]);
  await processIngestedData('records', [
    { Name: 'Widget A', COMPANY_GUID: co.guid, XML: 'StockOpeningBalance.xml', OpeningBalance: '0', OpeningRate: '0', OpeningValue: '0' },
    { Name: 'Widget A', COMPANY_GUID: co.guid, XML: 'StockOpeningBalance.xml', OpeningBalance: '5', OpeningRate: '10', OpeningValue: '50', GodownName: 'Main' },
  ], co.guid, null, null, { ...opts, chunkKey: 'ob:0' });

  const { rows } = await q(`SELECT collection_counts AS c FROM ingest_uploads WHERE id = $1`, [uploadId]);
  const c = rows[0].c;
  assert.deepEqual(c._cumulative['StockTransaction.xml'], { saved: 4, rejected: 0 });
  assert.equal(c['StockTransaction.xml'].saved, 3);
  assert.equal(c['StockTransaction.xml'].empty, 1);
  assert.equal(c['StockOpeningBalance.xml'].rejected, 0);
  assert.equal(c['StockOpeningBalance.xml'].warehouseRows, 1);
  const st = await q(`SELECT value FROM stock_transactions WHERE company_id = $1 AND voucher_guid = $2 AND stock_guid = 'Widget A'`, [co.id, v]);
  assert.equal(Number(st.rows[0].value), 30, 'repeated lines merged, not dropped');
});

test('stock masters wrapped in more than five envelopes are still saved', async () => {
  const co = await makeCompany();
  const envelope = (i) => ({
    XML: 'StockItemFull.xml', COMPANY_GUID: co.guid,
    BODY: JSON.stringify({ DATA: { TALLYMESSAGE: { STOCKITEM: [
      { NAME: `Item ${i}`, GUID: `${co.guid}-s${i}`, BASEUNITS: 'Nos', ALTERID: String(i) },
    ] } } }),
  });
  const rows = Array.from({ length: 6 }, (_, i) => envelope(i));
  await processIngestedData('master', rows, co.guid, null, null, { companyId: co.id });
  const { rows: saved } = await q('SELECT name FROM stocks WHERE company_id = $1 ORDER BY name', [co.id]);
  assert.deepEqual(saved.map((r) => r.name), rows.map((_, i) => `Item ${i}`));
});
