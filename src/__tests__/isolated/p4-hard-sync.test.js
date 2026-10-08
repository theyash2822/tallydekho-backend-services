// P4 hard sync (approval + deferred publication) on the disposable cluster only. Synthetic rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const {
  consumeHardSyncApproval, openHardSyncJob, publishHardSyncTx, sweepExpiredHardSyncJobs,
  APPROVAL_TTL_SECONDS, JOB_LEASE_SECONDS,
} = await import('../../services/hardSyncPublication.js');

const one = async () => 1;
const two = async () => 2;
const FY = { finYear: '2025-2026', begin: '20250401', end: '20260331' };
const LIST_FY = { finYear: '2025-2026', from: '2025-04-01', to: '2026-03-31' };

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  const deviceId = uniq('dev');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(
    `INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [guid, `Synthetic ${guid}`, workspaceId]
  );
  return { guid, id: rows[0].id, workspaceId, deviceId, manifest: [{ guid, years: [FY] }] };
}

async function voucher(co, guid, syncedAt, { cancelled = false, date = '2025-06-01' } = {}) {
  await q(
    `INSERT INTO vouchers (company_id, company_guid, guid, date, financial_year, is_cancelled, synced_at)
     VALUES ($1,$2,$3,$4,'2025-2026',$5,$6)`,
    [co.id, co.guid, guid, date, cancelled, syncedAt]
  );
  await q(
    `INSERT INTO voucher_ledger_entries (company_id, company_guid, voucher_guid, amount, synced_at)
     VALUES ($1,$2,$3,10,$4)`,
    [co.id, co.guid, guid, syncedAt]
  );
}

const ledger = (co, guid, syncedAt) => q(
  `INSERT INTO ledgers (company_id, company_guid, guid, name, synced_at) VALUES ($1,$2,$3,$4,$5)`,
  [co.id, co.guid, guid, `L ${guid}`, syncedAt]
);

const exists = async (table, col, val) =>
  (await q(`SELECT 1 FROM ${table} WHERE ${col} = $1`, [val])).rowCount > 0;

async function startJob(co, nowSec) {
  const { request } = await consumeHardSyncApproval(q, {
    workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: one, nowSec,
  });
  const job = await openHardSyncJob(q, {
    request, workspaceId: co.workspaceId, deviceId: co.deviceId,
    companyId: co.id, companyGuid: co.guid, years: [FY], nowSec,
  });
  return { request, job };
}

const publish = (co, nowSec, { verified = true, ids = [], complete = true } = {}) => publishHardSyncTx(
  () => schema.getPool().connect(),
  {
    deviceId: co.deviceId, companyId: co.id, companyGuid: co.guid, verified, nowSec,
    voucherList: complete ? { complete: true, years: [{ ...LIST_FY, ids: new Set(ids) }] } : { complete: false, reason: 'tdl_unverified' },
  }
);

test.after(async () => {
  await schema.getPool().end().catch(() => {});
});

test('approval: multi-member needs approval; one approval is consumed once; repeat init-sync reuses it', async () => {
  const co = await makeCompany();
  const t = 1_800_000_000;
  await assert.rejects(
    consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: two, nowSec: t }),
    { code: 'HARD_SYNC_APPROVAL_REQUIRED' }
  );
  const id = uniq('req');
  await q(
    `INSERT INTO hard_sync_requests (id, workspace_id, device_id, status, company_manifest_json, created_at, expires_at)
     VALUES ($1,$2,$3,'APPROVED',$4,$5,$6)`,
    [id, co.workspaceId, co.deviceId, JSON.stringify([{ guid: co.guid }]), t, t + APPROVAL_TTL_SECONDS]
  );
  const first = await consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: two, nowSec: t });
  assert.equal(first.request.id, id);
  assert.equal(first.reused, false);
  // No open job yet: the approval is spent, a second consume is refused.
  await assert.rejects(
    consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: two, nowSec: t + 1 }),
    { code: 'HARD_SYNC_APPROVAL_REQUIRED' }
  );
  await openHardSyncJob(q, { request: first.request, workspaceId: co.workspaceId, deviceId: co.deviceId, companyId: co.id, companyGuid: co.guid, years: [FY], nowSec: t });
  const again = await consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: two, nowSec: t + 5 });
  assert.equal(again.request.id, id);
  assert.equal(again.reused, true);
  const job2 = await openHardSyncJob(q, { request: again.request, workspaceId: co.workspaceId, deviceId: co.deviceId, companyId: co.id, companyGuid: co.guid, years: [FY], nowSec: t + 5 });
  assert.equal(Number(job2.started_at), t, 'repeat keeps the original start time');
});

test('approval: expired and scope-mismatched approvals are refused', async () => {
  const co = await makeCompany();
  const t = 1_800_000_000;
  const id = uniq('req');
  await q(
    `INSERT INTO hard_sync_requests (id, workspace_id, device_id, status, company_manifest_json, created_at, expires_at)
     VALUES ($1,$2,$3,'APPROVED',$4,$5,$6)`,
    [id, co.workspaceId, co.deviceId, JSON.stringify([{ guid: co.guid }]), t, t + 10]
  );
  await assert.rejects(
    consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: [{ guid: 'other' }], membershipCount: two, nowSec: t }),
    { code: 'HARD_SYNC_SCOPE_MISMATCH' }
  );
  await assert.rejects(
    consumeHardSyncApproval(q, { workspaceId: co.workspaceId, deviceId: co.deviceId, companies: co.manifest, membershipCount: two, nowSec: t + 11 }),
    { code: 'HARD_SYNC_EXPIRED' }
  );
  const { rows } = await q('SELECT status FROM hard_sync_requests WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'EXPIRED');
});

test('publication removes only stale, unlisted Tally rows; keeps placeholders, cancelled, fresh and listed rows', async () => {
  const co = await makeCompany();
  const t = 1_800_000_000;
  const old = t - 1000;
  const fresh = t + 10;
  const p = `${co.guid}-`;
  await voucher(co, `${p}gone`, old);
  await voucher(co, `${p}kept1`, old);
  await voucher(co, `${p}cancel`, old, { cancelled: true });
  await voucher(co, `${p}new`, fresh);
  await voucher(co, `app-${uniq('v')}`, old);
  await voucher(co, `${p}outside`, old, { date: '2024-06-01' });
  await ledger(co, `${p}L-gone`, old);
  await ledger(co, `${p}L-fresh`, fresh);
  await ledger(co, `app-${co.guid}`, old);

  await startJob(co, t);
  const r = await publish(co, fresh + 1, { ids: ['kept1', 'new'] });
  assert.equal(r.action, 'published');

  assert.equal(await exists('vouchers', 'guid', `${p}gone`), false);
  assert.equal(await exists('voucher_ledger_entries', 'voucher_guid', `${p}gone`), false);
  for (const g of [`${p}kept1`, `${p}cancel`, `${p}new`, `${p}outside`]) {
    assert.equal(await exists('vouchers', 'guid', g), true, g);
  }
  assert.equal((await q(`SELECT 1 FROM vouchers WHERE company_id = $1 AND guid LIKE 'app-%'`, [co.id])).rowCount, 1);
  assert.equal(await exists('ledgers', 'guid', `${p}L-gone`), false);
  assert.equal(await exists('ledgers', 'guid', `${p}L-fresh`), true);
  assert.equal(await exists('ledgers', 'guid', `app-${co.guid}`), true);

  const again = await publish(co, fresh + 2, { ids: [] });
  assert.equal(again.action, 'already', 'a published job never publishes twice');
});

test('a table this run did not re-observe is kept whole', async () => {
  const co = await makeCompany();
  const t = 1_800_000_000;
  await ledger(co, `${co.guid}-L1`, t - 50);
  await ledger(co, `${co.guid}-L2`, t - 50);
  await startJob(co, t);
  const r = await publish(co, t + 100, { ids: [] });
  assert.equal(r.action, 'published');
  assert.match(String(r.removed.ledgers), /^kept:no_rows_this_run/);
  assert.equal((await q('SELECT 1 FROM ledgers WHERE company_id = $1', [co.id])).rowCount, 2);
});

test('failed upload, incomplete list or expired lease publish nothing', async () => {
  for (const variant of ['unverified', 'incomplete', 'lease']) {
    const co = await makeCompany();
    const t = 1_800_000_000;
    await voucher(co, `${co.guid}-gone`, t - 10);
    await ledger(co, `${co.guid}-L-gone`, t - 10);
    await ledger(co, `${co.guid}-L-fresh`, t + 5);
    await startJob(co, t);
    const at = variant === 'lease' ? t + JOB_LEASE_SECONDS + 1 : t + 20;
    const r = await publish(co, at, { verified: variant !== 'unverified', complete: variant !== 'incomplete' });
    assert.notEqual(r.action, 'published', variant);
    assert.equal(await exists('vouchers', 'guid', `${co.guid}-gone`), true, variant);
    assert.equal(await exists('ledgers', 'guid', `${co.guid}-L-gone`), true, variant);
  }
});

test('expired preparing jobs are swept to abandoned', async () => {
  const co = await makeCompany();
  const t = 1_800_000_000;
  const { job } = await startJob(co, t);
  await sweepExpiredHardSyncJobs(q, t + JOB_LEASE_SECONDS + 1);
  const { rows } = await q('SELECT status FROM hard_sync_jobs WHERE id = $1', [job.id]);
  assert.equal(rows[0].status, 'abandoned');
});
