/**
 * Workspace / RBAS feature flags — ON by product request (2026-09-12).
 * Backend remains fail-closed when enforcement is enabled.
 */
export const FEATURE_FLAGS = {
  workspace_model_enabled: true,
  workspace_header_required: true,
  rbas_enabled: true,
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
  return FEATURE_FLAGS[name] !== false;
}

/** Callable map used by authz/scope/invite services: flags.rbas_enabled() */
export const flags = Object.fromEntries(
  Object.keys(FEATURE_FLAGS).map((k) => [k, () => flag(k)])
);
