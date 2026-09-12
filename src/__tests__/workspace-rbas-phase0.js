/**
 * Phase 0 notes — Workspace/RBAS (Mobile agent ownership)
 *
 * Baseline SHAs (recorded before this expand):
 *   Mobile:  776fc30569e5f208d6d63a04a9084d1ac4b8bdf5 (cursor)
 *   Backend: 09e4c3505c38bd8f4ab3936f5a3969eed37f9dc9 (cursor)
 *
 * Scope: Mobile + mobile-related Backend. Desktop/Web Portal owned by other agents.
 * All Universal phases 0–18; feature flags ON for cursor builds.
 *
 * Inventory (raw API bypasses on Mobile):
 *   - AuthContext bootstrap may use getMe / status outside central api.ts
 *   - barcode template / postWithToken helpers
 *   - After this work: all authenticated business calls must send X-Workspace-Id via api.ts
 *
 * Customer actions inventory: see Mobile handoff §15–27 (navigation, entry mode, invites,
 * pair/unpair Owner/Admin, Hard Sync/Restore approvals, GST activate Owner/Admin).
 *
 * Capability catalogue aligned to Universal §22 — no generic voucher edit/delete/cancel.
 */

export const PHASE0_SHAS = {
  mobile: '776fc30569e5f208d6d63a04a9084d1ac4b8bdf5',
  backend: '09e4c3505c38bd8f4ab3936f5a3969eed37f9dc9',
};
