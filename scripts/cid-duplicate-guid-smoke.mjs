#!/usr/bin/env node
/**
 * Company Identity — post-cutover duplicate-GUID isolation smoke (DB level).
 *
 * Proves on a real database that two workspaces may hold the SAME external Tally
 * GUID while remaining fully isolated, then removes everything it created.
 *
 * Intended for staging (and, with explicit approval, as the production
 * post-migration smoke in a maintenance window). It only touches rows tagged
 * with its own run id, and always cleans up — including on failure.
 *
 * Requires UNIQUE(workspace_id, guid) and no global UNIQUE(guid).
 *
 * Usage:
 *   node scripts/cid-duplicate-guid-smoke.mjs
 *   KEEP=1 node scripts/cid-duplicate-guid-smoke.mjs   # leave fixture for inspection
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';
import { purgeCompanyTallyDataById } from '../src/services/companyPurge.js';

const KEEP = process.env.KEEP === '1';
const RUN = `cidsmoke-${Date.now().toString(36)}`;
const now = () => Math.floor(Date.now() / 1000);

const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push([name, ok, detail]);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function one(sql, params = []) {
  const { rows } = await query(sql, params);
  return rows[0];
}

async function countFor(table, companyId) {
  const r = await one(`SELECT COUNT(*)::int AS c FROM ${table} WHERE company_id = $1`, [companyId]);
  return r.c;
}

/** Two disposable workspaces owned by one disposable user. */
async function createTenants() {
  const user = await one(
    `INSERT INTO users (mobile, name, created_at, updated_at)
     VALUES ($1, 'CID Smoke', $2, $2) RETURNING id`,
    [`99${Date.now().toString().slice(-8)}`, now()]
  );
  const mk = async (label) => {
    const ws = await one(
      `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status,
         commercial_status, tally_connection, setup_generation, is_base, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'PERSONAL', 'ACTIVE', 'ACTIVE', 'CONNECTED', 1, FALSE, $3, $3)
       RETURNING id`,
      [`${RUN} ${label}`, user.id, now()]
    );
    return ws.id;
  };
  return { userId: user.id, wsA: await mk('A'), wsB: await mk('B') };
}

