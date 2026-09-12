/**
 * Fail-closed company access for data + write routes.
 * Workspace membership + company lineage + optional capability/scopes.
 */
import { query } from '../db/schema.js';
import { flag } from '../config/featureFlags.js';
import { ensurePersonalWorkspace } from '../services/workspaceService.js';
import { loadMembership, authorize } from '../services/authorizationService.js';
import { assertCompanyAccess, assertFyAccess, assertLedgerAccess, assertGodownAccess, assertCostCentreAccess } from '../services/scopeService.js';
import { applyMask, getPolicies } from '../services/sensitivePolicyService.js';

function readWorkspaceHeader(req) {
  const h = req.headers['x-workspace-id'] || req.headers['X-Workspace-Id'] || null;
  return Array.isArray(h) ? h[0] : h;
}

/**
 * Resolve workspace onto req (personal fallback). Fail closed → null.
 */
export async function ensureReqWorkspace(req) {
  if (req.workspaceId && req.membership) return req.workspaceId;
  if (!req.user?.userId) return null;
  let workspaceId = req.workspaceId || readWorkspaceHeader(req);
  workspaceId = workspaceId ? String(workspaceId).trim() : '';
  if (!workspaceId && flag('workspace_model_enabled')) {
    const ws = await ensurePersonalWorkspace(req.user.userId);
    workspaceId = ws?.id || '';
  }
  if (!workspaceId) return null;
  const membership = await loadMembership(req.user.userId, workspaceId);
  if (!membership || membership.status !== 'ACTIVE') return null;
  req.workspaceId = workspaceId;
  req.membership = membership;
  return workspaceId;
}

/**
 * Company must belong to the resolved workspace (or legacy owner-bound).
 */
async function companyInWorkspace(companyGuid, workspaceId, userId) {
  const { rows } = await query(
    `SELECT c.guid FROM companies c
     WHERE c.guid = $1
       AND (
         c.workspace_id = $2
         OR (c.workspace_id IS NULL AND c.user_id = (
           SELECT owner_user_id FROM workspaces WHERE id = $2
         ))
         OR (c.workspace_id IS NULL AND c.user_id = $3 AND EXISTS (
           SELECT 1 FROM workspaces w WHERE w.id = $2 AND w.owner_user_id = $3 AND w.is_base = TRUE
         ))
       )
     LIMIT 1`,
    [companyGuid, workspaceId, userId]
  );
  return rows.length > 0;
}

/**
 * verifyCompanyAccess(req, res, companyGuid, opts) → true | false (and sends response).
 * Fail closed on any error.
 */
