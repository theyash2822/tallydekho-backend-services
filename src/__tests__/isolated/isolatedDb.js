/**
 * Isolated PostgreSQL test harness (synthetic data only).
 *
 * Positive checks before any application module touches a database:
 *   - TD_ISOLATED_TEST=1 explicitly set
 *   - TD_TEST_DATABASE_URL points at 127.0.0.1 on TD_TEST_PG_PORT (never 5432)
 *   - the database carries td_isolated_fixture_marker whose token matches the
 *     marker file written by scripts/isolated-pg.sh in TD_TEST_PG_DIR
 *
 * DATABASE_URL is overwritten with the isolated URL *before* src/db/schema.js is
 * imported, so the app pool can never fall back to .env or libpq defaults.
 * Never run these tests with `--import dotenv/config`.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { installNetworkGuard } from './networkGuard.js';

export class IsolationError extends Error {
  constructor(message) {
    super(`[isolated-db] ${message}`);
    this.code = 'ISOLATION_GUARD';
  }
}

export function validateIsolatedEnv(env = process.env) {
  if (env.TD_ISOLATED_TEST !== '1') throw new IsolationError('TD_ISOLATED_TEST=1 is required');
  const raw = env.TD_TEST_DATABASE_URL;
  if (!raw) throw new IsolationError('TD_TEST_DATABASE_URL is required');
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new IsolationError('TD_TEST_DATABASE_URL is not a valid URL');
  }
  const port = String(env.TD_TEST_PG_PORT || '');
  if (!port || port === '5432') throw new IsolationError('TD_TEST_PG_PORT must be set and must not be 5432');
  if (u.hostname !== '127.0.0.1') throw new IsolationError('isolated database must be on 127.0.0.1');
  if (u.port !== port) throw new IsolationError('TD_TEST_DATABASE_URL port does not match TD_TEST_PG_PORT');
  if (u.pathname !== '/td_isolated_test') throw new IsolationError('unexpected isolated database name');
  if (env.DATABASE_URL && env.DATABASE_URL !== raw) {
    throw new IsolationError('DATABASE_URL is set to a different database; refusing (do not load .env)');
  }
  const dir = env.TD_TEST_PG_DIR;
  if (!dir) throw new IsolationError('TD_TEST_PG_DIR is required');
  const markerFile = path.join(dir, '.td-isolated-marker');
  if (!fs.existsSync(markerFile)) throw new IsolationError('marker file missing; run scripts/isolated-pg.sh start');
  return { url: raw, token: fs.readFileSync(markerFile, 'utf8').trim() };
}

export async function verifyMarker(url, token) {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  await c.connect();
  try {
    const { rows } = await c.query('SELECT token FROM td_isolated_fixture_marker WHERE id = 1');
    if (!rows.length || rows[0].token !== token) throw new IsolationError('fixture marker mismatch');
  } finally {
    await c.end();
  }
}

let ready = null;

/**
 * Validate isolation, then import the application DB layer bound to the isolated
 * database and initialise the schema there. Returns the schema module.
 */
export function setupIsolatedDb() {
  if (!ready) {
    ready = (async () => {
      const { url, token } = validateIsolatedEnv();
      const u = new URL(url);
      installNetworkGuard({ allow: [[u.hostname, Number(u.port)]] });
      await verifyMarker(url, token);
      process.env.DATABASE_URL = url;
      process.env.NODE_ENV = 'test';
      process.env.APP_ENV = 'test';
      process.env.SKIP_DEMO_SEED = '1';
      process.env.JWT_SECRET = process.env.JWT_SECRET || 'isolated-test-secret';
      delete process.env.DB_APP_ROLE;
      const schema = await import('../../db/schema.js');
      try {
        await schema.initSchema();
      } catch (err) {
        await schema.getPool().end().catch(() => {});
        throw err;
      }
      return schema;
    })();
  }
  return ready;
}

/** Unique synthetic identifier per test so fixtures never collide or need bulk cleanup. */
export function uniq(prefix = 'iso') {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
