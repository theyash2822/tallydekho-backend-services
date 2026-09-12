import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { ensurePersonalWorkspace, isOwnerOrAdmin } from '../services/workspaceService.js';
import { listPendingHardSync, approveHardSync, rejectHardSync } from '../services/hardSyncService.js';
import { listAvailableBackups } from '../services/backupService.js';
import { approveRestore, listWorkspaceApprovals } from '../services/restoreService.js';

const router = Router();

router.get('/workspace/approvals', authMiddleware, async (req, res) => {
  try {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    const allowed = await isOwnerOrAdmin(req.user.userId, ws.id);
    if (!allowed) {
      return res.status(403).json({ success: false, error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Not authorized' } });
    }
    const hardSync = await listPendingHardSync(ws.id);
    const rest = await listWorkspaceApprovals(ws.id);
    res.json({
      success: true,
      data: {
        workspace: { id: ws.id, name: ws.name },
        hardSync,
        backups: rest.backups,
        restoreRequests: rest.restoreRequests,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.post('/workspace/hard-sync/:id/approve', authMiddleware, async (req, res) => {
  try {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    const row = await approveHardSync({ requestId: req.params.id, userId: req.user.userId, workspaceId: ws.id });
    res.json({ success: true, data: { requestId: row.id, status: row.status } });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ success: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

router.post('/workspace/hard-sync/:id/reject', authMiddleware, async (req, res) => {
  try {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    await rejectHardSync({ requestId: req.params.id, userId: req.user.userId, workspaceId: ws.id });
    res.json({ success: true });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ success: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/workspace/backups', authMiddleware, async (req, res) => {
  try {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    const backups = await listAvailableBackups(ws.id, 3);
    res.json({ success: true, data: backups });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.post('/workspace/restore/approve', authMiddleware, async (req, res) => {
  try {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    const { code, backupId } = req.body || {};
    if (!code || !backupId) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'code and backupId required' } });
    }
    const result = await approveRestore({
      userId: req.user.userId,
      workspaceId: ws.id,
      code: String(code).toUpperCase(),
      backupId,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(err.httpStatus || 500).json({ success: false, error: { code: err.code || 'SERVER_ERROR', message: err.message } });
  }
});

export default router;