export async function verifyCompanyAccess(req, res, companyGuid, opts = {}) {
  const {
    capability = null,
    financialYear = null,
    ledgerGuid = null,
    godownGuid = null,
    costCentreGuid = null,
    entryKind = null,
    responseShape = 'api-v1', // 'api-v1' | 'data' | 'tally'
  } = opts;

  const deny = (status, code, message) => {
    if (responseShape === 'data') {
      res.status(status).json({ status: false, message, code });
    } else if (responseShape === 'tally') {
      res.status(status).json({ status: false, message, error: { code } });
    } else {
      res.status(status).json({ success: false, error: { code, message } });
    }
    return false;
  };

  try {
    if (!companyGuid) return true;
    if (!req.user?.userId) return deny(401, 'UNAUTHORIZED', 'Auth required');

    if (!flag('workspace_model_enabled') && !flag('rbas_enabled')) {
      const { rows } = await query(
        'SELECT guid FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
        [companyGuid, req.user.userId]
      );
      if (!rows.length) return deny(403, 'FORBIDDEN', 'Company not found or access denied');
      return true;
    }

    const workspaceId = await ensureReqWorkspace(req);
    if (!workspaceId) {
      return deny(403, 'WORKSPACE_ACCESS_DENIED', 'Workspace membership required');
    }

    const okCompany = await companyInWorkspace(companyGuid, workspaceId, req.user.userId);
    if (!okCompany) {
      return deny(403, 'COMPANY_SCOPE_DENIED', 'Company not in this workspace');
    }

    // Membership company scope (even without a specific capability)
    if (flag('scope_company_enabled') && req.membership?.membership_type !== 'OWNER') {
      try {
        await assertCompanyAccess(req.membership.id, companyGuid);
      } catch (scopeErr) {
        return deny(403, scopeErr.code || 'COMPANY_SCOPE_DENIED', scopeErr.message || 'Company scope denied');
      }
    }

    if (flag('scope_fy_enabled') && financialYear && req.membership?.membership_type !== 'OWNER') {
      try {
        await assertFyAccess(req.membership.id, companyGuid, financialYear);
      } catch (scopeErr) {
        return deny(403, scopeErr.code || 'FY_SCOPE_DENIED', scopeErr.message || 'FY scope denied');
      }
    }

    if (capability && flag('rbas_enabled')) {
      const result = await authorize({
        userId: req.user.userId,
        workspaceId,
        capability,
        companyGuid,
        financialYear,
        ledgerGuid,
        godownGuid,
        costCentreGuid,
        entryKind,
      });
      if (result.decision !== 'ALLOW') {
        return deny(403, result.reason || 'CAPABILITY_DENIED', 'Not allowed');
      }
      req.authz = result;
    } else if (flag('rbas_enabled') && req.membership?.membership_type !== 'OWNER') {
      // Extra resource scopes when no capability passed
      try {
        if (ledgerGuid && flag('scope_ledger_enabled')) {
          await assertLedgerAccess(req.membership.id, companyGuid, ledgerGuid);
        }
        if (godownGuid && flag('scope_godown_enabled')) {
          await assertGodownAccess(req.membership.id, companyGuid, godownGuid);
        }
        if (costCentreGuid && flag('scope_cost_centre_enabled')) {
          await assertCostCentreAccess(req.membership.id, companyGuid, costCentreGuid);
        }
      } catch (scopeErr) {
        return deny(403, scopeErr.code || 'SCOPE_DENIED', scopeErr.message || 'Scope denied');
      }
    }

    // Non-owner: attach full sensitive policy map (VISIBLE/HIDDEN) for response masking
    if (flag('sensitive_policy_enabled') && req.membership?.membership_type !== 'OWNER') {
      try {
        const policies = await getPolicies(req.membership?.role_id);
        req.authz = { ...(req.authz || {}), masking: policies };
      } catch (maskErr) {
        console.warn('[companyAccess] getPolicies failed:', maskErr.message);
      }
    }

    return true;
  } catch (err) {
    console.warn('[companyAccess] fail closed:', err.message);
    return deny(403, 'FORBIDDEN', 'Access check failed');
  }
}

/**
 * Apply sensitive masking using req.authz.masking as the full policy map
 * ({ policyKey: 'VISIBLE' | 'HIDDEN' | 'MASKED' }). Set by verifyCompanyAccess.
 */
export function maskIfNeeded(req, payload) {
  if (!flag('sensitive_policy_enabled')) return payload;
  const masking = req.authz?.masking;
  if (!masking || typeof masking !== 'object' || !payload) return payload;
  try {
    return applyMask(payload, masking);
  } catch {
    return payload;
  }
}

