/** Thin socket handle for workspace lifecycle events (avoids circular imports). */
let _sock = null;

export function setWorkspaceSocket(svc) {
  _sock = svc || null;
}

export function getWorkspaceSocket() {
  return _sock;
}
