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

test('network guard rejects non-owned endpoints before dispatch, allows owned ones', async () => {
  const net = await import('node:net');
  const { installNetworkGuard, allowEndpoint, blockedAttempts } = await import('./networkGuard.js');
  installNetworkGuard();

  let decoyConnections = 0;
  const decoy = net.createServer((s) => { decoyConnections += 1; s.destroy(); });
  await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
  const decoyPort = decoy.address().port;

  const owned = net.createServer((s) => s.end('ok'));
  await new Promise((r) => owned.listen(0, '127.0.0.1', r));
  const ownedPort = owned.address().port;
  allowEndpoint('127.0.0.1', ownedPort);

  // Same loopback host as the owner's real backend: loopback is not a blanket allow.
  assert.throws(() => net.connect(3001, '127.0.0.1'), (e) => e.code === 'NETWORK_GUARD');
  assert.throws(() => net.connect(decoyPort, '127.0.0.1'), (e) => e.code === 'NETWORK_GUARD');
  // OTP/cloud-style host: rejected before DNS lookup. No request is ever sent.
  await assert.rejects(
    fetch('https://otp-provider.invalid/api/v5/otp?mobile=0000000000', { method: 'POST' }),
    (e) => e.code === 'NETWORK_GUARD' || e.cause?.code === 'NETWORK_GUARD'
  );
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(decoyConnections, 0);
  assert.ok(blockedAttempts().some((t) => t.startsWith('otp-provider.invalid')));

  const reply = await new Promise((resolve, reject) => {
    const c = net.connect(ownedPort, '127.0.0.1');
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(buf));
    c.on('error', reject);
  });
  assert.equal(reply, 'ok');
  decoy.close();
  owned.close();
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
