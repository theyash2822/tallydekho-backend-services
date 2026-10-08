// P2 integrity on the disposable cluster only (synthetic rows, unique ids per run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);

const { claimChunk, markChunkApplied, releaseChunkClaim } = await import('../../utils/chunkReceipts.js');
const { startSyncRun, heartbeatSyncRun, finishSyncRun, sweepStaleSyncRuns } = await import('../../utils/syncRuns.js');
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');
const { IngestBatchError } = await import('../../utils/ingestCompanyDualWrite.js');

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

test.after(async () => {
  await schema.getPool().end().catch(() => {});
});

test('chunk receipts: claim, in-progress, duplicate, conflict, release', async () => {
  const key = { uploadId: uniq('up'), stream: 'vouchers', chunkIndex: 0 };
  const first = await claimChunk(q, { ...key, hash: 'h1', recordCount: 3 });
  assert.equal(first.outcome, 'claimed');
  assert.equal((await claimChunk(q, { ...key, hash: 'h1', recordCount: 3 })).outcome, 'in_progress');
  assert.equal((await claimChunk(q, { ...key, hash: 'h2', recordCount: 3 })).outcome, 'conflict');
  await markChunkApplied(q, key);
  assert.equal((await claimChunk(q, { ...key, hash: 'h1', recordCount: 3 })).outcome, 'duplicate');

  const other = { ...key, chunkIndex: 1 };
  assert.equal((await claimChunk(q, { ...other, hash: 'x', recordCount: 1 })).outcome, 'claimed');
  await releaseChunkClaim(q, other);
  assert.equal((await claimChunk(q, { ...other, hash: 'x', recordCount: 1 })).outcome, 'claimed');
});

test('chunk receipts: a stale applying claim can be taken over', async () => {
  const key = { uploadId: uniq('up'), stream: 'master', chunkIndex: 0 };
  await claimChunk(q, { ...key, hash: 'h', recordCount: 1 });
  await q(
    `UPDATE ingest_chunk_receipts SET claimed_at = NOW() - INTERVAL '1 hour'
      WHERE upload_id = $1 AND stream = $2 AND chunk_index = $3`,
    [key.uploadId, key.stream, key.chunkIndex]
  );
  assert.equal((await claimChunk(q, { ...key, hash: 'h', recordCount: 1 })).outcome, 'claimed');
});

test('sync runs: owner-only heartbeat and single fenced terminal transition', async () => {
  const companyGuid = uniq('g');
  const id = await startSyncRun(q, { companyGuid, companyId: null, deviceId: 'dev-a', syncType: 'normal' });
  assert.equal(await heartbeatSyncRun(q, { syncRunId: id, deviceId: 'dev-b' }), false);
  assert.equal(await heartbeatSyncRun(q, { syncRunId: id, deviceId: 'dev-a' }), true);

  const foreign = await finishSyncRun(q, { syncRunId: id, deviceId: 'dev-b', status: 'completed' });
  assert.deepEqual(foreign, { ok: false, reason: 'not_owner' });

  assert.deepEqual(await finishSyncRun(q, { syncRunId: id, deviceId: 'dev-a', status: 'partial' }), { ok: true });
  const again = await finishSyncRun(q, { syncRunId: id, deviceId: 'dev-a', status: 'completed' });
  assert.equal(again.reason, 'not_running');
  assert.equal(again.status, 'partial');
});

