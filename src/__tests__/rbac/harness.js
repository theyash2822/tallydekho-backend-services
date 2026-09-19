/**
 * RBAC integration harness — auto-provisions fixtures on DATABASE_URL.
 * CI must supply an empty/disposable Postgres (service container).
 * Missing DATABASE_URL in CI / RBAC_INTEGRATION → FAIL (never skip).
 *
 * Phase 3C: reference-counted teardown so multi-file --test-concurrency=1
 * does not close the shared server/pool until the last consumer finishes.
 */
import { initSchema, getPool, recreatePool } from '../../db/schema.js';
import { createApp } from '../../createApp.js';
import { seedAbFixtures } from './fixtures.js';

let shared = null;
let sharedPromise = null;
let refCount = 0;

export function assertRbacDbRequired() {
  if (process.env.RBAC_UNIT_ONLY === '1' && process.env.CI !== 'true') {
    const err = new Error('RBAC_UNIT_ONLY');
    err.code = 'RBAC_UNIT_ONLY';
    throw err;
  }
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is required for RBAC integration tests. CI must provide Postgres; do not skip.'
    );
  }
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = 'rbac-integration-test-secret';
  }
}

async function closeHttpServer(httpServer) {
  await new Promise((resolve) => {
    httpServer.close(() => resolve());
    // Force-close lingering keep-alives so Node can exit
    try {
      httpServer.closeAllConnections?.();
    } catch (_) { /* ignore */ }
  });
}

async function buildHarness() {
  assertRbacDbRequired();
  // Local DBs accumulate hundreds of users/workspaces from prior runs, and
  // reseeding demo data for all of them blows the Node test timeout. Fixtures
  // seed their own CONNECTED workspaces.
  process.env.SKIP_DEMO_SEED = '1';
  // Prior file may have ended the shared pool for clean exit — recreate.
  if (getPool()?.ended) {
    await recreatePool();
  }
  await initSchema();
  const fixtures = await seedAbFixtures();
  const { app, httpServer, io, socketService } = createApp();
  await new Promise((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const { port } = httpServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    fixtures,
    app,
    httpServer,
    io,
    socketService,
    baseUrl,
    async teardown() {
      refCount = Math.max(0, refCount - 1);
      if (refCount > 0) return;
      try {
        if (io) {
          await new Promise((resolve) => {
            try {
              io.close(() => resolve());
            } catch (_) {
              resolve();
            }
            setTimeout(resolve, 500);
          });
        }
        if (httpServer) await closeHttpServer(httpServer);
      } catch (_) { /* ignore */ }
      shared = null;
      sharedPromise = null;
      try {
        await getPool().end();
      } catch (_) { /* ignore */ }
    },
  };
}

/** Shared across test files in one process (use --test-concurrency=1). */
export async function setupRbacHarness() {
  if (!sharedPromise) {
    sharedPromise = buildHarness().then((h) => {
      shared = h;
      return h;
    });
  }
  const h = await sharedPromise;
  refCount += 1;
  return h;
}

export async function httpJson(baseUrl, method, path, { token, headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}
