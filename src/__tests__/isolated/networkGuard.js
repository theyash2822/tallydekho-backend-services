/**
 * Outbound-connection guard for isolated tests.
 *
 * Every TCP/TLS connection in the process goes through net.Socket#connect
 * (pg, http/https, undici fetch, socket.io clients). The guard rejects any
 * destination that is not explicitly owned by the test before a socket is
 * opened or a DNS lookup happens. Loopback is NOT allowed wholesale: the
 * owner's real backend also listens on 127.0.0.1.
 */
import net from 'node:net';

export class NetworkGuardError extends Error {
  constructor(target) {
    super(`[network-guard] blocked outbound connection to ${target}`);
    this.code = 'NETWORK_GUARD';
  }
}

const allowed = new Set();
const blockedLog = [];
let original = null;

function describe(args) {
  const [a, b] = args;
  if (Array.isArray(a)) return describe(a);
  if (a && typeof a === 'object') {
    if (a.path) return { key: `unix:${a.path}`, label: `unix:${a.path}` };
    const host = a.host || 'localhost';
    return { key: `${host}:${a.port}`, label: `${host}:${a.port}` };
  }
  if (typeof a === 'string' && Number.isNaN(Number(a))) return { key: `unix:${a}`, label: `unix:${a}` };
  const host = typeof b === 'string' ? b : 'localhost';
  return { key: `${host}:${a}`, label: `${host}:${a}` };
}

/** Allow exactly one host:port (or unix socket path) owned by the test. */
export function allowEndpoint(host, port) {
  if (port === undefined) allowed.add(`unix:${host}`);
  else allowed.add(`${host}:${port}`);
}

export function blockedAttempts() {
  return blockedLog.slice();
}

export function installNetworkGuard({ allow = [] } = {}) {
  for (const [h, p] of allow) allowEndpoint(h, p);
  if (original) return;
  original = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const { key, label } = describe(args);
    if (!allowed.has(key)) {
      blockedLog.push(label);
      throw new NetworkGuardError(label);
    }
    return original.apply(this, args);
  };
}

export function uninstallNetworkGuard() {
  if (!original) return;
  net.Socket.prototype.connect = original;
  original = null;
  allowed.clear();
}
