import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness, httpJson } from './harness.js';

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

describe('RBAC device credential + upload ownership', () => {
  it('valid device-id missing secret → denied on ingest init', async () => {
    if (!ctx) throw new Error('harness required');
    const { status, json } = await httpJson(ctx.baseUrl, 'POST', '/ingest/init', {
      headers: { 'device-id': ctx.fixtures.devices.A.deviceId },
      body: {},
    });
    assert.equal(status, 401);
    assert.equal(json?.code, 'DEVICE_CREDENTIAL_INVALID');
  });

  it('wrong secret → denied', async () => {
    if (!ctx) throw new Error('harness required');
    const { status } = await httpJson(ctx.baseUrl, 'POST', '/ingest/init', {
      headers: {
        'device-id': ctx.fixtures.devices.A.deviceId,
        'x-device-secret': 'totally-wrong-secret',
      },
      body: {},
    });
    assert.equal(status, 401);
  });

  it('Device A secret + Device B id → denied', async () => {
    if (!ctx) throw new Error('harness required');
    const { status } = await httpJson(ctx.baseUrl, 'POST', '/ingest/init', {
      headers: {
        'device-id': ctx.fixtures.devices.B.deviceId,
        'x-device-secret': ctx.fixtures.devices.A.secret,
      },
      body: {},
    });
    assert.equal(status, 401);
  });

  it('valid credentials → ingest init; Device B cannot chunk uploadId A', async () => {
    if (!ctx) throw new Error('harness required');
    const init = await httpJson(ctx.baseUrl, 'POST', '/ingest/init', {
      headers: {
        'device-id': ctx.fixtures.devices.A.deviceId,
        'x-device-secret': ctx.fixtures.devices.A.secret,
      },
      body: {},
    });
    assert.ok(init.status === 200 || init.status === 201);
    const uploadId = init.json?.uploadId || init.json?.data?.uploadId || init.json?.id;
    assert.ok(uploadId, 'uploadId required from init');

    const hijack = await fetch(`${ctx.baseUrl}/ingest/chunk`, {
      method: 'POST',
      headers: {
        'device-id': ctx.fixtures.devices.B.deviceId,
        'x-device-secret': ctx.fixtures.devices.B.secret,
        'upload-id': String(uploadId),
        'stream-name': 'ledgers',
        'chunk-index': '0',
        'content-type': 'application/octet-stream',
      },
      body: Buffer.from('{"GUID":"x","COMPANY_GUID":"y"}'),
    });
    assert.ok(
      hijack.status === 401 || hijack.status === 403,
      `expected ownership deny, got ${hijack.status}`
    );
  });
});
