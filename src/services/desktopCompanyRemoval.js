// Desktop "Remove company": hide companies from mobile/web immediately instead of
// waiting for the next init-sync to deactivate them. Soft only — synced data
// stays, and adding the company back on the desktop reactivates it via init-sync.

export const MAX_REMOVE_GUIDS = 100;
const MAX_GUID_LENGTH = 128;

export class CompanyRemovalError extends Error {
  constructor(code, message, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export function normalizeRemovalGuids(raw) {
  if (!Array.isArray(raw)) {
    throw new CompanyRemovalError('INVALID_GUIDS', 'guids must be a non-empty array');
  }
  const guids = [...new Set(
    raw.filter((g) => typeof g === 'string').map((g) => g.trim()).filter((g) => g && g.length <= MAX_GUID_LENGTH)
  )];
  if (!guids.length) {
    throw new CompanyRemovalError('INVALID_GUIDS', 'guids must be a non-empty array');
  }
  if (guids.length > MAX_REMOVE_GUIDS) {
    throw new CompanyRemovalError('TOO_MANY_GUIDS', `At most ${MAX_REMOVE_GUIDS} companies can be removed at once`);
  }
  return guids;
}

// Scoped to the workspace, not the device: a company last synced from another
// device in the same workspace must still disappear when this desktop removes it.
export async function deactivateWorkspaceCompanies(queryFn, workspaceId, rawGuids) {
  if (!workspaceId) {
    throw new CompanyRemovalError('DEVICE_NOT_PAIRED', 'Device not paired to a Workspace', 403);
  }
  const guids = normalizeRemovalGuids(rawGuids);
  const { rows } = await queryFn(
    `UPDATE companies SET is_active = FALSE
      WHERE workspace_id = $1 AND guid = ANY($2::text[])
        AND COALESCE(is_demo, FALSE) = FALSE
      RETURNING guid`,
    [workspaceId, guids]
  );
  const removed = rows.map((r) => r.guid);
  const removedSet = new Set(removed);
  return { removed, notFound: guids.filter((g) => !removedSet.has(g)) };
}
