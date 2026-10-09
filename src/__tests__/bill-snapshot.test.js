import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseBillSnapshots,
  stageBillRows,
  applyBillSnapshot,
  isStagedMode,
} from '../services/billSnapshot.js';
import { purgeTablesFor } from '../services/companyPurge.js';

const STAGE_COLS = 15;

/** In-memory bill_outstanding + bill_outstanding_staging that understands the service's SQL. */
function fakeDb(initialBills = []) {
  const db = { bills: initialBills.map((b) => ({ ...b })), staging: [], nextId: 1 };
  db.query = async (sql, p = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (/^DELETE FROM bill_outstanding_staging WHERE upload_id=\$1 AND company_id=\$2 AND chunk_key=\$3/.test(s)) {
      const before = db.staging.length;
      db.staging = db.staging.filter((r) => !(r.upload_id === p[0] && r.company_id === p[1] && r.chunk_key === p[2]));
      return { rowCount: before - db.staging.length };
    }
    if (/^INSERT INTO bill_outstanding_staging/.test(s)) {
      for (let i = 0; i < p.length; i += STAGE_COLS) {
        const [upload_id, company_id, chunk_key, skipped, voucher_guid, company_guid, ledger_name, bill_name] = p.slice(i, i + STAGE_COLS);
        db.staging.push({ id: db.nextId++, upload_id, company_id, chunk_key, skipped, voucher_guid, company_guid, ledger_name, bill_name });
      }
      return { rowCount: p.length / STAGE_COLS };
    }
    if (/^SELECT COUNT\(\*\)::int AS total FROM bill_outstanding_staging/.test(s)) {
      return { rows: [{ total: db.staging.filter((r) => r.upload_id === p[0] && r.company_id === p[1]).length }] };
    }
    if (/pg_advisory_xact_lock/.test(s)) return { rows: [] };
    if (/^DELETE FROM bill_outstanding WHERE company_id=\$1/.test(s)) {
      const before = db.bills.length;
      db.bills = db.bills.filter((b) => b.company_id !== p[0]);
      return { rowCount: before - db.bills.length };
    }
    if (/^INSERT INTO bill_outstanding \(.*\) SELECT .* FROM bill_outstanding_staging/.test(s)) {
      const rows = db.staging.filter((r) => r.upload_id === p[0] && r.company_id === p[1] && !r.skipped);
      rows.forEach((r) => db.bills.push({ company_id: r.company_id, ledger_name: r.ledger_name, bill_name: r.bill_name }));
      return { rowCount: rows.length };
    }
    if (/^DELETE FROM bill_outstanding_staging WHERE upload_id=\$1 AND company_id=\$2$/.test(s)) {
      const before = db.staging.length;
      db.staging = db.staging.filter((r) => !(r.upload_id === p[0] && r.company_id === p[1]));
      return { rowCount: before - db.staging.length };
    }
    throw new Error(`fakeDb: unexpected SQL ${s.slice(0, 80)}`);
  };
  return db;
}

const row = (bill, extra = {}) => ({ skipped: false, company_guid: 'G1', ledger_name: 'Party', bill_name: bill, ...extra });
const old = (companyId, bill) => ({ company_id: companyId, ledger_name: 'Party', bill_name: bill });
const ok = (rowCount) => ({ status: 'SUCCESS', snapshotComplete: true, rowCount });
const billsOf = (db, companyId) => db.bills.filter((b) => b.company_id === companyId).map((b) => b.bill_name).sort();

test('SUCCESS spread over several chunks replaces the bills with every row', async () => {
  const db = fakeDb([old(1, 'OLD-1'), old(1, 'OLD-2')]);
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1'), row('B2')] });
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:1', rows: [row('B3')] });
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: ok(3) });
  assert.equal(r.action, 'replaced');
  assert.deepEqual(billsOf(db, 1), ['B1', 'B2', 'B3']);
  assert.equal(db.staging.length, 0, 'staging discarded');
});

test('a retried chunk is staged once (no duplicate bills)', async () => {
  const db = fakeDb();
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1'), row('B2')] });
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1'), row('B2')] });
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: ok(2) });
  assert.equal(r.action, 'replaced');
  assert.deepEqual(billsOf(db, 1), ['B1', 'B2']);
});

test('SUCCESS with zero rows clears the company bills', async () => {
  const db = fakeDb([old(1, 'PAID-LONG-AGO')]);
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: ok(0) });
  assert.equal(r.action, 'cleared');
  assert.deepEqual(billsOf(db, 1), []);
});

for (const status of ['TDL_NOT_LOADED', 'LEGACY_EMPTY_AMBIGUOUS', 'TALLY_TIMEOUT', 'TALLY_UNREACHABLE', 'INVALID_RESPONSE', 'PARSE_FAILED', 'COMPANY_CONTEXT_MISMATCH']) {
  test(`${status} keeps the previous bills`, async () => {
    const db = fakeDb([old(1, 'KEEP-ME')]);
    const r = await applyBillSnapshot(db, {
      uploadId: 'u1', companyId: 1, summary: { status, snapshotComplete: false, rowCount: 0 },
    });
    assert.equal(r.action, 'preserved');
    assert.equal(r.reason, status);
    assert.deepEqual(billsOf(db, 1), ['KEEP-ME']);
  });
}

