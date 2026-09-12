/**
 * Scope checks — company / FY / ledger / godown / cost-centre per membership_scope_policy.
 * Modes: ALL | SELECTED | NONE. Aligns with workspaceSchema member_*_access tables.
 * Fail-closed: unexpected DB error / unrecognized mode → deny.
 */
import { query } from '../db/schema.js';
import { flags } from '../config/featureFlags.js';

export class ScopeError extends Error {
  constructor(code, message, httpStatus = 403) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

async function getPolicy(membershipId) {
  const { rows } = await query(
    `SELECT * FROM membership_scope_policy WHERE membership_id = $1 LIMIT 1`,
    [membershipId]
  );
  return rows[0] || {
    membership_id: membershipId,
    company_mode: 'ALL', fy_mode: 'ALL', ledger_mode: 'ALL', godown_mode: 'ALL', cost_centre_mode: 'ALL',
  };
}

async function assertSelected(table, whereSql, params, deniedCode, deniedMessage) {
  try {
    const { rows } = await query(`SELECT 1 FROM ${table} WHERE ${whereSql} LIMIT 1`, params);
    if (!rows[0]) throw new ScopeError(deniedCode, deniedMessage, 403);
  } catch (err) {
    if (err instanceof ScopeError) throw err;
    throw new ScopeError(deniedCode, deniedMessage, 403);
  }
}

export async function assertCompanyAccess(membershipId, companyGuid) {
  if (!flags.scope_company_enabled()) return true;
  if (!companyGuid) return true;
  const policy = await getPolicy(membershipId);
  if (policy.company_mode === 'NONE') throw new ScopeError('SCOPE_COMPANY_DENIED', 'No company access for this member.', 403);
  if (policy.company_mode === 'ALL') return true;
  await assertSelected(
    'member_company_access',
    'membership_id = $1 AND company_guid = $2',
    [membershipId, companyGuid],
    'SCOPE_COMPANY_DENIED',
    'This member does not have access to the selected company.'
  );
  return true;
}

export async function assertFyAccess(membershipId, _companyGuid, financialYear) {
  if (!flags.scope_fy_enabled()) return true;
  if (!financialYear) return true;
  const policy = await getPolicy(membershipId);
  if (policy.fy_mode === 'NONE') throw new ScopeError('SCOPE_FY_DENIED', 'No financial-year access for this member.', 403);
  if (policy.fy_mode === 'ALL') return true;
  const fyKey = String(financialYear);
  await assertSelected(
    'member_fy_access',
    'membership_id = $1 AND fy_key = $2',
    [membershipId, fyKey],
    'SCOPE_FY_DENIED',
    'This member does not have access to the selected financial year.'
  );
  return true;
}

export async function assertLedgerAccess(membershipId, _companyGuid, ledgerGuid) {
  if (!flags.scope_ledger_enabled()) return true;
  if (!ledgerGuid) return true;
  const policy = await getPolicy(membershipId);
  if (policy.ledger_mode === 'NONE') throw new ScopeError('SCOPE_LEDGER_DENIED', 'No ledger access for this member.', 403);
  if (policy.ledger_mode === 'ALL') return true;
  await assertSelected(
    'member_ledger_access',
    'membership_id = $1 AND ledger_guid = $2',
    [membershipId, ledgerGuid],
    'SCOPE_LEDGER_DENIED',
    'This member does not have access to the selected ledger.'
  );
  return true;
}

export async function assertGodownAccess(membershipId, _companyGuid, godownName, godownGuid = null) {
  if (!flags.scope_godown_enabled()) return true;
  if (!godownName && !godownGuid) return true;
  const policy = await getPolicy(membershipId);
  if (policy.godown_mode === 'NONE') throw new ScopeError('SCOPE_GODOWN_DENIED', 'No godown access for this member.', 403);
  if (policy.godown_mode === 'ALL') return true;
  if (godownGuid) {
    await assertSelected(
      'member_godown_access',
      'membership_id = $1 AND godown_guid = $2',
      [membershipId, godownGuid],
      'SCOPE_GODOWN_DENIED',
      'This member does not have access to the selected godown.'
    );
  } else {
    await assertSelected(
      'member_godown_access',
      'membership_id = $1 AND godown_name = $2',
      [membershipId, godownName],
      'SCOPE_GODOWN_DENIED',
      'This member does not have access to the selected godown.'
    );
  }
  return true;
}

export async function assertCostCentreAccess(membershipId, _companyGuid, costCentreGuid) {
  if (!flags.scope_cost_centre_enabled()) return true;
  if (!costCentreGuid) return true;
  const policy = await getPolicy(membershipId);
  if (policy.cost_centre_mode === 'NONE') throw new ScopeError('SCOPE_COST_CENTRE_DENIED', 'No cost-centre access for this member.', 403);
  if (policy.cost_centre_mode === 'ALL') return true;
  await assertSelected(
    'member_cost_centre_access',
    'membership_id = $1 AND cost_centre_guid = $2',
    [membershipId, costCentreGuid],
    'SCOPE_COST_CENTRE_DENIED',
    'This member does not have access to the selected cost centre.'
  );
  return true;
}

export async function getScopePolicy(membershipId) {
  return getPolicy(membershipId);
}

export async function upsertScopePolicy(membershipId, patch = {}) {
  const current = await getPolicy(membershipId);
  const merged = { ...current, ...patch };
  await query(
    `INSERT INTO membership_scope_policy
       (membership_id, company_mode, fy_mode, ledger_mode, godown_mode, cost_centre_mode)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (membership_id) DO UPDATE SET
       company_mode = EXCLUDED.company_mode,
       fy_mode = EXCLUDED.fy_mode,
       ledger_mode = EXCLUDED.ledger_mode,
       godown_mode = EXCLUDED.godown_mode,
       cost_centre_mode = EXCLUDED.cost_centre_mode`,
    [membershipId, merged.company_mode, merged.fy_mode, merged.ledger_mode, merged.godown_mode, merged.cost_centre_mode]
  );
  return getPolicy(membershipId);
}
