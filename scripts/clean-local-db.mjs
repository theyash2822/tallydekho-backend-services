#!/usr/bin/env node
/**
 * Wipe local fake user/company data. Keeps only the reserved system Demo
 * workspace + canonical is_demo company.
 *
 * Safety:
 *   - inspect-only by default; CONFIRM=1 required to delete
 *   - refuses to delete system-demo-workspace or is_demo companies
 *   - one transaction
 *
 * Usage:
 *   DATABASE_URL=... node scripts/clean-local-db.mjs
 *   DATABASE_URL=... CONFIRM=1 node scripts/clean-local-db.mjs
 */
import 'dotenv/config';
import { query, getClient } from '../src/db/schema.js';
import { SYSTEM_DEMO_WORKSPACE_ID } from '../src/services/demoDataService.js';

const CONFIRM = process.env.CONFIRM === '1';

async function companyOwnedTables() {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'company_id' AND table_schema = 'public' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function workspaceScopedTables() {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'workspace_id' AND table_schema = 'public'
        AND table_name <> 'workspaces'
      ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

async function tableExists(name) {
  const { rows } = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
    [name]
  );
  return rows.length > 0;
}

async function count(sql, params = []) {
  const { rows } = await query(sql, params);
  return Number(rows[0]?.n || 0);
}

const USER_SCOPED = [
  ['demo_simulated_entries', 'user_id'],
  ['push_tokens', 'user_id'],
  ['auth_sessions', 'user_id'],
  ['invoice_pdf_versions', 'user_id'],
  ['stock_adjustments', 'user_id'],
  ['sync_log', 'user_id'],
  ['app_masters', 'user_id'],
  ['app_vouchers', 'user_id'],
  ['write_queue', 'user_id'],
  ['usage_events', 'owner_user_id'],
  ['billing_invoices', 'owner_user_id'],
  ['billing_payment_orders', 'owner_user_id'],
];

async function main() {
  const usersBefore = await count(`SELECT count(*)::int AS n FROM users`);
  const companiesBefore = await count(`SELECT count(*)::int AS n FROM companies`);
  const workspacesBefore = await count(`SELECT count(*)::int AS n FROM workspaces`);
  const demoCompanies = await count(
    `SELECT count(*)::int AS n FROM companies WHERE COALESCE(is_demo, false) = true`
  );

  const { rows: users } = await query(`SELECT id, mobile FROM users ORDER BY id`);
  const userIds = users.map((u) => Number(u.id));

  const { rows: wsRows } = await query(
    `SELECT id, name FROM workspaces WHERE id <> $1 ORDER BY id`,
    [SYSTEM_DEMO_WORKSPACE_ID]
  );
  const wsIds = wsRows.map((w) => w.id);

  // Explicit: only non-demo companies (demo lives only in system workspace).
  const { rows: wipeCompanies } = await query(
    `SELECT id, name FROM companies WHERE COALESCE(is_demo, false) = false ORDER BY id`
  );
  const coIds = wipeCompanies.map((c) => Number(c.id));

  console.log(`mode: ${CONFIRM ? 'DELETE (CONFIRM=1)' : 'INSPECT ONLY'}`);
  console.log(`preserve workspace: ${SYSTEM_DEMO_WORKSPACE_ID}`);
  console.log(`demo companies kept: ${demoCompanies}`);
  console.log(`\nwill remove:`);
  console.log(`  users              ${userIds.length}`);
  console.log(`  non-system workspaces ${wsIds.length}`);
  console.log(`  non-demo companies ${coIds.length}`);
  console.log(`\nbefore totals: users=${usersBefore} companies=${companiesBefore} workspaces=${workspacesBefore}`);

  if (wsIds.includes(SYSTEM_DEMO_WORKSPACE_ID)) {
    console.error('REFUSING: system demo workspace incorrectly included.');
    process.exit(3);
  }

  if (!CONFIRM) {
    console.log('\ninspect only — re-run with CONFIRM=1 to delete');
    process.exit(0);
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (coIds.length) {
      for (const t of await companyOwnedTables()) {
        await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::bigint[])`, [coIds]);
      }
      await client.query(`DELETE FROM companies WHERE id = ANY($1::bigint[])`, [coIds]);
    }

    if (userIds.length) {
      for (const [t, col] of USER_SCOPED) {
        if (await tableExists(t)) {
          await client.query(`DELETE FROM ${t} WHERE ${col} = ANY($1::int[])`, [userIds]);
        }
      }
      await client.query(`DELETE FROM write_queue WHERE actor_user_id = ANY($1::int[])`, [userIds]);

      await client.query(
        `DELETE FROM member_company_access WHERE membership_id IN
           (SELECT id FROM workspace_memberships WHERE user_id = ANY($1::int[]))`
      , [userIds]).catch(() => {});
      await client.query(`DELETE FROM workspace_memberships WHERE user_id = ANY($1::int[])`, [userIds]);
    }

    if (wsIds.length) {
      await client.query(
        `DELETE FROM member_company_access WHERE membership_id IN
           (SELECT id FROM workspace_memberships WHERE workspace_id = ANY($1::text[]))`,
        [wsIds]
      ).catch(() => {});
      await client.query(`DELETE FROM workspace_memberships WHERE workspace_id = ANY($1::text[])`, [wsIds]);

      for (const t of await workspaceScopedTables()) {
        await client.query(`DELETE FROM ${t} WHERE workspace_id = ANY($1::text[])`, [wsIds]);
      }
      await client.query(`DELETE FROM devices WHERE workspace_id = ANY($1::text[])`, [wsIds]);
    }

    if (userIds.length) {
      await client.query(`DELETE FROM devices WHERE user_id = ANY($1::int[])`, [userIds]);

      await client.query(
        `DELETE FROM credit_lots WHERE wallet_id IN
           (SELECT w.id FROM wallets w JOIN billing_accounts b ON b.id = w.billing_account_id
             WHERE b.owner_user_id = ANY($1::int[]))`,
        [userIds]
      ).catch(() => {});
      await client.query(
        `DELETE FROM wallet_transactions WHERE wallet_id IN
           (SELECT w.id FROM wallets w JOIN billing_accounts b ON b.id = w.billing_account_id
             WHERE b.owner_user_id = ANY($1::int[]))`,
        [userIds]
      ).catch(() => {});
      await client.query(
        `DELETE FROM wallets WHERE billing_account_id IN
           (SELECT id FROM billing_accounts WHERE owner_user_id = ANY($1::int[]))`,
        [userIds]
      ).catch(() => {});
      await client.query(`DELETE FROM billing_accounts WHERE owner_user_id = ANY($1::int[])`, [userIds]).catch(() => {});
    }

    if (wsIds.length) {
      await client.query(
        `DELETE FROM workspaces WHERE id = ANY($1::text[]) AND id <> $2`,
        [wsIds, SYSTEM_DEMO_WORKSPACE_ID]
      );
    }

    if (userIds.length) {
      await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  const usersAfter = await count(`SELECT count(*)::int AS n FROM users`);
  const companiesAfter = await count(`SELECT count(*)::int AS n FROM companies`);
  const workspacesAfter = await count(`SELECT count(*)::int AS n FROM workspaces`);
  const demoAfter = await count(
    `SELECT count(*)::int AS n FROM companies WHERE COALESCE(is_demo, false) = true`
  );
  const systemWs = await count(
    `SELECT count(*)::int AS n FROM workspaces WHERE id = $1`,
    [SYSTEM_DEMO_WORKSPACE_ID]
  );

  console.log(`\ndeleted.`);
  console.log(`users      ${usersBefore} → ${usersAfter}`);
  console.log(`companies  ${companiesBefore} → ${companiesAfter} (demo=${demoAfter})`);
  console.log(`workspaces ${workspacesBefore} → ${workspacesAfter} (system demo present=${systemWs})`);
  process.exit(usersAfter === 0 && demoAfter === 1 && systemWs === 1 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
