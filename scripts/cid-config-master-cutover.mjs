#!/usr/bin/env node
/**
 * Company Identity — config / master / MCA ownership cutover (OPERATOR TOOL).
 *
 * This is the part of the Phase 3D cutover that had no operator script and was
 * therefore only reachable by booting the app with
 * CID_ALLOW_DESTRUCTIVE_MIGRATION=1 — i.e. by a restart, with every failure
 * silently swallowed by `EXCEPTION WHEN others THEN NULL`. That is unacceptable
 * in production, so the same steps are done here explicitly and loudly.
 *
 * Covers:
 *   - composite UNIQUE(company_id, …) on config/cache/master tables
 *   - PK swap to company_id for single-row-per-company config tables
 *   - tdk_reference_counters PK → (company_id, voucher_prefix, fiscal_year)
 *   - member_company_access PK → (membership_id, company_id), drop company_guid
 *   - dropping legacy company_guid uniques superseded by company_id
 *
 * Two rows-destroying steps exist. They are NEVER implicit here:
 *   tdk_reference_counters rows with no resolvable company
 *   member_company_access rows with no resolvable company
 * They are reported, and only removed with CONFIRM_DELETE=1.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/cid-config-master-cutover.mjs                # report
 *   DATABASE_URL=... CONFIRM=1 node scripts/cid-config-master-cutover.mjs      # apply non-destructive
 *   DATABASE_URL=... CONFIRM=1 CONFIRM_DELETE=1 node ...                       # also prune orphans
 */
import 'dotenv/config';
import pg from 'pg';
import { createTimer, deploymentEnv, reportLockBlockers } from './lib/cidChildMigration.mjs';

const { Client } = pg;

const CONFIRM = process.env.CONFIRM === '1';
const CONFIRM_DELETE = process.env.CONFIRM_DELETE === '1';
const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS || 5000);

/** Composite uniques that replace company_guid-keyed uniqueness. */
const UNIQUES = [
  ['company_print_profile', 'uq_print_profile_company_id', '(company_id)'],
  ['company_inventory_settings', 'uq_inventory_settings_company_id', '(company_id)'],
  ['company_compliance_config', 'uq_compliance_config_company_id', '(company_id)'],
  ['inventory_barcode_settings', 'uq_barcode_settings_company_id', '(company_id)'],
  ['ai_insights_cache', 'uq_ai_insights_company_id_month', '(company_id, month_key)'],
  ['financial_year_summaries', 'uq_fy_summaries_company_id_fy', '(company_id, financial_year)'],
  ['kpi_ar_ap_snapshots', 'uq_kpi_ar_ap_company_id', '(company_id, side, as_of)'],
  ['kpi_loans_snapshots', 'uq_kpi_loans_company_id', '(company_id, as_of)'],
  ['company_years', 'uq_company_years_company_id_fy', '(company_id, fin_year)'],
];

/** Single-row-per-company config tables whose PK becomes company_id. */
const PK_COMPANY_ID = [
  'company_print_profile',
  'company_compliance_config',
  'inventory_barcode_settings',
];

/** Legacy company_guid uniques superseded by the company_id equivalents. */
const LEGACY_GUID_UNIQUES = [
  ['company_years', 'company_years_company_guid_fin_year_key'],
  ['ai_insights_cache', 'ai_insights_cache_company_guid_month_key_key'],
  ['financial_year_summaries', 'financial_year_summaries_company_guid_financial_year_key'],
  ['kpi_ar_ap_snapshots', 'kpi_ar_ap_snapshots_company_guid_side_as_of_key'],
  ['kpi_loans_snapshots', 'kpi_loans_snapshots_company_guid_as_of_key'],
  ['company_inventory_settings', 'company_inventory_settings_company_guid_key'],
];

const problems = [];

async function exists(client, table) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1) AS present`,
    [table]
  );
  return rows[0].present;
}

async function hasColumn(client, table, column) {
  const { rows } = await client.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2) AS present`,
    [table, column]
  );
  return rows[0].present;
}

