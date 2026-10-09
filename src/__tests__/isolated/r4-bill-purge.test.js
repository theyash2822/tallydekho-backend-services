// R4 / X12: a header-less (legacy) bill chunk cannot purge bills; staged rows stay out of the
// live table until publication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');
test.after(() => pool.end());

async function companyWithBills() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(`INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`, [guid, `Synthetic ${guid}`, workspaceId]);
  const co = { guid, id: rows[0].id };
  for (const bill of ['INV-1', 'INV-2']) {
    await q(`INSERT INTO bill_outstanding (company_guid, ledger_name, bill_name, amount, pending_amount, bill_type, company_id)
             VALUES ($1, 'Synthetic Customer', $2, 100, 100, 'Dr', $3)`, [guid, bill, co.id]);
  }
  return co;
}
const bills = async (co) => (await q('SELECT bill_name FROM bill_outstanding WHERE company_id = $1 ORDER BY bill_name', [co.id])).rows.map((r) => r.bill_name);
const row = (co, bill) => ({ XML: 'BillOutstanding.xml', COMPANY_GUID: co.guid, LedgerName: 'Synthetic Customer', BillName: bill, Amount: '50', PendingAmount: '50' });

test('a header-less bill chunk neither purges nor adds bills', async () => {
  const co = await companyWithBills();
  const uploadId = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id) VALUES ($1, 'synthetic-dev')`, [uploadId]);
  await processIngestedData('records', [row(co, 'INV-9')], co.guid, null, null, { companyId: co.id, uploadId, chunkKey: 'bo:0' });
  assert.deepEqual(await bills(co), ['INV-1', 'INV-2']);
});

test('staged bill rows do not touch live bills before publication', async () => {
  const co = await companyWithBills();
  const uploadId = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id) VALUES ($1, 'synthetic-dev')`, [uploadId]);
  await processIngestedData('records', [row(co, 'INV-9')], co.guid, null, null, { companyId: co.id, uploadId, chunkKey: 'bo:0', billSnapshotMode: 'staged' });
  assert.deepEqual(await bills(co), ['INV-1', 'INV-2'], 'live bills unchanged until /ingest/complete publishes');
});