test('SUCCESS but a chunk never arrived → staged count mismatch keeps the previous bills', async () => {
  const db = fakeDb([old(1, 'KEEP-ME')]);
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1')] });
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: ok(2) });
  assert.equal(r.action, 'preserved');
  assert.equal(r.reason, 'staged_count_mismatch');
  assert.deepEqual(billsOf(db, 1), ['KEEP-ME']);
  assert.equal(db.staging.length, 0);
});

test('SUCCESS without snapshotComplete is not trusted', async () => {
  const db = fakeDb([old(1, 'KEEP-ME')]);
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: { status: 'SUCCESS', snapshotComplete: false, rowCount: 0 } });
  assert.equal(r.action, 'preserved');
  assert.deepEqual(billsOf(db, 1), ['KEEP-ME']);
});

test('no summary for the company keeps the previous bills and drops its staging', async () => {
  const db = fakeDb([old(1, 'KEEP-ME')]);
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1')] });
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: undefined });
  assert.equal(r.action, 'preserved');
  assert.deepEqual(billsOf(db, 1), ['KEEP-ME']);
  assert.equal(db.staging.length, 0);
});

test('skippable rows count toward the total but never reach bill_outstanding', async () => {
  const db = fakeDb();
  await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('B1'), row('ZERO', { skipped: true })] });
  const r = await applyBillSnapshot(db, { uploadId: 'u1', companyId: 1, summary: ok(2) });
  assert.equal(r.action, 'replaced');
  assert.deepEqual(billsOf(db, 1), ['B1']);
});

test('one company swap never touches another company, in either order', async () => {
  for (const order of [[1, 2], [2, 1]]) {
    const db = fakeDb([old(1, 'C1-OLD'), old(2, 'C2-OLD')]);
    await stageBillRows(db, { uploadId: 'u1', companyId: 1, chunkKey: 'records:0', rows: [row('C1-NEW')] });
    const summaries = { 1: ok(1), 2: { status: 'TDL_NOT_LOADED', snapshotComplete: false, rowCount: 0 } };
    for (const id of order) {
      await applyBillSnapshot(db, { uploadId: id === 1 ? 'u1' : 'u2', companyId: id, summary: summaries[id] });
    }
    assert.deepEqual(billsOf(db, 1), ['C1-NEW']);
    assert.deepEqual(billsOf(db, 2), ['C2-OLD']);
  }
});

test('parseBillSnapshots keeps only well-formed summaries', () => {
  const m = parseBillSnapshots({
    billSnapshots: [
      { companyGuid: 'A', status: 'SUCCESS', snapshotComplete: true, rowCount: 3, tdlStatus: 'ACTIVE' },
      { companyGuid: 'B', status: 'SUCCESS', snapshotComplete: 'yes', rowCount: 0 },
      { companyGuid: 'C', status: 'SUCCESS', snapshotComplete: true, rowCount: -1 },
      { companyGuid: '', status: 'SUCCESS', snapshotComplete: true, rowCount: 1 },
      { companyGuid: 'D', snapshotComplete: true, rowCount: 1 },
    ],
  });
  assert.deepEqual([...m.keys()], ['A', 'B']);
  assert.equal(m.get('A').snapshotComplete, true);
  assert.equal(m.get('B').snapshotComplete, false, 'only literal true counts');
  assert.equal(parseBillSnapshots({}).size, 0);
});

test('staged mode header parsing', () => {
  assert.equal(isStagedMode('staged'), true);
  assert.equal(isStagedMode(' Staged '), true);
  assert.equal(isStagedMode(undefined), false);
  assert.equal(isStagedMode('direct'), false);
});

test('hard sync keeps bills; reset/delete and GUID replacement still wipe them', () => {
  assert.ok(!purgeTablesFor({ keepBillOutstanding: true }).includes('bill_outstanding'));
  assert.ok(!purgeTablesFor({ keepBillOutstanding: true }).includes('bill_outstanding_staging'));
  assert.ok(purgeTablesFor().includes('bill_outstanding'));
  assert.ok(purgeTablesFor().includes('vouchers'));
  // P4: hard sync never purges up front; publication removes only bills older than the verified upload.
  const hard = readFileSync(new URL('../services/hardSyncService.js', import.meta.url), 'utf8');
  assert.doesNotMatch(hard, /purgeCompan/);
  const publish = readFileSync(new URL('../services/hardSyncPublication.js', import.meta.url), 'utf8');
  assert.match(publish, /DELETE FROM bill_outstanding WHERE company_id = \$1 AND COALESCE\(synced_at, 0\) < \$2/);
});

test('ingest routes wire the staged header into chunks and summaries into complete', () => {
  const src = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');
  assert.match(src, /billSnapshotMode: req\.headers\['bill-snapshot-mode'\]/);
  assert.match(src, /chunkKey: `\$\{streamName\}:\$\{chunkIndex\}`/);
  assert.match(src, /applyBillSnapshotTx\(\{ uploadId, companyId: company\.id, summary \}\)/);
});
