/**
 * Mount real application routers on a test-owned loopback port (isolated DB only).
 * The port is registered with the network guard; nothing else is reachable.
 */
import express from 'express';
import { allowEndpoint } from './networkGuard.js';

export async function startRouteHarness(mounts) {
  const app = express();
  // Same body handling as server.js: chunk uploads arrive raw.
  app.use('/ingest/chunk', express.raw({ type: '*/*', limit: '50mb' }));
  app.use(express.json({ limit: '5mb' }));
  for (const [prefix, router] of mounts) app.use(prefix, router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  allowEndpoint('127.0.0.1', port);
  const call = async (method, path, { body, raw, headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': raw !== undefined ? 'application/x-ndjson' : 'application/json', ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch { /* empty */ }
    return { status: res.status, body: json };
  };
  return { call, close: () => new Promise((r) => server.close(r)) };
}

/** Synthetic owner + workspace + company + paired device with a real hashed secret. */
export async function seedWorkspace(q, uniq) {
  const { hashSecret } = await import('../../services/deviceCredential.js');
  const { createAuthSession } = await import('../../services/authSessionService.js');
  const mobile = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const { rows: u } = await q(`INSERT INTO users (mobile, name) VALUES ($1, 'Synthetic Owner') RETURNING id`, [mobile]);
  const userId = u[0].id;
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name, owner_user_id) VALUES ($1, 'Synthetic WS', $2)`, [workspaceId, userId]);
  await q(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, status) VALUES ($1,$2,$3,'OWNER','ACTIVE')`,
    [uniq('wm'), workspaceId, userId]
  );
  const companyGuid = uniq('co');
  const { rows: c } = await q(
    `INSERT INTO companies (guid, name, workspace_id, is_active) VALUES ($1, 'Synthetic Co', $2, TRUE) RETURNING id`,
    [companyGuid, workspaceId]
  );
  const deviceId = uniq('dev');
  const deviceSecret = `secret-${uniq('s')}`;
  await q(
    `INSERT INTO devices (device_id, paired, workspace_id, binding_status, device_secret_hash, last_seen)
     VALUES ($1, TRUE, $2, 'ACTIVE', $3, EXTRACT(EPOCH FROM NOW())::BIGINT)`,
    [deviceId, workspaceId, await hashSecret(deviceSecret)]
  );
  const session = await createAuthSession(userId, { clientType: 'test' });
  return {
    userId, workspaceId, companyGuid, companyId: c[0].id, deviceId,
    userHeaders: { authorization: `Bearer ${session.accessToken}` },
    deviceHeaders: { 'x-device-id': deviceId, 'x-device-secret': deviceSecret },
  };
}
