#!/usr/bin/env node
/**
 * X10 — map every INSERT ... ON CONFLICT (cols) target in src/ to a matching
 * unique index/constraint in a database, using catalog metadata only.
 *
 * Never reads application rows. Runs inside a READ ONLY transaction and rolls back.
 *
 * Usage:
 *   node scripts/x10-arbiter-map.mjs --url-env TD_TEST_DATABASE_URL --out report.md
 *   node scripts/x10-arbiter-map.mjs --env-file .env --out report.md   (reads DATABASE_URL, never prints it)
 *   node scripts/x10-arbiter-map.mjs --source-only --out report.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

export function extractArbiters(src, file) {
  const results = [];
  const re = /INSERT\s+INTO\s+([a-z_][a-z0-9_]*)/gi;
  let m;
  while ((m = re.exec(src))) {
    const table = m[1].toLowerCase();
    const start = m.index;
    const nextInsert = src.slice(start + 1).search(/INSERT\s+INTO\s/i);
    const end = nextInsert < 0 ? Math.min(src.length, start + 6000) : Math.min(start + 1 + nextInsert, start + 6000);
    const stmt = src.slice(start, end);
    const oc = /ON\s+CONFLICT\s*(\(([^)]*)\)(\s*WHERE\s+([\s\S]*?))?\s*DO|ON\s+CONSTRAINT\s+([a-z0-9_]+)|DO)/i.exec(stmt);
    if (!oc) continue;
    const line = src.slice(0, start).split('\n').length;
    if (oc[5]) {
      results.push({ file, line, table, constraint: oc[5], cols: null, where: null });
    } else if (oc[2] !== undefined) {
      const cols = oc[2].split(',').map((c) => c.trim().replace(/\s+/g, ' ').toLowerCase()).filter(Boolean);
      const where = oc[4] ? oc[4].trim().replace(/\s+/g, ' ') : null;
      results.push({ file, line, table, constraint: null, cols, where });
    } else {
      results.push({ file, line, table, constraint: null, cols: [], where: null, noTarget: true });
    }
  }
  return results;
}

async function catalog(url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const { rows: ver } = await client.query('SHOW server_version');
    const { rows: idx } = await client.query(`
      SELECT t.relname AS table, i.relname AS index, ix.indisunique AS unique, ix.indisprimary AS primary,
             ix.indisvalid AS valid, ix.indisready AS ready,
             pg_get_indexdef(ix.indexrelid) AS def,
             pg_get_expr(ix.indpred, ix.indrelid) AS predicate,
             ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true)
                   FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k) AS cols
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = current_schema() AND ix.indisunique
      ORDER BY t.relname, i.relname`);
    const { rows: cons } = await client.query(`
      SELECT conname, conrelid::regclass::text AS table, contype, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE connamespace = current_schema()::regnamespace AND contype IN ('u','p','x')`);
    const { rows: alterCols } = await client.query(`
      SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND (column_name ILIKE '%alter_id%' OR column_name ILIKE '%alterid%')
      ORDER BY table_name, column_name`);
    return { version: ver[0].server_version, idx, cons, alterCols };
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    await client.end();
  }
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[()"]/g, '').trim();
}

export function matchArbiter(a, idx, cons) {
  const tIdx = idx.filter((r) => r.table === a.table);
  if (a.constraint) {
    const c = cons.find((r) => r.conname === a.constraint);
    return c ? { status: 'OK', detail: `constraint ${a.constraint}` } : { status: 'MISSING', detail: `constraint ${a.constraint} not found` };
  }
  if (a.noTarget) return { status: 'NO_TARGET', detail: 'ON CONFLICT DO … without arbiter (any unique violation)' };
  const want = a.cols.map(norm).sort().join('|');
  const candidates = tIdx.filter((r) => r.cols.map(norm).sort().join('|') === want);
  if (!candidates.length) {
    return { status: 'MISSING', detail: `no unique index on (${a.cols.join(', ')}); table has: ${tIdx.map((r) => `${r.index}(${r.cols.join(',')})${r.predicate ? ' WHERE ' + r.predicate : ''}`).join('; ') || 'none'}` };
  }
  const usable = candidates.filter((r) => r.valid && r.ready);
  if (!usable.length) return { status: 'INVALID', detail: candidates.map((r) => r.index).join(', ') + ' not valid/ready' };
  const pred = a.where ? norm(a.where) : null;
  const exact = usable.find((r) => (r.predicate ? norm(r.predicate) : null) === pred);
  if (exact) return { status: 'OK', detail: exact.index + (exact.predicate ? ` WHERE ${exact.predicate}` : '') };
  const nonPartial = usable.find((r) => !r.predicate);
  if (nonPartial) return { status: 'OK', detail: `${nonPartial.index} (non-partial)` };
  return { status: 'PREDICATE_MISMATCH', detail: usable.map((r) => `${r.index} WHERE ${r.predicate}`).join('; ') + ` vs statement WHERE ${a.where || '(none)'}` };
}

async function main() {
  const out = arg('--out');
  const files = walk(path.join(ROOT, 'src'));
  const arbiters = files.flatMap((f) => extractArbiters(fs.readFileSync(f, 'utf8'), path.relative(ROOT, f)));
  const lines = ['# X10 arbiter map', '', `Generated: ${new Date().toISOString()}`, `Statements with ON CONFLICT in src/: ${arbiters.length}`, ''];

  let url = null;
  let target = 'source-only';
  if (arg('--url-env')) {
    url = process.env[arg('--url-env')];
    target = `env:${arg('--url-env')}`;
  } else if (arg('--env-file')) {
    const txt = fs.readFileSync(path.resolve(arg('--env-file')), 'utf8');
    const m = /^\s*DATABASE_URL\s*=\s*"?([^"\n]+)"?/m.exec(txt);
    url = m ? m[1].trim() : null;
    target = `env-file:${path.basename(arg('--env-file'))} DATABASE_URL (value not printed)`;
  }
  lines.push(`Target: ${target}`, '');

  let cat = null;
  if (url) cat = await catalog(url);
  if (cat) {
    lines.push(`PostgreSQL server_version: ${cat.version}`, '');
  }

  lines.push('| Table | Arbiter | Source | Status | Detail |', '|---|---|---|---|---|');
  const seen = new Set();
  const summary = {};
  for (const a of arbiters) {
    const key = `${a.table}|${a.constraint || (a.cols || []).join(',')}|${a.where || ''}`;
    const m = cat ? matchArbiter(a, cat.idx, cat.cons) : { status: 'NOT_CHECKED', detail: '' };
    summary[m.status] = (summary[m.status] || 0) + 1;
    if (seen.has(key + m.status)) continue;
    seen.add(key + m.status);
    const arb = a.constraint ? `CONSTRAINT ${a.constraint}` : a.noTarget ? '(none)' : `(${a.cols.join(', ')})${a.where ? ' WHERE ' + a.where : ''}`;
    lines.push(`| ${a.table} | ${arb.replace(/\|/g, '\\|')} | ${a.file}:${a.line} | ${m.status} | ${m.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('', '## Summary (per statement)', '', ...Object.entries(summary).map(([k, v]) => `- ${k}: ${v}`));
  if (cat) {
    lines.push('', '## AlterID-like columns', '', '| Table | Column | Type |', '|---|---|---|',
      ...cat.alterCols.map((c) => `| ${c.table_name} | ${c.column_name} | ${c.data_type} |`));
    const invalid = cat.idx.filter((r) => !r.valid || !r.ready);
    lines.push('', `## Invalid/not-ready unique indexes: ${invalid.length}`, ...invalid.map((r) => `- ${r.table}.${r.index}`));
  }
  const text = lines.join('\n') + '\n';
  if (out) fs.writeFileSync(out, text);
  else process.stdout.write(text);
  console.error(`arbiters=${arbiters.length} ${JSON.stringify(summary)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error('x10-arbiter-map failed:', e.code || '', e.message.replace(/postgres(ql)?:\/\/[^\s]+/gi, '<url>'));
    process.exit(1);
  });
}
