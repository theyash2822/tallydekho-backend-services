// R2 / S7: a verified completion is announced to the device's workspace even when the
// legacy devices.user_id is empty; stale runs are swept without any new request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';
import { startRouteHarness, seedWorkspace } from './routeHarness.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const ingest = await import('../../routes/ingest.js');
const { sweepStaleSyncRuns, startSyncRun } = await import('../../utils/syncRuns.js');
const notified = [];
ingest.setSocketService({
  notifySynced: (userId, companyGuid, workspaceId) => notified.push({ userId, companyGuid, workspaceId }),
  notifyWorkspace: () => {}, notifyWorkspaceRoom: () => {}, emitToUser: () => {},
});
const harness = await startRouteHarness([['/', ingest.default]]);
test.after(async () => {
  await harness.close();
  await schema.getPool().end();
});

test('a verified completion reaches the workspace audience with a null legacy user_id', async () => {
  const ws = await seedWorkspace(q, uniq);
  // devices.user_id no longer exists on the current schema: the legacy id is always absent.
  const uploadId = uniq('up');
  await q(`INSERT INTO ingest_uploads (id, device_id, company_guid) VALUES ($1, $2, $3)`, [uploadId, ws.deviceId, ws.companyGuid]);
  const headers = { ...ws.deviceHeaders, 'device-id': ws.deviceId };
  const line = JSON.stringify({ XML: 'LedgerTransaction.xml', COMPANY_GUID: ws.companyGuid, Guid: `${ws.companyGuid}-v1`, LedgerName: 'Cash', Amount: '10' });
  const chunk = await harness.call('POST', '/ingest/chunk', {
    raw: `${line}\n`, headers: { ...headers, 'upload-id': uploadId, 'stream-name': 'records', 'chunk-index': '0', 'company-guid': ws.companyGuid },
  });
  assert.equal(chunk.status, 200, JSON.stringify(chunk.body));
  notified.length = 0;
  const done = await harness.call('POST', '/ingest/complete', { headers, body: { uploadId, companyGuid: ws.companyGuid, companies: [{ guid: ws.companyGuid }] } });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual(notified.map((n) => [n.companyGuid, n.workspaceId]), [[ws.companyGuid, ws.workspaceId]]);
});

test('a run whose desktop went silent is abandoned by the sweep alone', async () => {
  const ws = await seedWorkspace(q, uniq);
  const runId = await startSyncRun(q, { companyGuid: ws.companyGuid, companyId: ws.companyId, deviceId: ws.deviceId, syncType: 'normal' });
  await q(`UPDATE sync_runs SET heartbeat_at = NOW() - INTERVAL '2 hours', started_at = NOW() - INTERVAL '2 hours' WHERE id = $1`, [runId]);
  assert.ok((await sweepStaleSyncRuns(q)) >= 1);
  const { rows } = await q('SELECT status FROM sync_runs WHERE id = $1', [runId]);
  assert.equal(rows[0].status, 'abandoned');
});
