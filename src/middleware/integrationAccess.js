/**
 * Canonical gate for /app/integrations/* — never trust companyGuid alone.
 * Sequence: JWT (caller) → workspace membership → company in workspace → capability.
 */
import { verifyCompanyAccess } from './companyAccess.js';

/**
 * Express middleware factory.
 * @param {'configure'|'read'} mode — configure uses integrations.configure; read uses einvoice.view/eway.view when possible, else integrations.configure
 */
export function requireIntegrationCompanyAccess(mode = 'configure') {
  return async function integrationCompanyAccess(req, res, next) {
    try {
      const companyGuid =
        req.body?.companyGuid ||
        req.body?.company_guid ||
        req.query?.companyGuid ||
        req.query?.company_guid ||
        null;
      if (!companyGuid) {
        return res.status(400).json({ status: false, message: 'companyGuid required', code: 'VALIDATION_ERROR' });
      }
      const isEway = String(req.path || '').includes('eway');
      const capability =
        mode === 'configure'
          ? 'integrations.configure'
          : isEway
            ? 'eway.view'
            : 'einvoice.view';
      const ok = await verifyCompanyAccess(req, res, companyGuid, {
        capability,
        responseShape: 'data',
      });
      if (!ok) return;
      req.integrationCompanyGuid = companyGuid;
      next();
    } catch (err) {
      return res.status(403).json({
        status: false,
        message: err.message || 'Integration access denied',
        code: err.code || 'FORBIDDEN',
      });
    }
  };
}
