// R1 / X9 (V-001) + X1 through the real routes: an entry Tally may already hold
// is never posted again — not by the desktop pull, the auto-retry worker, a
// manual retry, or a manual retry "with confirmation".
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';
import { startRouteHarness, seedWorkspace } from './routeHarness.js';

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const tallyWrite = await import('../../routes/tally-write.js');
const { default: apiV1 } = await import('../../routes/api-v1.js');
const harness = await startRouteHarness([['/tally', tallyWrite.default], ['/api', apiV1]]);
test.after(async () => {
  await harness.close();
  await schema.getPool().end();
});

/** A connected desktop socket that records every tally:write it receives. */
function fakeDesktop(ws, reply) {
  const posts = [];
  const socket = {
    connected: true,
    emit: (event, payload, cb) => {
      if (event !== 'tally:write') return;
      posts.push(payload.xml);
      if (typeof cb === 'function') cb(reply(posts.length));
    },
  };
  tallyWrite.setTallyWriteSocket({ connectedClients: new Map([[`desktop_${ws.deviceId}`, socket]]) });
  return posts;
}

async function queueEntry(ws, status = 'failed', xml = `<ENVELOPE>${uniq('x')}</ENVELOPE>`) {
  const { rows } = await q(
    `INSERT INTO write_queue (user_id, company_guid, company_id, entry_type, entry_label, payload, xml, status,
                              attempt_count, created_at, updated_at, workspace_id, actor_user_id)
     VALUES ($1,$2,$3,'sales','Synthetic',$4,$5,$6,0,EXTRACT(EPOCH FROM NOW())::BIGINT,EXTRACT(EPOCH FROM NOW())::BIGINT,$7,$1)
     RETURNING id`,
    [ws.userId, ws.companyGuid, ws.companyId, '{}', xml, status, ws.workspaceId]
  );
  return rows[0].id;
}

const row = async (id) => (await q(`SELECT * FROM write_queue WHERE id=$1`, [id])).rows[0];

test('desktop-reported unknown outcome is never re-posted by any retry path', async () => {
  const ws = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(ws, () => ({ status: false, outcomeUnknown: true, code: 'TALLY_WRITE_OUTCOME_UNKNOWN' }));
  const id = await queueEntry(ws);

  const first = await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: ws.userHeaders });
  assert.equal(posts.length, 1, 'first manual retry posts once');
  assert.notEqual(first.status, 200);
  let r = await row(id);
  assert.equal(r.outcome_unknown, true);

  // User "confirms" — the removed override must not post again.
  const again = await harness.call('POST', `/tally/audit-trail/${id}/retry`, {
    headers: ws.userHeaders, body: { confirmOutcomeUnknown: true },
  });
  assert.equal(again.status, 409);
  assert.equal(again.body.outcomeUnknown, true);
  const apiAgain = await harness.call('POST', `/api/vouchers/my-entries/${id}/retry`, {
    headers: ws.userHeaders, body: { confirmOutcomeUnknown: true },
  });
  assert.equal(apiAgain.status, 409);

  await tallyWrite.retryOfflineEntries(ws.workspaceId);
  const pending = await harness.call('POST', '/tally/desktop/writeback/pending', { headers: ws.deviceHeaders, body: {} });
  assert.equal(pending.status, 200);
  assert.equal(pending.body.data.items.some((i) => String(i.outboxId) === String(id)), false);
  const claim = await harness.call('POST', `/tally/desktop/writeback/${id}/claim`, { headers: ws.deviceHeaders, body: {} });
  assert.equal(claim.status, 409);

  assert.equal(posts.length, 1, 'exactly one post across every path');
  r = await row(id);
  assert.equal(r.outcome_unknown, true);
});

test('outbox result route records outcome_unknown and releases the lock without making it retryable', async () => {
  const ws = await seedWorkspace(q, uniq);
  const id = await queueEntry(ws, 'desktop_offline');
  const claim = await harness.call('POST', `/tally/desktop/writeback/${id}/claim`, { headers: ws.deviceHeaders, body: {} });
  assert.equal(claim.status, 200);
  const res = await harness.call('POST', `/tally/desktop/writeback/${id}/result`, {
    headers: ws.deviceHeaders,
    body: { success: false, outcomeUnknown: true, errorCode: 'OUTCOME_UNKNOWN', errorMessage: 'reply lost' },
  });
  assert.equal(res.status, 200);
  const r = await row(id);
  assert.equal(r.outcome_unknown, true);
  assert.equal(r.locked_by_device_id, null);
  const reclaim = await harness.call('POST', `/tally/desktop/writeback/${id}/claim`, { headers: ws.deviceHeaders, body: {} });
  assert.equal(reclaim.status, 409);
});

test('confirmed rejection stays retryable (legitimate retry path preserved)', async () => {
  const ws = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(ws, (n) => (n === 1 ? { status: false, message: "Ledger 'X' does not exist" } : { status: true, voucherNumber: '42' }));
  const id = await queueEntry(ws);
  await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: ws.userHeaders });
  assert.equal((await row(id)).outcome_unknown, false);
  const ok = await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: ws.userHeaders });
  assert.equal(ok.status, 200);
  assert.equal(posts.length, 2);
  assert.equal((await row(id)).status, 'success');
});

