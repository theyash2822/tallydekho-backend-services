import { query } from '../db/schema.js';
import { flag } from '../config/featureFlags.js';
import {
  getCapability,
  getSensitivePolicy,
  allSensitivePolicyKeys,
  ownerAdminKeys,
  ownerOnlyKeys,
  resolveCapabilityKey,
} from './capabilityRegistry.js';
import { getRole, getGrantedCapabilityKeys } from './roleService.js';

/**
 * Load ACTIVE or SUSPENDED membership for user in workspace. Fail closed → null on error.
 */
export async function loadMembership(userId, workspaceId) {
  try {
    if (!userId || !workspaceId) return null;
    const { rows } = await query(
      `SELECT * FROM workspace_memberships
       WHERE workspace_id = $1 AND user_id = $2
         AND status IN ('ACTIVE','SUSPENDED')
       LIMIT 1`,
      [workspaceId, userId]
    );
    return rows[0] || null;
  } catch (err) {
    console.warn('[authz] loadMembership failed:', err.message);
    return null;
  }
}

async function loadScopes(membershipId) {
  if (!membershipId) return null;
  const { rows: policy } = await query(
    `SELECT * FROM membership_scope_policy WHERE membership_id = $1 LIMIT 1`,
    [membershipId]
  );
  const { rows: companies } = await query(
    `SELECT c.guid AS company_guid, mca.company_id
       FROM member_company_access mca
       JOIN companies c ON c.id = mca.company_id
      WHERE mca.membership_id = $1`,
    [membershipId]
  );
  const { rows: fys } = await query(
    `SELECT fy_key FROM member_fy_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: ledgers } = await query(
    `SELECT ledger_guid, ledger_name FROM member_ledger_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: godowns } = await query(
    `SELECT godown_guid, godown_name FROM member_godown_access WHERE membership_id = $1`,
    [membershipId]
  );
  const { rows: ccs } = await query(
    `SELECT cost_centre_guid, cost_centre_name FROM member_cost_centre_access WHERE membership_id = $1`,
    [membershipId]
  );
  return {
    policy: policy[0] || {
      company_mode: 'ALL',
      fy_mode: 'ALL',
      ledger_mode: 'ALL',
      godown_mode: 'ALL',
      cost_centre_mode: 'ALL',
    },
    companies: companies.map((r) => r.company_guid),
    financialYears: fys.map((r) => r.fy_key),
    ledgers,
    godowns,
    costCentres: ccs,
  };
}

/** Admin-equivalent = MEMBER with builtin ADMIN role (Phase 6). Not membership_type. */
export function isAdminRole(role) {
  return role?.system_key === 'ADMIN';
}

/**
 * Membership gate before role/capability checks.
 * Owner ALWAYS ALLOW when ACTIVE. Returns null to continue evaluation.
 * Exported for unit tests (no DB).
 */
export function membershipAuthzGate(membership) {
  if (!membership) {
    return { decision: 'DENY', reason: 'NO_MEMBERSHIP' };
  }
  if (membership.status === 'SUSPENDED') {
    return { decision: 'DENY', reason: 'MEMBERSHIP_SUSPENDED' };
  }
  if (membership.status !== 'ACTIVE') {
    return { decision: 'DENY', reason: 'MEMBERSHIP_INACTIVE' };
  }
  if (membership.membership_type === 'OWNER') {
    return { decision: 'ALLOW' };
  }
  return null;
}

/**
 * Normalize role entry_mode to OPTIONAL | REGULAR | BOTH.
 * Accepts OPTIONAL_ONLY / REGULAR_ONLY aliases. Exported for unit tests (no DB).
 */
export function normalizeEntryMode(raw) {
  const modeRaw = String(raw || 'BOTH').toUpperCase();
  if (modeRaw === 'OPTIONAL_ONLY' || modeRaw === 'OPTIONAL') return 'OPTIONAL';
  if (modeRaw === 'REGULAR_ONLY' || modeRaw === 'REGULAR') return 'REGULAR';
  return 'BOTH';
}

/**
 * Entry Mode gate for creation capabilities that support entry mode.
 * Returns DENY reason object or null if allowed / not applicable.
 * Exported for unit tests (no DB).
 */
export function entryModeGate(roleEntryMode, entryKind, supportsEntryMode) {
  if (!entryKind || !supportsEntryMode) return null;
  const mode = normalizeEntryMode(roleEntryMode);
  const kind = String(entryKind).toUpperCase();
  if (mode === 'OPTIONAL' && kind === 'REGULAR') {
    return { decision: 'DENY', reason: 'ENTRY_MODE_DENIED' };
  }
  if (mode === 'REGULAR' && kind === 'OPTIONAL') {
    return { decision: 'DENY', reason: 'ENTRY_MODE_DENIED' };
  }
  return null;
}

/**
 * authorize({ userId, workspaceId, capability }) → { decision, reason?, masking? }
 * Fail closed on DB errors. Owner ALWAYS ALLOW. Admin: protected + role caps.
 */
