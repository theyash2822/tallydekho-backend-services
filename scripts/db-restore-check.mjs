#!/usr/bin/env node
/**
 * Restore verification — turns a dump file into a *verified* backup.
 *
 * Restores into a throwaway database and checks that what came back is usable:
 * schema present, critical row counts non-trivial, and the Company Identity
 * constraints intact. This is the mechanism the production cutover depends on,
 * because once real duplicate GUIDs exist in production, snapshot restore is the
 * only rollback available.
 *
 * Usage:
 *   BACKUP_FILE=/path/to/db.dump \
 *   RESTORE_DATABASE_URL=postgres://user@host/td_restore_check \
 *     node scripts/db-restore-check.mjs
 *
 * Options:
 *   EXPECT_CID_CUTOVER=1   require UNIQUE(workspace_id,guid) and no global
 *                          UNIQUE(guid) — i.e. a post-cutover snapshot
 *   KEEP_RESTORE=1         keep the restored database for inspection
 *   JOBS=4                 parallel restore jobs
 *
 * The restore target MUST NOT be a live database: the script refuses unless the
 * target is empty or DROP_EXISTING=1 is given.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BACKUP_FILE = process.env.BACKUP_FILE;
const RESTORE_DATABASE_URL = process.env.RESTORE_DATABASE_URL;
const JOBS = Number(process.env.JOBS || 4);
const KEEP = process.env.KEEP_RESTORE === '1';
const DROP_EXISTING = process.env.DROP_EXISTING === '1';
const EXPECT_CID_CUTOVER = process.env.EXPECT_CID_CUTOVER === '1';

const results = [];
let failed = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!BACKUP_FILE) fail('BACKUP_FILE is required');
if (!RESTORE_DATABASE_URL) fail('RESTORE_DATABASE_URL is required');
if (!fs.existsSync(BACKUP_FILE)) fail(`backup not found: ${BACKUP_FILE}`);

function run(cmd, args, { capture = true, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
    }
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolve({ code, out: out.trim(), err: err.trim() });
      else reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim().slice(0, 400)}` : ''}`));
    });
  });
}

const sql = async (statement) => {
  const { out } = await run('psql', [RESTORE_DATABASE_URL, '-XAt', '-c', statement]);
  return out;
};

function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '<unparsable url>';
  }
}

/** Row counts worth trusting a restore over — these carry the business data. */
const CRITICAL_TABLES = [
  'companies',
  'workspaces',
  'ledgers',
  'vouchers',
  'voucher_ledger_entries',
  'stocks',
  'stock_transactions',
];

