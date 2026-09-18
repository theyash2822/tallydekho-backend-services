#!/usr/bin/env node
/**
 * Remove specific users and everything they own, so a number can be re-registered
 * from scratch.
 *
 * Almost every foreign key into users is NO ACTION, so children have to be
 * deleted explicitly and in dependency order — a bare DELETE FROM users fails on
 * the first reference. Company-owned tables are discovered from the live schema
 * rather than listed, because that list has already drifted once.
 *
 * Safety:
 *   - inspect-only by default; CONFIRM=1 required to delete
 *   - targets are named by mobile number, never by a pattern
 *   - refuses to touch the reserved system Demo workspace
 *   - one transaction: it all lands or none of it does
 *
 * Usage:
 *   DATABASE_URL=... MOBILES=9024466791,9078802278 node scripts/delete-users.mjs
 *   DATABASE_URL=... MOBILES=... CONFIRM=1 node scripts/delete-users.mjs
 */
import 'dotenv/config';
import { query, getClient } from '../src/db/schema.js';
import { SYSTEM_DEMO_WORKSPACE_ID } from '../src/services/demoDataService.js';

const CONFIRM = process.env.CONFIRM === '1';
const MOBILES = String(process.env.MOBILES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Tables carrying company_id, read live so the list cannot go stale. */
async function companyOwnedTables() {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.columns
      WHERE column_name = 'company_id' AND table_schema = 'public' ORDER BY table_name`
  );
  return rows.map((r) => r.table_name);
}

/** Tables referencing a user, with the column that does the referencing. */
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

/**
 * Every table carrying workspace_id, read from the live schema.
 *
 * Hardcoding this list failed twice — member_company_access is keyed by
 * membership_id instead, and workspace_backups was missing entirely. Discovery
 * cannot drift.
 */
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

async function count(sql, params) {
  const { rows } = await query(sql, params);
  return Number(rows[0]?.n || 0);
}

async function main() {
  if (!MOBILES.length) {
    console.error('MOBILES is required, e.g. MOBILES=9024466791,9078802278');
    process.exit(2);
  }

  const { rows: users } = await query(
    `SELECT id, mobile, name FROM users WHERE mobile = ANY($1::text[]) ORDER BY id`,
    [MOBILES]
  );
  if (!users.length) {
    console.log(`no users match: ${MOBILES.join(', ')}`);
    process.exit(0);
  }
  const userIds = users.map((u) => Number(u.id));

  const { rows: wsRows } = await query(
    `SELECT id, name FROM workspaces WHERE owner_user_id = ANY($1::int[]) ORDER BY id`,
    [userIds]
  );
  const wsIds = wsRows.map((w) => w.id);

  if (wsIds.includes(SYSTEM_DEMO_WORKSPACE_ID)) {
    console.error('REFUSING: the reserved system Demo workspace is in scope.');
    process.exit(3);
  }

  const { rows: coRows } = wsIds.length
    ? await query(
        `SELECT id, name, is_demo FROM companies WHERE workspace_id = ANY($1::text[]) ORDER BY id`,
        [wsIds]
      )
    : { rows: [] };
  const coIds = coRows.map((c) => Number(c.id));

  console.log(`mode: ${CONFIRM ? 'DELETE (CONFIRM=1)' : 'INSPECT ONLY'}\n`);
  console.log('users:');
  for (const u of users) console.log(`  ${u.id.toString().padEnd(6)} ${String(u.mobile).padEnd(18)} ${u.name || ''}`);
  console.log(`\nworkspaces owned : ${wsIds.length}`);
  for (const w of wsRows) console.log(`  ${w.id}  ${w.name || ''}`);
  console.log(`companies        : ${coIds.length}`);
  for (const c of coRows) console.log(`  ${c.id}  ${c.name}${c.is_demo ? '  (demo)' : ''}`);

  // Memberships these users hold in workspaces they do NOT own — removing the
  // user must remove those too, or the other workspace keeps a dangling member.
  const foreignMemberships = await count(
    `SELECT count(*)::int AS n FROM workspace_memberships
      WHERE user_id = ANY($1::int[]) AND ($2::text[] = '{}' OR workspace_id <> ALL($2::text[]))`,
    [userIds, wsIds]
  );
  console.log(`\nmemberships in other people's workspaces: ${foreignMemberships}`);

  if (coIds.length) {
    const tables = await companyOwnedTables();
    let total = 0;
    console.log('\ncompany-owned rows:');
    for (const t of tables) {
      const n = await count(`SELECT count(*)::int AS n FROM ${t} WHERE company_id = ANY($1::bigint[])`, [coIds]);
      if (n) {
        console.log(`  ${t.padEnd(32)} ${n}`);
        total += n;
      }
    }
    console.log(`  total: ${total}`);
  }

  if (!CONFIRM) {
    console.log('\ninspect only — re-run with CONFIRM=1 to delete');
    process.exit(0);
  }

  const before = await count(`SELECT count(*)::int AS n FROM users`);
  const client = await getClient();
  try {
    await client.query('BEGIN');

    if (coIds.length) {
      for (const t of await companyOwnedTables()) {
        await client.query(`DELETE FROM ${t} WHERE company_id = ANY($1::bigint[])`, [coIds]);
      }
      await client.query(`DELETE FROM companies WHERE id = ANY($1::bigint[])`, [coIds]);
    }

    // Any remaining rows pointing at these users by company-independent columns.
    for (const [t, col] of USER_SCOPED) {
      if (await tableExists(t)) {
        await client.query(`DELETE FROM ${t} WHERE ${col} = ANY($1::int[])`, [userIds]);
      }
    }
    await client.query(`DELETE FROM write_queue WHERE actor_user_id = ANY($1::int[])`, [userIds]);

    // Per-membership company scope hangs off membership_id, so it has to go
    // before the memberships it references — for every membership these users
    // hold, including ones in workspaces they do not own.
    await client.query(
      `DELETE FROM member_company_access WHERE membership_id IN
         (SELECT id FROM workspace_memberships WHERE user_id = ANY($1::int[]))`,
      [userIds]
    ).catch(() => {});
    // Memberships anywhere, including other people's workspaces.
    await client.query(`DELETE FROM workspace_memberships WHERE user_id = ANY($1::int[])`, [userIds]);

    if (wsIds.length) {
      // Any membership belonging to someone else in a workspace being removed.
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
    await client.query(`DELETE FROM devices WHERE user_id = ANY($1::int[])`, [userIds]);

    // Billing last: wallets hang off the account, the account off the user.
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

    if (wsIds.length) {
      await client.query(`DELETE FROM workspaces WHERE id = ANY($1::text[])`, [wsIds]);
    }
    await client.query(`DELETE FROM users WHERE id = ANY($1::int[])`, [userIds]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFAILED, rolled back:', e.message);
    process.exit(1);
  } finally {
    client.release();
  }

  const after = await count(`SELECT count(*)::int AS n FROM users`);
  const stillThere = await count(
    `SELECT count(*)::int AS n FROM users WHERE mobile = ANY($1::text[])`,
    [MOBILES]
  );
  console.log(`\ndeleted.`);
  console.log(`users before/after : ${before} / ${after}`);
  console.log(`target numbers left: ${stillThere} (expect 0)`);
  process.exit(stillThere === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
