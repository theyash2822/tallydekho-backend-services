/**
 * RBAC Phase 7 — legacy auth usage telemetry.
 *
 * Answers exactly one operational question:
 *   "Did any legitimate supported client use a legacy auth path today?"
 *
 * stdout logs alone cannot answer it (not queryable without external log
 * infrastructure), so events are aggregated into daily counters.
 *
 * Recorded: UTC day, event type, route class, client platform, client version.
 * NEVER recorded: JWT, Authorization header, refresh token, OTP, PIN,
 * device secret, mobile number, email, user id.
 *
 * Aggregate-only by design — counters cannot become a personal-data store.
 */
import jwt from 'jsonwebtoken';
import { query } from '../db/schema.js';

export const LEGACY_EVENTS = {
  /** Sessionless JWT presented and rejected (production default). */
  JWT_REJECTED: 'LEGACY_JWT_REJECTED',
  /** Sessionless JWT accepted because ALLOW_LEGACY_JWT=1. */
  JWT_ACCEPTED: 'LEGACY_JWT_ACCEPTED',
  /** A legacy /app/* auth route was hit. */
  APP_AUTH_HIT: 'LEGACY_APP_AUTH_HIT',
};

const UNKNOWN = 'unknown';

/** Bounded, log-safe label — no free-form client text reaches the database. */
function label(value) {
  const s = String(value ?? '').trim();
  if (!s) return UNKNOWN;
  return /^[A-Za-z0-9._+-]{1,32}$/.test(s) ? s : 'invalid';
}

/**
 * Classify the bearer token on a request as one of three states.
 *
 *   'verified' — validates against our own JWT_SECRET, so the sender is provably
 *                one of our clients. Cannot be forged; only this server can mint
 *                such a token. Expiry is ignored on purpose, since an expired
 *                token still proves origin, which is the question being asked.
 *   'invalid'  — a token was presented and did not validate. Forged, corrupted,
 *                or signed with a key that is not ours.
 *   'absent'   — no bearer token at all. Normal for unauthenticated routes such
 *                as login, so it is not suspicious by itself.
 *
 * The distinction between 'invalid' and 'absent' matters: see isIdentifiedClient().
 */
export function credentialState(req) {
  const header = req?.headers?.authorization;
  if (!header?.startsWith('Bearer ')) return 'absent';
  if (!process.env.JWT_SECRET) return 'invalid';
  try {
    jwt.verify(header.slice(7), process.env.JWT_SECRET, { ignoreExpiration: true });
    return 'verified';
  } catch {
    return 'invalid';
  }
}

/** Convenience boolean: did this request prove it came from one of our clients? */
export function carriesOurCredential(req) {
  return credentialState(req) === 'verified';
}

/**
 * Whether this event attributes to a real client of ours, which is what blocks
 * the RBAC cutover and resets the clean-day clock.
 *
 * Header self-declaration alone is NOT sufficient, and relying on it was a bug:
 * no shipped Web, Mobile or Desktop client sends x-client-platform or
 * x-app-version, so an earlier version of this function returned false for every
 * request including genuine legacy usage. STRICT mode would then have exited 0
 * every day and the seven clean days would have been declared vacuously — the
 * precise false confidence this telemetry exists to prevent.
 *
 * A verified credential is therefore what counts, and headers can never downgrade
 * it. Withholding headers cannot hide a real client from the gate.
 *
 * A token that was presented and failed to verify is the one case headers cannot
 * rescue. Otherwise anyone could launder a forged token into "legitimate usage"
 * by adding two header lines, and hold the cutover open indefinitely — a denial
 * of progress against our own release, costing nothing to mount.
 *
 * Headers still decide the case where no token was presented at all, because that
 * is normal for unauthenticated legacy routes such as login. A real client calling
 * /app/auth/send-otp has no token to offer, and once clients send identification
 * headers that is the only signal distinguishing it from a scanner.
 *
 *   credential     headers      identified
 *   ----------     -------      ----------
 *   verified       any          yes   — provably ours, blocks the clean day
 *   invalid        any          no    — forgery cannot be laundered by headers
 *   absent         present      yes   — unauthenticated legacy use by a real client
 *   absent         missing      no    — unattributable; scanners, abandoned builds
 */
export function isIdentifiedClient(platform, appVersion, credential = 'absent') {
  // Accepts the legacy boolean form as well as the tri-state.
  const state = credential === true ? 'verified' : credential === false ? 'absent' : credential;
  if (state === 'verified') return true;
  if (state === 'invalid') return false;
  return label(platform) !== UNKNOWN && label(appVersion) !== UNKNOWN;
}

export function legacyEventFromRequest(req) {
  return {
    platform: label(req?.headers?.['x-client-platform']),
    appVersion: label(req?.headers?.['x-app-version']),
    routeClass: `${req?.baseUrl || ''}${req?.route?.path || req?.path || ''}` || UNKNOWN,
  };
}

/**
 * Fire-and-forget counter increment. Never throws and never blocks an auth
 * response — telemetry must not be able to break login.
 */
export async function recordLegacyAuthEvent(eventType, req, opts = {}) {
  const { platform, appVersion, routeClass } = legacyEventFromRequest(req);
  // JWT_* events are only reachable after the signature already verified, so the
  // caller states that directly. /app/* hits are open to anyone, so the token is
  // classified here instead.
  const credential = opts.credentialVerified === true ? 'verified' : credentialState(req);
  const identified = isIdentifiedClient(platform, appVersion, credential);

  // stdout line retained for existing log pipelines / greppability.
  console.warn(
    `[auth] ${eventType} ${JSON.stringify({
      ts: new Date().toISOString(),
      platform,
      appVersion,
      routeClass,
      identifiedClient: identified,
    })}`
  );

  try {
    await query(
      `INSERT INTO legacy_auth_events
         (day, event_type, route_class, platform, app_version, identified_client, hits, last_seen)
       VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, 1, NOW())
       ON CONFLICT (day, event_type, route_class, platform, app_version)
       DO UPDATE SET hits = legacy_auth_events.hits + 1, last_seen = NOW()`,
      [eventType, String(routeClass).slice(0, 120), platform, appVersion, identified]
    );
  } catch (err) {
    console.warn('[legacyAuthTelemetry] counter skipped:', err.message);
  }
}
