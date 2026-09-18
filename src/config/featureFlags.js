/**
 * Workspace feature flags.
 * Known keys below are ON. Unknown keys default OFF (Wave 4 fail-closed).
 * RBAC is mandatory infrastructure — there is no rbas_enabled kill-switch.
 */
export const FEATURE_FLAGS = {
  workspace_model_enabled: true,
  workspace_header_required: true,
  member_invites_enabled: true,
  scope_company_enabled: true,
  scope_fy_enabled: true,
  scope_ledger_enabled: true,
  scope_godown_enabled: true,
  scope_cost_centre_enabled: true,
  sensitive_policy_enabled: true,
  workspace_device_routing_enabled: true,
  cloud_backup_enabled: true,
  restore_sessions_enabled: true,
  hard_sync_approval_enabled: true,
};

export function flag(name) {
  return FEATURE_FLAGS[name] === true;
}

/** Callable map used by authz/scope/invite services */
export const flags = Object.fromEntries(
  Object.keys(FEATURE_FLAGS).map((k) => [k, () => flag(k)])
);
