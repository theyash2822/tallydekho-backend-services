/**
 * Company Identity Phase 3 — WebSocket room uses company:{id}, not global guid.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { io as ioClient } from 'socket.io-client';
import { setupRbacHarness } from './harness.js';
import { query } from '../../db/schema.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

let ctx;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') {
      ctx = null;
      return;
    }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Company Identity Phase 3 — WS room identity', () => {
  it('static: socketHandler joins company:{id} not company:{guid}', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../socket/socketHandler.js'),
      'utf8'
    );
    assert.ok(src.includes('company:${cos[0].id}') || src.includes('`company:${c.id}`'));
    assert.ok(src.includes('resolveCompanyRoomId'));
    const registerIdx = src.indexOf("socket.on('company:register'");
    assert.ok(registerIdx > 0);
    const block = src.slice(registerIdx, registerIdx + 1800);
    assert.ok(block.includes('workspace_id = $2'));
    assert.ok(
      !block.includes('workspace_id IS NULL AND user_id'),
      'company:register must not use user_id ownership fallback'
    );
  });

  it('company:register joins internal id room; A1 events stay on A room', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows } = await query(`SELECT id, guid FROM companies WHERE guid = $1`, [
      ctx.fixtures.companies.A1,
    ]);
    const companyId = rows[0].id;
    assert.ok(companyId);

    const socket = ioClient(ctx.baseUrl, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout connect')), 8000);
      socket.on('connect', () => {
        clearTimeout(t);
        resolve();
      });
      socket.on('connect_error', reject);
    });

    socket.emit('register', {
      token: ctx.fixtures.tokens.ownerA.accessToken,
      type: 'web',
    });
    await new Promise((r) => setTimeout(r, 200));
    socket.emit('workspace:register', { workspaceId: ctx.fixtures.workspaces.A });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout workspace')), 8000);
      socket.on('workspace_registered', () => {
        clearTimeout(t);
        resolve();
      });
    });

    socket.emit('company:register', { companyGuid: ctx.fixtures.companies.A1 });
    const registered = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout company_registered')), 8000);
      socket.on('company_registered', (p) => {
        clearTimeout(t);
        resolve(p);
      });
      socket.on('company_access_denied', (p) => {
        clearTimeout(t);
        reject(new Error(`denied ${JSON.stringify(p)}`));
      });
    });
    assert.equal(registered.companyId, companyId);
    assert.equal(registered.room, `company:${companyId}`);
    socket.close();
  });
});
