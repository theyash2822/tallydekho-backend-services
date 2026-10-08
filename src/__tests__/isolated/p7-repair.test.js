// P7 repair tooling on the disposable cluster only (synthetic rows, unique ids per run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const repair = await import('../../services/repairTools.js');

const NOW = Math.floor(Date.now() / 1000);

async function seed() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(
    `INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`,
    [guid, `Synthetic ${guid}`, workspaceId]
  );
  const companyId = rows[0].id;
  const v = (n, num, fy, extra = {}) => q(
    `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, party_name, narration, raw_data, financial_year, irn)
     VALUES ($1,$2,$3,$4,'Sales','20240501',$5,$6,$7,$8,$9)`,
    [`${guid}-v${n}`, guid, companyId, num, extra.party || 'Party', extra.narration || null, extra.raw || null, fy, extra.irn || null]
  );
  await v(1, '0042', '2024-2025');
  await v(2, '42', '2024-2025');
  await v(3, 'INV/1', '2023-2024', { party: 'A &#38; B' });
  await v(4, 'INV/2', '2025-2026', { raw: '<ALLINVENTORYENTRIES.LIST>', irn: 'IRN-SYN' });
  await q(
    `INSERT INTO voucher_items (voucher_guid, company_guid, company_id, ledger_name, amount, type)
     VALUES ($1,$2,$3,'Sales',100,'Cr')`,
    [`${guid}-v4`, guid, companyId]
  );
  for (const fy of ['2023-2024', '2024-2025', '2025-2026']) {
    await q(`INSERT INTO voucher_sync_watermarks (company_id, fin_year, alter_id, updated_at) VALUES ($1,$2,500,$3)`, [companyId, fy, NOW]);
  }
  await q(
    `INSERT INTO sync_runs (id, company_guid, company_id, sync_type, status, started_at, heartbeat_at)
     VALUES (gen_random_uuid(), $1, $2, 'normal', 'running', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
            (gen_random_uuid(), $1, $2, 'normal', 'running', NOW(), NOW())`,
    [guid, companyId]
  );
  const years = await q(
    `INSERT INTO company_years (company_guid, company_id, fin_year, begin_date, end_date, is_active)
     VALUES ($1,$2,'2021-2022','20210401','20220331',FALSE), ($1,$2,'2022-2023','20220401','20230331',FALSE),
            ($1,$2,'2024-2025','20240401','20250331',TRUE)
     RETURNING id, fin_year`,
    [guid, companyId]
  );
  const yearId = (fy) => years.rows.find((r) => r.fin_year === fy).id;
  return { workspaceId, companyId, guid, yearId };
}

test.after(async () => {
  await schema.getPool().end().catch(() => {});
});

test('preview is read-only and classifies I.1–I.8 within the company scope', async () => {
  const s = await seed();
  const other = await seed();
  const before = await q(`SELECT COUNT(*)::int AS n FROM voucher_sync_watermarks WHERE company_id = $1`, [s.companyId]);
  const d = await repair.diagnose(q, { workspaceId: s.workspaceId, companyId: s.companyId, nowSec: NOW });
  const after = await q(`SELECT COUNT(*)::int AS n FROM voucher_sync_watermarks WHERE company_id = $1`, [s.companyId]);
  assert.equal(after.rows[0].n, before.rows[0].n);

  const f = d.findings;
  assert.deepEqual(f['I.1'].refetchYears, ['2024-2025']);
  assert.deepEqual(f['I.2'].refetchYears, ['2025-2026']);
  assert.deepEqual(f['I.3'].refetchYears, ['2023-2024']);
  assert.equal(f['I.4'].classification, 'unverifiable');
  assert.equal(f['I.5'].classification, 'unverifiable');
  assert.equal(f['I.6'].counts.irnWithoutDetails, 1);
  assert.equal(f['I.7'].classification, 'confirmed');
  assert.equal(f['I.7'].staleRunIds.length, 1, 'only the run without a heartbeat for a day');
  assert.equal(f['I.8'].inactiveYears.length, 2);

  await assert.rejects(
    repair.diagnose(q, { workspaceId: other.workspaceId, companyId: s.companyId }),
    (e) => e.code === 'REPAIR_SCOPE_INVALID'
  );
});

