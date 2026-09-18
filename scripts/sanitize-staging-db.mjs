#!/usr/bin/env node
/**
 * Scrub secrets from a staging database restored from a production snapshot.
 *
 * Structure and row volume are preserved so migration timing stays meaningful;
 * every credential, session, and OTP is destroyed.
 *
 *   DATABASE_URL=<staging> node scripts/sanitize-staging-db.mjs            # report
 *   DATABASE_URL=<staging> CONFIRM=1 node scripts/sanitize-staging-db.mjs  # apply
 *
 * Refuses to run against a production-stamped database. The secret-bearing
 * column list is discovered from the live schema rather than hardcoded, so a
 * newly added credential column cannot silently escape scrubbing.
 */
import 'dotenv/config';
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const CONFIRM = process.env.CONFIRM === '1';

/** Tables emptied wholesale — sessions and pairing handshakes carry nothing worth keeping. */
const TRUNCATE_TABLES = [
  'auth_sessions',
  'desktop_pairing_sessions',
  'restore_sessions',
  'push_tokens',
];

/**
 * Columns that look like secrets but are not, so they are kept.
 * Timestamps and expiry markers hold no secret and preserving them keeps row
 * shape realistic.
 */
const NOT_SECRET = new Set([
  'devices.credential_claimed_at',
  'integrations.token_expiry',
  'users.otp_expires',
  'users.phone_change_otp_expires',
  'users.email_change_otp_expires',
]);

const SECRET_PATTERN = '(secret|token|password|api_key|apikey|credential|otp|private_key)';

const client = new pg.Client({ connectionString: url });
await client.connect();

let exitCode = 0;
try {
  const { rows: dbinfo } = await client.query('SELECT current_database() AS db');
  console.log(`database : ${dbinfo[0].db}`);

  // Never scrub something that is actually production.
  const { rows: stamp } = await client.query(`
    SELECT to_regclass('public.deployment_identity') IS NOT NULL AS present
  `);
  let stamped = 'unstamped';
  if (stamp[0].present) {
    const { rows } = await client.query(
      'SELECT app_env FROM deployment_identity ORDER BY stamped_at DESC LIMIT 1'
    );
    stamped = rows[0]?.app_env ?? 'unstamped';
  }
  console.log(`db stamp : ${stamped}`);
  if (stamped === 'production') {
    console.error(
      '\nREFUSING: this database is stamped production.\n' +
        'Sanitisation is destructive and is only ever run on a staging copy.\n' +
        'Re-stamp the restored copy first (RESTAMP_DEPLOYMENT_ENV=1 APP_ENV=staging).'
    );
    process.exit(1);
  }

  const { rows: cols } = await client.query(
    `SELECT table_name, column_name, is_nullable, data_type
       FROM information_schema.columns c
      WHERE table_schema = 'public'
        AND column_name ~* $1
        AND EXISTS (
          SELECT 1 FROM information_schema.tables t
           WHERE t.table_schema = 'public' AND t.table_name = c.table_name
             AND t.table_type = 'BASE TABLE')
      ORDER BY table_name, column_name`,
    [SECRET_PATTERN]
  );

  const targets = [];
  const kept = [];
  for (const c of cols) {
    const key = `${c.table_name}.${c.column_name}`;
    if (NOT_SECRET.has(key)) {
      kept.push(key);
      continue;
    }
    // Tables emptied entirely need no per-column work.
    if (TRUNCATE_TABLES.includes(c.table_name)) continue;
    targets.push(c);
  }

  console.log('\n── tables to truncate ────────────────────────────────────────');
  for (const t of TRUNCATE_TABLES) {
    const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
      `public.${t}`,
    ]);
    if (!rows[0].present) {
      console.log(`  ${t.padEnd(30)} (absent)`);
      continue;
    }
    const { rows: n } = await client.query(`SELECT count(*)::bigint AS n FROM public.${t}`);
    console.log(`  ${t.padEnd(30)} ${String(n[0].n).padStart(10)} rows`);
  }

  console.log('\n── columns to clear ──────────────────────────────────────────');
  for (const c of targets) {
    const nullable = c.is_nullable === 'YES';
    const name = `${c.table_name}.${c.column_name}`;
    console.log(`  ${name.padEnd(50)} ${nullable ? 'NULL' : "''  (NOT NULL)"}`);
  }

  if (kept.length) {
    console.log('\n── deliberately preserved (not secrets) ──────────────────────');
    for (const k of kept) console.log(`  ${k}`);
  }

  if (!CONFIRM) {
    console.log('\nREPORT ONLY — pass CONFIRM=1 to apply.');
    process.exit(0);
  }

  console.log('\n── applying ──────────────────────────────────────────────────');
  await client.query('BEGIN');

  for (const t of TRUNCATE_TABLES) {
    const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [
      `public.${t}`,
    ]);
    if (!rows[0].present) continue;
    await client.query(`TRUNCATE public.${t} CASCADE`);
    console.log(`  truncated ${t}`);
  }

  for (const c of targets) {
    // A NOT NULL column cannot be nulled; blank it instead so the row survives.
    const value = c.is_nullable === 'YES' ? 'NULL' : `''`;
    const sql =
      `UPDATE public.${c.table_name} SET ${c.column_name} = ${value} ` +
      (c.is_nullable === 'YES' ? `WHERE ${c.column_name} IS NOT NULL` : '');
    try {
      const res = await client.query(sql);
      console.log(`  cleared ${c.table_name}.${c.column_name} (${res.rowCount} rows)`);
    } catch (err) {
      // Type mismatch (e.g. jsonb) needs a human decision rather than a guess.
      console.log(
        `  FAILED  ${c.table_name}.${c.column_name}: ${err.code} ${err.message.split('\n')[0]}`
      );
      exitCode = 1;
    }
  }

  if (exitCode !== 0) {
    await client.query('ROLLBACK');
    console.error('\nrolled back — resolve the failures above and re-run');
    process.exit(exitCode);
  }

  await client.query('COMMIT');

  // Prove it: nothing secret-looking may still hold a value.
  console.log('\n── verification ──────────────────────────────────────────────');
  let residue = 0;
  for (const c of targets) {
    const { rows } = await client.query(
      `SELECT count(*)::bigint AS n FROM public.${c.table_name}
        WHERE ${c.column_name} IS NOT NULL AND ${c.column_name}::text <> ''`
    );
    if (Number(rows[0].n) > 0) {
      console.log(`  RESIDUE ${c.table_name}.${c.column_name}: ${rows[0].n} rows`);
      residue += 1;
    }
  }
  if (residue === 0) {
    console.log('  no secret-bearing column retains a value');
    console.log('\nsanitisation complete');
  } else {
    console.error(`\n${residue} column(s) still hold values`);
    process.exit(1);
  }
} finally {
  await client.end();
}
