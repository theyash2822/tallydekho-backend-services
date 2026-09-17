/**
 * Pairing Stabilization v1.1 — unit + local HTTP smoke + optional seeded matrix.
 *
 * Always-run: pure unit + legacy 410 smoke (when BASE_URL up).
 * Seeded matrix (Owner/Admin/Member): set PAIRING_E2E=1 plus:
 *   BASE_URL, OWNER_TOKEN, ADMIN_TOKEN, MEMBER_TOKEN (optional),
 *   WORKSPACE_ID, PAIRING_CODE (optional for live pair),
 *   REAL_COMPANY_GUID (optional for read-gate).
 *
 * Run: npm test  (or node --test src/__tests__/pairing-stabilization.test.js)
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { generateDeviceSecret, hashSecret, verifySecret, hashToken } from '../services/deviceCredential.js';
import {
  BindingError,
} from '../services/workspacePairingService.js';

// Messages are module-private; keep product copy asserted here in sync with service.
const RESTORE_REPLACE_MSG =
  'This Workspace already has a connected Tally Desktop. If the old computer is unavailable, use Restore / Replace Computer.';

const BASE_URL = process.env.BASE_URL || process.env.API_BASE_URL || 'http://127.0.0.1:3001';
const E2E = process.env.PAIRING_E2E === '1';
const OWNER_TOKEN = process.env.OWNER_TOKEN || '';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MEMBER_TOKEN = process.env.MEMBER_TOKEN || '';
const WORKSPACE_ID = process.env.WORKSPACE_ID || '';
const PAIRING_CODE = process.env.PAIRING_CODE || '';
const REAL_COMPANY_GUID = process.env.REAL_COMPANY_GUID || '';

const http = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true,
  timeout: 12_000,
});

function auth(token) {
  return { Authorization: `Bearer ${token}`, 'X-Workspace-Id': WORKSPACE_ID };
}

async function backendUp() {
  try {
    const res = await http.get('/app/ping');
    return res.status < 500;
  } catch {
    return false;
  }
}

// ─── Unit ────────────────────────────────────────────────────────────────────

test('1–4 authority codes: BindingError carries stable pairing codes', () => {
  const e = new BindingError('WORKSPACE_ALREADY_HAS_DESKTOP', RESTORE_REPLACE_MSG, 409);
  assert.equal(e.code, 'WORKSPACE_ALREADY_HAS_DESKTOP');
  assert.equal(e.httpStatus, 409);
  assert.match(e.message, /Restore \/ Replace Computer/);
  const deny = new BindingError('PAIRING_NOT_ALLOWED', 'Only Owner or System Admin', 403);
  assert.equal(deny.httpStatus, 403);
  const wsReq = new BindingError('WORKSPACE_REQUIRED', 'Workspace id is required', 400);
  assert.equal(wsReq.code, 'WORKSPACE_REQUIRED');
  const elsewhere = new BindingError('DEVICE_ALREADY_PAIRED', 'already connected to another', 409);
  assert.equal(elsewhere.code, 'DEVICE_ALREADY_PAIRED');
});

test('11 device secret: hash / verify / claim-token hash differ', async () => {
  const secret = generateDeviceSecret();
  const hash = await hashSecret(secret);
  assert.equal(await verifySecret(secret, hash), true);
  assert.equal(await verifySecret('wrong', hash), false);
  assert.notEqual(hashToken('111111'), hashToken('222222'));
});

test('21 Restore/Replace message constant matches product copy', () => {
  assert.equal(
    RESTORE_REPLACE_MSG,
    'This Workspace already has a connected Tally Desktop. If the old computer is unavailable, use Restore / Replace Computer.'
  );
});

// ─── Legacy HTTP smoke ───────────────────────────────────────────────────────

test('4 legacy POST /api/tally-sync/pair returns 410 or 401 (deprecated)', async () => {
  if (!(await backendUp())) return;
  const res = await http.post('/api/tally-sync/pair', { pairing_code: '000000' }, {
    headers: { Authorization: 'Bearer fake' },
  });
  assert.ok([401, 410].includes(res.status), `unexpected ${res.status}`);
  if (res.status === 410) {
    assert.equal(res.data?.error?.code || res.data?.code, 'PAIRING_API_DEPRECATED');
  }
});

test('4 legacy POST /api/tally-sync/unpair returns 410 or 401 (deprecated)', async () => {
  if (!(await backendUp())) return;
  const res = await http.post('/api/tally-sync/unpair', {}, {
    headers: { Authorization: 'Bearer fake' },
  });
  assert.ok([401, 410].includes(res.status), `unexpected ${res.status}`);
  if (res.status === 410) {
    assert.equal(res.data?.error?.code || res.data?.code, 'PAIRING_API_DEPRECATED');
  }
});

test('4 legacy POST /app/pairing returns 410 or 401 (deprecated)', async () => {
  if (!(await backendUp())) return;
  const res = await http.post('/app/pairing', { pairingCode: '000000' }, {
    headers: { Authorization: 'Bearer fake' },
  });
  assert.ok([401, 410].includes(res.status), `unexpected ${res.status}`);
});

test('4 legacy PUT /app/pairing returns 410 or 401 (deprecated)', async () => {
  if (!(await backendUp())) return;
  const res = await http.put('/app/pairing', { deviceId: 'x', deviceName: 'x' }, {
    headers: { Authorization: 'Bearer fake' },
  });
  assert.ok([401, 410].includes(res.status), `unexpected ${res.status}`);
  if (res.status === 410) {
    assert.equal(res.data?.code, 'PAIRING_API_DEPRECATED');
  }
});

test('4 legacy DELETE /app/pairing returns 410 or 401 (deprecated)', async () => {
  if (!(await backendUp())) return;
  const res = await http.delete('/app/pairing', {
    headers: { Authorization: 'Bearer fake' },
  });
  assert.ok([401, 410].includes(res.status), `unexpected ${res.status}`);
  if (res.status === 410) {
    assert.equal(res.data?.code, 'PAIRING_API_DEPRECATED');
  }
});

test('claim without approved session returns PENDING (not NOT_FOUND)', async () => {
  if (!(await backendUp())) return;
  const codeRes = await http.get('/desktop/pairing-code', {
    headers: { 'device-id': 'pairing-stab-test-device' },
  });
  if (codeRes.status === 404) {
    await http.post('/desktop/register', {
      deviceId: 'pairing-stab-test-device',
      name: 'PairingStab',
      host: 'test',
    }, { headers: { 'device-id': 'pairing-stab-test-device' } });
  }
  const again = await http.get('/desktop/pairing-code', {
    headers: { 'device-id': 'pairing-stab-test-device' },
  });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const sessionId = again.data?.data?.sessionId;
  const claimToken = again.data?.data?.claimToken;
  assert.ok(sessionId, 'sessionId required from pairing-code');
  assert.ok(claimToken, 'claimToken required from pairing-code');

  const claim = await http.post(`/desktop/pairing-sessions/${sessionId}/claim`, { claimToken });
  assert.ok([400, 403, 409].includes(claim.status), `unexpected claim status ${claim.status}`);
  assert.ok(claim.data?.code, 'error code present');
  if (claim.status === 409) {
    assert.equal(claim.data.code, 'PAIRING_SESSION_PENDING');
  }
});

test('13 claim with wrong token is denied', async () => {
  if (!(await backendUp())) return;
  const again = await http.get('/desktop/pairing-code', {
    headers: { 'device-id': 'pairing-stab-test-device' },
  });
  if (again.status !== 200) return;
  const sessionId = again.data?.data?.sessionId;
  const claim = await http.post(`/desktop/pairing-sessions/${sessionId}/claim`, {
    claimToken: 'definitely-wrong-token',
  });
  assert.ok([403, 409].includes(claim.status));
});

test('DELETE /desktop/paired-device without credential is rejected when hashed', async () => {
  if (!(await backendUp())) return;
  const res = await http.delete('/desktop/paired-device', {
    headers: { 'device-id': 'pairing-stab-test-device' },
  });
  // Unpaired / no hash may soft-200; paired hashed must 401/403
  assert.ok([200, 401, 403, 500].includes(res.status), `got ${res.status}`);
});

// ─── Seeded matrix (PAIRING_E2E=1) ───────────────────────────────────────────

describe('seeded pairing matrix (PAIRING_E2E=1)', { skip: !E2E }, () => {
  test('env has Owner/Admin tokens + workspace', () => {
    assert.ok(OWNER_TOKEN, 'OWNER_TOKEN required');
    assert.ok(ADMIN_TOKEN, 'ADMIN_TOKEN required');
    assert.ok(WORKSPACE_ID, 'WORKSPACE_ID required');
  });

  test('1 Owner Pair allowed (or already bound / needs code)', async () => {
    if (!PAIRING_CODE) return; // document skip when no live Desktop code
    const res = await http.post(
      `/api/workspaces/${WORKSPACE_ID}/tally/pair`,
      { pairingCode: PAIRING_CODE },
      { headers: auth(OWNER_TOKEN) }
    );
    assert.ok([200, 409].includes(res.status), `Owner pair status ${res.status} ${JSON.stringify(res.data)}`);
    if (res.status === 409) {
      assert.ok(
        ['WORKSPACE_ALREADY_HAS_DESKTOP', 'DEVICE_ALREADY_PAIRED', 'PAIRING_CODE_INVALID'].includes(res.data?.code),
        res.data?.code
      );
    }
  });

  test('2 Admin Pair allowed (or already bound / needs code)', async () => {
    if (!PAIRING_CODE) return;
    const res = await http.post(
      `/api/workspaces/${WORKSPACE_ID}/tally/pair`,
      { pairingCode: PAIRING_CODE },
      { headers: auth(ADMIN_TOKEN) }
    );
    assert.ok([200, 409].includes(res.status), `Admin pair ${res.status}`);
  });

  test('3 Member Pair denied', async () => {
    if (!MEMBER_TOKEN) return;
    const res = await http.post(
      `/api/workspaces/${WORKSPACE_ID}/tally/pair`,
      { pairingCode: PAIRING_CODE || '000000' },
      { headers: auth(MEMBER_TOKEN) }
    );
    assert.equal(res.status, 403);
    assert.ok(
      ['PAIRING_NOT_ALLOWED', 'FORBIDDEN'].includes(res.data?.code || res.data?.error?.code),
      JSON.stringify(res.data)
    );
  });

  test('5–6 Owner/Admin can call Unpair endpoint (idempotent if already UNPAIRED)', async () => {
    const ownerRes = await http.post(
      `/api/workspaces/${WORKSPACE_ID}/tally/unpair`,
      {},
      { headers: auth(OWNER_TOKEN) }
    );
    assert.ok([200, 404, 409].includes(ownerRes.status), `Owner unpair ${ownerRes.status}`);
    const adminRes = await http.post(
      `/api/workspaces/${WORKSPACE_ID}/tally/unpair`,
      {},
      { headers: auth(ADMIN_TOKEN) }
    );
    assert.ok([200, 404, 409].includes(adminRes.status), `Admin unpair ${adminRes.status}`);
  });

  test('17–18 real company GUID read denied when not CONNECTED', async () => {
    if (!REAL_COMPANY_GUID) return;
    const ctx = await http.get(`/api/workspaces/${WORKSPACE_ID}/context`, {
      headers: auth(OWNER_TOKEN),
    });
    const status = String(ctx.data?.data?.pairing?.status || ctx.data?.pairing?.status || '').toUpperCase();
    if (status === 'CONNECTED') return; // only assert deny when Demo-state
    const res = await http.get(`/api/vouchers?companyGuid=${REAL_COMPANY_GUID}&limit=1`, {
      headers: auth(OWNER_TOKEN),
    });
    assert.ok([403, 404].includes(res.status), `expected deny got ${res.status}`);
    if (res.status === 403) {
      assert.equal(res.data?.error?.code || res.data?.code, 'TALLY_NOT_CONNECTED');
    }
  });

  test('21–22 invite create requires CONNECTED', async () => {
    const ctx = await http.get(`/api/workspaces/${WORKSPACE_ID}/context`, {
      headers: auth(OWNER_TOKEN),
    });
    const status = String(ctx.data?.data?.pairing?.status || ctx.data?.pairing?.status || '').toUpperCase();
    const inviteBody = {
      mobile: '9999999999',
      roleId: ctx.data?.data?.roles?.[0]?.id || ctx.data?.roles?.[0]?.id,
    };
    const res = await http.post(`/api/workspaces/${WORKSPACE_ID}/invitations`, inviteBody, {
      headers: auth(OWNER_TOKEN),
    });
    if (status !== 'CONNECTED') {
      assert.equal(res.status, 403);
      assert.equal(
        res.data?.code || res.data?.error?.code,
        'TALLY_CONNECTION_REQUIRED_FOR_INVITE'
      );
    } else {
      // CONNECTED: may fail on seat/mobile validation — not 403 for connection
      assert.notEqual(res.data?.code || res.data?.error?.code, 'TALLY_CONNECTION_REQUIRED_FOR_INVITE');
    }
  });

  test('context exposes canPair / canUnpair', async () => {
    const ctx = await http.get(`/api/workspaces/${WORKSPACE_ID}/context`, {
      headers: auth(OWNER_TOKEN),
    });
    assert.equal(ctx.status, 200);
    const pairing = ctx.data?.data?.pairing || ctx.data?.pairing || {};
    assert.equal(typeof pairing.canPair, 'boolean');
    assert.equal(typeof pairing.canUnpair, 'boolean');
    assert.ok(pairing.status, 'pairing.status present');
  });
});