async function constraintDef(client, table, name) {
  const { rows } = await client.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = to_regclass($1) AND conname = $2`,
    [table, name]
  );
  return rows[0]?.def || null;
}

/** Runs a step, reporting the outcome instead of swallowing it. */
async function step(client, timer, label, sql, { tolerate = [] } = {}) {
  try {
    await timer.timed(label, () => client.query(sql));
    return true;
  } catch (err) {
    if (tolerate.includes(err.code)) {
      console.log(`             already satisfied (${err.code})`);
      return true;
    }
    console.error(`    FAILED   ${label}\n             ${err.code || ''} ${err.message}`);
    problems.push(`${label}: ${err.message}`);
    return false;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const { rows: info } = await client.query('SELECT current_database() AS db');
  console.log(`database : ${info[0].db}`);
  console.log(`db stamp : ${await deploymentEnv(client)}`);
  console.log(`mode     : ${CONFIRM ? 'APPLY' : 'report only'}${CONFIRM_DELETE ? ' + prune orphans' : ''}`);

  console.log('\n── orphan rows that block the PK swaps ───────────────────────');
  const orphanCounts = {};
  for (const table of ['tdk_reference_counters', 'member_company_access']) {
    if (!(await exists(client, table))) {
      console.log(`  (absent: ${table})`);
      continue;
    }
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE company_id IS NULL`);
    orphanCounts[table] = rows[0].n;
    console.log(`  ${table.padEnd(26)} company_id IS NULL: ${rows[0].n}`);
  }

  console.log('\n── current constraint state ──────────────────────────────────');
  for (const [table, name, cols] of UNIQUES) {
    if (!(await exists(client, table))) {
      console.log(`  (absent: ${table})`);
      continue;
    }
    const def = await constraintDef(client, table, name);
    console.log(`  ${table.padEnd(30)} ${name}: ${def || 'MISSING'} ${def ? '' : `→ will add ${cols}`}`);
  }
  const mcaGuid = (await exists(client, 'member_company_access'))
    ? await hasColumn(client, 'member_company_access', 'company_guid')
    : false;
  console.log(`  member_company_access.company_guid present: ${mcaGuid}`);

  if (!CONFIRM) {
    console.log('\nREPORT ONLY — pass CONFIRM=1 to apply.');
    console.log('Rows-destroying steps additionally require CONFIRM_DELETE=1.');
    await client.end();
    process.exit(0);
  }

  console.log('\n── lock blockers ─────────────────────────────────────────────');
  await reportLockBlockers(client, 30);

  await client.query(`SET lock_timeout = ${LOCK_TIMEOUT_MS}`);
  await client.query('SET statement_timeout = 0');

  const timer = createTimer();

  console.log('\n── composite UNIQUE(company_id, …) ───────────────────────────');
  for (const [table, name, cols] of UNIQUES) {
    if (!(await exists(client, table))) continue;
    if (await constraintDef(client, table, name)) {
      console.log(`    (present) ${table}.${name}`);
      continue;
    }
    await step(
      client,
      timer,
      `${table}: ADD CONSTRAINT ${name} UNIQUE ${cols}`,
      `ALTER TABLE ${table} ADD CONSTRAINT ${name} UNIQUE ${cols}`,
      { tolerate: ['42P07'] }
    );
  }

  console.log('\n── config PK → company_id ────────────────────────────────────');
  for (const table of PK_COMPANY_ID) {
    if (!(await exists(client, table))) continue;
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id IS NULL`
    );
    if (rows[0].n > 0) {
      console.error(`    SKIP ${table}: ${rows[0].n} rows with NULL company_id — resolve first`);
      problems.push(`${table} has ${rows[0].n} NULL company_id rows`);
      continue;
    }
    await step(client, timer, `${table}: SET NOT NULL`, `ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL`);
    await step(client, timer, `${table}: DROP old PK`, `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_pkey`);
    await step(
      client,
      timer,
      `${table}: PRIMARY KEY (company_id)`,
      `ALTER TABLE ${table} ADD CONSTRAINT ${table}_pkey PRIMARY KEY (company_id)`,
      { tolerate: ['42P16', '42P07'] }
    );
  }

  console.log('\n── tdk_reference_counters ────────────────────────────────────');
  if (await exists(client, 'tdk_reference_counters')) {
    // Scope by workspace when the table carries it; a guid-only match would be
    // ambiguous under the duplicate-GUID architecture.
    const counterHasWorkspace = await hasColumn(client, 'tdk_reference_counters', 'workspace_id');
    await step(
      client,
      timer,
      `tdk_reference_counters: backfill company_id (${counterHasWorkspace ? 'workspace-scoped' : 'guid match'})`,
      `UPDATE tdk_reference_counters t SET company_id = c.id
         FROM companies c
        WHERE t.company_id IS NULL AND c.guid = t.company_guid` +
        (counterHasWorkspace ? ' AND c.workspace_id = t.workspace_id' : '')
    );
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM tdk_reference_counters WHERE company_id IS NULL'
    );
    if (rows[0].n > 0) {
      if (!CONFIRM_DELETE) {
        console.error(
          `    SKIP prune: ${rows[0].n} unresolvable counter row(s) would be DELETED. ` +
            'Re-run with CONFIRM_DELETE=1 once reviewed.'
        );
        problems.push(`tdk_reference_counters has ${rows[0].n} unresolvable rows (PK swap blocked)`);
      } else {
        await step(
          client,
          timer,
          `tdk_reference_counters: DELETE ${rows[0].n} unresolvable row(s)`,
          'DELETE FROM tdk_reference_counters WHERE company_id IS NULL'
        );
      }
    }
    const { rows: still } = await client.query(
      'SELECT count(*)::int AS n FROM tdk_reference_counters WHERE company_id IS NULL'
    );
    if (still[0].n === 0) {
      await step(client, timer, 'tdk_reference_counters: SET NOT NULL', 'ALTER TABLE tdk_reference_counters ALTER COLUMN company_id SET NOT NULL');
      await step(client, timer, 'tdk_reference_counters: DROP old PK', 'ALTER TABLE tdk_reference_counters DROP CONSTRAINT IF EXISTS tdk_reference_counters_pkey');
      await step(
        client,
        timer,
        'tdk_reference_counters: PRIMARY KEY (company_id, voucher_prefix, fiscal_year)',
        `ALTER TABLE tdk_reference_counters ADD CONSTRAINT tdk_reference_counters_pkey
           PRIMARY KEY (company_id, voucher_prefix, fiscal_year)`,
        { tolerate: ['42P16', '42P07'] }
      );
    }
  }

  console.log('\n── member_company_access ─────────────────────────────────────');
  if (await exists(client, 'member_company_access')) {
    const { rows } = await client.query(
      'SELECT count(*)::int AS n FROM member_company_access WHERE company_id IS NULL'
    );
    if (rows[0].n > 0 && !CONFIRM_DELETE) {
      console.error(
        `    SKIP: ${rows[0].n} access row(s) without company_id would be DELETED. ` +
          'These are grants; review before pruning, then re-run with CONFIRM_DELETE=1.'
      );
      problems.push(`member_company_access has ${rows[0].n} rows without company_id (PK swap blocked)`);
    } else {
      if (rows[0].n > 0) {
        await step(
          client,
          timer,
          `member_company_access: DELETE ${rows[0].n} row(s) without company_id`,
          'DELETE FROM member_company_access WHERE company_id IS NULL'
        );
      }
      await step(client, timer, 'member_company_access: DROP old PK', 'ALTER TABLE member_company_access DROP CONSTRAINT IF EXISTS member_company_access_pkey');
      await step(
        client,
        timer,
        'member_company_access: PRIMARY KEY (membership_id, company_id)',
        `ALTER TABLE member_company_access
           ADD CONSTRAINT member_company_access_pkey PRIMARY KEY (membership_id, company_id)`,
        { tolerate: ['42P16', '42P07'] }
      );
      if (await hasColumn(client, 'member_company_access', 'company_guid')) {
        await step(
          client,
          timer,
          'member_company_access: DROP COLUMN company_guid',
          'ALTER TABLE member_company_access DROP COLUMN company_guid'
        );
      }
    }
  }

  console.log('\n── drop legacy company_guid uniques ──────────────────────────');
  for (const [table, name] of LEGACY_GUID_UNIQUES) {
    if (!(await exists(client, table))) continue;
    if (!(await constraintDef(client, table, name))) {
      console.log(`    (absent) ${table}.${name}`);
      continue;
    }
    await step(client, timer, `${table}: DROP CONSTRAINT ${name}`, `ALTER TABLE ${table} DROP CONSTRAINT ${name}`);
  }

  const { total } = timer.summary();
  console.log('\n── summary ───────────────────────────────────────────────────');
  console.log(`steps executed : ${timer.timings.length}`);
  console.log(`total          : ${(total / 1000).toFixed(2)} s`);

  if (problems.length) {
    console.error(`\n${problems.length} unresolved item(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    await client.end();
    process.exit(1);
  }
  console.log('\nconfig / master / MCA ownership cutover complete');
  await client.end();
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
