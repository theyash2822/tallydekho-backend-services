/**
 * Hard Sync is off on this branch until the staged design (prepare a replacement separately,
 * then publish it in one transaction per company — remediation plan §5.4) replaces the live
 * mark-and-sweep. Every entry point refuses with the same explanation; normal sync is unaffected.
 */
export const HARD_SYNC_UNAVAILABLE = Object.freeze({
  code: 'HARD_SYNC_UNAVAILABLE',
  message: 'Hard Sync is temporarily unavailable while it is rebuilt to prepare data separately before replacing it. Normal sync keeps your books up to date.',
});

export function hardSyncEnabled() {
  return false;
}
