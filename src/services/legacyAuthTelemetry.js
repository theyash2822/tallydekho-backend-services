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
 * A client that sends platform + version identifies itself, so its traffic is a
 * real migration blocker. Traffic with no identity is treated as unattributed
 * (abandoned builds, scanners) and must not silently reset the clean-day clock —
 * the operator decides, using the split the report provides.
 */
export function isIdentifiedClient(platform, appVersion) {
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
export async function recordLegacyAuthEvent(eventType, req) {
  const { platform, appVersion, routeClass } = legacyEventFromRequest(req);
  const identified = isIdentifiedClient(platform, appVersion);

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
