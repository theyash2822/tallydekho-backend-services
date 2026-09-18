#!/usr/bin/env node
/**
 * Operator database backup.
 *
 * A backup nobody has restored is not a backup. This script only produces the
 * artefact; scripts/db-restore-check.mjs proves it can be restored, and the
 * Company Identity cutover requires that proof (rollback after real duplicate
 * GUIDs exist is snapshot restore, nothing else).
 *
 * Usage:
 *   DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/tallydekho \
 *     node scripts/db-backup.mjs
 *
 * Options:
 *   BACKUP_DIR   destination directory (required; created if absent)
 *   BACKUP_TAG   label in the filename, e.g. pre-cid-cutover
 *   JOBS         parallel pg_dump jobs for directory format (default 1)
 *   FORMAT       custom | directory   (default custom → single .dump file)
 *
 * Never overwrites an existing artefact. Exits non-zero on any failure.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DATABASE_URL = process.env.DATABASE_URL;
const BACKUP_DIR = process.env.BACKUP_DIR;
const TAG = (process.env.BACKUP_TAG || 'manual').replace(/[^A-Za-z0-9._-]/g, '-');
const FORMAT = (process.env.FORMAT || 'custom').toLowerCase();
const JOBS = Number(process.env.JOBS || 1);

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!DATABASE_URL) fail('DATABASE_URL is required (no implicit default — never guess the database)');
if (!BACKUP_DIR) fail('BACKUP_DIR is required (explicit destination only)');
if (!['custom', 'directory'].includes(FORMAT)) fail(`FORMAT must be custom or directory (got ${FORMAT})`);

function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? '***@' : ''}${u.host}${u.pathname}`;
  } catch {
    return '<unparsable DATABASE_URL>';
  }
}

function dbName(url) {
  try {
    return new URL(url).pathname.replace(/^\//, '') || 'unknown';
  } catch {
    return 'unknown';
  }
}

function run(cmd, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    let err = '';
    if (capture) {
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
    }
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} exited ${code}${err ? `: ${err.trim()}` : ''}`))
    );
  });
}

function dirSize(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    total += dirSize(path.join(target, entry.name));
  }
  return total;
}

const human = (bytes) => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
};

async function main() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = `${dbName(DATABASE_URL)}_${TAG}_${stamp}`;
  const target = path.join(BACKUP_DIR, FORMAT === 'directory' ? base : `${base}.dump`);

  if (fs.existsSync(target)) fail(`refusing to overwrite existing backup: ${target}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  console.log(`source   : ${redact(DATABASE_URL)}`);
  console.log(`target   : ${target}`);
  console.log(`format   : ${FORMAT}${FORMAT === 'directory' ? ` (jobs=${JOBS})` : ''}`);

  // Record the server version — a dump can only be restored by an equal or
  // newer pg_restore, and a version mismatch is a silent rollback failure.
  const serverVersion = await run(
    'psql',
    [DATABASE_URL, '-XAt', '-c', 'SHOW server_version'],
    { capture: true }
  );
  const dumpVersion = await run('pg_dump', ['--version'], { capture: true });
  console.log(`server   : PostgreSQL ${serverVersion}`);
  console.log(`pg_dump  : ${dumpVersion}`);

  const args = ['--no-owner', '--no-privileges', '--verbose', '--file', target];
  if (FORMAT === 'directory') {
    args.push('--format=directory', `--jobs=${JOBS}`);
  } else {
    args.push('--format=custom', '--compress=6');
  }
  args.push(DATABASE_URL);

  const started = Date.now();
  try {
    await run('pg_dump', args);
  } catch (err) {
    // A partial artefact is worse than none — an operator could restore it.
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      console.error('removed partial artefact');
    }
    fail(err.message);
  }
  const durationMs = Date.now() - started;

  if (!fs.existsSync(target)) fail('pg_dump reported success but produced no artefact');
  const size = dirSize(target);
  if (size === 0) fail('backup artefact is empty');

  // pg_restore --list proves the archive's table of contents is readable.
  const toc = await run('pg_restore', ['--list', target], { capture: true });
  const tableCount = (toc.match(/^\d+;.*TABLE DATA/gm) || []).length;
  if (tableCount === 0) fail('archive contains no TABLE DATA entries');

  const manifest = {
    database: dbName(DATABASE_URL),
    tag: TAG,
    format: FORMAT,
    artefact: path.basename(target),
    bytes: size,
    size: human(size),
    durationMs,
    serverVersion,
    pgDumpVersion: dumpVersion,
    tableDataEntries: tableCount,
    createdAt: new Date().toISOString(),
    restoreVerified: false,
  };
  fs.writeFileSync(`${target}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nOK  ${human(size)} in ${(durationMs / 1000).toFixed(1)}s · ${tableCount} table data entries`);
  console.log(`manifest : ${target}.manifest.json`);
  console.log('\nNOT YET A VALID BACKUP — verify the restore:');
  console.log(`  BACKUP_FILE=${target} RESTORE_DATABASE_URL=postgres://.../verify_db \\`);
  console.log('    node scripts/db-restore-check.mjs');
  process.exit(0);
}

main().catch((err) => fail(err.message));
