/**
 * Canonical device ↔ company resolution (Company Identity Phase 2/3).
 * Fail closed: device workspace must own the company row.
 * Never trusts company GUID alone as authority.
 */
import { query } from '../db/schema.js';

export class CompanyResolutionError extends Error {
  constructor(code, message, httpStatus = 403) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * Resolve company for a user workspace (HTTP path). workspace_id authoritative.
 */
export async function resolveCompanyInWorkspace({ workspaceId, companyGuid }) {
  const guid = String(companyGuid || '').trim();
  if (!workspaceId) {
    throw new CompanyResolutionError('WORKSPACE_REQUIRED', 'workspaceId required', 403);
  }
  if (!guid) {
    throw new CompanyResolutionError('COMPANY_GUID_REQUIRED', 'companyGuid required', 400);
  }
  const { rows } = await query(
    `SELECT id, workspace_id, guid, name, device_id, is_active
     FROM companies
     WHERE guid = $1 AND workspace_id = $2
     LIMIT 1`,
    [guid, workspaceId]
  );
  if (!rows[0]) {
    throw new CompanyResolutionError(
      'COMPANY_NOT_IN_WORKSPACE',
      'Company not in this workspace',
      403
    );
  }
  return rows[0];
}

/**
 * @param {{ deviceId: string, companyGuid: string, device?: object, requireSyncAuthority?: boolean }} opts
 */
export async function resolveCompanyForDevice({
  deviceId,
  companyGuid,
  device: deviceHint = null,
  requireSyncAuthority = false,
}) {
  const guid = String(companyGuid || '').trim();
  if (!deviceId) {
    throw new CompanyResolutionError('DEVICE_REQUIRED', 'device-id required', 401);
  }
  if (!guid) {
    throw new CompanyResolutionError('COMPANY_GUID_REQUIRED', 'companyGuid required', 400);
  }

  let device = deviceHint;
  if (!device) {
    const { rows } = await query('SELECT * FROM devices WHERE device_id = $1 LIMIT 1', [deviceId]);
    device = rows[0] || null;
  }
  if (!device) {
    throw new CompanyResolutionError('DEVICE_CREDENTIAL_INVALID', 'Device not registered', 401);
  }
  const workspaceId = device.workspace_id || null;
  if (!workspaceId) {
    throw new CompanyResolutionError('DEVICE_NOT_PAIRED', 'Device not paired to a Workspace', 403);
  }

  const { rows } = await query(
    `SELECT id, workspace_id, guid, name, device_id, is_active
     FROM companies
     WHERE guid = $1 AND workspace_id = $2
     LIMIT 1`,
    [guid, workspaceId]
  );
  if (!rows[0]) {
    // Different workspace may own the same Tally GUID — that is a separate company.
    // This workspace simply has not registered the company yet.
    throw new CompanyResolutionError(
      'COMPANY_NOT_IN_WORKSPACE',
      'Company is not registered to this device Workspace. Run init-sync for this company first.',
      403
    );
  }

  const company = rows[0];
  if (requireSyncAuthority && company.device_id && company.device_id !== deviceId) {
    const { rows: holder } = await query(
      `SELECT device_id, paired, binding_status, workspace_id
       FROM devices WHERE device_id = $1 LIMIT 1`,
      [company.device_id]
    );
    const active =
      holder[0] &&
      holder[0].workspace_id === workspaceId &&
      (holder[0].paired === true || holder[0].binding_status === 'ACTIVE');
    if (active) {
      throw new CompanyResolutionError(
        'COMPANY_SYNC_AUTHORITY_CONFLICT',
        'Another Desktop device currently holds sync authority for this company. Re-run init-sync from this device to reclaim, or disconnect the other device.',
        409
      );
    }
  }
  return company;
}

/** Workspace-scoped availability — same GUID in another workspace is allowed (separate company). */
export async function assertCompanyGuidAvailableForWorkspace(workspaceId, companyGuid) {
  const guid = String(companyGuid || '').trim();
  if (!workspaceId || !guid) {
    throw new CompanyResolutionError('VALIDATION_ERROR', 'workspaceId and companyGuid required', 400);
  }
  const { rows } = await query(
    `SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
    [guid, workspaceId]
  );
  if (!rows[0]) return 'create';
  return 'same_workspace';
}
