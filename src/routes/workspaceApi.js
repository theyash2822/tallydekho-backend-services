import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { resolveWorkspaceMiddleware, bindWorkspaceParam, requireCapability } from '../middleware/workspaceContext.js';
import {
  ensurePersonalWorkspace,
  listWorkspacesForUser,
  getWorkspaceContext,
  renameWorkspace,
  createAdditionalWorkspace,
  listMembers,
  listSeats,
  purchaseSeat,
  getMemberScopes,
  putMemberScopes,
  createInvitation,
  listMyInvitations,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
  acceptInvitation,
  declineInvitation,
  suspendMember,
  unsuspendMember,
  removeMember,
  changeMemberRole,
  initiateOwnershipTransfer,
  acceptOwnershipTransferByTarget,
  confirmOwnershipTransferEmail,
  revokeOwnershipTransfer,
  completeOwnershipTransfer,
  requestWorkspaceReset,
  confirmWorkspaceReset,
  confirmWorkspaceResetByToken,
  executeWorkspaceReset,
  requestWorkspaceClose,
  confirmWorkspaceClose,
  confirmWorkspaceCloseByToken,
  executeWorkspaceClose,
  getActiveOwnershipTransfer,
  getWorkspaceLifecycleStatus,
  getPaymentModeMap,
  putPaymentModeMap,
  listAudit,
  recordWorkspaceEntered,
  getBillingOverview,
} from '../services/workspaceService.js';
import {
  listRoles,
  getRole,
  updateRoleMeta,
  createCustomRole,
  deleteRole,
} from '../services/roleService.js';
import {
  listRates,
  listWalletTransactions,
  createPaymentOrder,
  listPaymentOrders,
  completePaymentOrder,
  listInvoices,
  listUsageEvents,
  createRechargeOrder,
  fulfillRechargePayment,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  razorpayConfigured,
} from '../services/billingService.js';
import { CAPABILITIES, SENSITIVE_POLICIES } from '../services/capabilityRegistry.js';
import { listPendingHardSync, approveHardSync, rejectHardSync } from '../services/hardSyncService.js';
import { listAvailableBackups } from '../services/backupService.js';
import { approveRestore, listWorkspaceApprovals } from '../services/restoreService.js';
import { query } from '../db/schema.js';
import { listCostCentresForCompany } from '../services/costCentreListService.js';

const router = Router();
let _socket = null;
export function setWorkspaceApiSocket(s) { _socket = s; }

function notifyHardSyncDecision(row, status) {
  if (!row) return;
  const event = status === 'APPROVED' ? 'hard_sync_approved' : 'hard_sync_rejected';
  _socket?.notifyDesktop?.(row.device_id, event, { requestId: row.id, operation: row.operation });
  _socket?.notifyWorkspaceRoom?.(row.workspace_id, 'hard_sync_status', { requestId: row.id, status });
}

function notifyRestoreApproved(result) {
  if (!result?.deviceId) return;
  _socket?.notifyDesktop?.(result.deviceId, 'restore_approved', {
    sessionId: result.sessionId,
    workspaceId: result.workspaceId,
  });
  if (result.workspaceId) {
    _socket?.notifyWorkspaceRoom?.(result.workspaceId, 'restore_status', {
      sessionId: result.sessionId,
      status: 'APPROVED',
    });
  }
}

function notifyRestoreRejected(result) {
  if (!result) return;
  if (result.deviceId) {
    _socket?.notifyDesktop?.(result.deviceId, 'restore_rejected', {
      sessionId: result.sessionId,
      workspaceId: result.workspaceId,
    });
  }
  if (result.workspaceId) {
    _socket?.notifyWorkspaceRoom?.(result.workspaceId, 'restore_status', {
      sessionId: result.sessionId,
      status: 'REJECTED',
    });
  }
}

function errJson(res, err) {
  return res.status(err.httpStatus || 500).json({
    success: false,
    error: { code: err.code || 'SERVER_ERROR', message: err.message },
  });
}

// ── Me / workspaces ──────────────────────────────────────────────────────────

router.get('/me/workspaces', authMiddleware, async (req, res) => {
  try {
    await ensurePersonalWorkspace(req.user.userId);
    const list = await listWorkspacesForUser(req.user.userId);
    res.json({ success: true, data: list });
  } catch (err) {
    if (err.code === 'USER_NOT_FOUND' || /user not found/i.test(err.message || '')) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Session expired. Please sign in again.' },
      });
    }
    errJson(res, err);
  }
});

router.get('/me/invitations', authMiddleware, async (req, res) => {
  try {
    const list = await listMyInvitations(req.user.userId);
    res.json({ success: true, data: list });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/workspaces/:id/context', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const ctx = await getWorkspaceContext(req.user.userId, req.params.id);
    if (!ctx) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Workspace not found' } });
    if (ctx.denied) {
      return res.status(403).json({
        success: false,
        error: { code: 'MEMBERSHIP_SUSPENDED', message: 'Membership suspended' },
      });
    }
    const entered = await recordWorkspaceEntered(req.user.userId, req.params.id).catch(() => false);
    if (entered) {
      try {
        _socket?.notifyWorkspaceRoom?.(req.params.id, 'workspace_audit', {
          workspaceId: req.params.id,
          event_type: 'workspace.entered',
          actor_user_id: req.user.userId,
        });
      } catch { /* optional */ }
    }
    res.json({ success: true, data: ctx });
  } catch (err) {
    errJson(res, err);
  }
});