export async function authorize({
  userId,
  workspaceId,
  capability,
  companyGuid = null,
  financialYear = null,
  ledgerGuid = null,
  godownGuid = null,
  costCentreGuid = null,
  entryKind = null,
}) {
  try {
    const capabilityKey = resolveCapabilityKey(capability);
    const membership = await loadMembership(userId, workspaceId);
    const gate = membershipAuthzGate(membership);
    if (gate) return gate;

    const cap = getCapability(capabilityKey);
    if (!cap) {
      return { decision: 'DENY', reason: 'UNKNOWN_CAPABILITY' };
    }
    if (cap.protected_authority === 'OWNER') {
      return { decision: 'DENY', reason: 'OWNER_ONLY' };
    }

    const role = membership.role_id ? await getRole(membership.role_id) : null;
    const admin = isAdminRole(role);

    if (admin && cap.protected_authority === 'OWNER_OR_ADMIN_ROLE') {
      return { decision: 'ALLOW' };
    }

    if (!membership.role_id) {
      return { decision: 'DENY', reason: 'NO_ROLE' };
    }

    const granted = await getGrantedCapabilityKeys(membership.role_id);
    if (!granted.has(capabilityKey)) {
      return { decision: 'DENY', reason: 'CAPABILITY_NOT_GRANTED' };
    }

    // Entry Mode — creation only (accept OPTIONAL|REGULAR|BOTH and *_ONLY aliases)
    const entryDeny = entryModeGate(role?.entry_mode, entryKind, cap.supports_entry_mode);
    if (entryDeny) return entryDeny;

    // Scopes — fail closed via scopeService when enabled
    try {
      const { assertCompanyAccess, assertFyAccess, assertLedgerAccess, assertGodownAccess, assertCostCentreAccess } =
        await import('./scopeService.js');
      if (companyGuid && flag('scope_company_enabled')) {
        await assertCompanyAccess(membership.id, companyGuid);
      }
      if (companyGuid && financialYear && flag('scope_fy_enabled')) {
        await assertFyAccess(membership.id, companyGuid, financialYear);
      }
      if (companyGuid && ledgerGuid && flag('scope_ledger_enabled')) {
        await assertLedgerAccess(membership.id, companyGuid, ledgerGuid);
      }
      if (companyGuid && godownGuid && flag('scope_godown_enabled')) {
        await assertGodownAccess(membership.id, companyGuid, godownGuid);
      }
      if (companyGuid && costCentreGuid && flag('scope_cost_centre_enabled')) {
        await assertCostCentreAccess(membership.id, companyGuid, costCentreGuid);
      }
    } catch (scopeErr) {
      return {
        decision: 'DENY',
        reason: scopeErr.code || 'SCOPE_DENIED',
      };
    }

    // Sensitive masking hint when viewing data that may include sensitive fields
    let masking = null;
    if (flag('sensitive_policy_enabled') && role?.sensitivePolicies) {
      masking = {};
      for (const key of allSensitivePolicyKeys()) {
        const pol = getSensitivePolicy(key);
        const grantedPol = role.sensitivePolicies[key] !== false;
        if (!grantedPol && pol) masking[key] = pol.masking || 'HIDDEN';
      }
    }

    return { decision: 'ALLOW', masking: masking && Object.keys(masking).length ? masking : undefined };
  } catch (err) {
    console.warn('[authz] authorize failed closed:', err.message);
    return { decision: 'DENY', reason: 'AUTHZ_ERROR' };
  }
}

/** Fail closed throw if capability not granted. Canonical replacement for isOwnerOrAdmin gates. */
export async function assertCapability(userId, workspaceId, capability) {
  const result = await authorize({ userId, workspaceId, capability });
  if (result.decision !== 'ALLOW') {
    const err = new Error('Capability not granted');
    err.code = result.reason || 'CAPABILITY_DENIED';
    err.httpStatus = 403;
    err.capability = capability;
    throw err;
  }
  return result;
}

/**
 * Effective access bundle for workspace context / mobile bootstrap.
 */
export async function getEffectiveAccess(userId, workspaceId) {
  try {
    const membership = await loadMembership(userId, workspaceId);
    if (!membership) {
      return { membership: null, role: null, capabilities: [], entryMode: 'BOTH', sensitivePolicies: {}, scopes: null };
    }

    if (membership.membership_type === 'OWNER') {
      const scopes = await loadScopes(membership.id);
      return {
        membership,
        role: null,
        capabilities: [...(await import('./capabilityRegistry.js')).allKeys()],
        entryMode: 'BOTH',
        sensitivePolicies: Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, true])),
        scopes,
      };
    }

    const role = membership.role_id ? await getRole(membership.role_id) : null;
    const admin = isAdminRole(role);
    let capabilities = [];
    if (role) {
      capabilities = Object.entries(role.capabilities || {})
        .filter(([, g]) => g)
        .map(([k]) => k);
      if (admin) {
        const extra = new Set([...capabilities, ...ownerAdminKeys().filter((k) => !ownerOnlyKeys().includes(k))]);
        capabilities = [...extra];
      }
    }

    const scopes = await loadScopes(membership.id);
    return {
      membership,
      role: role
        ? {
            id: role.id,
            systemKey: role.system_key,
            displayName: role.display_name,
            entryMode: role.entry_mode,
            isBuiltin: role.is_builtin,
          }
        : null,
      capabilities,
      entryMode: role?.entry_mode || 'BOTH',
      sensitivePolicies: role?.sensitivePolicies || {},
      scopes,
    };
  } catch (err) {
    console.warn('[authz] getEffectiveAccess failed closed:', err.message);
    return { membership: null, role: null, capabilities: [], entryMode: 'BOTH', sensitivePolicies: {}, scopes: null };
  }
}