test('sync runs: expired leases are swept to abandoned', async () => {
  const companyGuid = uniq('g');
  const stale = await startSyncRun(q, { companyGuid, companyId: null, deviceId: 'dev-a' });
  await q(`UPDATE sync_runs SET heartbeat_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [stale]);
  const fresh = await startSyncRun(q, { companyGuid, companyId: null, deviceId: 'dev-a' });
  const { rows } = await q(`SELECT id, status FROM sync_runs WHERE id = ANY($1::uuid[])`, [[stale, fresh]]);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.equal(byId[stale], 'abandoned');
  assert.equal(byId[fresh], 'running');
  assert.equal(await sweepStaleSyncRuns(q, { companyGuid }), 0);
});

test('payment-mode map unique index exists after initSchema', async () => {
  const { rows } = await q(
    `SELECT 1 FROM pg_indexes WHERE tablename = 'payment_mode_posting_map'
       AND indexdef ILIKE '%UNIQUE%' AND indexdef ILIKE '%(workspace_id, company_guid, payment_mode)%'`
  );
  assert.ok(rows.length >= 1);
});

test('payment-mode map save replaces atomically and keeps the last entry per mode', async () => {
  const { putPaymentModeMap } = await import('../../services/workspaceService.js');
  const co = await makeCompany();
  const { rows: ws } = await q(`SELECT workspace_id FROM companies WHERE id = $1`, [co.id]);
  const workspaceId = ws[0].workspace_id;
  await putPaymentModeMap(workspaceId, co.guid, null, [
    { paymentMode: 'UPI', ledgerName: 'Bank A' },
    { paymentMode: 'Cash', ledgerName: 'Cash' },
    { paymentMode: 'UPI', ledgerName: 'Bank B' },
  ]).catch((err) => {
    // The read-back after saving may need memberships this synthetic workspace lacks.
    if (!/access|member|capabil|forbidden|not found/i.test(err.message)) throw err;
  });
  await putPaymentModeMap(workspaceId, co.guid, null, [
    { paymentMode: 'UPI', ledgerName: 'Bank C' },
  ]).catch((err) => {
    if (!/access|member|capabil|forbidden|not found/i.test(err.message)) throw err;
  });
  const { rows } = await q(
    `SELECT payment_mode, ledger_name FROM payment_mode_posting_map
      WHERE workspace_id = $1 AND company_guid = $2 ORDER BY payment_mode`,
    [workspaceId, co.guid]
  );
  assert.deepEqual(rows, [{ payment_mode: 'UPI', ledger_name: 'Bank C' }]);
});

test('write_queue has the outcome_unknown flag defaulting to false', async () => {
  const { rows } = await q(
    `SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'write_queue' AND column_name = 'outcome_unknown'`
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].is_nullable, 'NO');
  assert.match(String(rows[0].column_default), /false/i);
});

test('thin Simplified stub does not wipe voucher number or inventory lines', async () => {
  const co = await makeCompany();
  const vGuid = `${co.guid}-00000001`;
  const full = {
    GUID: vGuid,
    VoucherNumber: 'S-1',
    VoucherTypeName: 'Sales',
    Date: '20250401',
    PartyLedgerName: 'Synthetic Customer',
    NARRATION: 'synthetic',
    ISCANCELLED: 'No',
    ALLLEDGERENTRIES: [{ LEDGERNAME: 'Synthetic Customer', AMOUNT: '-100' }],
    ALLINVENTORYENTRIES: [{ STOCKITEMNAME: 'Synthetic Bolt', ACTUALQTY: '2 nos', BILLEDQTY: '2 nos', RATE: '50/nos', AMOUNT: '100' }],
  };
  await processIngestedData('vouchers', [full], co.guid, null, null, { companyId: co.id });
  const before = await q(
    `SELECT COUNT(*)::int AS n FROM voucher_items WHERE company_id = $1 AND voucher_guid = $2 AND item_name IS NOT NULL`,
    [co.id, vGuid]
  );
  assert.ok(before.rows[0].n > 0, 'full voucher must have stored inventory lines');

  const thin = { GUID: vGuid, XML: 'SimplifiedVoucher.xml', VoucherTypeName: 'Sales', Date: '20250401' };
  await processIngestedData('vouchers', [thin], co.guid, null, null, { companyId: co.id });

  const { rows: v } = await q(
    `SELECT voucher_number, is_cancelled FROM vouchers WHERE company_id = $1 AND guid = $2`,
    [co.id, vGuid]
  );
  assert.equal(v[0].voucher_number, 'S-1');
  assert.equal(v[0].is_cancelled, false);
  const after = await q(
    `SELECT COUNT(*)::int AS n FROM voucher_items WHERE company_id = $1 AND voucher_guid = $2 AND item_name IS NOT NULL`,
    [co.id, vGuid]
  );
  assert.equal(after.rows[0].n, before.rows[0].n);
});

test('repeated item/godown lines are merged, not dropped', async () => {
  const co = await makeCompany();
  const vGuid = `${co.guid}-00000002`;
  const line = { VOUCHERGUID: vGuid, STOCKITEMNAME: 'Synthetic Nut', GODOWNNAME: 'Main', RATE: '10/nos' };
  await processIngestedData('master', [
    { ...line, XML: 'VoucherInventoryDetail.xml', ACTUALQTY: '2 nos', BILLEDQTY: '2 nos', AMOUNT: '20' },
    { ...line, XML: 'VoucherInventoryDetail.xml', ACTUALQTY: '3 nos', BILLEDQTY: '3 nos', AMOUNT: '30' },
  ], co.guid, null, null, { companyId: co.id });
  const { rows } = await q(
    `SELECT actual_qty::float AS qty, amount::float AS amount FROM voucher_inventory_items
      WHERE company_id = $1 AND voucher_guid = $2`,
    [co.id, vGuid]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].qty, 5);
  assert.equal(rows[0].amount, 50);
});

test('a rolled-back batch is reported as a failure, not success', async () => {
  const co = await makeCompany();
  const vGuid = `${co.guid}-00000003`;
  // Force a statement error inside the voucher transaction: an over-long numeric value.
  const bad = {
    GUID: vGuid,
    VoucherNumber: 'S-3',
    VoucherTypeName: 'Sales',
    Date: '20250401',
    PartyLedgerName: 'Synthetic Customer',
    ALLLEDGERENTRIES: [{ LEDGERNAME: 'Synthetic Customer', AMOUNT: '-1e400' }],
  };
  let thrown = null;
  try {
    await processIngestedData('vouchers', [bad], co.guid, null, null, { companyId: co.id });
  } catch (err) {
    thrown = err;
  }
  const { rows } = await q(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND guid = $2`, [co.id, vGuid]);
  if (rows[0].n === 0) {
    assert.ok(thrown instanceof IngestBatchError, 'a voucher batch that did not persist must throw IngestBatchError');
    assert.equal(thrown.code, 'INGEST_BATCH_FAILED');
  } else {
    assert.equal(thrown, null, 'a persisted batch must not report failure');
  }
});
