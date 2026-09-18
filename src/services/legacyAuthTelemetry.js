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
 * Does the request carry a token that our own JWT_SECRET validates?
 *
 * This is the load-bearing signal, because it cannot be forged: only this server
 * can mint a token that verifies. Expiry is ignored on purpose — an expired token
 * still proves the sender is one of our clients, which is the question being asked.
 */
export function carriesOurCredential(req) {
  const header = req?.headers?.authorization;
  if (!header?.startsWith('Bearer ') || !process.env.JWT_SECRET) return false;
  try {
    jwt.verify(header.slice(7), process.env.JWT_SECRET, { ignoreExpiration: true });
    return true;
  } catch {
    return false;
  }
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
 * A verified credential is therefore what counts. Headers only refine attribution
 * to a platform and version once clients start sending them, and they can only
 * ever move an event toward "identified", never away from it, so a client cannot
 * hide from the gate by withholding them.
 *
 * Spoofing runs one way: anything may *claim* headers and be counted as
 * identified. That direction is safe, since it delays a destructive migration
 * rather than permitting one. The unsafe direction, a real client being scored
 * unattributed, is what the credential check closes.
 */
export function isIdentifiedClient(platform, appVersion, credentialVerified = false) {
  if (credentialVerified) return true;
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
  // checked here instead.
  const credentialVerified = opts.credentialVerified ?? carriesOurCredential(req);
  const identified = isIdentifiedClient(platform, appVersion, credentialVerified);

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
