/**
 * TallyDekho — Critical Backend Integration Tests
 *
 * Uses Node.js built-in test runner (node:test, available in Node 18+).
 * Run with: node --test src/__tests__/critical.test.js
 *
 * Requires the backend to be running. Set BASE_URL env var if not using default.
 * e.g. BASE_URL=http://localhost:3001 node --test src/__tests__/critical.test.js
 *
 * Note: If you prefer Jest, install it first:
 *   npm install --save-dev jest
 * Then run: npx jest src/__tests__/critical.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

// Axios instance that never throws on 4xx/5xx — we want to inspect status codes
const http = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true,     // always resolve, never reject on HTTP errors
  timeout: 10_000,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. Auth: POST /api/auth/send-otp — returns success with a valid phone number
// ─────────────────────────────────────────────────────────────────────────────
test('POST /api/auth/send-otp — returns success with valid phone', async () => {
  const res = await http.post('/api/auth/send-otp', { phone: '+919876543210' });

  assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.data)}`);
  assert.equal(res.data.success, true, 'Response should have success: true');
  assert.ok(res.data.data?.message, 'Response data should have a message field');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Auth: POST /api/auth/verify-otp — returns 4xx with a wrong OTP
// ─────────────────────────────────────────────────────────────────────────────
test('POST /api/auth/verify-otp — returns 4xx with wrong OTP', async () => {
  const res = await http.post('/api/auth/verify-otp', {
    phone: '+919876543210',
    otp: '0000',   // definitely wrong
  });

  assert.ok(
    res.status >= 400 && res.status < 500,
    `Expected 4xx status, got ${res.status}: ${JSON.stringify(res.data)}`
  );
  assert.equal(res.data.success, false, 'Response should have success: false');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pairing: GET /api/tally-sync/status — returns 401 without auth token
// ─────────────────────────────────────────────────────────────────────────────
test('GET /api/tally-sync/status — returns 401 without token', async () => {
  const res = await http.get('/api/tally-sync/status');

  assert.equal(
    res.status, 401,
    `Expected 401, got ${res.status}: ${JSON.stringify(res.data)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Data: POST /app/dashboard — returns 4xx when device not paired
//    (hits the /app/ route which checks for pairing via device-id header)
// ─────────────────────────────────────────────────────────────────────────────
test('POST /app/dashboard — returns 4xx when device not paired', async () => {
  // No device-id header → device lookup will find no user → 403
  const res = await http.post('/app/dashboard', {
    companyGuid: 'nonexistent-guid',
  }, {
    headers: {
      'device-id': 'test-device-that-does-not-exist',
      'Content-Type': 'application/json',
    }
  });

  assert.ok(
    res.status >= 400 && res.status < 500,
    `Expected 4xx status (unpaired device), got ${res.status}: ${JSON.stringify(res.data)}`
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Ingest: POST /ingest/init — returns 4xx / error without device-id header
//    The route itself should still accept (no auth), but downstream queries
//    need device-id. We test that omitting it doesn't crash the server (500)
//    and either returns a 400/error shape or succeeds gracefully.
// ─────────────────────────────────────────────────────────────────────────────
test('POST /ingest/init — handles missing device-id header gracefully', async () => {
  const res = await http.post('/ingest/init', {});

  // The route may return 200 with uploadId (no strict auth) or 4xx/5xx
  // Key invariant: server must NOT crash (no unhandled 5xx from missing header)
  // Accept 200 (graceful) or 4xx (rejected). Reject 5xx.
  assert.ok(
    res.status < 500,
    `Server should not return 5xx for missing device-id, got ${res.status}: ${JSON.stringify(res.data)}`
  );
});