async function main() {
  console.log(`archive  : ${BACKUP_FILE}`);
  console.log(`target   : ${redact(RESTORE_DATABASE_URL)}`);

  // Never restore over a populated database by accident.
  const existing = await run(
    'psql',
    [RESTORE_DATABASE_URL, '-XAt', '-c',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"],
    { allowFailure: true }
  );
  if (existing.code !== 0) {
    fail(
      `cannot connect to the restore target. Create it first:\n` +
        `  createdb <name>   (the target must exist and be empty)`
    );
  }
  const tableCount = Number(existing.out || 0);
  if (tableCount > 0) {
    if (!DROP_EXISTING) {
      fail(
        `restore target already contains ${tableCount} tables. ` +
          'Refusing to overwrite — use an empty database, or pass DROP_EXISTING=1 if it is disposable.'
      );
    }
    console.log(`dropping ${tableCount} existing tables (DROP_EXISTING=1)`);
    await sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  }

  // Extensions must exist before their dependent tables are created. pg_restore
  // cannot create them without superuser rights, and without this step tables
  // like kb_chunks (pgvector) vanish while the restore still looks successful.
  const { out: preToc } = await run('pg_restore', ['--list', BACKUP_FILE]);
  const archiveExtensions = [
    ...new Set(
      (preToc.match(/^\d+;.*\bEXTENSION\s+-\s+(\S+)/gm) || []).map((line) =>
        line.replace(/^.*\bEXTENSION\s+-\s+(\S+).*$/, '$1')
      )
    ),
  ].filter((name) => name !== 'plpgsql');

  const missingExtensions = [];
  for (const name of archiveExtensions) {
    const attempt = await run(
      'psql',
      [RESTORE_DATABASE_URL, '-XAt', '-c', `CREATE EXTENSION IF NOT EXISTS "${name}"`],
      { allowFailure: true }
    );
    if (attempt.code !== 0) missingExtensions.push(name);
  }
  if (archiveExtensions.length) {
    console.log(
      `extensions: ${archiveExtensions.join(', ')}` +
        (missingExtensions.length ? ` (could not create: ${missingExtensions.join(', ')})` : '')
    );
  }

  const isDirFormat = fs.statSync(BACKUP_FILE).isDirectory();
  const args = ['--no-owner', '--no-privileges', '--dbname', RESTORE_DATABASE_URL];
  if (isDirFormat) args.push('--format=directory', `--jobs=${JOBS}`);
  args.push(BACKUP_FILE);

  const started = Date.now();
  // pg_restore reports non-fatal warnings with a non-zero exit; verification
  // below is the real gate, so capture rather than abort here.
  const restore = await run('pg_restore', args, { allowFailure: true });
  const restoreMs = Date.now() - started;
  console.log(`restore  : ${(restoreMs / 1000).toFixed(1)}s (pg_restore exit ${restore.code})`);

  // pg_restore exits 1 for benign role/ownership warnings too, so an operator
  // must be able to see what was actually reported instead of guessing.
  const restoreErrors = (restore.err || '')
    .split('\n')
    .filter((l) => /^pg_restore: error:/.test(l));
  if (restoreErrors.length) {
    console.log(`         ${restoreErrors.length} pg_restore error line(s); first 5:`);
    for (const line of restoreErrors.slice(0, 5)) console.log(`           ${line}`);
  }

  console.log('\nverification');

  const restoredTables = Number(
    await sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
  );
  check('schema restored', restoredTables > 50, `${restoredTables} tables`);

  // A missing extension (e.g. pgvector) makes its dependent tables fail to
  // create while the restore still looks broadly successful. Compare the
  // archive's own table list against what actually landed.
  const { out: toc } = await run('pg_restore', ['--list', BACKUP_FILE]);
  const archiveTables = new Set(
    (toc.match(/^\d+;.*\bTABLE\s+public\s+(\S+)/gm) || []).map((line) =>
      line.replace(/^.*\bTABLE\s+public\s+(\S+).*$/, '$1')
    )
  );
  const present = new Set(
    (await sql("SELECT string_agg(table_name, ',') FROM information_schema.tables WHERE table_schema='public'"))
      .split(',')
      .filter(Boolean)
  );
  const missing = [...archiveTables].filter((t) => !present.has(t));
  check(
    'every table in the archive was restored',
    missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : `${archiveTables.size} archive tables`
  );

  const extensions = await sql(
    "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname <> 'plpgsql'"
  );
  check(
    'archive extensions available in the restore target',
    missingExtensions.length === 0,
    missingExtensions.length
      ? `install as superuser first: ${missingExtensions.map((e) => `CREATE EXTENSION ${e};`).join(' ')}`
      : extensions || 'none required'
  );

  const rowCounts = {};
  for (const table of CRITICAL_TABLES) {
    const present = await sql(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='${table}')`
    );
    if (present !== 't') {
      check(`table ${table} present`, false, 'missing');
      continue;
    }
    rowCounts[table] = Number(await sql(`SELECT count(*) FROM ${table}`));
  }
  check(
    'companies restored with rows',
    (rowCounts.companies || 0) > 0,
    `companies=${rowCounts.companies ?? 'n/a'}`
  );
  console.log(`         row counts: ${JSON.stringify(rowCounts)}`);

  // Company Identity invariants — a restore that lost these cannot be a rollback target.
  const wsNotNull = await sql(
    `SELECT is_nullable FROM information_schema.columns
      WHERE table_name='companies' AND column_name='workspace_id'`
  );
  check('companies.workspace_id NOT NULL', wsNotNull === 'NO', `is_nullable=${wsNotNull}`);

  const constraints = await sql(
    `SELECT string_agg(conname || '=' || pg_get_constraintdef(oid), ' | ' ORDER BY conname)
       FROM pg_constraint
      WHERE conrelid = 'companies'::regclass AND contype IN ('u','p')`
  );
  console.log(`         companies uniques: ${constraints || 'none'}`);

  const hasComposite = /UNIQUE \(workspace_id, guid\)/.test(constraints || '');
  const hasGlobalGuid = /UNIQUE \(guid\)/.test(constraints || '');

  if (EXPECT_CID_CUTOVER) {
    check('UNIQUE(workspace_id, guid) present', hasComposite);
    check('global UNIQUE(guid) absent', !hasGlobalGuid);
  } else {
    check(
      'companies has a guid uniqueness constraint',
      hasComposite || hasGlobalGuid,
      hasComposite ? 'composite (post-cutover)' : 'global (pre-cutover)'
    );
  }

  // Orphans would mean the dump captured a torn state.
  const orphanCompanies = Number(
    await sql(`SELECT count(*) FROM companies c
                LEFT JOIN workspaces w ON w.id = c.workspace_id
               WHERE c.workspace_id IS NULL OR w.id IS NULL`)
  );
  check('no companies without a workspace', orphanCompanies === 0, `${orphanCompanies} orphans`);

  const fkCount = Number(
    await sql(`SELECT count(*) FROM pg_constraint WHERE contype='f'`)
  );
  check('foreign keys restored', fkCount > 0, `${fkCount} FK constraints`);

  // Record the verification next to the artefact so an operator can prove it later.
  const manifestPath = `${BACKUP_FILE}.manifest.json`;
  const verification = {
    verifiedAt: new Date().toISOString(),
    restoreMs,
    pgRestoreExit: restore.code,
    pgRestoreErrorLines: restoreErrors.length,
    pgRestoreErrorSample: restoreErrors.slice(0, 5),
    restoredTables,
    rowCounts,
    companiesUniques: constraints,
    expectedCidCutover: EXPECT_CID_CUTOVER,
    checks: results,
    restoreVerified: failed === 0,
  };
  try {
    const existingManifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : {};
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...existingManifest, ...verification }, null, 2)}\n`
    );
    console.log(`\nmanifest updated: ${path.basename(manifestPath)}`);
  } catch (err) {
    console.warn(`could not update manifest: ${err.message}`);
  }

  if (!KEEP) {
    await sql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    console.log('restore target emptied (KEEP_RESTORE=1 to retain)');
  }

  if (failed) {
    console.error(`\n${failed} verification check(s) failed — this backup is NOT proven restorable`);
    process.exit(1);
  }
  console.log('\nBACKUP VERIFIED RESTORABLE');
  process.exit(0);
}

main().catch((err) => fail(err.message));
