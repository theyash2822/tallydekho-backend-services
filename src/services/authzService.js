/**
 * authzService — compatibility re-export.
 * Canonical implementation lives in authorizationService.js.
 * Routes / middleware should prefer authorizationService directly.
 */
import { loadMembership, authorize, getEffectiveAccess } from './authorizationService.js';
import { getRole } from './roleService.js';

export { loadMembership, authorize, getEffectiveAccess };

export class AuthzError extends Error {
  constructor(code, message, httpStatus = 403) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** Alias used by integrationService drafts */
export async function resolveMembership(userId, workspaceId) {
  return loadMembership(userId, workspaceId);
}

/**
 * Owner / Admin check from a membership row (Admin = membership_type or role system_key).
 */
export async function isOwnerOrAdminMembership(membership) {
  if (!membership || membership.status !== 'ACTIVE') return false;
  if (membership.membership_type === 'OWNER' || membership.membership_type === 'ADMIN') return true;
  if (!membership.role_id) return false;
  const role = await getRole(membership.role_id);
  return role?.system_key === 'ADMIN';
}