/** Map tally write path → capability + entryKind */
export const TALLY_WRITE_CAPABILITIES = {
  '/voucher/sales': { capability: 'sales_invoice.create', entryKind: 'REGULAR' },
  '/voucher/proforma': { capability: 'sales_invoice.create', entryKind: 'OPTIONAL' },
  '/voucher/proforma/convert': { capability: 'sales_proforma.convert_to_regular', entryKind: null },
  '/voucher/sales-order': { capability: 'sales_order.create', entryKind: 'REGULAR' },
  '/voucher/quotation': { capability: 'sales_order.create', entryKind: 'OPTIONAL' },
  '/voucher/delivery-note': { capability: 'delivery_note.create', entryKind: null },
  '/voucher/credit-note': { capability: 'credit_note.create', entryKind: null },
  '/voucher/purchase': { capability: 'purchase_invoice.create', entryKind: null },
  '/voucher/purchase-order': { capability: 'purchase_order.create', entryKind: null },
  '/voucher/debit-note': { capability: 'debit_note.create', entryKind: null },
  '/voucher/receipt': { capability: 'receipt.create', entryKind: null },
  '/voucher/payment': { capability: 'payment.create', entryKind: null },
  '/voucher/journal': { capability: 'journal.create', entryKind: null },
  '/voucher/contra': { capability: 'contra.create', entryKind: null },
  '/voucher/stock-transfer': { capability: 'stock_transfer.create', entryKind: null },
  '/voucher/stock-adjustment': { capability: 'stock_adjustment.create', entryKind: null },
  '/voucher/cancel': { capability: null, deny: true }, // no generic cancel in registry
  '/master/party': { capability: 'ledger_master.create', entryKind: null },
  '/master/stock-item': { capability: 'stock_item.create', entryKind: null },
  '/master/stock-item-alter': { capability: 'stock_item.alter', entryKind: null },
  '/master/warehouse': { capability: 'warehouse.create', entryKind: null },
  '/master/bank': { capability: 'ledger_master.create', entryKind: null },
  '/invoice/:tdkRef/share-pdf': { capability: 'document.pdf.generate', entryKind: null },
};

/** Express middleware factory — fail-closed capability + Entry Mode on Tally writes. */
export function requireTallyWriteAccess(pathKey) {
  return async (req, res, next) => {
    try {
      const companyGuid =
        req.body?.companyGuid ||
        req.body?.company_guid ||
        req.query?.companyGuid ||
        null;
      if (!companyGuid) {
        return res.status(400).json({
          status: false,
          message: 'companyGuid required',
          error: { code: 'VALIDATION_ERROR' },
        });
      }
      if (!(await assertTallyWriteAccess(req, res, companyGuid, pathKey))) return;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function assertTallyWriteAccess(req, res, companyGuid, pathKey) {
  const map = TALLY_WRITE_CAPABILITIES[pathKey];
  if (map?.deny) {
    res.status(403).json({
      status: false,
      message: 'Generic voucher cancel is not permitted',
      error: { code: 'CAPABILITY_DENIED' },
    });
    return false;
  }
  const capability = map?.capability || null;
  // Sales Invoice/Order: derive Entry Mode from isOptional / entryKind body
  let entryKind = map?.entryKind || req.body?.entryKind || null;
  if (pathKey === '/voucher/sales' || pathKey === '/voucher/sales-order') {
    const opt =
      req.body?.isOptional === true ||
      req.body?.is_optional === true ||
      String(req.body?.entryKind || '').toUpperCase() === 'OPTIONAL' ||
      String(req.body?.original_entry_type || '').toLowerCase() === 'optional' ||
      String(req.body?.entryType || '').toLowerCase() === 'optional';
    entryKind = opt ? 'OPTIONAL' : 'REGULAR';
  } else if (pathKey === '/voucher/proforma' || pathKey === '/voucher/quotation') {
    entryKind = 'OPTIONAL';
  }
  const ledgerGuid = req.body?.partyGuid || req.body?.ledgerGuid || req.body?.party_guid || null;
  const godownGuid = req.body?.godownGuid || req.body?.warehouseGuid || null;
  const fromGodown = req.body?.fromGodownGuid || req.body?.fromWarehouseGuid;
  const toGodown = req.body?.toGodownGuid || req.body?.toWarehouseGuid;
  const financialYear = req.body?.fy || req.body?.financialYear || null;

  if (!(await verifyCompanyAccess(req, res, companyGuid, {
    capability,
    entryKind,
    ledgerGuid,
    godownGuid: godownGuid || fromGodown,
    financialYear,
    responseShape: 'tally',
  }))) {
    return false;
  }

  // Stock transfer requires both endpoints
  if (pathKey === '/voucher/stock-transfer' && toGodown && req.membership?.membership_type !== 'OWNER') {
    if (!(await verifyCompanyAccess(req, res, companyGuid, {
      godownGuid: toGodown,
      responseShape: 'tally',
    }))) {
      return false;
    }
  }
  return true;
}
