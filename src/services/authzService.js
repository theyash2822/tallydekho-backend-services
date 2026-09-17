/**
 * authzService — compatibility re-export.
 * Canonical implementation lives in authorizationService.js.
 * Routes / middleware should prefer authorizationService directly.
 */
import { loadMembership, authorize, getEffectiveAccess } from './authorizationService.js';

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
