/**
 * RBAC Phase 7 — legacy auth observation must be answerable from data.
 *
 * stdout-only logging cannot prove "zero legitimate legacy usage today", so the
 * counters and their safety properties are pinned here: no secrets, no PII, and
 * telemetry can never break an auth response.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import {
  LEGACY_EVENTS,
  carriesOurCredential,
  credentialState,
  isLegitimateLegacyUse,
  legacyEventFromRequest,
} from '../services/legacyAuthTelemetry.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('legacy auth telemetry', () => {
  it('covers both legacy surfaces: sessionless JWT and /app auth', () => {
    assert.equal(LEGACY_EVENTS.JWT_ACCEPTED, 'LEGACY_JWT_ACCEPTED');
    assert.equal(LEGACY_EVENTS.JWT_REJECTED, 'LEGACY_JWT_REJECTED');
    assert.equal(LEGACY_EVENTS.APP_AUTH_HIT, 'LEGACY_APP_AUTH_HIT');

    const mw = read('middleware/auth.js');
    assert.match(mw, /recordLegacyAuthEvent\(LEGACY_EVENTS\.JWT_REJECTED/);
    assert.match(mw, /recordLegacyAuthEvent\(LEGACY_EVENTS\.JWT_ACCEPTED/);

    // Every /app/* auth hit must be counted, not just the OTP endpoints.
    const appAuth = read('routes/auth.js');
    assert.match(appAuth, /router\.use\(\(req, _res, next\) => \{\s*void recordLegacyAuthEvent\(LEGACY_EVENTS\.APP_AUTH_HIT, req\)/);
  });

  it('only server-verified evidence blocks a clean day', () => {
    // This decides whether a production day counts as clean, so the policy is
    // pinned exhaustively rather than by example. Changing this table changes what
    // "seven clean days" means.
    const cases = [
      ['verified', true, 'a token we minted, or a login that actually completed'],
      ['invalid', false, 'a token was presented and failed — not our client'],
      ['absent', false, 'nothing the server could verify'],
      [true, true, 'boolean form used by call sites holding proof'],
      [false, false, 'boolean form'],
      [undefined, false, 'default must be non-blocking'],
    ];

    for (const [evidence, expected, why] of cases) {
      assert.equal(
        isLegitimateLegacyUse(evidence),
        expected,
        `evidence=${evidence} should be ${expected}: ${why}`
      );
    }
  });

  it('client headers cannot move the gate in either direction', () => {
    // Two bugs lived here in turn. First headers were the ONLY signal, and since
    // no shipped client sends them, every genuine legacy request scored
    // non-blocking — seven clean days would have been certified vacuously. Then
    // headers became sufficient, which let anyone jam the cutover with two header
    // lines. isLegitimateLegacyUse now takes no header argument at all, so neither
    // failure can return: the signature itself forbids it.
    assert.match(
      read('services/legacyAuthTelemetry.js'),
      /export function isLegitimateLegacyUse\(evidence = 'absent'\)/,
      'evidence is the only input; no platform or version parameter'
    );

    // A real client withholding everything still blocks, on server evidence alone.
    assert.equal(isLegitimateLegacyUse('verified'), true);
    // A stranger sending anything at all still does not.
    assert.equal(isLegitimateLegacyUse('invalid'), false);
    assert.equal(isLegitimateLegacyUse('absent'), false);
  });

  it('a completed legacy login is recorded as evidence at every success point', () => {
    // These are the unauthenticated routes, where no credential exists yet. Without
    // a hook at the success point, a real client logging in through the legacy
    // surface would be indistinguishable from a scanner probing it.
    const appAuth = read('routes/auth.js');

    // /app/verify-otp — both branches issue a credential once the OTP matched.
    const otpHooks = appAuth.match(
      /recordLegacyAuthEvent\(LEGACY_EVENTS\.LOGIN_SUCCESS, req, \{ serverVerified: true \}\)/g
    );
    assert.ok(
      otpHooks && otpHooks.length >= 3,
      'expected success hooks on the 2FA branch, the full-token branch, and /app/verify'
    );

    // The hook must sit after the OTP check, otherwise a wrong OTP would count.
    const otpCheck = appAuth.indexOf("user.otp !== String(otp)");
    const firstHook = appAuth.indexOf('LEGACY_EVENTS.LOGIN_SUCCESS');
    assert.ok(otpCheck > -1 && firstHook > otpCheck, 'success must follow OTP verification');

    // /app/verify takes its token in the body, so the Authorization-header check
    // cannot see it and a genuine client would otherwise score unattributable.
    const verifyRoute = appAuth.slice(appAuth.indexOf("router.post('/verify'"));
    assert.match(
      verifyRoute.slice(0, 1200),
      /jwt\.verify\([\s\S]*LEGACY_EVENTS\.LOGIN_SUCCESS/,
      '/app/verify must record success after verifying the body token'
    );
  });

  it('telemetry cannot break a login', () => {
    // Every call site is fire-and-forget, and the recorder swallows its own
    // failures. A telemetry outage must never turn into a failed sign-in.
    const appAuth = read('routes/auth.js');
    const mw = read('middleware/auth.js');
    for (const [name, src] of [['routes/auth.js', appAuth], ['middleware/auth.js', mw]]) {
      const calls = src.match(/^\s*(void )?recordLegacyAuthEvent\(/gm) || [];
      assert.ok(calls.length > 0, `${name} should record legacy events`);
      for (const call of calls) {
        assert.match(call, /void /, `${name}: every call must be fire-and-forget`);
      }
    }
    const svc = read('services/legacyAuthTelemetry.js');
    assert.match(svc, /catch \(err\) \{[\s\S]*console\.warn/, 'recorder must swallow failures');
  });

  it('only our own signing key can mark a request identified', () => {
    const prev = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret-for-telemetry';
    try {
      const ours = jwt.sign({ userId: 1 }, process.env.JWT_SECRET);
      const forged = jwt.sign({ userId: 1 }, 'attacker-key');

      assert.equal(carriesOurCredential({ headers: { authorization: `Bearer ${ours}` } }), true);
      assert.equal(carriesOurCredential({ headers: { authorization: `Bearer ${forged}` } }), false);
      assert.equal(carriesOurCredential({ headers: { authorization: 'Bearer garbage' } }), false);
      assert.equal(carriesOurCredential({ headers: {} }), false);
      assert.equal(carriesOurCredential({}), false);

      // "Presented and failed" must be distinguishable from "never presented":
      // the first is a forgery signal, the second is normal on a login route.
      assert.equal(credentialState({ headers: { authorization: `Bearer ${ours}` } }), 'verified');
      assert.equal(credentialState({ headers: { authorization: `Bearer ${forged}` } }), 'invalid');
      assert.equal(credentialState({ headers: { authorization: 'Bearer garbage' } }), 'invalid');
      assert.equal(credentialState({ headers: {} }), 'absent');
      assert.equal(credentialState({}), 'absent');

      // An attacker choosing the "none" algorithm must not verify.
      const none = [
        Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ userId: 1 })).toString('base64url'),
        '',
      ].join('.');
      assert.equal(credentialState({ headers: { authorization: `Bearer ${none}` } }), 'invalid');

      // An expired token still proves origin: the client is ours either way, and
      // that is the question the observation window asks.
      const expired = jwt.sign({ userId: 1 }, process.env.JWT_SECRET, { expiresIn: -60 });
      assert.equal(
        carriesOurCredential({ headers: { authorization: `Bearer ${expired}` } }),
        true
      );
    } finally {
      process.env.JWT_SECRET = prev;
    }
  });

  it('JWT events assert the credential rather than inferring it from headers', () => {
    // Both sites sit after jwt.verify(), so they must say so explicitly; deriving
    // it again would be redundant, and omitting it would misclassify the event.
    const mw = read('middleware/auth.js');
    assert.match(mw, /JWT_REJECTED, req, \{\s*serverVerified: true,?\s*\}/);
    assert.match(mw, /JWT_ACCEPTED, req, \{\s*serverVerified: true,?\s*\}/);
  });

  it('client labels are bounded — no free-form text reaches the counters', () => {
    const hostile = legacyEventFromRequest({
      headers: {
        'x-client-platform': 'a'.repeat(500),
        'x-app-version': "4.0'; DROP TABLE users;--",
      },
      baseUrl: '/app',
      path: '/verify-otp',
    });
    assert.equal(hostile.platform, 'invalid');
    assert.equal(hostile.appVersion, 'invalid');
    assert.equal(hostile.routeClass, '/app/verify-otp');

    const missing = legacyEventFromRequest({ headers: {}, baseUrl: '/api', path: '/me' });
    assert.equal(missing.platform, 'unknown');
    assert.equal(missing.appVersion, 'unknown');
  });

  it('records no secrets and no user identifiers', () => {
    const src = read('services/legacyAuthTelemetry.js');
    const insert = src.slice(src.indexOf('INSERT INTO legacy_auth_events'));
    for (const forbidden of [
      'authorization',
      'token',
      'jwt',
      'refresh',
      'otp',
      'password',
      'secret',
      'userId',
      'user_id',
      'mobile',
      'email',
      'ip',
    ]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, 'i').test(insert),
        `legacy_auth_events must not persist ${forbidden}`
      );
    }
  });

  it('telemetry failure can never break authentication', () => {
    const src = read('services/legacyAuthTelemetry.js');
    // The DB write is wrapped and swallowed...
    assert.match(src, /try \{[\s\S]*INSERT INTO legacy_auth_events[\s\S]*\} catch \(err\) \{[\s\S]*console\.warn/);
    // ...and callers never await it, so a slow counter cannot stall a login.
    assert.match(read('middleware/auth.js'), /void recordLegacyAuthEvent/);
    assert.match(read('routes/auth.js'), /void recordLegacyAuthEvent/);
  });

  it('counters are aggregate-only so they cannot become a personal-data store', () => {
    const schema = read('db/workspaceSchema.js');
    const table = schema.slice(
      schema.indexOf('CREATE TABLE IF NOT EXISTS legacy_auth_events'),
      schema.indexOf('idx_legacy_auth_events_day')
    );
    assert.match(table, /PRIMARY KEY \(day, event_type, route_class, platform, app_version\)/);
    assert.match(table, /hits\s+BIGINT/);
    assert.ok(!/user_id|session|token/i.test(table), 'no per-user column may exist');
  });

  it('an operator report exists to produce the daily verdict', () => {
    const script = read('../scripts/report-legacy-auth-usage.mjs');
    assert.match(script, /legacy_auth_events/);
    assert.match(script, /identified_client/);
    // Must fail loudly rather than imply a clean day when telemetry is absent.
    assert.match(script, /process\.exit\(2\)/);
    assert.match(script, /STRICT/);
  });
});

describe('OTP secrecy', () => {
  const otpLogSites = [
    'routes/auth.js',
    'routes/api-v1.js',
    'services/sms.js',
  ];

  it('no auth path prints a live OTP in production', () => {
    for (const rel of otpLogSites) {
      const src = read(rel);
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!/console\.(log|warn|error|info)/.test(line)) return;
        const interpolatesOtp = /\$\{\s*otp\d?\s*\}/i.test(line);
        assert.ok(
          !interpolatesOtp,
          `${rel}:${i + 1} logs an OTP directly; route it through devOtpSuffix() — ${line.trim()}`
        );
      });
    }
  });

  it('devOtpSuffix is silent in production', async () => {
    const { devOtpSuffix } = await import('../utils/otpLogging.js');
    const prev = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.equal(devOtpSuffix('1234'), '');
      process.env.NODE_ENV = 'development';
      assert.match(devOtpSuffix('1234'), /1234/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe('observation report date handling', () => {
  const reporter = fs.readFileSync(
    path.join(root, '..', 'scripts', 'report-legacy-auth-usage.mjs'),
    'utf8'
  );

  it('the hazard being guarded against is real', () => {
    // A DATE column arrives as local midnight. Rendering that through UTC moves it
    // backwards for any positive offset, so in IST the row for the 18th prints as
    // the 17th. Constructed with an explicit offset so the result does not depend
    // on the machine running the test.
    const localMidnightIST = new Date('2026-09-18T00:00:00+05:30');
    assert.equal(
      localMidnightIST.toISOString().slice(0, 10),
      '2026-09-17',
      'toISOString shifts the calendar day backwards in IST'
    );
  });

  it('the report formats the observation day in SQL, not through a JS Date', () => {
    // A clean day recorded against the wrong date is worse than no record: the
    // seven-day window would be certified from rows that describe other days.
    assert.match(
      reporter,
      /to_char\(\s*day\s*,\s*'YYYY-MM-DD'\s*\)\s+AS day/,
      'the day must be formatted by Postgres, which knows it is a calendar date'
    );
    assert.ok(
      !/new Date\(\s*row\.day\s*\)/.test(reporter),
      'reading row.day into a JS Date reintroduces the timezone shift'
    );
  });
});
