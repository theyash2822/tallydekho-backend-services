import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Under `npm run test:isolated` the SQL cases run on the disposable cluster; the app modules must
// load after the harness has pointed DATABASE_URL at it.
if (process.env.TD_ISOLATED_TEST === '1') {
  const { setupIsolatedDb } = await import('./isolated/isolatedDb.js');
  await setupIsolatedDb();
}
const {
  parseVoucherLists,
  reconcileDeletedVouchers,
  VOUCHER_CHILD_TABLES,
  MASS_MIN,
  voucherDeletionMode,
} = await import('../services/voucherDeletion.js');
const { purgeTablesFor } = await import('../services/companyPurge.js');

const CO_ID = 13114; // Laveena (real company row); every case runs in a rolled-back transaction
const CO = '2d96a00f-9865-4be5-b8c6-7b9ced59d5df';
const FY = '2030-2031';
const UPLOAD = 'tdk-test-voucher-deletion-upload';
const UPLOAD_START = 2_000_000_000;
const RUN_START = UPLOAD_START - 600; // sync run starts before the Tally fetches, the upload after
const RUN_ID = '00000000-0000-4000-8000-00000000d1e7';
const OLD = RUN_START - 100;

const list = (ids, extra = {}) => ({
  companyGuid: CO,
  complete: true,
  years: [{ finYear: FY, from: '2030-04-01', to: '2031-03-31', ids }],
  ...extra,
});

describe('parseVoucherLists', () => {
  test('complete list becomes per-FY id sets', () => {
    const m = parseVoucherLists({ voucherLists: [list(['00000001', '0000000a'])] });
    const s = m.get(CO);
    assert.equal(s.complete, true);
    assert.deepEqual([...s.years[0].ids], ['00000001', '0000000a']);
  });

  test('incomplete or malformed lists never authorise deletion', () => {
    const bad = [
      { companyGuid: CO, complete: false, reason: 'context_report_missing' },
      { companyGuid: CO, complete: 'true', years: list([]).years },
      list(['00000001'], { years: [] }),
      list(['../x']),
      list([1]),
      { ...list([]), years: [{ finYear: '2030', from: '2030-04-01', to: '2031-03-31', ids: [] }] },
      { ...list([]), years: [{ finYear: FY, from: '20300401', to: '2031-03-31', ids: [] }] },
      { ...list([]), years: [{ finYear: FY, from: '2031-04-01', to: '2030-03-31', ids: [] }] },
    ];
    for (const b of bad) {
      const s = parseVoucherLists({ voucherLists: [b] }).get(CO);
      assert.equal(s.complete, false, JSON.stringify(b));
      assert.deepEqual(s.years, []);
    }
    assert.equal(parseVoucherLists({}).size, 0);
  });
});

