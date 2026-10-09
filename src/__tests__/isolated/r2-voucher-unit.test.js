// R2 / X4: voucher header, ledger lines, bill + batch allocations and the app-link
// reconciliation commit as one unit; nothing (and no posting event) survives a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');
const { IngestBatchError } = await import('../../utils/ingestCompanyDualWrite.js');
const { setupSocket } = await import('../../socket/socketHandler.js');

const emitted = [];
setupSocket({ on: () => {}, to: (room) => ({ emit: (event) => emitted.push({ room, event }) }) });
test.after(() => pool.end());

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(`INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`, [guid, `Synthetic ${guid}`, workspaceId]);
  return { guid, id: rows[0].id, workspaceId };
}
async function appEntry(co, ref) {
  await q(
    `INSERT INTO app_vouchers (company_guid, company_id, voucher_type, tdk_reference_no, created_at, updated_at)
     VALUES ($1, $2, 'sales_invoice', $3, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)`,
    [co.guid, co.id, ref],
  );
}
const voucher = (co, v, ref, batch) => ({
  GUID: v, VoucherNumber: 'S-41', VoucherTypeName: 'Sales', Date: '20250510', Reference: ref,
  PartyLedgerName: 'Synthetic Customer',
  ALLLEDGERENTRIES: [
    { LEDGERNAME: 'Synthetic Customer', ISPARTYLEDGER: 'Yes', AMOUNT: '-100', BILLALLOCATIONS: [{ NAME: ref, BILLTYPE: 'New Ref', AMOUNT: '-100' }] },
    { LEDGERNAME: 'Sales', AMOUNT: '100' },
  ],
  ALLINVENTORYENTRIES: [{
    STOCKITEMNAME: 'Widget', ACTUALQTY: '1 Nos', RATE: '100', AMOUNT: '100',
    BATCHALLOCATIONS: [{ BATCHNAME: batch, GODOWNNAME: 'Main', ACTUALQTY: '1 Nos', RATE: '100' }],
  }],
});
const state = async (co, v, ref) => ({
  voucher: (await q('SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND guid = $2', [co.id, v])).rows[0].n,
  ledgerLines: (await q('SELECT COUNT(*)::int AS n FROM voucher_ledger_entries WHERE company_id = $1 AND voucher_guid = $2', [co.id, v])).rows[0].n,
  bills: (await q('SELECT COUNT(*)::int AS n FROM voucher_bill_allocations WHERE company_id = $1 AND voucher_guid = $2', [co.id, v])).rows[0].n,
  batches: (await q('SELECT COUNT(*)::int AS n FROM batch_allocations WHERE company_id = $1 AND voucher_guid = $2', [co.id, v])).rows[0].n,
  appLink: (await q('SELECT tally_voucher_no FROM app_vouchers WHERE company_id = $1 AND tdk_reference_no = $2', [co.id, ref])).rows[0]?.tally_voucher_no ?? null,
});

test('a failing batch-allocation write rolls back the header, children and the app link; no event', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-x4`;
  const ref = `TDK-SAL-${uniq('r')}`;
  await appEntry(co, ref);
  await q(`ALTER TABLE batch_allocations ADD CONSTRAINT x4_fault_batch CHECK (batch_name <> 'X4-FAIL') NOT VALID`);
  emitted.length = 0;
  try {
    await assert.rejects(
      processIngestedData('vouchers', [voucher(co, v, ref, 'X4-FAIL')], co.guid, null, null, { companyId: co.id }),
      (err) => err instanceof IngestBatchError,
    );
  } finally {
    await q('ALTER TABLE batch_allocations DROP CONSTRAINT IF EXISTS x4_fault_batch');
  }
  assert.deepEqual(await state(co, v, ref), { voucher: 0, ledgerLines: 0, bills: 0, batches: 0, appLink: null });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(emitted.filter((e) => e.event === 'voucher:tallySynced'), [], 'no posting event for a rolled-back unit');
});

test('the corrected replay commits the whole unit once and announces it once', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-x4ok`;
  const ref = `TDK-SAL-${uniq('r')}`;
  await appEntry(co, ref);
  emitted.length = 0;
  await processIngestedData('vouchers', [voucher(co, v, ref, 'B-1')], co.guid, null, null, { companyId: co.id });
  await processIngestedData('vouchers', [voucher(co, v, ref, 'B-1')], co.guid, null, null, { companyId: co.id });
  assert.deepEqual(await state(co, v, ref), { voucher: 1, ledgerLines: 2, bills: 1, batches: 1, appLink: 'S-41' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emitted.filter((e) => e.event === 'voucher:tallySynced').length, 1, 'announced once');
});

// R2 / X2: a thin index row records the newer version it saw but never claims it applied.
const full = (v, alterId, narration) => ({
  XML: 'Voucher.xml', GUID: v, VoucherNumber: 'S-9', VoucherTypeName: 'Sales', Date: '20250601', AlterId: String(alterId),
  PartyLedgerName: 'Synthetic Customer', Narration: narration,
  ALLLEDGERENTRIES: [{ LEDGERNAME: 'Synthetic Customer', AMOUNT: '-50' }, { LEDGERNAME: 'Sales', AMOUNT: '50' }],
  ALLINVENTORYENTRIES: [{ STOCKITEMNAME: 'Widget', ACTUALQTY: '5', RATE: '10', AMOUNT: '50' }],
});
const stub = (v, alterId) => ({ XML: 'SimplifiedVoucher.xml', GUID: v, VoucherTypeName: 'Sales', Date: '20250601', AlterId: String(alterId) });
const versions = async (co, v) => (await q(
  `SELECT alter_id::int AS applied, observed_alter_id::int AS observed, raw_data LIKE '%' || $3 || '%' AS has_full,
          (SELECT COUNT(*)::int FROM voucher_items i WHERE i.company_id = vouchers.company_id AND i.voucher_guid = vouchers.guid AND i.item_name IS NOT NULL) AS items
     FROM vouchers WHERE company_id = $1 AND guid = $2`, [co.id, v, 'Narration']
)).rows[0];
const ingest = (co, rows) => processIngestedData('vouchers', rows, co.guid, null, null, { companyId: co.id });

test('X2: full(v10), stub(v11), full(v11): details stay required until the full v11 arrives', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-x2`;
  await ingest(co, [full(v, 10, 'first')]);
  assert.deepEqual(await versions(co, v), { applied: 10, observed: 10, has_full: true, items: 1 });
  await ingest(co, [stub(v, 11)]);
  assert.deepEqual(await versions(co, v), { applied: 10, observed: 11, has_full: true, items: 1 }, 'stub moved only the observed version');
  const { rows: wm } = await q('SELECT MAX(alter_id)::int AS max FROM vouchers WHERE company_id = $1', [co.id]);
  assert.equal(wm[0].max, 10, 'the voucher watermark still asks for v11 details');
  await ingest(co, [full(v, 11, 'second')]);
  assert.deepEqual(await versions(co, v), { applied: 11, observed: 11, has_full: true, items: 1 });
});

test('X2: a stub that arrives first is stored as observed only; old full data after it does not claim the newer version', async () => {
  const co = await makeCompany();
  const v = `${co.guid}-x2b`;
  await ingest(co, [stub(v, 12)]);
  assert.deepEqual(await versions(co, v), { applied: 0, observed: 12, has_full: false, items: 0 });
  await ingest(co, [full(v, 11, 'older')]);
  const after = await versions(co, v);
  assert.deepEqual([after.applied, after.observed], [11, 12]);
});
