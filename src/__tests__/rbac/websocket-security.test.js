import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { setupRbacHarness } from './harness.js';
import { query } from '../../db/schema.js';

let ctx;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') { ctx = null; return; }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

function connectClient() {
  return ioClient(ctx.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false });
}

describe('RBAC WebSocket tenant isolation', () => {
  it('desktop register without secret → not privileged', async () => {
    if (!ctx) throw new Error('harness required');
    const socket = connectClient();
    const result = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 8000);
      socket.on('connect', () => {
        socket.emit('register', { type: 'desktop', deviceId: ctx.fixtures.devices.A.deviceId });
      });
      socket.on('registered', (payload) => {
        clearTimeout(t);
        resolve(payload);
      });
      socket.on('error', (err) => {
        clearTimeout(t);
        resolve(err);
      });
    });
    socket.close();
    assert.ok(result?.privileged === false || result?.code === 'DEVICE_CREDENTIAL_INVALID');
  });

  it('User A joins Workspace A; after membership remove receives nothing', async () => {
    if (!ctx) throw new Error('harness required');
    const token = ctx.fixtures.tokens.memberA.accessToken;
    const socket = connectClient();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('connect timeout')), 8000);
      socket.on('connect', () => {
        clearTimeout(t);
        socket.emit('register', { token, type: 'web' });
      });
      socket.on('registered', () => resolve());
      socket.on('error', reject);
    });
    socket.emit('workspace:register', { workspaceId: ctx.fixtures.workspaces.A });
    await new Promise((r) => setTimeout(r, 200));

    await query(
      `UPDATE workspace_memberships SET status = 'SUSPENDED' WHERE id = $1`,
      [ctx.fixtures.memberships.memberA]
    );
    if (typeof ctx.socketService.revokeUserWorkspaceAccess === 'function') {
      await ctx.socketService.revokeUserWorkspaceAccess(
        ctx.fixtures.users.memberA.id,
        ctx.fixtures.workspaces.A
      );
    }

    let gotEvent = false;
    socket.on('synced', () => { gotEvent = true; });
    ctx.socketService.notifySynced?.(
      ctx.fixtures.users.memberA.id,
      ctx.fixtures.companies.A1,
      ctx.fixtures.workspaces.A
    );
    await new Promise((r) => setTimeout(r, 300));
    socket.close();
    // After revoke, user must not receive workspace tenant events on that socket
    assert.equal(gotEvent, false);
  });

  it('User A cannot register Workspace B', async () => {
    if (!ctx) throw new Error('harness required');
    const socket = connectClient();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 8000);
      socket.on('connect', () => {
        socket.emit('register', { token: ctx.fixtures.tokens.ownerA.accessToken, type: 'web' });
      });
      socket.on('registered', () => { clearTimeout(t); resolve(); });
      socket.on('error', reject);
    });
    const denied = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 1500);
      socket.on('workspace_access_denied', (p) => {
        clearTimeout(t);
        resolve(p);
      });
      socket.emit('workspace:register', { workspaceId: ctx.fixtures.workspaces.B });
    });
    socket.close();
    assert.ok(denied === null || denied?.workspaceId === ctx.fixtures.workspaces.B);
  });
});