test('apply needs the previewed hash, refuses changed state, is scoped and idempotent', async () => {
  const s = await seed();
  const other = await seed();
  const scope = { workspaceId: s.workspaceId, companyId: s.companyId, nowSec: NOW };
  const selectYearIds = [s.yearId('2022-2023')];
  const { hash, manifest, ownerOperations } = repair.buildManifest(await repair.diagnose(q, scope), { selectYearIds });
  assert.deepEqual(manifest.actions.map((a) => a.type).sort(), [
    'expire_stale_run', 'reactivate_year', 'reset_voucher_watermark', 'reset_voucher_watermark', 'reset_voucher_watermark',
  ]);
  assert.ok(ownerOperations.every((o) => o.status === 'OWNER_OPERATION_PENDING'));

  assert.throws(
    () => repair.buildManifest({ scope: { workspaceId: s.workspaceId, companyId: s.companyId }, findings: { 'I.8': { inactiveYears: [] } } }, { selectYearIds: [other.yearId('2021-2022')] }),
    (e) => e.code === 'REPAIR_SELECTION_INVALID'
  );

  const client = await schema.getPool().connect();
  try {
    await assert.rejects(repair.applyManifest(client, { ...scope, selectYearIds }), (e) => e.code === 'REPAIR_APPROVAL_REQUIRED');
    await assert.rejects(
      repair.applyManifest(client, { ...scope, selectYearIds, approvedHash: '0'.repeat(64) }),
      (e) => e.code === 'REPAIR_STATE_CHANGED'
    );

    await q(`UPDATE vouchers SET narration = 'x &#10; y' WHERE guid = $1`, [`${s.guid}-v4`]);
    await assert.rejects(
      repair.applyManifest(client, { ...scope, selectYearIds, approvedHash: hash }),
      (e) => e.code === 'REPAIR_STATE_CHANGED',
      'new evidence after the preview changes the manifest'
    );
    await q(`UPDATE vouchers SET narration = NULL WHERE guid = $1`, [`${s.guid}-v4`]);

    const res = await repair.applyManifest(client, { ...scope, selectYearIds, approvedHash: hash });
    assert.equal(res.before.watermarks, 3);
    assert.equal(res.after.watermarks, 0);
    assert.equal(res.before.running_runs, 2);
    assert.equal(res.after.running_runs, 1, 'live run untouched');
    assert.equal(res.after.inactive_years, 1, 'unselected inactive year stays inactive');
    assert.equal(res.after.vouchers, res.before.vouchers, 'no voucher rows removed');

    const again = repair.buildManifest(await repair.diagnose(q, scope), {});
    assert.ok(again.manifest.actions.every((a) => a.type === 'reset_voucher_watermark'), 'stale run and year already repaired');
    const rerun = await repair.applyManifest(client, { ...scope, approvedHash: again.hash });
    assert.ok(rerun.applied.every((a) => a.rows === 0), 'rerun changes nothing');
  } finally {
    client.release();
  }

  const o = await q(
    `SELECT (SELECT COUNT(*)::int FROM voucher_sync_watermarks WHERE company_id = $1) AS wm,
            (SELECT COUNT(*)::int FROM sync_runs WHERE company_id = $1 AND status = 'running') AS runs,
            (SELECT COUNT(*)::int FROM company_years WHERE company_id = $1 AND is_active = FALSE) AS years`,
    [other.companyId]
  );
  assert.deepEqual(o.rows[0], { wm: 3, runs: 2, years: 2 }, 'other company untouched');
});
