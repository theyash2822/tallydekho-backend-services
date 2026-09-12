import { query } from '../db/schema.js';
import { getRole } from './roleService.js';

/** Known sensitive field keys masked/hidden across API responses. */
export const SENSITIVE_KEYS = [
  'cost_price',
  'inventory_valuation',
  'margin',
  'bank_balance',
  'cash_balance',
  'credit_limit',
  'tax_identity',
  'purchase_values',
];

const MASK_VALUE = '••••';

/**
 * Resolves the effective visibility ('HIDDEN' | 'MASKED' | 'VISIBLE') for
 * each known sensitive key for a role. Any key without an explicit
 * role_sensitive_policies row defaults to HIDDEN — except for the built-in
 * Owner/Admin system roles, which default to VISIBLE (fail-closed for
 * everyone else, sensible-default for the roles that manage the workspace).
 */
export async function getPolicies(roleId) {
  const policies = {};
  const role = roleId ? await getRole(roleId).catch(() => null) : null;
  const isAdminRole = !!(role && role.system_key === 'ADMIN');
  const fallback = isAdminRole ? 'VISIBLE' : 'HIDDEN';
  for (const key of SENSITIVE_KEYS) policies[key] = fallback;

  if (!roleId) return policies;
  try {
    // Schema uses granted BOOLEAN; map to VISIBLE/HIDDEN for mask helpers.
    const { rows } = await query('SELECT policy_key, granted FROM role_sensitive_policies WHERE role_id = $1', [roleId]);
    for (const row of rows) {
      if (SENSITIVE_KEYS.includes(row.policy_key)) {
        policies[row.policy_key] = row.granted ? 'VISIBLE' : 'HIDDEN';
      }
    }
  } catch (err) {
    // Fail closed on lookup errors — keep the HIDDEN/VISIBLE fallback above,
    // never widen visibility because of a DB hiccup.
  }
  return policies;
}

export async function setPolicy(roleId, policyKey, visibility) {
  const granted = visibility === 'VISIBLE' || visibility === true;
  await query(
    `INSERT INTO role_sensitive_policies (role_id, policy_key, granted) VALUES ($1,$2,$3)
     ON CONFLICT (role_id, policy_key) DO UPDATE SET granted = EXCLUDED.granted`,
    [roleId, policyKey, granted]
  );
}

function maskValue(value) {
  if (value == null) return value;
  if (typeof value === 'number') return null;
  return MASK_VALUE;
}

/**
 * Deep-applies a sensitive-field mask over a JSON-serializable payload.
 * HIDDEN removes the key entirely, MASKED replaces the value, VISIBLE
 * leaves it untouched. Recurses into plain objects and arrays.
 */
export function applyMask(payload, policies = {}) {
  if (Array.isArray(payload)) return payload.map((item) => applyMask(item, policies));
  if (payload && typeof payload === 'object' && payload.constructor === Object) {
    const out = {};
    for (const [key, value] of Object.entries(payload)) {
      if (SENSITIVE_KEYS.includes(key)) {
        const visibility = policies[key] || 'HIDDEN';
        if (visibility === 'HIDDEN') continue;
        out[key] = visibility === 'MASKED' ? maskValue(value) : value;
        continue;
      }
      out[key] = applyMask(value, policies);
    }
    return out;
  }
  return payload;
}
