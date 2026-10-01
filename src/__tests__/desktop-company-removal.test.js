import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  deactivateWorkspaceCompanies,
  normalizeRemovalGuids,
  CompanyRemovalError,
  MAX_REMOVE_GUIDS,
} from '../services/desktopCompanyRemoval.js';

function fakeQuery(existing) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    const [, guids] = params;
    return { rows: guids.filter((g) => existing.includes(g)).map((guid) => ({ guid })) };
  };
  fn.calls = calls;
  return fn;
}

test('deactivates only within the device workspace and reports unknown GUIDs', async () => {
  const q = fakeQuery(['A', 'B']);
  const result = await deactivateWorkspaceCompanies(q, 'ws-1', ['A', 'X']);
  assert.deepEqual(result, { removed: ['A'], notFound: ['X'] });
  assert.equal(q.calls.length, 1);
  assert.match(q.calls[0].sql, /SET is_active = FALSE/);
  assert.match(q.calls[0].sql, /workspace_id = \$1/);
  assert.doesNotMatch(q.calls[0].sql, /device_id/, 'must not be limited to the calling device');
  assert.match(q.calls[0].sql, /COALESCE\(is_demo, FALSE\) = FALSE/, 'Demo companies are never hidden');
  assert.deepEqual(q.calls[0].params, ['ws-1', ['A', 'X']]);
});

test('removing the last company works (no minimum list size)', async () => {
  const q = fakeQuery(['ONLY']);
  const result = await deactivateWorkspaceCompanies(q, 'ws-1', ['ONLY']);
  assert.deepEqual(result.removed, ['ONLY']);
});

test('refuses without a workspace and never queries', async () => {
  const q = fakeQuery(['A']);
  await assert.rejects(
    () => deactivateWorkspaceCompanies(q, null, ['A']),
    (err) => err instanceof CompanyRemovalError && err.code === 'DEVICE_NOT_PAIRED' && err.httpStatus === 403
  );
  assert.equal(q.calls.length, 0);
});

test('GUID list is validated, trimmed and de-duplicated', () => {
  assert.deepEqual(normalizeRemovalGuids([' A ', 'A', 'B', '', 5, null, 'x'.repeat(129)]), ['A', 'B']);
  for (const bad of [undefined, null, 'A', [], [''], [1, 2]]) {
    assert.throws(() => normalizeRemovalGuids(bad), (e) => e.code === 'INVALID_GUIDS');
  }
  const tooMany = Array.from({ length: MAX_REMOVE_GUIDS + 1 }, (_, i) => `g${i}`);
  assert.throws(() => normalizeRemovalGuids(tooMany), (e) => e.code === 'TOO_MANY_GUIDS');
});

test('route is device-authenticated and sends one refresh event, only once connected', () => {
  const src = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');
  assert.match(src, /router\.post\('\/desktop\/companies\/remove', requireDeviceCredential,/);
  const start = src.indexOf("router.post('/desktop/companies/remove'");
  const route = src.slice(start, src.indexOf('router.post(', start + 10));
  assert.match(route, /notifyWorkspaceRoom\(workspaceId, 'synced'/);
  assert.doesNotMatch(route, /notifySynced\(/, 'notifySynced per GUID also flips clients to CONNECTED');
  assert.doesNotMatch(route, /forEach\(/, 'one event per request, not per company');
  assert.match(route, /=== 'CONNECTED'/);
});
