/**
 * After verifyCompanyAccess — internal ownership uses companies.id only.
 * No company_guid ownership fallback (Phase 3E).
 */
export function requireResolvedCompanyId(req) {
  const id = req.company?.id;
  if (id == null) {
    const err = new Error('Company not resolved on request');
    err.code = 'COMPANY_NOT_RESOLVED';
    err.httpStatus = 403;
    throw err;
  }
  return Number(id);
}
