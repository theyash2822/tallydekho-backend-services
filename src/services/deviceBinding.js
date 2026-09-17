/**
 * Backward-compatible re-exports — prefer workspacePairingService.js for new code.
 */
export {
  BindingError,
  pairDeviceToWorkspace,
  unpairDevice,
  unpairWorkspace,
  markFirstSyncConnected,
  getKnownLineageGuids,
  getConnectionStatus,
  resolveWorkspaceDataMode,
  buildTallyStatusPayload,
  getTallyActionFlags,
  createPairingSession,
  approvePairing,
  claimPairingCredential,
  acknowledgePairingCredential,
} from './workspacePairingService.js';
