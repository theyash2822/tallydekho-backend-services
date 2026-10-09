/**
 * X10 / V-010 — clean install, previous-shape upgrade and already-upgraded
 * restart, each in its own Postgres schema of the disposable cluster.
 *
 * Normal startup must never delete, merge or re-key business rows, whatever
 * NODE_ENV or CID_ALLOW_DESTRUCTIVE_MIGRATION say. The destructive Company
 * Identity cutover may only run on a database with no data (clean install).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { validateIsolatedEnv, verifyMarker } from './isolatedDb.js';
import { installNetworkGuard } from './networkGuard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const CHILD = path.join(here, 'fixtures', 'schema-scenario-child.mjs');
// Created on first use by services (aiInsights, helpEmbeddings) with their own keys.
const LAZY_TABLES = new Set(['ai_insights_cache', 'financial_year_summaries', 'kb_chunks']);

const { url, token } = validateIsolatedEnv();
const u = new URL(url);
installNetworkGuard({ allow: [[u.hostname, Number(u.port)]] });
await verifyMarker(url, token);

const admin = new pg.Client({ connectionString: url });
await admin.connect();
test.after(() => admin.end());

async function freshSchema(name) {
  await admin.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
  await admin.query(`CREATE SCHEMA ${name}`);
}

function boot(schemaName, env) {
  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  delete childEnv.NODE_ENV;
  delete childEnv.CID_ALLOW_DESTRUCTIVE_MIGRATION;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  const r = spawnSync(process.execPath, [CHILD, schemaName], { env: childEnv, encoding: 'utf8', timeout: 120000 });
  const line = r.stdout.trim().split('\n').pop();
  assert.ok(line, `no output from schema child: ${r.stderr}`);
  return JSON.parse(line);
}

async function inSchema(schemaName, sql, params) {
  await admin.query(`SET search_path = ${schemaName}`);
  try {
    return await admin.query(sql, params);
  } finally {
    await admin.query('RESET search_path');
  }
}

async function counts(schemaName) {
  const { rows } = await inSchema(schemaName, `
    SELECT (SELECT count(*) FROM companies)::int AS companies,
           (SELECT count(*) FROM vouchers)::int AS vouchers,
           (SELECT count(*) FROM member_company_access)::int AS mca,
           (SELECT count(*) FROM tdk_reference_counters)::int AS tdk`);
  return rows[0];
}

async function hasConstraint(schemaName, name) {
  const { rows } = await admin.query(
    `SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = $1 AND c.conname = $2`, [schemaName, name]);
  return rows.length === 1;
}

async function hasColumn(schemaName, table, column) {
  const { rows } = await admin.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3`,
    [schemaName, table, column]);
  return rows.length === 1;
}

function arbiterMap(schemaName) {
  const env = { ...process.env, X10_URL: `${url}?options=${encodeURIComponent(`-c search_path=${schemaName}`)}` };
  delete env.DATABASE_URL;
  const out = path.join('/tmp', `x10-${schemaName}.md`);
  const r = spawnSync(process.execPath, ['scripts/x10-arbiter-map.mjs', '--url-env', 'X10_URL', '--out', out],
    { cwd: root, env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(out, 'utf8').split('\n')
    .filter((l) => /\| MISSING \|/.test(l))
    .map((l) => l.split('|')[1].trim());
}

async function seedWorkspace(schemaName, tag) {
  await inSchema(schemaName, `
    INSERT INTO users (id, mobile) VALUES (900001, '+910000${tag}') ON CONFLICT DO NOTHING;
    INSERT INTO workspaces (id, name) VALUES ('ws-${tag}', 'Synthetic ${tag}');
    INSERT INTO workspace_memberships (id, workspace_id, user_id) VALUES ('wm-${tag}', 'ws-${tag}', 900001);
    INSERT INTO companies (guid, name, workspace_id) VALUES ('guid-${tag}', 'Synthetic Co ${tag}', 'ws-${tag}');
    INSERT INTO vouchers (guid, company_guid, company_id, voucher_number)
      SELECT 'v-${tag}-' || g, 'guid-${tag}', c.id, g::text FROM companies c, generate_series(1, 3) g
       WHERE c.guid = 'guid-${tag}';
  `);
}

for (const [label, env] of [
  ['NODE_ENV unset', {}],
  ['development', { NODE_ENV: 'development' }],
  ['test', { NODE_ENV: 'test' }],
  ['production + accidental opt-in flag', { NODE_ENV: 'production', CID_ALLOW_DESTRUCTIVE_MIGRATION: '1' }],
]) {
  test(`clean install succeeds with final keys (${label})`, async () => {
    const name = `x10_fresh_${(env.NODE_ENV || 'unset')}`;
    await freshSchema(name);
    const r = boot(name, env);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.cutover, 'applied_on_empty_database');
    assert.ok(await hasColumn(name, 'vouchers', 'voucher_type_parent'));
    assert.ok(await hasConstraint(name, 'companies_workspace_guid_key'));
    assert.ok(await hasConstraint(name, 'uq_vouchers_company_id_guid'));
    const missing = arbiterMap(name).filter((t) => !LAZY_TABLES.has(t));
    assert.deepEqual(missing, [], `ON CONFLICT targets without a matching unique key: ${missing}`);
  });
}

test('previous-shape database with data: boot never runs the destructive cutover', async () => {
  const name = 'x10_prev';
  await freshSchema(name);
  assert.equal(boot(name, { NODE_ENV: 'test' }).ok, true);
  await seedWorkspace(name, 'prev');
  // Recreate the pre-cutover key shape plus rows the cutover would delete.
  await inSchema(name, `
    ALTER TABLE vouchers DROP CONSTRAINT uq_vouchers_company_id_guid;
    ALTER TABLE companies DROP CONSTRAINT companies_workspace_guid_key;
    ALTER TABLE companies ADD CONSTRAINT companies_guid_key UNIQUE (guid);
    ALTER TABLE member_company_access DROP CONSTRAINT member_company_access_pkey;
    ALTER TABLE member_company_access ALTER COLUMN company_id DROP NOT NULL;
    ALTER TABLE member_company_access ADD COLUMN company_guid TEXT;
    ALTER TABLE tdk_reference_counters DROP CONSTRAINT tdk_reference_counters_pkey;
    ALTER TABLE tdk_reference_counters ALTER COLUMN company_id DROP NOT NULL;
    INSERT INTO member_company_access (membership_id, company_id, company_guid) VALUES ('wm-prev', NULL, 'orphan-guid');
    INSERT INTO tdk_reference_counters (company_guid, voucher_prefix, fiscal_year, last_seq, company_id)
      VALUES ('orphan-guid', 'SAL', '2026', 7, NULL);
  `);
  const before = await counts(name);

  for (const env of [
    { NODE_ENV: 'development', CID_ALLOW_DESTRUCTIVE_MIGRATION: '1' },
    { NODE_ENV: 'production', CID_ALLOW_DESTRUCTIVE_MIGRATION: '1' },
    {},
  ]) {
    const r = boot(name, env);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.cutover, 'pending_operator_migration');
    assert.ok(r.logs.some((l) => l.includes('SCHEMA MISMATCH')));
    assert.deepEqual(await counts(name), before, 'boot changed business row counts');
    assert.ok(await hasColumn(name, 'member_company_access', 'company_guid'), 'boot dropped MCA.company_guid');
    assert.ok(await hasConstraint(name, 'companies_guid_key'), 'boot re-keyed companies');
    const orphan = await inSchema(name, `SELECT count(*)::int AS c FROM member_company_access WHERE company_id IS NULL`);
    assert.equal(orphan.rows[0].c, 1, 'boot deleted an unresolved access row');
  }
});

test('already-upgraded database restarts idempotently without touching rows', async () => {
  const name = 'x10_upgraded';
  await freshSchema(name);
  assert.equal(boot(name, { NODE_ENV: 'production' }).ok, true);
  await seedWorkspace(name, 'up');
  const before = await counts(name);
  for (const env of [{ NODE_ENV: 'development', CID_ALLOW_DESTRUCTIVE_MIGRATION: '1' }, { NODE_ENV: 'production' }]) {
    const r = boot(name, env);
    assert.equal(r.ok, true, r.error);
    assert.equal(r.cutover, 'already_applied');
    assert.deepEqual(await counts(name), before);
  }
  const missing = arbiterMap(name).filter((t) => !LAZY_TABLES.has(t));
  assert.deepEqual(missing, []);
});
