// R1 / 05 (V-003): a sync of company A leaves company B and every year's visibility alone.
// R1 / S4: registration and heartbeats never report a sync that did not happen.
// Real /desktop/init-sync, /desktop/register and /desktop/pairing-device routes on the isolated DB.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';
import { startRouteHarness, seedWorkspace } from './routeHarness.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const { default: ingestRoutes } = await import('../../routes/ingest.js');
const { default: pairingRoutes } = await import('../../routes/pairing.js');
const harness = await startRouteHarness([['/', ingestRoutes], ['/desktop', pairingRoutes]]);
test.after(async () => {
  await harness.close();
  await schema.getPool().end();
});

const fy = (y) => ({ finYear: `${y}-${y + 1}`, begin: `${y}0401`, end: `${y + 1}0331` });

async function addYear(companyId, guid, y, active) {
  await q(
    `INSERT INTO company_years (company_guid, company_id, fin_year, begin_date, end_date, is_active, is_current)
     VALUES ($1,$2,$3,$4,$5,$6,FALSE)`,
    [guid, companyId, `${y}-${y + 1}`, `${y}-04-01`, `${y + 1}-03-31`, active],
  );
}
const visibility = async (companyId) => (await q(
  `SELECT c.is_active, json_object_agg(y.fin_year, y.is_active ORDER BY y.fin_year) AS years
     FROM companies c LEFT JOIN company_years y ON y.company_id = c.id
    WHERE c.id = $1 GROUP BY c.is_active`, [companyId])).rows[0];

test('05: syncing company A only leaves company B and all year visibility unchanged', async () => {
  const ws = await seedWorkspace(q, uniq);
  await q('UPDATE companies SET device_id = $1 WHERE id = $2', [ws.deviceId, ws.companyId]);
  const bGuid = uniq('coB');
  const { rows: b } = await q(
    `INSERT INTO companies (guid, name, workspace_id, device_id, is_active) VALUES ($1,'Company B',$2,$3,TRUE) RETURNING id`,
    [bGuid, ws.workspaceId, ws.deviceId],
  );
  await addYear(ws.companyId, ws.companyGuid, 2024, true);
  await addYear(b[0].id, bGuid, 2024, true);
  await addYear(b[0].id, bGuid, 2025, true);
  const bBefore = await visibility(b[0].id);

  // A sync of company A with only FY 2025-26 selected this time.
  const res = await harness.call('POST', '/desktop/init-sync', {
    headers: ws.deviceHeaders,
    body: { companies: [{ guid: ws.companyGuid, name: 'Synthetic Co', years: [fy(2025)], allYears: [fy(2024), fy(2025)] }] },
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.deepEqual(await visibility(b[0].id), bBefore, 'company B and its years are untouched');
  const a = await visibility(ws.companyId);
  assert.equal(a.is_active, true);
  assert.deepEqual(a.years, { '2024-2025': true, '2025-2026': true }, 'a year left out of this sync stays visible');
});

test('S4: registration reports the last verified sync, never the registration or heartbeat time', async () => {
  const ws = await seedWorkspace(q, uniq);
  const register = () => harness.call('POST', '/desktop/register', { headers: { 'device-id': ws.deviceId }, body: { desktopVersion: '1.0.0' } });

  const first = await register();
  assert.equal(first.status, 200);
  assert.equal(first.body.data.lastSync, null, 'no sync has completed, so there is no last sync');
  assert.ok(first.body.data.lastSeen, 'registration time is reported separately');

  const pairingNoSync = await harness.call('GET', '/desktop/pairing-device', { headers: { 'device-id': ws.deviceId } });
  assert.equal(pairingNoSync.body.data.pairing.LAST_SYNC_AT, null);
  assert.ok(pairingNoSync.body.data.pairing.LAST_SEEN_AT);

  const syncedAt = 1_700_000_000;
  await q('UPDATE companies SET device_id = $1, synced_at = $2 WHERE id = $3', [ws.deviceId, syncedAt, ws.companyId]);
  const again = await register();
  assert.equal(again.body.data.lastSync, new Date(syncedAt * 1000).toISOString());
  assert.notEqual(again.body.data.lastSeen, again.body.data.lastSync);

  const pairing = await harness.call('GET', '/desktop/pairing-device', { headers: { 'device-id': ws.deviceId } });
  assert.equal(pairing.body.data.pairing.LAST_SYNC_AT, syncedAt);
});
