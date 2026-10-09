// R1 early fix for 07 (V-006): an AllVoucher record without a cancel flag keeps the stored state.
// R2 extra (7440b21): a nameless stock line with a Tally-formatted quantity is counted as rejected,
// not silently as an empty row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');
test.after(() => pool.end());

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(
    `INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [guid, `Synthetic ${guid}`, workspaceId],
  );
  return { guid, id: rows[0].id };
}

const allVoucher = (co, guid, extra = {}) => ({
  XML: 'AllVoucher.xml',
  COMPANY_GUID: co.guid,
  _FINANCIAL_YEAR: '2025-2026',
  VOUCHER: JSON.stringify({ GUID: guid, DATE: '20250510', VOUCHERTYPE: 'Sales', VOUCHERNUMBER: 'S-1', AMOUNT: '100', ALTERID: '7', ...extra }),
});
const cancelled = async (co, guid) =>
  (await q('SELECT is_cancelled FROM vouchers WHERE company_id = $1 AND guid = $2', [co.id, guid])).rows[0]?.is_cancelled;

test('07: an absent cancel flag keeps a cancelled voucher cancelled; an explicit flag still changes it', async () => {
  const co = await makeCompany();
  const v = uniq('v');
  const run = (extra) => processIngestedData('records', [allVoucher(co, v, extra)], co.guid, null, null, { companyId: co.id });

  await run({ ISCANCELLED: 'Yes' });
  assert.equal(await cancelled(co, v), true);
  await run({});
  assert.equal(await cancelled(co, v), true, 'a record without the flag does not un-cancel');
  await run({ ISCANCELLED: 'No' });
  assert.equal(await cancelled(co, v), false, 'an explicit No is authoritative');
  await run({ IsCancelled: 'Yes' });
  assert.equal(await cancelled(co, v), true, 'any casing of the flag is read');
});

test('a nameless stock line with quantity "(-)5 Nos" is rejected, not counted as empty', async () => {
  const co = await makeCompany();
  const uploadId = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id) VALUES ($1, 'synthetic-dev')`, [uploadId]);
  const rows = [
    { XML: 'StockTransaction.xml', COMPANY_GUID: co.guid, Guid: uniq('v'), ACTUALQTY: '(-)5 Nos', AMOUNT: '(-)50' },
    { XML: 'StockTransaction.xml', COMPANY_GUID: co.guid, Guid: uniq('v'), ACTUALQTY: '0', AMOUNT: '0' },
  ];
  await processIngestedData('records', rows, co.guid, null, null, { companyId: co.id, uploadId, chunkKey: 'st:0' });
  const { rows: up } = await q(`SELECT collection_counts->'StockTransaction.xml' AS st FROM ingest_uploads WHERE id = $1`, [uploadId]);
  assert.equal(up[0].st.empty, 1, 'only the line with nothing in it is empty');
  assert.equal(up[0].st.rejected, 1, 'the line with a quantity but no item is reported');
});
