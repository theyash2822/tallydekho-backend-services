import { Router } from 'express';
import { query } from '../db/schema.js';
import { requireDeviceCredential, optionalDeviceCredential } from '../middleware/auth.js';
import { getWorkspaceById, workspacePublicView, requestWorkspaceReset } from '../services/workspaceService.js';
import { markFirstSyncConnected, getKnownLineageGuids } from '../services/deviceBinding.js';
import { evaluateLineage } from '../utils/tallyLineage.js';
import { createHardSyncRequest, getHardSyncRequest } from '../services/hardSyncService.js';
import { createBackupSession, completeBackup, failBackup, listAvailableBackups } from '../services/backupService.js';
import { createRestoreRequest, restoreStatusForDevice, completeRestore } from '../services/restoreService.js';
import { storeLocalUpload, readLocalDownload } from '../services/objectStore.js';

let _socket = null;
export function setDesktopWorkspaceSocket(s) { _socket = s; }

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

export async function desktopMeHandler(req, res) {
  const deviceId = req.headers['device-id'] || req.deviceId;
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id required' });
  try {
    const { rows } = await query(
      `SELECT d.*, u.id AS uid, u.mobile, u.name AS user_name, u.email, u.language
       FROM devices d
       LEFT JOIN workspaces w ON w.id = d.workspace_id
       LEFT JOIN users u ON u.id = w.owner_user_id
       WHERE d.device_id = $1 LIMIT 1`,
      [deviceId]
    );
    const d = rows[0];
    if (!d || !d.paired) return res.json({ status: false, message: 'Device not paired' });
    const workspace = d.workspace_id ? await getWorkspaceById(d.workspace_id) : null;
    const { rows: lastBackup } = await query(
      `SELECT completed_at FROM workspace_backups
       WHERE workspace_id = $1 AND status = 'AVAILABLE' AND deleted_at IS NULL
       ORDER BY completed_at DESC LIMIT 1`,
      [d.workspace_id]
    ).catch(() => ({ rows: [] }));
    const { rows: tallyCompanies } = await query(
      `SELECT tally_company_guid AS guid, company_name AS name
       FROM workspace_tally_lineage_companies
       WHERE workspace_id = $1 AND status = 'ACTIVE'
       ORDER BY company_name NULLS LAST`,
      [d.workspace_id]
    ).catch(() => ({ rows: [] }));
    res.json({
      status: true,
      data: {
        id: d.uid,
        mobile: d.mobile,
        name: d.user_name || '',
        email: d.email || '',
        language: d.language || 'English',
        workspace: workspacePublicView(workspace),
        device: {
          deviceId: d.device_id,
          name: d.name,
          bindingStatus: d.binding_status,
        },
        lastCloudBackupAt: lastBackup[0]?.completed_at || null,
        tallyCompanies,
      },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch profile' });
  }
}

router.get('/me', optionalDeviceCredential, desktopMeHandler);

router.post('/claim-credential', requireDeviceCredential, async (req, res) => {
  try {
    await query(
      `UPDATE devices SET credential_claimed_at = $2 WHERE device_id = $1 AND paired = TRUE`,
      [req.deviceId, now()]
    );
    res.json({ status: true });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

router.post('/hard-sync/request', requireDeviceCredential, async (req, res) => {
  try {
    const { operation, oldGuid, newGuid, companies } = req.body || {};
    const result = await createHardSyncRequest({
      workspaceId: req.workspaceId,
      deviceId: req.deviceId,
      operation: operation === 'GUID_REPLACEMENT' ? 'GUID_REPLACEMENT' : 'REBUILD',
      oldGuid: oldGuid || null,
      newGuid: newGuid || null,
      companyManifest: companies || [],
    });
    if (!result.autoApproved && result.request?.status === 'PENDING') {
      _socket?.notifyWorkspaceRoom?.(req.workspaceId, 'hard_sync_request', {
        requestId: result.request.id,
        operation: result.request.operation,
        deviceId: req.deviceId,
      });
    }
    res.json({
      status: true,
      data: {
        requestId: result.request.id,
        requestStatus: result.request.status,
        autoApproved: result.autoApproved,
        alreadyApproved: !!result.alreadyApproved,
      },
    });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ status: false, code: err.code, message: err.message });
  }
});

router.get('/hard-sync/status', requireDeviceCredential, async (req, res) => {
  try {
    const id = req.query.requestId;
    if (!id) return res.status(400).json({ status: false, message: 'requestId required' });
    const row = await getHardSyncRequest(id);
    if (!row || row.workspace_id !== req.workspaceId) {
      return res.status(404).json({ status: false, code: 'NOT_FOUND' });
    }
    res.json({ status: true, data: { requestId: row.id, requestStatus: row.status } });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// Desktop starts Owner Reset for New Tally (same 3-confirm + 24h grace as Web).
router.post('/workspace/reset/request', requireDeviceCredential, async (req, res) => {
  try {
    if (!req.workspaceId) {
      return res.status(403).json({ status: false, code: 'DEVICE_NOT_PAIRED', message: 'Device is not paired to a workspace.' });
    }
    const actorUserId = req.device?.user_id;
    if (!actorUserId) {
      return res.status(403).json({ status: false, code: 'OWNER_ONLY', message: 'Only the Workspace Owner can reset from this Desktop.' });
    }
    const data = await requestWorkspaceReset(actorUserId, req.workspaceId);
    _socket?.notifyWorkspaceRoom?.(req.workspaceId, 'workspace_reset_requested', {
      requestId: data.requestId,
      deviceId: req.deviceId,
    });
    res.json({
      status: true,
      data: {
        requestId: data.requestId,
        requestStatus: data.status,
        confirmPhrase: data.confirmPhrase,
        confirmsRequired: data.confirmsRequired,
        hours: data.hours,
        emailsSent: data.emailsSent,
      },
    });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ status: false, code: err.code, message: err.message });
  }
});

router.get('/workspace/reset/status', requireDeviceCredential, async (req, res) => {
  try {
    if (!req.workspaceId) {
      return res.json({ status: true, data: { requestStatus: null } });
    }
    const { rows } = await query(
      `SELECT id, status, confirm_count, grace_ends_at, created_at
       FROM workspace_lifecycle_requests
       WHERE workspace_id = $1 AND kind = 'RESET'
         AND status IN ('PENDING_CONFIRM','PENDING_GRACE')
       ORDER BY created_at DESC LIMIT 1`,
      [req.workspaceId]
    );
    const row = rows[0];
    res.json({
      status: true,
      data: row
        ? {
            requestId: row.id,
            requestStatus: row.status,
            confirmCount: row.confirm_count,
            graceEndsAt: row.grace_ends_at,
          }
        : { requestStatus: null },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

router.post('/backup/sessions', requireDeviceCredential, async (req, res) => {
  try {
    const workspace = await getWorkspaceById(req.workspaceId);
    if (!workspace) return res.status(404).json({ status: false, code: 'WORKSPACE_NOT_FOUND' });
    if (workspace.lifecycle_status === 'RESET_PENDING' || workspace.lifecycle_status === 'CLOSED') {
      return res.status(403).json({ status: false, code: 'WORKSPACE_CLOSED', message: 'Workspace connection is no longer active.' });
    }
    const { sizeBytes, sha256, desktopVersion, tallyVersion, companyManifest } = req.body || {};
    const result = await createBackupSession({
      workspace,
      deviceId: req.deviceId,
      sizeBytes,
      sha256,
      desktopVersion,
      tallyVersion,
      companyManifest,
    });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ status: false, code: err.code, message: err.message });
  }
});

router.post('/backup/sessions/:id/complete', requireDeviceCredential, async (req, res) => {
  try {
    const backup = await completeBackup(req.workspaceId, req.params.id, req.body || {});
    res.json({ status: true, data: { backupId: backup.id, status: backup.status } });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ status: false, code: err.code, message: err.message });
  }
});

router.post('/backup/sessions/:id/fail', requireDeviceCredential, async (req, res) => {
  await failBackup(req.workspaceId, req.params.id);
  res.json({ status: true });
});

router.get('/backup/list', requireDeviceCredential, async (req, res) => {
  try {
    const backups = await listAvailableBackups(req.workspaceId, 3);
    res.json({ status: true, data: backups });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

router.post('/restore/request', optionalDeviceCredential, async (req, res) => {
  try {
    const result = await createRestoreRequest(req.deviceId || req.headers['device-id']);
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

router.get('/restore/status', optionalDeviceCredential, async (req, res) => {
  try {
    const data = await restoreStatusForDevice(req.deviceId || req.headers['device-id']);
    res.json({ status: true, data });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

router.post('/restore/complete', optionalDeviceCredential, async (req, res) => {
  try {
    const result = await completeRestore({
      deviceId: req.deviceId || req.headers['device-id'],
      ok: req.body?.ok !== false,
      lineageGuids: req.body?.lineageGuids || [],
      restoredFolders: req.body?.restoredFolders || [],
    });
    res.json({ status: true, data: result });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ status: false, code: err.code, message: err.message });
  }
});

router.post('/lineage/validate', requireDeviceCredential, async (req, res) => {
  try {
    const incoming = (req.body?.companies || []).map((c) => c.guid).filter(Boolean);
    const known = await getKnownLineageGuids(req.workspaceId);
    const verdict = evaluateLineage(known, incoming);
    res.json({ status: verdict.ok, data: verdict, code: verdict.code || null });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

export async function localObjectPutHandler(req, res) {
  try {
    const token = req.params.token;
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
    const stored = await storeLocalUpload(token, buf);
    res.json({ status: true, data: stored });
  } catch (err) {
    res.status(400).json({ status: false, message: err.message });
  }
}

export async function localObjectGetHandler(req, res) {
  try {
    const { buffer, objectKey } = await readLocalDownload(req.params.token);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${objectKey.split('/').pop()}"`);
    res.send(buffer);
  } catch (err) {
    res.status(404).json({ status: false, message: 'Not found' });
  }
}

export { markFirstSyncConnected, getKnownLineageGuids, evaluateLineage };
export default router;