router.patch('/workspaces/:id', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const ws = await renameWorkspace(req.user.userId, req.params.id, req.body?.name);
    res.json({ success: true, data: { id: ws.id, name: ws.name } });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspaces', authMiddleware, async (req, res) => {
  try {
    const ws = await createAdditionalWorkspace(req.user.userId, req.body?.name);
    res.status(201).json({ success: true, data: { id: ws.id, name: ws.name, isBase: ws.is_base } });
  } catch (err) {
    errJson(res, err);
  }
});

// ── Members ──────────────────────────────────────────────────────────────────

router.get(
  '/workspaces/:id/members',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.view'),
  async (req, res) => {
    try {
      const members = await listMembers(req.params.id);
      res.json({ success: true, data: members });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get(
  '/workspaces/:id/members/:membershipId/scopes',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.scope_manage'),
  async (req, res) => {
    try {
      const scopes = await getMemberScopes(req.params.membershipId, req.params.id);
      res.json({ success: true, data: scopes });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.put(
  '/workspaces/:id/members/:membershipId/scopes',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.scope_manage'),
  async (req, res) => {
    try {
      const scopes = await putMemberScopes(req.params.membershipId, req.body || {}, req.params.id);
      res.json({ success: true, data: scopes });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/members/:userId/suspend',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.suspend'),
  async (req, res) => {
    try {
      await suspendMember(req.user.userId, req.params.id, Number(req.params.userId));
      res.json({ success: true });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/members/:userId/unsuspend',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.unsuspend'),
  async (req, res) => {
    try {
      await unsuspendMember(req.user.userId, req.params.id, Number(req.params.userId));
      res.json({ success: true });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.delete(
  '/workspaces/:id/members/:userId',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.remove'),
  async (req, res) => {
    try {
      const targetUserId = Number(req.params.userId);
      if (!Number.isFinite(targetUserId)) {
        const err = new Error('Invalid member user id');
        err.code = 'VALIDATION_ERROR';
        err.httpStatus = 400;
        throw err;
      }
      await removeMember(req.user.userId, req.params.id, targetUserId);
      try {
        _socket?.notifyWorkspace?.(targetUserId, 'workspace_access_revoked', {
          workspaceId: req.params.id,
          reason: 'MEMBER_REMOVED',
        });
      } catch {
        /* socket notify must not fail the remove */
      }
      res.json({ success: true });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.patch(
  '/workspaces/:id/members/:userId/role',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.role_assign'),
  async (req, res) => {
    try {
      const roleId = req.body?.roleId || req.body?.role_id;
      const data = await changeMemberRole(
        req.user.userId,
        req.params.id,
        Number(req.params.userId),
        roleId
      );
      _socket?.notifyWorkspace?.(Number(req.params.userId), 'workspace_access_changed', {
        workspaceId: req.params.id,
        reason: 'ROLE_CHANGED',
        roleId,
      });
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

// ── Lifecycle (ownership transfer / reset / close) ───────────────────────────

router.post(
  '/workspaces/:id/transfer/initiate',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('ownership.transfer'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const data = await initiateOwnershipTransfer(req.user.userId, req.params.id, {
        targetUserId: body.targetUserId ?? body.target_user_id,
        outgoingRoleId: body.outgoingRoleId ?? body.outgoing_role_id,
      });
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/transfer/:transferId/accept',
  authMiddleware,
  bindWorkspaceParam,
  async (req, res) => {
    try {
      const data = await acceptOwnershipTransferByTarget(
        req.user.userId,
        req.params.id,
        req.params.transferId
      );
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

/** Email link confirm (no auth — token is the credential) */
router.get('/workspaces/:id/transfer/:transferId/confirm', async (req, res) => {
  try {
    const data = await confirmOwnershipTransferEmail(req.params.transferId, req.query.token);
    res.type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Confirmed (${data.confirmCount}/3)</h2><p>Status: ${data.status}</p></body></html>`
    );
  } catch (err) {
    res.status(err.httpStatus || 400).type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Confirm failed</h2><p>${err.message}</p></body></html>`
    );
  }
});

router.post(
  '/workspaces/:id/transfer/:transferId/confirm',
  authMiddleware,
  bindWorkspaceParam,
  async (req, res) => {
    try {
      const token = req.body?.token || req.query?.token;
      const data = await confirmOwnershipTransferEmail(req.params.transferId, token);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/transfer/:transferId/revoke',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('ownership.transfer'),
  async (req, res) => {
    try {
      const data = await revokeOwnershipTransfer(
        req.user.userId,
        req.params.id,
        req.params.transferId
      );
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/transfer/:transferId/complete',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('ownership.transfer'),
  async (req, res) => {
    try {
      const system = Boolean(req.body?.system) && process.env.ALLOW_SYSTEM_LIFECYCLE === '1';
      const data = await completeOwnershipTransfer(
        req.user.userId,
        req.params.id,
        req.params.transferId,
        { system }
      );
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/reset/request',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.reset'),
  async (req, res) => {
    try {
      const data = await requestWorkspaceReset(req.user.userId, req.params.id);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/reset/confirm',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.reset'),
  async (req, res) => {
    try {
      const phrase = req.body?.phrase || req.body?.confirmationPhrase;
      const data = await confirmWorkspaceReset(req.user.userId, req.params.id, phrase);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get('/workspaces/:id/reset/:requestId/confirm', async (req, res) => {
  try {
    const data = await confirmWorkspaceResetByToken(req.params.requestId, req.query.token);
    res.type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Reset confirm (${data.confirmCount}/3)</h2><p>Status: ${data.status}</p></body></html>`
    );
  } catch (err) {
    res.status(err.httpStatus || 400).type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Confirm failed</h2><p>${err.message}</p></body></html>`
    );
  }
});

router.post(
  '/workspaces/:id/reset/execute',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.reset'),
  async (req, res) => {
    try {
      const system = Boolean(req.body?.system) && process.env.ALLOW_SYSTEM_LIFECYCLE === '1';
      const data = await executeWorkspaceReset(req.user.userId, req.params.id, { system });
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/close/request',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.close'),
  async (req, res) => {
    try {
      const data = await requestWorkspaceClose(req.user.userId, req.params.id);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get('/workspaces/:id/close/:requestId/confirm', async (req, res) => {
  try {
    const data = await confirmWorkspaceCloseByToken(req.params.requestId, req.query.token);
    res.type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Close confirm (${data.confirmCount}/3)</h2><p>Status: ${data.status}</p></body></html>`
    );
  } catch (err) {
    res.status(err.httpStatus || 400).type('html').send(
      `<html><body style="font-family:sans-serif;padding:40px"><h2>Confirm failed</h2><p>${err.message}</p></body></html>`
    );
  }
});

router.post(
  '/workspaces/:id/close/execute',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.close'),
  async (req, res) => {
    try {
      const system = Boolean(req.body?.system) && process.env.ALLOW_SYSTEM_LIFECYCLE === '1';
      const data = await executeWorkspaceClose(req.user.userId, req.params.id, { system });
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

/** Aliases for web portal client paths */
router.post(
  '/workspaces/:id/reset/complete',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.reset'),
  async (req, res) => {
    try {
      const data = await executeWorkspaceReset(req.user.userId, req.params.id, {});
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);
router.post(
  '/workspaces/:id/close/confirm',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.close'),
  async (req, res) => {
    try {
      const phrase = req.body?.phrase || req.body?.confirmationPhrase;
      const data = await confirmWorkspaceClose(req.user.userId, req.params.id, phrase);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);
router.post(
  '/workspaces/:id/close/complete',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.close'),
  async (req, res) => {
    try {
      const data = await executeWorkspaceClose(req.user.userId, req.params.id, {});
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get(
  '/workspaces/:id/transfer',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('ownership.transfer'),
  async (req, res) => {
    try {
      const data = await getActiveOwnershipTransfer(req.params.id);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get(
  '/workspaces/:id/lifecycle',
  authMiddleware,
  bindWorkspaceParam,
  async (req, res) => {
    try {
      const data = await getWorkspaceLifecycleStatus(req.params.id);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

// ── Roles ────────────────────────────────────────────────────────────────────

router.get('/capabilities/registry', authMiddleware, async (req, res) => {
  res.json({
    success: true,
    data: { capabilities: CAPABILITIES, sensitivePolicies: SENSITIVE_POLICIES },
  });
});

router.get(
  '/workspaces/:id/roles',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('roles.edit'),
  async (req, res) => {
    try {
      const roles = await listRoles(req.params.id);
      res.json({ success: true, data: roles });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get(
  '/workspaces/:id/roles/:roleId',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('roles.edit'),
  async (req, res) => {
    try {
      const role = await getRole(req.params.roleId);
      if (!role || role.workspace_id !== req.params.id) {
        return res.status(404).json({ success: false, error: { code: 'ROLE_NOT_FOUND', message: 'Role not found' } });
      }
      res.json({ success: true, data: role });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.patch(
  '/workspaces/:id/roles/:roleId',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('roles.edit'),
  async (req, res) => {
    try {
      const role = await getRole(req.params.roleId);
      if (!role || role.workspace_id !== req.params.id) {
        return res.status(404).json({ success: false, error: { code: 'ROLE_NOT_FOUND', message: 'Role not found' } });
      }
      const body = req.body || {};
      const updated = await updateRoleMeta(req.params.roleId, {
        displayName: body.display_name ?? body.displayName,
        entryMode: body.entry_mode ?? body.entryMode,
        capabilities: body.capabilities,
        sensitivePolicies: body.sensitivePolicies ?? body.sensitive_policies,
        actorUserId: req.user.userId,
        workspaceId: req.params.id,
      });
      res.json({ success: true, data: updated });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/roles',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('roles.edit'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const role = await createCustomRole(req.params.id, {
        displayName: body.display_name ?? body.displayName,
        entryMode: body.entry_mode ?? body.entryMode ?? 'BOTH',
        capabilities: body.capabilities || {},
        sensitivePolicies: body.sensitivePolicies || body.sensitive_policies || {},
        actorUserId: req.user.userId,
      });
      res.status(201).json({ success: true, data: role });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.delete(
  '/workspaces/:id/roles/:roleId',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('roles.edit'),
  async (req, res) => {
    try {
      await deleteRole(req.params.roleId, req.params.id);
      res.json({ success: true });
    } catch (err) {
      errJson(res, err);
    }
  }
);

// ── Invitations ──────────────────────────────────────────────────────────────

router.get(
  '/workspaces/:id/invitations',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.invite'),
  async (req, res) => {
    try {
      const list = await listWorkspaceInvitations(req.params.id);
      res.json({ success: true, data: list });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/invitations',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.invite'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const inv = await createInvitation({
        workspaceId: req.params.id,
        invitedByUserId: req.user.userId,
        mobile: body.mobile,
        roleId: body.roleId || body.role_id,
        scopes: body.scopes,
      });
      if (inv?.invitee_user_id) {
        _socket?.notifyWorkspace?.(inv.invitee_user_id, 'invitation_received', {
          invitationId: inv.id,
          workspaceId: req.params.id,
        });
      }
      try {
        _socket?.notifyWorkspaceRoom?.(req.params.id, 'workspace_audit', {
          workspaceId: req.params.id,
          event_type: 'invitation.created',
        });
      } catch { /* optional */ }
      res.status(201).json({ success: true, data: inv });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/invitations/:inviteId/revoke',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.invite'),
  async (req, res) => {
    try {
      await revokeWorkspaceInvitation(req.user.userId, req.params.id, req.params.inviteId);
      try {
        _socket?.notifyWorkspaceRoom?.(req.params.id, 'workspace_audit', {
          workspaceId: req.params.id,
          event_type: 'invitation.revoked',
        });
      } catch { /* optional */ }
      res.json({ success: true });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post('/invitations/:id/accept', authMiddleware, async (req, res) => {
  try {
    const result = await acceptInvitation(req.user.userId, req.params.id);
    try {
      if (result?.workspaceId) {
        _socket?.notifyWorkspaceRoom?.(result.workspaceId, 'workspace_audit', {
          workspaceId: result.workspaceId,
          event_type: 'invitation.accepted',
        });
        _socket?.notifyWorkspaceRoom?.(result.workspaceId, 'membership_changed', {
          workspaceId: result.workspaceId,
          status: 'ACTIVE',
        });
      }
    } catch { /* optional */ }
    res.json({ success: true, data: result });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/invitations/:id/decline', authMiddleware, async (req, res) => {
  try {
    await declineInvitation(req.user.userId, req.params.id);
    res.json({ success: true });
  } catch (err) {
    errJson(res, err);
  }
});

// ── Audit / seats / billing ──────────────────────────────────────────────────

router.get(
  '/workspaces/:id/audit',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.view'),
  async (req, res) => {
    try {
      const rows = await listAudit(req.params.id, req.query.limit);
      res.json({ success: true, data: rows });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get('/billing/overview', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const overview = await getBillingOverview(req.user.userId);
    res.json({ success: true, data: overview });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/billing/rates', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const rates = await listRates();
    res.json({ success: true, data: rates });
  } catch (err) {
    errJson(res, err);
  }
});

/** Usage drilldown — usage_events + wallet_transactions; filters: workspaceId, kind, limit */
router.get('/billing/usage', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const rows = await listUsageEvents(req.user.userId, {
      workspaceId: req.query.workspaceId || req.query.workspace_id || req.workspaceId,
      kind: req.query.kind,
      limit: req.query.limit,
    });
    res.json({ success: true, data: rows });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/billing/transactions', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const rows = await listWalletTransactions(req.user.userId, { limit: req.query.limit });
    res.json({ success: true, data: rows });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/billing/payment-orders', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const rows = await listPaymentOrders(req.user.userId, { limit: req.query.limit });
    res.json({ success: true, data: rows });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/billing/payment-orders', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const body = req.body || {};
    const order = await createPaymentOrder({
      userId: req.user.userId,
      credits: body.credits,
      amountInr: body.amountInr ?? body.amount_inr,
      meta: body.meta || {},
    });
    res.status(201).json({ success: true, data: order });
  } catch (err) {
    errJson(res, err);
  }
});

/** Owner credit recharge via Razorpay Checkout */
router.post('/billing/recharge/create', authMiddleware, resolveWorkspaceMiddleware, requireCapability('credits.recharge'), async (req, res) => {
  try {
    const credits = req.body?.credits;
    const workspaceId = req.body?.workspaceId || req.headers['x-workspace-id'] || req.workspaceId || null;
    const data = await createRechargeOrder(req.user.userId, { credits, workspaceId });
    res.status(201).json({ success: true, data });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/billing/recharge/status', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  res.json({
    success: true,
    data: {
      provider: 'RAZORPAY',
      configured: razorpayConfigured(),
      inrPerCredit: 1,
    },
  });
});

/** Client-side Checkout success verify + fulfill */
router.post('/billing/recharge/verify', authMiddleware, resolveWorkspaceMiddleware, requireCapability('credits.recharge'), async (req, res) => {
  try {
    const {
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    } = req.body || {};
    if (!verifyRazorpayCheckoutSignature({ orderId, paymentId, signature })) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: 'Razorpay signature mismatch' },
      });
    }
    const data = await fulfillRechargePayment({
      providerOrderId: orderId,
      providerPaymentId: paymentId,
      signature,
    });
    res.json({ success: true, data });
  } catch (err) {
    errJson(res, err);
  }
});

/** Razorpay webhook (payment.captured) — raw body signature */
router.post('/billing/webhooks/razorpay', async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    // The body arrives as a Buffer: this path is mounted with express.raw ahead
    // of express.json precisely so the signed bytes survive intact. Re-encoding
    // a parsed object here would reintroduce the mismatch.
    const raw = Buffer.isBuffer(req.body)
      ? req.body
      : typeof req.body === 'string'
        ? req.body
        : JSON.stringify(req.body || {});
    if (!verifyRazorpayWebhookSignature(raw, signature)) {
      return res.status(400).json({ success: false, error: { code: 'INVALID_SIGNATURE' } });
    }
    const event = Buffer.isBuffer(req.body)
      ? JSON.parse(req.body.toString('utf8'))
      : typeof req.body === 'string'
        ? JSON.parse(req.body)
        : req.body;
    const payment = event?.payload?.payment?.entity;
    const orderId = payment?.order_id;
    const paymentId = payment?.id;
    if (event?.event === 'payment.captured' && orderId && paymentId) {
      const data = await fulfillRechargePayment({
        providerOrderId: orderId,
        providerPaymentId: paymentId,
        raw: event,
      });
      return res.json({ success: true, data });
    }
    res.json({ success: true, data: { ignored: true, event: event?.event } });
  } catch (err) {
    errJson(res, err);
  }
});

/**
 * Manual/dev complete — credits wallet without Razorpay.
 * Production: blocked (product 5.1 / 5.2). Enable only with ALLOW_DEV_BILLING_COMPLETE=true outside production.
 */
router.post('/billing/payment-orders/:id/complete', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const allowDev =
      process.env.NODE_ENV !== 'production' &&
      String(process.env.ALLOW_DEV_BILLING_COMPLETE || '').toLowerCase() === 'true';
    if (!allowDev) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'DEV_COMPLETE_DISABLED',
          message: 'Manual payment completion is not available',
        },
      });
    }
    const data = await completePaymentOrder(req.user.userId, req.params.id);
    res.json({ success: true, data });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/billing/invoices', authMiddleware, resolveWorkspaceMiddleware, requireCapability('billing.manage'), async (req, res) => {
  try {
    const rows = await listInvoices(req.user.userId, { limit: req.query.limit });
    res.json({ success: true, data: rows });
  } catch (err) {
    errJson(res, err);
  }
});

router.get(
  '/workspaces/:id/seats',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('members.view'),
  async (req, res) => {
    try {
      const seats = await listSeats(req.params.id);
      res.json({ success: true, data: seats });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.post(
  '/workspaces/:id/seats',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('seats.purchase'),
  async (req, res) => {
    try {
      const seat = await purchaseSeat(req.user.userId, req.params.id);
      res.status(201).json({ success: true, data: seat });
    } catch (err) {
      errJson(res, err);
    }
  }
);

// ── Existing approvals / hard-sync / backup / restore (workspace header) ─────

router.get('/workspace/approvals', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const wsId = req.workspaceId;
    const hardSync = await listPendingHardSync(wsId);
    const rest = await listWorkspaceApprovals(wsId);
    const { rows: ws } = await query('SELECT id, name FROM workspaces WHERE id = $1', [wsId]);
    res.json({
      success: true,
      data: {
        workspace: { id: ws[0]?.id, name: ws[0]?.name },
        hardSync,
        backups: rest.backups,
        restoreRequests: rest.restoreRequests,
      },
    });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspace/hard-sync/:id/approve', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const row = await approveHardSync({
      requestId: req.params.id,
      userId: req.user.userId,
      workspaceId: req.workspaceId,
    });
    notifyHardSyncDecision(row, 'APPROVED');
    res.json({ success: true, data: { requestId: row.id, status: row.status } });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspace/hard-sync/:id/reject', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    await rejectHardSync({
      requestId: req.params.id,
      userId: req.user.userId,
      workspaceId: req.workspaceId,
    });
    const { rows } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [req.params.id]);
    notifyHardSyncDecision(rows[0], 'REJECTED');
    res.json({ success: true });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/workspace/backups', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const backups = await listAvailableBackups(req.workspaceId, 3);
    res.json({ success: true, data: backups });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspace/restore/approve', authMiddleware, resolveWorkspaceMiddleware, async (req, res) => {
  try {
    const { code, backupId } = req.body || {};
    if (!code || !backupId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'code and backupId required' },
      });
    }
    const result = await approveRestore({
      userId: req.user.userId,
      workspaceId: req.workspaceId,
      code: String(code).toUpperCase(),
      backupId,
    });
    notifyRestoreApproved({ ...result, workspaceId: req.workspaceId });
    res.json({ success: true, data: result });
  } catch (err) {
    errJson(res, err);
  }
});

// ── Mobile §29 aliases (workspace-scoped) ───────────────────────────────────

router.get('/workspaces/:id/companies', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const ctx = await getWorkspaceContext(req.user.userId, req.params.id);
    if (!ctx || ctx.denied) {
      return res.status(403).json({ success: false, error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Not authorized' } });
    }
    res.json({ success: true, data: ctx.companies || [] });
  } catch (err) {
    errJson(res, err);
  }
});

router.get(
  '/workspaces/:id/companies/:companyGuid/payment-mode-map',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.settings.view'),
  async (req, res) => {
    try {
      const data = await getPaymentModeMap(req.params.id, req.params.companyGuid, req.user.userId);
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get(
  '/workspaces/:id/companies/:companyGuid/cost-centres',
  authMiddleware,
  bindWorkspaceParam,
  async (req, res) => {
    try {
      const { verifyCompanyAccess } = await import('../middleware/companyAccess.js');
      const companyGuid = req.params.companyGuid;
      if (!(await verifyCompanyAccess(req, res, companyGuid, { responseShape: 'api-v1' }))) return;

      const rows = await listCostCentresForCompany(companyGuid);
      res.json({ success: true, data: rows });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.put(
  '/workspaces/:id/companies/:companyGuid/payment-mode-map',
  authMiddleware,
  bindWorkspaceParam,
  requireCapability('workspace.settings.manage'),
  async (req, res) => {
    try {
      const body = req.body || {};
      const list = Array.isArray(body.mappings)
        ? body.mappings
        : Array.isArray(body.map)
          ? body.map
          : Array.isArray(body)
            ? body
            : [];
      const data = await putPaymentModeMap(
        req.params.id,
        req.params.companyGuid,
        req.user.userId,
        list
      );
      res.json({ success: true, data });
    } catch (err) {
      errJson(res, err);
    }
  }
);

router.get('/workspaces/:id/company-years', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const companyGuid = req.query.companyGuid || req.query.guid;
    if (!companyGuid) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'companyGuid required' } });
    }
    const { rows: owned } = await query(
      `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
      [companyGuid, req.params.id]
    );
    if (!owned[0]) {
      return res.status(403).json({ success: false, error: { code: 'COMPANY_SCOPE_DENIED', message: 'Company not in workspace' } });
    }
    const { rows } = await query(
      `SELECT fin_year AS financial_year, begin_date AS start_date, end_date
       FROM company_years WHERE company_id = $1 ORDER BY begin_date DESC`,
      [owned[0].id]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    errJson(res, err);
  }
});

router.get('/workspaces/:id/tally/status', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const { buildTallyStatusPayload } = await import('../services/workspacePairingService.js');
    const data = await buildTallyStatusPayload(req.params.id, req.user.userId);
    res.json({ success: true, data });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspaces/:id/tally/pair', authMiddleware, bindWorkspaceParam, requireCapability('tally.pair'), async (req, res) => {
  try {
    const pairing_code = req.body?.pairing_code || req.body?.pairingCode || req.body?.pairCode || req.body?.code;
    if (!pairing_code) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Pairing code required' } });
    }
    const { approvePairing } = await import('../services/workspacePairingService.js');
    const bound = await approvePairing({
      workspaceId: req.params.id,
      actorUserId: req.user.userId,
      pairingCode: pairing_code,
    });

    if (_socket) {
      _socket.notifyPaired?.(req.user.userId, 'Desktop', req.params.id);
      // Wake-up only — secret comes from HTTP claim (except legacy_immediate bridge)
      if (bound.mode === 'session_approved' && bound.deviceId) {
        _socket.notifyDesktop?.(bound.deviceId, 'pairing_approved', {
          sessionId: bound.sessionId,
          workspaceId: bound.workspace.id,
          workspace: { id: bound.workspace.id, name: bound.workspace.name },
        });
      }
      if (bound.mode === 'legacy_immediate' && bound.deviceSecret && bound.deviceId) {
        _socket.notifyDesktop?.(bound.deviceId, 'pairing_confirmed', {
          userId: req.user.userId,
          pairedAt: new Date().toISOString(),
          deviceSecret: bound.deviceSecret,
          workspace: { id: bound.workspace.id, name: bound.workspace.name },
        });
        _socket.notifyWorkspaceRoom?.(bound.workspace.id, 'tally_connection', {
          status: bound.connectionStatus || 'RECONNECTING',
          workspaceId: bound.workspace.id,
        });
      }
      // Session path: clients stay Demo until claim → RECONNECTING event from claim route
    }

    console.log(
      `[WS PAIR] User ${req.user.userId} approved device ${bound.deviceId} → workspace ${bound.workspace.id}` +
        ` mode=${bound.mode}` +
        (bound.alreadyBound ? ' (idempotent)' : '')
    );
    res.json({
      success: true,
      data: {
        device_id: bound.deviceId,
        workspace_id: bound.workspace.id,
        workspace_name: bound.workspace.name,
        is_paired: bound.mode === 'legacy_immediate' || bound.alreadyBound,
        connection_status: bound.connectionStatus,
        already_bound: !!bound.alreadyBound,
        session_id: bound.sessionId || null,
        awaiting_desktop_claim: bound.mode === 'session_approved' && !bound.alreadyBound,
        message:
          bound.mode === 'session_approved' && !bound.alreadyBound
            ? 'Desktop connected. Waiting for the first successful Tally sync before showing live data.'
            : undefined,
      },
    });
  } catch (err) {
    if (err?.code) {
      return res.status(err.httpStatus || 409).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    errJson(res, err);
  }
});

router.post('/workspaces/:id/tally/unpair', authMiddleware, bindWorkspaceParam, requireCapability('tally.unpair'), async (req, res) => {
  try {
    const { unpairWorkspace } = await import('../services/workspacePairingService.js');
    const result = await unpairWorkspace({
      workspaceId: req.params.id,
      actorUserId: req.user.userId,
    });
    if (result.alreadyUnpaired) {
      return res.json({
        success: true,
        data: { message: 'Already unpaired', code: 'ALREADY_UNPAIRED' },
      });
    }
    // Non-destructive: do NOT deactivate companies or clear companies.workspace_id.
    if (_socket?.notifyUnpaired) {
      _socket.notifyUnpaired(
        req.user.userId,
        result?.newCode || null,
        result.deviceId,
        req.params.id,
      );
    } else if (result.deviceId) {
      // newCode is intentionally null after unpair — Desktop must mint a fresh session.
      _socket?.notifyDesktop?.(result.deviceId, 'unpaired', { newCode: null });
      _socket?.notifyWorkspaceRoom?.(req.params.id, 'tally_connection', {
        status: 'UNPAIRED',
        workspaceId: req.params.id,
      });
    }
    res.json({ success: true, data: { message: 'Unpaired' } });
  } catch (err) {
    if (err?.code) {
      return res.status(err.httpStatus || 403).json({
        success: false,
        error: { code: err.code, message: err.message },
      });
    }
    errJson(res, err);
  }
});

router.get('/workspaces/:id/approvals', authMiddleware, bindWorkspaceParam, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const hardSync = await listPendingHardSync(req.params.id);
    const rest = await listWorkspaceApprovals(req.params.id);
    const { rows: ws } = await query('SELECT id, name FROM workspaces WHERE id = $1', [req.params.id]);
    res.json({
      success: true,
      data: {
        workspace: { id: ws[0]?.id, name: ws[0]?.name },
        hardSync,
        backups: rest.backups,
        restoreRequests: rest.restoreRequests,
      },
    });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/hard-sync-requests/:id/approve', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const row = await approveHardSync({
      requestId: req.params.id,
      userId: req.user.userId,
      workspaceId: req.workspaceId,
    });
    notifyHardSyncDecision(row, 'APPROVED');
    res.json({ success: true, data: { requestId: row.id, status: row.status } });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/hard-sync-requests/:id/reject', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    await rejectHardSync({
      requestId: req.params.id,
      userId: req.user.userId,
      workspaceId: req.workspaceId,
    });
    const { rows } = await query('SELECT * FROM hard_sync_requests WHERE id = $1', [req.params.id]);
    notifyHardSyncDecision(rows[0], 'REJECTED');
    res.json({ success: true });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/restore-sessions/:id/approve', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const { code, backupId } = req.body || {};
    if (!code || !backupId) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'code and backupId required' },
      });
    }
    const result = await approveRestore({
      userId: req.user.userId,
      workspaceId: req.workspaceId,
      code: String(code).toUpperCase(),
      backupId,
    });
    notifyRestoreApproved({ ...result, workspaceId: req.workspaceId });
    res.json({ success: true, data: result });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/restore-sessions/:id/reject', authMiddleware, resolveWorkspaceMiddleware, requireCapability('tally.restore_replace'), async (req, res) => {
  try {
    const { rejectRestore } = await import('../services/restoreService.js');
    const result = await rejectRestore({
      userId: req.user.userId,
      workspaceId: req.workspaceId,
      sessionId: req.params.id,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    errJson(res, err);
  }
});

/** Alias: header-workspace restore reject (Mobile §25) */
router.post('/workspace/restore/:id/reject', authMiddleware, resolveWorkspaceMiddleware, async (req, res) => {
  try {
    const { rejectRestore } = await import('../services/restoreService.js');
    const result = await rejectRestore({
      userId: req.user.userId,
      workspaceId: req.workspaceId,
      sessionId: req.params.id,
    });
    notifyRestoreRejected(result);
    res.json({ success: true, data: result });
  } catch (err) {
    errJson(res, err);
  }
});

// Integration stubs (GST / E-Invoice / E-Way) — Owner/Admin activation
router.get('/workspaces/:id/integrations/:domain', authMiddleware, bindWorkspaceParam, async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    if (!['gst', 'einvoice', 'eway'].includes(domain)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid domain' } });
    }
    const { rows } = await query(
      `SELECT domain, status, config_json, activated_at FROM workspace_integrations
       WHERE workspace_id = $1 AND domain = $2 LIMIT 1`,
      [req.params.id, domain]
    ).catch(() => ({ rows: [] }));
    res.json({
      success: true,
      data: rows[0] || { domain, status: 'NOT_CONFIGURED', config_json: null, activated_at: null },
    });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspaces/:id/integrations/:domain', authMiddleware, bindWorkspaceParam, requireCapability('integrations.configure'), async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    if (!['gst', 'einvoice', 'eway'].includes(domain)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid domain' } });
    }
    const { v4: uuid } = await import('uuid');
    const id = uuid();
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO workspace_integrations (id, workspace_id, domain, status, config_json, updated_at)
       VALUES ($1,$2,$3,'CONFIGURED',$4,$5)
       ON CONFLICT (workspace_id, domain) DO UPDATE SET
         config_json = EXCLUDED.config_json, status = 'CONFIGURED', updated_at = EXCLUDED.updated_at`,
      [id, req.params.id, domain, JSON.stringify(req.body || {}), ts]
    ).catch(async (e) => {
      // Table may not exist yet on older DBs — create minimally
      if (String(e.message).includes('workspace_integrations')) {
        await query(`
          CREATE TABLE IF NOT EXISTS workspace_integrations (
            id TEXT PRIMARY KEY,
            workspace_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
            config_json JSONB,
            activated_at BIGINT,
            updated_at BIGINT,
            UNIQUE (workspace_id, domain)
          )`);
        await query(
          `INSERT INTO workspace_integrations (id, workspace_id, domain, status, config_json, updated_at)
           VALUES ($1,$2,$3,'CONFIGURED',$4,$5)
           ON CONFLICT (workspace_id, domain) DO UPDATE SET
             config_json = EXCLUDED.config_json, status = 'CONFIGURED', updated_at = EXCLUDED.updated_at`,
          [id, req.params.id, domain, JSON.stringify(req.body || {}), ts]
        );
      } else throw e;
    });
    res.json({ success: true, data: { domain, status: 'CONFIGURED' } });
  } catch (err) {
    errJson(res, err);
  }
});

router.post('/workspaces/:id/integrations/:domain/activate', authMiddleware, bindWorkspaceParam, requireCapability('integrations.configure'), async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    const { rows } = await query(
      `SELECT status FROM workspace_integrations WHERE workspace_id = $1 AND domain = $2 LIMIT 1`,
      [req.params.id, domain]
    ).catch(() => ({ rows: [] }));
    if (!rows[0] || rows[0].status === 'NOT_CONFIGURED') {
      return res.status(409).json({
        success: false,
        error: { code: 'INTEGRATION_NOT_CONFIGURED', message: 'Configure provider settings before activation' },
      });
    }
    // Already active: succeed without charging again. Only NOT_CONFIGURED was
    // rejected before, so re-activating an active integration deducted the fee
    // a second time — and the button is reachable by anyone holding
    // integrations.configure, spending the Owner's credits each press.
    if (rows[0].status === 'ACTIVE') {
      return res.json({ success: true, data: { domain, status: 'ACTIVE', alreadyActive: true } });
    }
    // Deduct activation credits from the Owner wallet when billing is present.
    try {
      const { deductCredits, ensureBillingAccount, getServiceRate } = await import('../services/billingService.js');
      const { rows: ws } = await query(`SELECT owner_user_id FROM workspaces WHERE id = $1`, [req.params.id]);
      const ownerId = ws[0]?.owner_user_id;
      if (ownerId) {
        await ensureBillingAccount(ownerId);
        const rateKey = domain === 'gst' ? 'GST_ACTIVATION'
          : domain === 'einvoice' ? 'EINVOICE_ACTIVATION' : 'EWAY_ACTIVATION';
        // Price comes from service_rates; the amount was hardcoded at 100, so
        // repricing in the rates table had no effect on what was charged.
        const rate = await getServiceRate(rateKey);
        const amount = Number(rate?.credits ?? 100);
        await deductCredits({
          userId: ownerId,
          amount,
          kind: rateKey,
          reference: `${req.params.id}:${domain}`,
          workspaceId: req.params.id,
          meta: { domain, rateVersion: rate?.version ?? null },
        });
      }
    } catch (billErr) {
      if (billErr.code === 'BILLING_INSUFFICIENT_CREDITS' || /insufficient/i.test(billErr.message || '')) {
        return res.status(402).json({
          success: false,
          error: {
            code: 'BILLING_INSUFFICIENT_CREDITS',
            message: 'This Workspace does not have enough credits. Please ask the Workspace Owner to recharge from the Web Portal.',
          },
        });
      }
      // If billing not fully wired, still mark activated for cursor builds
      console.warn('[integrations.activate] billing:', billErr.message);
    }
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `UPDATE workspace_integrations SET status = 'ACTIVE', activated_at = $3, updated_at = $3
       WHERE workspace_id = $1 AND domain = $2`,
      [req.params.id, domain, ts]
    ).catch(() => {});
    res.json({ success: true, data: { domain, status: 'ACTIVE' } });
  } catch (err) {
    errJson(res, err);
  }
});

export default router;