describe('reconcileDeletedVouchers (real SQL, rolled back)', () => {
  let schema;
  const inTx = async (fn) => {
    schema ||= await import('../db/schema.js');
    const client = await schema.getClient();
    try {
      await client.query('BEGIN');
      // A disposable database has no Laveena row; create a synthetic one inside the rolled-back transaction.
      const { rows: present } = await client.query('SELECT 1 FROM companies WHERE id = $1', [CO_ID]);
      if (!present.length) {
        await client.query(`INSERT INTO workspaces (id, name) VALUES ('tdk-test-vd-ws', 'Synthetic')`);
        await client.query(
          `INSERT INTO companies (id, guid, name, is_active, workspace_id) VALUES ($1, $2, 'Synthetic', TRUE, 'tdk-test-vd-ws')`,
          [CO_ID, CO]
        );
      }
      await client.query('INSERT INTO ingest_uploads (id, device_id, created_at) VALUES ($1, $2, $3)', [UPLOAD, 'tdk-test', UPLOAD_START]);
      await client.query(
        `INSERT INTO sync_runs (id, company_guid, company_id, sync_type, status, started_at) VALUES ($1, $2, $3, 'normal', 'running', to_timestamp($4))`,
        [RUN_ID, CO, CO_ID, RUN_START]
      );
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  };
  const addVoucher = (client, guid, { date = '2030-06-01', syncedAt = OLD, cancelled = false, raw = null } = {}) =>
    client.query(
      `INSERT INTO vouchers (guid, company_guid, company_id, voucher_type, date, amount, is_cancelled, synced_at, raw_data)
       VALUES ($1, $2, $3, 'Sales', $4, 100, $5, $6, $7)`,
      [guid, CO, CO_ID, date, cancelled, syncedAt, raw]
    );
  const exists = async (client, guid) =>
    (await client.query('SELECT 1 FROM vouchers WHERE company_id = $1 AND guid = $2', [CO_ID, guid])).rows.length === 1;
  const run = (client, summary, extra = {}) => reconcileDeletedVouchers(client, {
    uploadId: UPLOAD, syncRunId: RUN_ID, companyId: CO_ID, companyGuid: CO, mode: 'on',
    summary: parseVoucherLists({ voucherLists: [summary] }).get(CO),
    ...extra,
  });

  test('deletes only Tally-origin, uncancelled, older vouchers of the listed FY that Tally no longer has', () => inTx(async (c) => {
    const g = (s) => `${CO}-${s}`;
    for (let i = 1; i <= 6; i++) await addVoucher(c, g(`aa00000${i}`));
    await addVoucher(c, g('bb000001'));
    await c.query(
      `INSERT INTO voucher_ledger_entries (voucher_guid, company_guid, company_id, ledger_name, amount) VALUES ($1, $2, $3, 'Party', 100)`,
      [g('bb000001'), CO, CO_ID]
    );
    await addVoucher(c, g('cc000001'), { cancelled: true });
    await addVoucher(c, g('dd000001'), { syncedAt: UPLOAD_START + 5 });
    await addVoucher(c, `v-b-tdktest-${Date.now()}`);
    await addVoucher(c, g('ee000001'), { date: '', raw: JSON.stringify({ YEAR_ID: `${CO}_${FY}` }) });
    await addVoucher(c, g('ff000001'), { date: '2029-06-01' });

    const r = await run(c, list(['aa000001', 'aa000002', 'aa000003', 'aa000004', 'aa000005', 'aa000006']));
    assert.equal(r.action, 'deleted');
    assert.equal(r.deleted, 2);
    assert.deepEqual(r.years, [{ finYear: FY, held: 8, inTally: 6, missing: 2 }]);
    assert.equal(await exists(c, g('bb000001')), false, 'missing from Tally → deleted');
    assert.equal(await exists(c, g('ee000001')), false, 'dateless stub of the FY → deleted');
    assert.equal(await exists(c, g('aa000001')), true, 'still in Tally');
    assert.equal(await exists(c, g('cc000001')), true, 'cancelled vouchers are not in the list, never deleted');
    assert.equal(await exists(c, g('dd000001')), true, 'written by this upload');
    assert.equal(await exists(c, g('ff000001')), true, 'outside the listed FY');
    const vle = await c.query('SELECT 1 FROM voucher_ledger_entries WHERE company_id = $1 AND voucher_guid = $2', [CO_ID, g('bb000001')]);
    assert.equal(vle.rows.length, 0, 'child rows go with the voucher');
    const app = await c.query(`SELECT 1 FROM vouchers WHERE company_id = $1 AND guid LIKE 'v-b-tdktest-%'`, [CO_ID]);
    assert.equal(app.rows.length, 1, 'app-created voucher untouched');
  }));

  test('a verified empty FY deletes its last voucher (the Laveena case)', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000009`);
    const r = await run(c, list([]));
    assert.equal(r.action, 'deleted');
    assert.equal(r.deleted, 1);
  }));

  test('incomplete list keeps everything', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000009`);
    const r = await run(c, { companyGuid: CO, complete: false, reason: 'context_company_not_open' });
    assert.equal(r.action, 'kept');
    assert.equal(r.reason, 'context_company_not_open');
    assert.equal(await exists(c, `${CO}-aa000009`), true);
  }));

  test('mass deletion is refused', () => inTx(async (c) => {
    for (let i = 0; i <= MASS_MIN; i++) await addVoucher(c, `${CO}-ab${String(i).padStart(6, '0')}`);
    const r = await run(c, list([]));
    assert.equal(r.action, 'kept');
    assert.equal(r.reason, `mass_delete_guard:${FY}`);
    assert.equal(r.deleted, 0);
    assert.equal(await exists(c, `${CO}-ab000000`), true);
  }));

  test('a voucher written after the sync run started is protected, even before the upload began', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000007`, { syncedAt: RUN_START + 30 });
    const r = await run(c, list([]));
    assert.equal(r.action, 'none');
    assert.equal(await exists(c, `${CO}-aa000007`), true);
  }));

  test('no or unknown sync run → keep everything', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000009`);
    assert.equal((await run(c, list([]), { syncRunId: null })).reason, 'no_sync_run');
    assert.equal((await run(c, list([]), { syncRunId: 'not-a-uuid' })).reason, 'no_sync_run');
    assert.equal((await run(c, list([]), { syncRunId: '00000000-0000-4000-8000-0000000000ff' })).reason, 'sync_run_not_found');
    assert.equal(await exists(c, `${CO}-aa000009`), true);
  }));

  test('dry_run reports without deleting; off does nothing', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000009`);
    const dry = await run(c, list([]), { mode: 'dry_run' });
    assert.equal(dry.action, 'dry_run');
    assert.equal(dry.missing, 1);
    assert.equal(dry.deleted, 0);
    assert.equal((await run(c, list([]), { mode: 'off' })).reason, 'disabled');
    assert.equal(await exists(c, `${CO}-aa000009`), true);
  }));

  test('nothing missing → none', () => inTx(async (c) => {
    await addVoucher(c, `${CO}-aa000001`);
    const r = await run(c, list(['aa000001']));
    assert.equal(r.action, 'none');
    assert.equal(r.deleted, 0);
  }));
});

describe('wiring', () => {
  test('VOUCHER_DELETION_MODE defaults to on', () => {
    assert.equal(voucherDeletionMode({}), 'on');
    assert.equal(voucherDeletionMode({ VOUCHER_DELETION_MODE: 'DRY_RUN' }), 'dry_run');
    assert.equal(voucherDeletionMode({ VOUCHER_DELETION_MODE: 'off' }), 'off');
    assert.equal(voucherDeletionMode({ VOUCHER_DELETION_MODE: 'weird' }), 'on');
  });

  test('child tables match the hard-sync projection, minus bills', () => {
    const projection = new Set(purgeTablesFor());
    for (const t of VOUCHER_CHILD_TABLES) {
      if (t === 'voucher_bill_allocations') continue;
      assert.ok(projection.has(t), `${t} is a Tally projection table`);
    }
    assert.ok(!VOUCHER_CHILD_TABLES.includes('bill_outstanding'));
  });

  test('/ingest/complete runs the check per company and reports it', () => {
    const src = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');
    assert.match(src, /reconcileDeletedVouchersTx\(\{\s*uploadId,\s*syncRunId: body\?\.syncRunId \|\| null,\s*companyId: company\.id,\s*companyGuid: company\.guid,/);
    assert.match(src, /voucherDeletions: voucherDeletionResults/);
  });
});