async function main() {
  console.log(`=== CID duplicate-GUID smoke (run ${RUN}) ===`);
  const db = await one(`SELECT current_database() AS db`);
  console.log(`target: ${db.db}`);

  const cons = await one(`
    SELECT
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='companies'::regclass
              AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (guid)') AS global_unique,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='companies'::regclass
              AND contype='u' AND pg_get_constraintdef(oid) ILIKE '%workspace_id%guid%') AS ws_unique
  `);
  check('global UNIQUE(guid) removed', cons.global_unique === false);
  check('UNIQUE(workspace_id, guid) active', cons.ws_unique === true);
  if (cons.global_unique || !cons.ws_unique) {
    console.error('ABORT: constraint state is pre-cutover — run cid-guid-unique-cutover.mjs first');
    process.exit(2);
  }

  const sharedGuid = `${RUN}-SAME-TALLY-GUID`;
  let tenants;
  let companyA;
  let companyB;

  try {
    tenants = await createTenants();

    const insCompany = async (wsId, name) =>
      one(
        `INSERT INTO companies (guid, workspace_id, name, formal_name, is_active, synced_at, created_at)
         VALUES ($1, $2, $3, $3, TRUE, $4, $4) RETURNING id, guid, workspace_id`,
        [sharedGuid, wsId, name, now()]
      );
    companyA = await insCompany(tenants.wsA, `${RUN} Co A`);
    companyB = await insCompany(tenants.wsB, `${RUN} Co B`);

    check(
      'same Tally GUID accepted in two workspaces',
      companyA.guid === companyB.guid && companyA.id !== companyB.id,
      `A=${companyA.id} B=${companyB.id} guid=${sharedGuid}`
    );

    // Same workspace must NOT allow a second row for the same GUID.
    let sameWsRejected = false;
    try {
      await insCompany(tenants.wsA, `${RUN} Co A dup`);
    } catch (e) {
      sameWsRejected = e.code === '23505';
    }
    check('same workspace + same GUID rejected (23505)', sameWsRejected);

    // ── seed isolated data ────────────────────────────────────────────────
    const seed = async (company, tag) => {
      await query(
        `INSERT INTO ledgers (guid, company_guid, company_id, name, parent, nature, synced_at)
         VALUES ($1,$2,$3,$4,'Sundry Debtors','Assets',$5)
         ON CONFLICT (company_id, guid) DO NOTHING`,
        [`${RUN}-led-${tag}`, sharedGuid, company.id, `Party ${tag}`, now()]
      );
      await query(
        `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, synced_at)
         VALUES ($1,$2,$3,$4,'Sales',CURRENT_DATE,$5)
         ON CONFLICT (company_id, guid) DO NOTHING`,
        [`${RUN}-vch-${tag}`, sharedGuid, company.id, `V-${tag}`, now()]
      );
      await query(
        `INSERT INTO stocks (guid, company_guid, company_id, name, unit, synced_at)
         VALUES ($1,$2,$3,$4,'Nos',$5)
         ON CONFLICT (company_id, guid) DO NOTHING`,
        [`${RUN}-stk-${tag}`, sharedGuid, company.id, `Stock ${tag}`, now()]
      );
      await query(
        `INSERT INTO warehouses (guid, company_guid, company_id, name, synced_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (company_id, name) DO NOTHING`,
        [`${RUN}-wh-${tag}`, sharedGuid, company.id, `WH-${tag}`, now()]
      );
      await query(
        `INSERT INTO company_inventory_settings (company_id, company_guid, product_display_field)
         VALUES ($1,$2,$3) ON CONFLICT (company_id) DO UPDATE SET product_display_field = EXCLUDED.product_display_field`,
        [company.id, sharedGuid, tag === 'A' ? 'auto' : 'name']
      );
      await query(
        `INSERT INTO ai_insights_cache (company_id, company_guid, month_key, metrics_json, ai_output_json, valid_until)
         VALUES ($1,$2,'2026-04',$3::jsonb,$3::jsonb, NOW() + interval '1 day')
         ON CONFLICT (company_id, month_key) DO UPDATE SET metrics_json = EXCLUDED.metrics_json`,
        [company.id, sharedGuid, JSON.stringify({ tag })]
      );
      await query(
        `INSERT INTO write_queue (user_id, company_guid, company_id, workspace_id, entry_type,
           entry_label, payload, xml, status, attempt_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,'sales',$5,'{}','<xml/>','desktop_offline',0,$6,$6)`,
        [tenants.userId, sharedGuid, company.id, company.workspace_id, `${tag} sale`, now()]
      );
    };
    await seed(companyA, 'A');
    await seed(companyB, 'B');

    // ── isolation assertions ──────────────────────────────────────────────
    for (const table of ['ledgers', 'vouchers', 'stocks', 'warehouses']) {
      const a = await countFor(table, companyA.id);
      const b = await countFor(table, companyB.id);
      check(`${table} isolated by company_id`, a === 1 && b === 1, `A=${a} B=${b}`);
    }

    const cfg = await one(
      `SELECT
         (SELECT product_display_field FROM company_inventory_settings WHERE company_id=$1) AS a,
         (SELECT product_display_field FROM company_inventory_settings WHERE company_id=$2) AS b`,
      [companyA.id, companyB.id]
    );
    check('config isolated with identical GUID', cfg.a !== cfg.b, `A=${cfg.a} B=${cfg.b}`);

    const cache = await one(
      `SELECT
         (SELECT metrics_json::text FROM ai_insights_cache WHERE company_id=$1 AND month_key='2026-04') AS a,
         (SELECT metrics_json::text FROM ai_insights_cache WHERE company_id=$2 AND month_key='2026-04') AS b`,
      [companyA.id, companyB.id]
    );
    check('cache isolated for identical GUID + month', cache.a !== cache.b && !!cache.a && !!cache.b);

    const wq = await query(
      `SELECT company_id, workspace_id FROM write_queue WHERE company_guid = $1`,
      [sharedGuid]
    );
    const wqA = wq.rows.filter((r) => Number(r.company_id) === Number(companyA.id));
    const wqB = wq.rows.filter((r) => Number(r.company_id) === Number(companyB.id));
    check(
      'write_queue routes by company_id → owning workspace',
      wqA.length === 1 &&
        wqB.length === 1 &&
        wqA[0].workspace_id === tenants.wsA &&
        wqB[0].workspace_id === tenants.wsB
    );

    // Workspace-scoped resolution must never cross tenants.
    const resolveA = await one(
      `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2`,
      [sharedGuid, tenants.wsA]
    );
    const resolveB = await one(
      `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2`,
      [sharedGuid, tenants.wsB]
    );
    check(
      'workspace + GUID resolves to owning company only',
      Number(resolveA.id) === Number(companyA.id) && Number(resolveB.id) === Number(companyB.id)
    );

    // ── purge isolation (the historically GUID-scoped path) ───────────────
    const beforeB = {
      ledgers: await countFor('ledgers', companyB.id),
      vouchers: await countFor('vouchers', companyB.id),
      stocks: await countFor('stocks', companyB.id),
      warehouses: await countFor('warehouses', companyB.id),
    };
    await purgeCompanyTallyDataById(companyA.id, { companyGuid: sharedGuid });
    const afterA = await countFor('ledgers', companyA.id);
    const afterB = {
      ledgers: await countFor('ledgers', companyB.id),
      vouchers: await countFor('vouchers', companyB.id),
      stocks: await countFor('stocks', companyB.id),
      warehouses: await countFor('warehouses', companyB.id),
    };
    check('purge A removed A projection', afterA === 0);
    check(
      'purge A left B untouched',
      JSON.stringify(beforeB) === JSON.stringify(afterB),
      `before=${JSON.stringify(beforeB)} after=${JSON.stringify(afterB)}`
    );
  } finally {
    if (KEEP) {
      console.log(`KEEP=1 — fixture retained (guid ${sharedGuid})`);
    } else if (tenants) {
      // Purge projections first so company FKs (RESTRICT) can be removed.
      for (const co of [companyA, companyB].filter(Boolean)) {
        await purgeCompanyTallyDataById(co.id, { companyGuid: sharedGuid }).catch(() => {});
        await query(`DELETE FROM write_queue WHERE company_id = $1`, [co.id]).catch(() => {});
        await query(`DELETE FROM company_inventory_settings WHERE company_id = $1`, [co.id]).catch(() => {});
        await query(`DELETE FROM ai_insights_cache WHERE company_id = $1`, [co.id]).catch(() => {});
        await query(`DELETE FROM companies WHERE id = $1`, [co.id]).catch((e) =>
          console.warn(`cleanup companies id=${co.id}: ${e.message}`)
        );
      }
      for (const ws of [tenants.wsA, tenants.wsB]) {
        await query(`DELETE FROM workspace_tally_bindings WHERE workspace_id = $1`, [ws]).catch(() => {});
        await query(`DELETE FROM role_capabilities WHERE role_id IN (SELECT id FROM workspace_roles WHERE workspace_id = $1)`, [ws]).catch(() => {});
        await query(`DELETE FROM workspace_roles WHERE workspace_id = $1`, [ws]).catch(() => {});
        await query(`DELETE FROM workspace_memberships WHERE workspace_id = $1`, [ws]).catch(() => {});
        await query(`DELETE FROM workspaces WHERE id = $1`, [ws]).catch((e) =>
          console.warn(`cleanup workspace ${ws}: ${e.message}`)
        );
      }
      await query(`DELETE FROM users WHERE id = $1`, [tenants.userId]).catch(() => {});
      const leftover = await one(`SELECT COUNT(*)::int AS c FROM companies WHERE guid = $1`, [
        sharedGuid,
      ]);
      console.log(`cleanup: companies remaining for smoke guid = ${leftover.c}`);
    }
  }

  console.log(`\nsummary: ${results.length - failures}/${results.length} checks passed`);
  if (failures) {
    console.error('cid-duplicate-guid-smoke FAILED');
    process.exit(1);
  }
  console.log('cid-duplicate-guid-smoke OK');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
