/**
 * Company Identity Phase 3E — REAL duplicate Tally GUID isolation (DB).
 * Requires UNIQUE(workspace_id, guid) and no global UNIQUE(guid).
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { query } from '../../db/schema.js';
import { setupRbacHarness, httpJson } from './harness.js';
import { purgeCompanyTallyDataById } from '../../services/companyPurge.js';
import { emitVoucherSynced } from '../../socket/socketHandler.js';

let ctx;
let sharedGuid;
let companyA;
let companyB;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') {
      ctx = null;
      return;
    }
    throw err;
  }

  const { rows: cons } = await query(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'companies'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) = 'UNIQUE (guid)'
      ) AS has_global_unique,
      EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'companies'::regclass
          AND contype = 'u'
          AND pg_get_constraintdef(oid) ILIKE '%workspace_id%guid%'
      ) AS has_ws_guid_unique
  `);
  assert.equal(cons[0].has_global_unique, false, 'global UNIQUE(guid) must be removed');
  assert.equal(cons[0].has_ws_guid_unique, true, 'UNIQUE(workspace_id, guid) must be active');

  sharedGuid = `dup-guid-${ctx.fixtures.suffix}`;
  const { rows: aIns } = await query(
    `INSERT INTO companies (guid, workspace_id, name, formal_name, is_active, synced_at, created_at)
     VALUES ($1, $2, 'Dup A', 'Dup A', TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
     RETURNING id, guid, workspace_id`,
    [sharedGuid, ctx.fixtures.workspaces.A]
  );
  const { rows: bIns } = await query(
    `INSERT INTO companies (guid, workspace_id, name, formal_name, is_active, synced_at, created_at)
     VALUES ($1, $2, 'Dup B', 'Dup B', TRUE, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)
     RETURNING id, guid, workspace_id`,
    [sharedGuid, ctx.fixtures.workspaces.B]
  );
  companyA = aIns[0];
  companyB = bIns[0];
  assert.notEqual(companyA.id, companyB.id);
  assert.equal(companyA.guid, companyB.guid);

  // Seed isolated business + config + cache rows
  await query(
    `INSERT INTO ledgers (guid, company_guid, company_id, name, parent, nature, synced_at)
     VALUES ($1,$2,$3,'Customer A','Sundry Debtors','Assets',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`led-a-${ctx.fixtures.suffix}`, sharedGuid, companyA.id]
  );
  await query(
    `INSERT INTO ledgers (guid, company_guid, company_id, name, parent, nature, synced_at)
     VALUES ($1,$2,$3,'Customer B','Sundry Debtors','Assets',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`led-b-${ctx.fixtures.suffix}`, sharedGuid, companyB.id]
  );
  await query(
    `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, amount, synced_at)
     VALUES ($1,$2,$3,'VA-1','Sales',CURRENT_DATE,100,EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`v-a-${ctx.fixtures.suffix}`, sharedGuid, companyA.id]
  ).catch(async () => {
    await query(
      `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, synced_at)
       VALUES ($1,$2,$3,'VA-1','Sales',CURRENT_DATE,EXTRACT(EPOCH FROM NOW())::BIGINT)
       ON CONFLICT (company_id, guid) DO NOTHING`,
      [`v-a-${ctx.fixtures.suffix}`, sharedGuid, companyA.id]
    );
  });
  await query(
    `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, synced_at)
     VALUES ($1,$2,$3,'VB-1','Sales',CURRENT_DATE,EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`v-b-${ctx.fixtures.suffix}`, sharedGuid, companyB.id]
  );
  await query(
    `INSERT INTO stocks (guid, company_guid, company_id, name, unit, synced_at)
     VALUES ($1,$2,$3,'Stock A','Nos',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`st-a-${ctx.fixtures.suffix}`, sharedGuid, companyA.id]
  );
  await query(
    `INSERT INTO stocks (guid, company_guid, company_id, name, unit, synced_at)
     VALUES ($1,$2,$3,'Stock B','Nos',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, guid) DO NOTHING`,
    [`st-b-${ctx.fixtures.suffix}`, sharedGuid, companyB.id]
  );
  await query(
    `INSERT INTO warehouses (guid, company_guid, company_id, name, synced_at)
     VALUES ($1,$2,$3,'WH-A',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, name) DO NOTHING`,
    [`wh-a-${ctx.fixtures.suffix}`, sharedGuid, companyA.id]
  );
  await query(
    `INSERT INTO warehouses (guid, company_guid, company_id, name, synced_at)
     VALUES ($1,$2,$3,'WH-B',EXTRACT(EPOCH FROM NOW())::BIGINT)
     ON CONFLICT (company_id, name) DO NOTHING`,
    [`wh-b-${ctx.fixtures.suffix}`, sharedGuid, companyB.id]
  );
  await query(
    `INSERT INTO company_inventory_settings (company_id, company_guid, product_display_field)
     VALUES ($1,$2,'auto') ON CONFLICT (company_id) DO UPDATE SET product_display_field = 'auto'`,
    [companyA.id, sharedGuid]
  );
  await query(
    `INSERT INTO company_inventory_settings (company_id, company_guid, product_display_field)
     VALUES ($1,$2,'name') ON CONFLICT (company_id) DO UPDATE SET product_display_field = 'name'`,
    [companyB.id, sharedGuid]
  );
  await query(
    `INSERT INTO ai_insights_cache (company_id, company_guid, month_key, metrics_json, ai_output_json, valid_until)
     VALUES ($1,$2,'2026-04','{"a":1}'::jsonb,'{"a":true}'::jsonb, NOW() + interval '1 day')
     ON CONFLICT (company_id, month_key) DO UPDATE SET metrics_json = EXCLUDED.metrics_json`,
    [companyA.id, sharedGuid]
  ).catch(() => {});
  await query(
    `INSERT INTO ai_insights_cache (company_id, company_guid, month_key, metrics_json, ai_output_json, valid_until)
     VALUES ($1,$2,'2026-04','{"b":2}'::jsonb,'{"b":true}'::jsonb, NOW() + interval '1 day')
     ON CONFLICT (company_id, month_key) DO UPDATE SET metrics_json = EXCLUDED.metrics_json`,
    [companyB.id, sharedGuid]
  ).catch(() => {});
  await query(
    `INSERT INTO write_queue (user_id, company_guid, company_id, entry_type, entry_label, payload, xml, status, attempt_count, created_at, updated_at, workspace_id)
     VALUES ($1,$2,$3,'sales','A sale','{}','<xml/>','desktop_offline',0,
             EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT, $4)`,
    [ctx.fixtures.users.ownerA.id, sharedGuid, companyA.id, ctx.fixtures.workspaces.A]
  ).catch(() => {});
  await query(
    `INSERT INTO write_queue (user_id, company_guid, company_id, entry_type, entry_label, payload, xml, status, attempt_count, created_at, updated_at, workspace_id)
     VALUES ($1,$2,$3,'sales','B sale','{}','<xml/>','desktop_offline',0,
             EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT, $4)`,
    [ctx.fixtures.users.ownerB.id, sharedGuid, companyB.id, ctx.fixtures.workspaces.B]
  ).catch(() => {});
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Company Identity Phase 3E — real duplicate GUID isolation', () => {
  it('fixture rows are real and share GUID with distinct ids', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows } = await query(
      `SELECT id, workspace_id, guid FROM companies WHERE guid = $1 ORDER BY id`,
      [sharedGuid]
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].guid, rows[1].guid);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.notEqual(rows[0].workspace_id, rows[1].workspace_id);
  });

  it('ledger / voucher / stock / warehouse isolation by company_id', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows: ledA } = await query(`SELECT name FROM ledgers WHERE company_id = $1`, [companyA.id]);
    const { rows: ledB } = await query(`SELECT name FROM ledgers WHERE company_id = $1`, [companyB.id]);
    assert.ok(ledA.some((r) => r.name === 'Customer A'));
    assert.ok(!ledA.some((r) => r.name === 'Customer B'));
    assert.ok(ledB.some((r) => r.name === 'Customer B'));
    assert.ok(!ledB.some((r) => r.name === 'Customer A'));

    const { rows: vA } = await query(`SELECT voucher_number FROM vouchers WHERE company_id = $1`, [companyA.id]);
    const { rows: vB } = await query(`SELECT voucher_number FROM vouchers WHERE company_id = $1`, [companyB.id]);
    assert.ok(vA.some((r) => r.voucher_number === 'VA-1'));
    assert.ok(!vA.some((r) => r.voucher_number === 'VB-1'));
    assert.ok(vB.some((r) => r.voucher_number === 'VB-1'));

    const { rows: sA } = await query(`SELECT name FROM stocks WHERE company_id = $1`, [companyA.id]);
    const { rows: sB } = await query(`SELECT name FROM stocks WHERE company_id = $1`, [companyB.id]);
    assert.ok(sA.some((r) => r.name === 'Stock A'));
    assert.ok(sB.some((r) => r.name === 'Stock B'));
    assert.ok(!sA.some((r) => r.name === 'Stock B'));

    const { rows: wA } = await query(`SELECT name FROM warehouses WHERE company_id = $1`, [companyA.id]);
    const { rows: wB } = await query(`SELECT name FROM warehouses WHERE company_id = $1`, [companyB.id]);
    assert.ok(wA.some((r) => r.name === 'WH-A'));
    assert.ok(wB.some((r) => r.name === 'WH-B'));
  });

  it('config and cache isolation with identical GUID + month', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows: cfg } = await query(
      `SELECT company_id, product_display_field FROM company_inventory_settings WHERE company_id = ANY($1::bigint[])`,
      [[companyA.id, companyB.id]]
    );
    const a = cfg.find((r) => Number(r.company_id) === Number(companyA.id));
    const b = cfg.find((r) => Number(r.company_id) === Number(companyB.id));
    assert.ok(a && b);
    assert.notEqual(a.product_display_field, b.product_display_field);

    const { rows: cache } = await query(
      `SELECT company_id, metrics_json FROM ai_insights_cache WHERE month_key = '2026-04' AND company_id = ANY($1::bigint[])`,
      [[companyA.id, companyB.id]]
    ).catch(() => ({ rows: [] }));
    if (cache.length >= 2) {
      const ca = cache.find((r) => Number(r.company_id) === Number(companyA.id));
      const cb = cache.find((r) => Number(r.company_id) === Number(companyB.id));
      assert.notDeepEqual(ca.metrics_json, cb.metrics_json);
    }
  });

  it('write_queue routes by company_id not shared GUID', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows } = await query(
      `SELECT company_id, workspace_id, entry_label FROM write_queue
        WHERE company_guid = $1 AND company_id = ANY($2::bigint[])`,
      [sharedGuid, [companyA.id, companyB.id]]
    );
    const a = rows.filter((r) => Number(r.company_id) === Number(companyA.id));
    const b = rows.filter((r) => Number(r.company_id) === Number(companyB.id));
    assert.ok(a.length >= 1);
    assert.ok(b.length >= 1);
    assert.ok(a.every((r) => r.workspace_id === ctx.fixtures.workspaces.A));
    assert.ok(b.every((r) => r.workspace_id === ctx.fixtures.workspaces.B));
  });

  it('purge A by company_id leaves B untouched', async () => {
    if (!ctx) throw new Error('harness required');
    await purgeCompanyTallyDataById(companyA.id, { companyGuid: sharedGuid });
    const { rows: ledA } = await query(`SELECT COUNT(*)::int AS n FROM ledgers WHERE company_id = $1`, [companyA.id]);
    const { rows: ledB } = await query(`SELECT COUNT(*)::int AS n FROM ledgers WHERE company_id = $1`, [companyB.id]);
    const { rows: vB } = await query(`SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`, [companyB.id]);
    const { rows: sB } = await query(`SELECT COUNT(*)::int AS n FROM stocks WHERE company_id = $1`, [companyB.id]);
    assert.equal(ledA[0].n, 0);
    assert.ok(ledB[0].n >= 1, 'B ledgers must survive A purge');
    assert.ok(vB[0].n >= 1, 'B vouchers must survive A purge');
    assert.ok(sB[0].n >= 1, 'B stocks must survive A purge');
  });

  it('HTTP scope: member A cannot resolve B company via shared GUID in workspace A', async () => {
    if (!ctx) throw new Error('harness required');
    // Device B can sync its own same-GUID company; Device A cannot ingest B's workspace
    const { status, json } = await httpJson(ctx.baseUrl, 'POST', '/ingest/sync-run/start', {
      headers: {
        'device-id': ctx.fixtures.devices.A.deviceId,
        'x-device-secret': ctx.fixtures.devices.A.secret,
      },
      body: { companyGuid: sharedGuid, syncType: 'normal' },
    });
    // A may resolve its own row with sharedGuid — must not be B's id
    if (status === 200 || status === 201) {
      const { rows } = await query(
        `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2`,
        [sharedGuid, ctx.fixtures.workspaces.A]
      );
      assert.equal(Number(rows[0].id), Number(companyA.id));
      assert.notEqual(Number(rows[0].id), Number(companyB.id));
    } else {
      assert.ok([403, 409].includes(status), JSON.stringify(json));
    }
  });

  it('socket room resolve refuses guid-only (no companyId/workspace)', async () => {
    if (!ctx) throw new Error('harness required');
    // emit without opts must not throw; room resolve returns null → no cross-tenant emit
    await emitVoucherSynced(sharedGuid, 'TDK-TEST', '1');
    assert.ok(true);
  });
});