test('review: discard closes the attempt for good; found_in_tally settles without posting', async () => {
  const ws = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(ws, () => ({ status: true }));
  const a = await queueEntry(ws);
  const b = await queueEntry(ws);
  await q(`UPDATE write_queue SET outcome_unknown = TRUE WHERE id = ANY($1)`, [[a, b]]);

  const bad = await harness.call('POST', `/api/vouchers/my-entries/${a}/resolve-unknown`, {
    headers: ws.userHeaders, body: { resolution: 'retry' },
  });
  assert.equal(bad.status, 400);

  const d = await harness.call('POST', `/api/vouchers/my-entries/${a}/resolve-unknown`, {
    headers: ws.userHeaders, body: { resolution: 'discard' },
  });
  assert.equal(d.status, 200);
  let ra = await row(a);
  assert.equal(ra.outcome_unknown, true);
  assert.equal(ra.unknown_resolution, 'discarded');
  assert.equal((await harness.call('POST', `/tally/audit-trail/${a}/retry`, { headers: ws.userHeaders })).status, 409);
  // A second resolution of the same entry is refused.
  assert.equal((await harness.call('POST', `/api/vouchers/my-entries/${a}/resolve-unknown`, {
    headers: ws.userHeaders, body: { resolution: 'found_in_tally' },
  })).status, 404);

  const f = await harness.call('POST', `/api/vouchers/my-entries/${b}/resolve-unknown`, {
    headers: ws.userHeaders, body: { resolution: 'found_in_tally', tallyVoucherNumber: 'S-17' },
  });
  assert.equal(f.status, 200);
  const rb = await row(b);
  assert.equal(rb.status, 'success');
  assert.equal(rb.outcome_unknown, false);
  assert.equal(rb.tally_voucher_number, 'S-17');
  assert.equal(posts.length, 0, 'review never posts to Tally');
});

test('X1: a member removed from the workspace cannot retry or resolve its entries', async () => {
  const ws = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(ws, () => ({ status: true }));
  const id = await queueEntry(ws);
  await q(`UPDATE workspace_memberships SET status='REMOVED' WHERE workspace_id=$1 AND user_id=$2`, [ws.workspaceId, ws.userId]);
  const r = await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: ws.userHeaders });
  assert.notEqual(r.status, 200);
  assert.equal(posts.length, 0);
  assert.equal((await row(id)).status, 'failed');
});

test('X1: another user cannot retry a foreign entry', async () => {
  const owner = await seedWorkspace(q, uniq);
  const other = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(owner, () => ({ status: true }));
  const id = await queueEntry(owner);
  const r = await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: other.userHeaders });
  assert.notEqual(r.status, 200);
  assert.equal(posts.length, 0);
});

// R6 / W1: the outbox-result path delivers the posting event once, scoped to the company room.
test('W1: a successful outbox result announces the posting once to its company room', async () => {
  const ws = await seedWorkspace(q, uniq);
  const { setupSocket } = await import('../../socket/socketHandler.js');
  const emitted = [];
  const svc = setupSocket({ on: () => {}, to: (room) => ({ emit: (event, payload) => emitted.push({ room, event, payload }) }) });
  tallyWrite.setTallyWriteSocket({ ...svc, connectedClients: new Map() });
  const id = await queueEntry(ws, 'processing');
  await q('UPDATE write_queue SET locked_by_device_id = $1, lock_expires_at = EXTRACT(EPOCH FROM NOW())::BIGINT + 600 WHERE id = $2', [ws.deviceId, id]);
  const ref = `TDK-SAL-${uniq('w1')}`;
  await q(
    `INSERT INTO app_vouchers (company_guid, company_id, voucher_type, tdk_reference_no, write_queue_id, created_at, updated_at)
     VALUES ($1, $2, 'sales_invoice', $3, $4, EXTRACT(EPOCH FROM NOW())::BIGINT, EXTRACT(EPOCH FROM NOW())::BIGINT)`,
    [ws.companyGuid, ws.companyId, ref, id],
  );
  const post = () => harness.call('POST', `/tally/desktop/writeback/${id}/result`, { headers: ws.deviceHeaders, body: { success: true, tallyVoucherNumber: 'S-77', tallyVoucherGuid: 'g-77' } });
  const first = await post();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await new Promise((r) => setTimeout(r, 50));
  const synced = emitted.filter((e) => e.event === 'voucher:tallySynced');
  assert.equal(synced.length, 1);
  assert.equal(synced[0].room, `company:${ws.companyId}`);
  assert.equal(synced[0].payload.tdkReferenceNo, ref);
  assert.equal(synced[0].payload.workspaceId, ws.workspaceId);

  const again = await post();
  assert.equal(again.status, 403, 'a repeated result no longer owns the lock');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(emitted.filter((e) => e.event === 'voucher:tallySynced').length, 1, 'announced once');
});

// QA follow-up: a write-back the desktop never reported goes to review, never back to the queue.
test('a processing entry whose desktop lock expired moves to review and is never re-sent', async () => {
  const ws = await seedWorkspace(q, uniq);
  const posts = fakeDesktop(ws, () => ({ status: true }));
  const id = await queueEntry(ws, 'processing');
  await q('UPDATE write_queue SET locked_by_device_id = $1, lock_expires_at = EXTRACT(EPOCH FROM NOW())::BIGINT - 5 WHERE id = $2', [ws.deviceId, id]);
  const fresh = await queueEntry(ws, 'processing');
  await q('UPDATE write_queue SET locked_by_device_id = $1, lock_expires_at = EXTRACT(EPOCH FROM NOW())::BIGINT + 600 WHERE id = $2', [ws.deviceId, fresh]);
  assert.ok((await tallyWrite.sweepStuckWriteback()) >= 1);
  const r = await row(id);
  assert.deepEqual([r.status, r.outcome_unknown, r.locked_by_device_id], ['failed', true, null]);
  assert.equal((await row(fresh)).status, 'processing', 'a live lock is left alone');
  const retry = await harness.call('POST', `/tally/audit-trail/${id}/retry`, { headers: ws.userHeaders });
  assert.notEqual(retry.status, 200);
  assert.equal(posts.length, 0, 'nothing was posted');
});
