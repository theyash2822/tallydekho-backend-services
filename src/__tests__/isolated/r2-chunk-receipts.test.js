// R2 / X11 + 10: through the real /ingest/chunk route on the isolated DB.
// Schema-invalid chunks never become receipts; a chunk re-applied after a crash
// (receipt left 'applying') changes neither rows nor counters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';
import { startRouteHarness, seedWorkspace } from './routeHarness.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const { default: ingestRoutes } = await import('../../routes/ingest.js');
const harness = await startRouteHarness([['/', ingestRoutes]]);
test.after(async () => {
  await harness.close();
  await schema.getPool().end();
});

async function upload(ws) {
  const id = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id, company_guid) VALUES ($1, $2, $3)`, [id, ws.deviceId, ws.companyGuid]);
  return id;
}
const send = (ws, uploadId, index, raw, stream = 'records') => harness.call('POST', '/ingest/chunk', {
  raw,
  headers: { ...ws.deviceHeaders, 'device-id': ws.deviceId, 'upload-id': uploadId, 'stream-name': stream, 'chunk-index': String(index), 'company-guid': ws.companyGuid },
});
const receipts = async (uploadId) => (await q('SELECT chunk_index, status FROM ingest_chunk_receipts WHERE upload_id = $1 ORDER BY chunk_index', [uploadId])).rows;
const ledgerLine = (ws, v, name, amount) => JSON.stringify({ XML: 'LedgerTransaction.xml', COMPANY_GUID: ws.companyGuid, Guid: v, LedgerName: name, Amount: String(amount) });
const stockLine = (ws, v, item, qty) => JSON.stringify({
  XML: 'StockTransaction.xml', COMPANY_GUID: ws.companyGuid, Guid: v, STOCKITEMNAME: item, StockItemName: item,
  ACTUALQTY: `${qty} Nos`, BILLEDQTY: `${qty} Nos`, RATE: '10', AMOUNT: String(qty * 10), _FINANCIAL_YEAR: '2025-2026',
});

test('X11: null-only, primitive, wrong-shape, invalid middle/last and truncated chunks are refused without a receipt', async () => {
  const ws = await seedWorkspace(q, uniq);
  const up = await upload(ws);
  const good = ledgerLine(ws, uniq('v'), 'Sales', 10);
  const bodies = {
    'null only': 'null\n',
    primitive: '42\n',
    'array of primitives': '[1,2,3]',
    'no collection name': `${good}\n{"COMPANY_GUID":"${ws.companyGuid}"}\n`,
    'invalid middle line': `${good}\n{"XML":\n${good}\n`,
    'invalid last line': `${good}\n${good}\n{"XML":"LedgerTransaction.xml"`,
    truncated: `${good}\n${good}`.slice(0, -7),
  };
  let i = 0;
  for (const [label, raw] of Object.entries(bodies)) {
    const res = await send(ws, up, i++, raw);
    assert.equal(res.status, 400, label);
    assert.equal(res.body.status, false, label);
    assert.ok(['CHUNK_EMPTY', 'RECORD_INVALID', 'NDJSON_INVALID'].includes(res.body.code), `${label}: ${res.body.code}`);
    assert.doesNotMatch(JSON.stringify(res.body), /Sales/, `${label}: no record content echoed`);
  }
  assert.deepEqual(await receipts(up), [], 'no receipt for any refused chunk');
  const { rows } = await q('SELECT chunks FROM ingest_uploads WHERE id = $1', [up]);
  assert.equal(rows[0].chunks, 0);

  const ok = await send(ws, up, 99, `${good}\n${good.replace('"Sales"', '"Cash"').replace('"10"', '"-10"')}`);
  assert.equal(ok.status, 200, 'a valid chunk without a final newline is accepted');
});

test('10: a chunk re-applied after a crash (claim left applying) adds no rows and no counts', async () => {
  const ws = await seedWorkspace(q, uniq);
  const up = await upload(ws);
  const v = `${ws.companyGuid}-v1`;
  const raw = [stockLine(ws, v, 'Widget A', 1), stockLine(ws, v, 'Widget B', 2)].join('\n') + '\n';

  const first = await send(ws, up, 0, raw);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const rowsAfterFirst = (await q('SELECT COUNT(*)::int AS n FROM stock_transactions WHERE company_id = $1 AND voucher_guid = $2', [ws.companyId, v])).rows[0].n;
  const countsAfterFirst = (await q(`SELECT chunks, collection_counts->'_cumulative'->'StockTransaction.xml' AS st FROM ingest_uploads WHERE id = $1`, [up])).rows[0];
  assert.equal(rowsAfterFirst, 2);
  assert.equal(countsAfterFirst.chunks, 1);
  assert.equal(Number(countsAfterFirst.st?.saved), 2, 'totals were recorded for the first application');

  // Crash window: effects committed, receipt never marked applied; the claim goes stale.
  await q(`UPDATE ingest_chunk_receipts SET status = 'applying', applied_at = NULL, claimed_at = NOW() - INTERVAL '2 hours' WHERE upload_id = $1`, [up]);
  const retry = await send(ws, up, 0, raw);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));

  const rowsAfterRetry = (await q('SELECT COUNT(*)::int AS n FROM stock_transactions WHERE company_id = $1 AND voucher_guid = $2', [ws.companyId, v])).rows[0].n;
  const countsAfterRetry = (await q(`SELECT chunks, collection_counts->'_cumulative'->'StockTransaction.xml' AS st FROM ingest_uploads WHERE id = $1`, [up])).rows[0];
  assert.equal(rowsAfterRetry, 2, 'no extra rows');
  assert.equal(countsAfterRetry.chunks, 1, 'chunk counter unchanged');
  assert.deepEqual(countsAfterRetry.st, countsAfterFirst.st, 'saved/rejected totals unchanged');

  // A plain duplicate after success is acknowledged without re-applying; changed content conflicts.
  const dup = await send(ws, up, 0, raw);
  assert.equal(dup.body.data?.duplicate, true);
  const changed = await send(ws, up, 0, raw.replace('Widget B', 'Widget C'));
  assert.equal(changed.status, 409);
  assert.equal(changed.body.code, 'CHUNK_CONTENT_CONFLICT');
  assert.equal((await q('SELECT chunks FROM ingest_uploads WHERE id = $1', [up])).rows[0].chunks, 1);
});
