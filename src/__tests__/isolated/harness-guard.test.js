import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIsolatedEnv, setupIsolatedDb } from './isolatedDb.js';

const base = {
  TD_ISOLATED_TEST: '1',
  TD_TEST_PG_PORT: '55432',
  TD_TEST_PG_DIR: process.env.TD_TEST_PG_DIR || '/tmp/td-isolated-pg',
  TD_TEST_DATABASE_URL: 'postgresql://td_isolated:x@127.0.0.1:55432/td_isolated_test',
};

test('guard rejects missing explicit test mode', () => {
  assert.throws(() => validateIsolatedEnv({ ...base, TD_ISOLATED_TEST: '' }), /TD_ISOLATED_TEST/);
});

test('guard rejects default port and non-loopback hosts', () => {
  assert.throws(() => validateIsolatedEnv({ ...base, TD_TEST_PG_PORT: '5432' }), /5432/);
  assert.throws(
    () => validateIsolatedEnv({ ...base, TD_TEST_DATABASE_URL: 'postgresql://u:p@db.example.com:55432/td_isolated_test' }),
    /127\.0\.0\.1/
  );
});

test('guard rejects a database name merely containing "test"', () => {
  assert.throws(
    () => validateIsolatedEnv({ ...base, TD_TEST_DATABASE_URL: 'postgresql://u:p@127.0.0.1:55432/tallydekho_test' }),
    /database name/
  );
});

test('guard rejects a different DATABASE_URL already loaded (e.g. from .env)', () => {
  assert.throws(
    () => validateIsolatedEnv({ ...base, DATABASE_URL: 'postgresql://other@127.0.0.1:5432/tallydekho' }),
    /different database/
  );
});

test('isolated schema initialises on the disposable cluster only', async () => {
  const schema = await setupIsolatedDb();
  const { rows } = await schema.getPool().query(
    "SELECT current_database() AS db, inet_server_port() AS port, (SELECT app_env FROM deployment_identity WHERE id=1) AS env"
  );
  assert.equal(rows[0].db, 'td_isolated_test');
  assert.equal(String(rows[0].port), process.env.TD_TEST_PG_PORT);
  assert.equal(rows[0].env, 'test');
  await schema.getPool().end();
});
