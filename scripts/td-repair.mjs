#!/usr/bin/env node
/**
 * Historical-damage preview / scoped repair (TD-FIX-2026-10-08 P7, I.1–I.8).
 *
 * Deliberately does NOT load .env: the database URL must be passed explicitly.
 * Output is counts and identifiers only (no customer text).
 *
 * Preview (read-only, default):
 *   node scripts/td-repair.mjs --database-url <url> --workspace <id> --company <id> [--items I.1,I.7]
 *
 * Apply (owner-approved runbook only; see audits/implementation/P7_repair_tooling.md):
 *   TD_REPAIR_OWNER_APPROVED=1 node scripts/td-repair.mjs --database-url <url> --workspace <id> --company <id> \
 *     --apply --approve <hash from preview> [--reactivate-years 12,13]
 */
import pg from 'pg';
import { diagnose, buildManifest, applyManifest, REPAIR_ITEMS } from '../src/services/repairTools.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    const key = a.slice(2);
    if (key === 'apply') out.apply = true;
    else out[key] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args['database-url'] || !args.workspace || !args.company) {
    throw new Error('--database-url, --workspace and --company are required');
  }
  const items = args.items ? args.items.split(',').map((s) => s.trim()) : REPAIR_ITEMS;
  const selectYearIds = args['reactivate-years'] ? args['reactivate-years'].split(',').map(Number) : [];
  const scope = { workspaceId: args.workspace, companyId: Number(args.company), items };
  const pool = new pg.Pool({ connectionString: args['database-url'], max: 1 });
  try {
    if (!args.apply) {
      const q = (text, params) => pool.query(text, params);
      const preview = buildManifest(await diagnose(q, scope), { selectYearIds });
      console.log(JSON.stringify({ mode: 'preview', ...preview }, null, 2));
      return;
    }
    if (process.env.TD_REPAIR_OWNER_APPROVED !== '1') throw new Error('Apply requires TD_REPAIR_OWNER_APPROVED=1');
    if (!args.approve) throw new Error('Apply requires --approve <manifest hash>');
    const client = await pool.connect();
    try {
      const res = await applyManifest(client, { ...scope, selectYearIds, approvedHash: args.approve });
      console.log(JSON.stringify({ mode: 'applied', ...res }, null, 2));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`td-repair: ${err.code || 'ERROR'} ${err.message}`);
  process.exit(1);
});
