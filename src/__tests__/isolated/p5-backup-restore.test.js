// P5 N5/N6/N1 on the disposable cluster with a temporary local object store. Synthetic rows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const objectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'td-p5-objects-'));
process.env.BACKUP_OBJECT_ROOT = objectRoot;
for (const k of ['AWS_S3_BACKUP_BUCKET', 'AWS_S3_ACCESS_KEY', 'AWS_ACCESS_KEY_ID']) delete process.env[k];

const schema = await setupIsolatedDb();
const q = (text, params) => schema.getPool().query(text, params);
const backups = await import('../../services/backupService.js');
const restore = await import('../../services/restoreService.js');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function makeWorkspace() {
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(`INSERT INTO users (mobile, name) VALUES ($1, 'Synthetic') RETURNING id`, [`9${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 15)]);
  await q(`INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type) VALUES ($1,$2,$3,'OWNER')`, [uniq('m'), workspaceId, rows[0].id]);
  const deviceId = uniq('dev');
  return { id: workspaceId, setup_generation: 1, userId: rows[0].id, deviceId };
}

async function uploadSession(ws, bytes, declared = bytes) {
  const { backupId, upload } = await backups.createBackupSession({
    workspace: ws, deviceId: ws.deviceId, sizeBytes: declared.length, sha256: sha(declared), companyManifest: [{ guid: 'g1', name: 'Acme', folder: '10000' }],
  });
  const dest = path.join(objectRoot, upload.objectKey);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
  return { backupId, dest };
}

test.after(async () => {
  await schema.getPool().end().catch(() => {});
  fs.rmSync(objectRoot, { recursive: true, force: true });
});

test('N6: completion verifies the stored bytes, not the client claim', async () => {
  const ws = await makeWorkspace();
  const good = Buffer.from('PK\u0003\u0004 synthetic archive');
  const ok = await uploadSession(ws, good);
  const done = await backups.completeBackup(ws.id, ok.backupId, { sizeBytes: good.length, sha256: sha(good) }, { deviceId: ws.deviceId });
  assert.equal(done.status, 'AVAILABLE');
  assert.equal((await backups.completeBackup(ws.id, ok.backupId, {}, { deviceId: ws.deviceId })).status, 'AVAILABLE', 'duplicate completion is idempotent');

  // Wrong bytes stored while the client reports the declared (good) hash.
  const bad = await uploadSession(ws, Buffer.from('tampered'), good);
  await assert.rejects(
    backups.completeBackup(ws.id, bad.backupId, { sizeBytes: good.length, sha256: sha(good) }, { deviceId: ws.deviceId }),
    { code: 'BACKUP_CHECKSUM_MISMATCH' }
  );
  const { rows } = await q('SELECT status FROM workspace_backups WHERE id = $1', [bad.backupId]);
  assert.equal(rows[0].status, 'FAILED');
  assert.equal(fs.existsSync(bad.dest), false, 'bad object removed');
  assert.deepEqual((await backups.listAvailableBackups(ws.id)).map((b) => b.id), [ok.backupId], 'only verified backups listed');
});

test('N6: missing object stays uploading; other device cannot complete or fail; orphans are abandoned', async () => {
  const ws = await makeWorkspace();
  const bytes = Buffer.from('PK\u0003\u0004 later');
  const { backupId, upload } = await backups.createBackupSession({ workspace: ws, deviceId: ws.deviceId, sizeBytes: bytes.length, sha256: sha(bytes) });
  await assert.rejects(backups.completeBackup(ws.id, backupId, {}, { deviceId: ws.deviceId }), { code: 'BACKUP_OBJECT_MISSING' });
  assert.equal((await q('SELECT status FROM workspace_backups WHERE id = $1', [backupId])).rows[0].status, 'UPLOADING');
  await assert.rejects(backups.completeBackup(ws.id, backupId, {}, { deviceId: 'someone-else' }), { code: 'NOT_FOUND' });
  assert.deepEqual(await backups.failBackup(ws.id, backupId, 'someone-else'), { failed: false });
  await q('UPDATE workspace_backups SET created_at = created_at - $2 WHERE id = $1', [backupId, backups.UPLOAD_ABANDON_SECONDS + 10]);
  assert.equal(await backups.sweepAbandonedBackups(ws.id), 1);
  assert.equal((await q('SELECT status FROM workspace_backups WHERE id = $1', [backupId])).rows[0].status, 'ABANDONED');
  await assert.rejects(
    backups.createBackupSession({ workspace: ws, deviceId: ws.deviceId, sizeBytes: 10, sha256: 'not-a-hash' }),
    { code: 'BACKUP_MANIFEST_INVALID' }
  );
  void upload;
});

test('N5: status and completion need the restore token; device id alone gets nothing', async () => {
  const ws = await makeWorkspace();
  const bytes = Buffer.from('PK\u0003\u0004 restore me');
  const { backupId } = await uploadSession(ws, bytes);
  await backups.completeBackup(ws.id, backupId, {}, { deviceId: ws.deviceId });

  const newDevice = uniq('newdev');
  await q(`INSERT INTO devices (device_id) VALUES ($1)`, [newDevice]);
  const req = await restore.createRestoreRequest(newDevice);
  assert.ok(req.restoreToken && req.code);

  const approved = await restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: req.code, backupId });
  assert.equal(approved.deviceId, newDevice);
  await assert.rejects(restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: req.code, backupId }), { code: 'RESTORE_SESSION_EXPIRED' }, 'single use');

  assert.equal((await restore.restoreStatusForDevice(newDevice)).status, 'RESTORE_TOKEN_REQUIRED');
  assert.equal((await restore.restoreStatusForDevice(newDevice, 'guess')).status, 'RESTORE_TOKEN_REQUIRED');
  const status = await restore.restoreStatusForDevice(newDevice, req.restoreToken);
  assert.equal(status.status, 'APPROVED');
  assert.ok(status.download?.url);

  await assert.rejects(restore.completeRestore({ deviceId: newDevice, ok: true }), { code: 'RESTORE_TOKEN_REQUIRED' });
  await assert.rejects(
    restore.completeRestore({ deviceId: newDevice, restoreToken: req.restoreToken, ok: true, restoredFolders: ['10007'] }),
    { code: 'TALLY_DATA_MISMATCH' }
  );
});

test('N1: completion with the folder mapping activates; a lost acknowledgement can be retried', async () => {
  const ws = await makeWorkspace();
  const bytes = Buffer.from('PK\u0003\u0004 restore ack');
  const { backupId } = await uploadSession(ws, bytes);
  await backups.completeBackup(ws.id, backupId, {}, { deviceId: ws.deviceId });
  const newDevice = uniq('newdev');
  await q(`INSERT INTO devices (device_id) VALUES ($1)`, [newDevice]);
  const req = await restore.createRestoreRequest(newDevice);
  await restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: req.code, backupId });

  const args = { deviceId: newDevice, restoreToken: req.restoreToken, ok: true, restoredFolders: ['10000'], lineageGuids: ['g1'] };
  const first = await restore.completeRestore(args);
  assert.equal(first.activated, true);
  const again = await restore.completeRestore(args);
  assert.equal(again.activated, true);
  assert.equal(again.repeated, true);
  assert.notEqual(again.deviceSecret, first.deviceSecret, 'credential re-issued for the retry');
  const { rows } = await q('SELECT binding_status, workspace_id FROM devices WHERE device_id = $1', [newDevice]);
  assert.deepEqual(rows[0], { binding_status: 'ACTIVE', workspace_id: ws.id });
});

test('N5: wrong restore codes are rate limited per user', async () => {
  const ws = await makeWorkspace();
  for (let i = 0; i < restore.CODE_ATTEMPT_MAX; i++) {
    await assert.rejects(restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: `ZZ${i}`, backupId: 'x' }), (e) => e.code === 'NOT_FOUND' || e.code === 'RESTORE_SESSION_EXPIRED');
  }
  const bytes = Buffer.from('PK\u0003\u0004 rl');
  const { backupId } = await uploadSession(ws, bytes);
  await backups.completeBackup(ws.id, backupId, {}, { deviceId: ws.deviceId });
  for (let i = 0; i < restore.CODE_ATTEMPT_MAX; i++) {
    await assert.rejects(restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: `QQ${i}`, backupId }), { code: 'RESTORE_SESSION_EXPIRED' });
  }
  await assert.rejects(restore.approveRestore({ userId: ws.userId, workspaceId: ws.id, code: 'QQX', backupId }), { code: 'RESTORE_CODE_RATE_LIMITED' });
});
