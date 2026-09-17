/**
 * Workspace context middleware.
 * JWT stays user identity only — workspace via X-Workspace-Id (or personal fallback).
 */
import { flag } from '../config/featureFlags.js';
import { ensurePersonalWorkspace, getWorkspaceById } from '../services/workspaceService.js';
import { loadMembership, authorize } from '../services/authorizationService.js';

function readWorkspaceHeader(req) {
  const h = req.headers['x-workspace-id'] || req.headers['X-Workspace-Id'] || null;
  return Array.isArray(h) ? h[0] : h;
}

/**
 * Resolves req.workspaceId from X-Workspace-Id.
 * If header missing: fall back to personal base workspace (mobile compat).
 * Verifies ACTIVE membership; SUSPENDED → 403 MEMBERSHIP_SUSPENDED. Fail closed.
 */
export async function resolveWorkspaceMiddleware(req, res, next) {
  try {
    if (!req.user?.userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Auth required' } });
    }

    let workspaceId = req._forceWorkspaceId || readWorkspaceHeader(req);
    workspaceId = workspaceId ? String(workspaceId).trim() : '';

    if (!workspaceId) {
      if (flag('workspace_header_required') || flag('workspace_model_enabled')) {
        const ws = await ensurePersonalWorkspace(req.user.userId);
        workspaceId = ws.id;
      } else {
        return next();
      }
    }

    const membership = await loadMembership(req.user.userId, workspaceId);
    if (!membership) {
      return res.status(403).json({
        success: false,
        error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Not a member of this workspace' },
      });
    }
    if (membership.status === 'SUSPENDED') {
      return res.status(403).json({
        success: false,
        error: { code: 'MEMBERSHIP_SUSPENDED', message: 'Membership suspended' },
      });
    }
    if (membership.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Membership inactive' },
      });
    }

    const workspace = await getWorkspaceById(workspaceId);
    req.workspaceId = workspaceId;
    req.workspace = workspace;
    req.membership = membership;
    next();
  } catch (err) {
    console.warn('[workspaceContext] fail closed:', err.message);
    return res.status(403).json({
      success: false,
      error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Workspace resolution failed' },
    });
  }
}

/** Bind req.params.id as workspace before resolve + capability checks. */
export function bindWorkspaceParam(req, res, next) {
  if (req.params?.id) req._forceWorkspaceId = req.params.id;
  return resolveWorkspaceMiddleware(req, res, next);
}

/** Alias for callers that prefer attachWorkspaceContext naming. */
export const attachWorkspaceContext = resolveWorkspaceMiddleware;

/**
 * Middleware factory: require a capability key after resolveWorkspaceMiddleware.
 */
export function requireCapability(capabilityKey) {
  return async function requireCapabilityMiddleware(req, res, next) {
    try {
      if (!req.workspaceId || !req.user?.userId) {
        return res.status(403).json({
          success: false,
          error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Workspace context required' },
        });
      }
      const result = await authorize({
        userId: req.user.userId,
        workspaceId: req.workspaceId,
        capability: capabilityKey,
      });
      if (result.decision !== 'ALLOW') {
        return res.status(403).json({
          success: false,
          error: {
            code: result.reason || 'CAPABILITY_DENIED',
            message: 'Capability not granted',
            capability: capabilityKey,
          },
        });
      }
      req.authz = result;
      next();
    } catch {
      return res.status(403).json({
        success: false,
        error: { code: 'CAPABILITY_DENIED', message: 'Authorization failed' },
      });
    }
  };
}
