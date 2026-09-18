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
  /** A legacy /app/* auth route was hit. Attempt only; proves nothing by itself. */
  APP_AUTH_HIT: 'LEGACY_APP_AUTH_HIT',
  /**
   * A legacy authentication actually COMPLETED: the server checked the OTP or a
   * token it minted itself and then issued or confirmed credentials. This is the
   * evidence that an unauthenticated legacy flow is still in real use, and it
   * cannot be manufactured from outside.
   */
  LOGIN_SUCCESS: 'LEGACY_LOGIN_SUCCESS',
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
 * Only 'verified' is treated as evidence; see isLegitimateLegacyUse().
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
 * Does this event count as real legacy usage — the thing that blocks a clean day
 * and resets the seven-day clock?
 *
 * Only the server's own verification counts. Nothing a caller can put in a
 * request makes an event blocking:
 *
 *   evidence     meaning                                            blocking
 *   --------     -------                                            --------
 *   verified     a token we minted validated, OR a legacy login     yes
 *                actually completed against a real OTP/token
 *   invalid      a token was presented and failed to verify         no
 *   absent       nothing the server could verify                    no
 *
 * Client headers deliberately play no part. They record which platform and
 * version to chase once a blocking event exists, and nothing more.
 *
 * Two earlier versions of this function got it wrong in opposite directions,
 * which is why the rule is now this blunt:
 *
 * Headers were once the ONLY signal. No shipped client sends x-client-platform
 * or x-app-version, so every genuine legacy request scored non-blocking, STRICT
 * exited 0 daily, and seven clean days would have been certified while legacy
 * auth was still carrying real traffic.
 *
 * Headers were then sufficient but not necessary, which fixed the false-clean
 * hole and opened a false-block one: two header lines from anyone on the
 * internet counted as a real client, and could hold the cutover open forever at
 * no cost to the sender.
 *
 * Server-verified evidence closes both. It cannot be withheld by a real client
 * to escape the gate, and it cannot be fabricated by a stranger to jam it.
 */
export function isLegitimateLegacyUse(evidence = 'absent') {
  // Accepts the boolean form used by call sites that already know the answer.
  const state = evidence === true ? 'verified' : evidence === false ? 'absent' : evidence;
  return state === 'verified';
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
  // Call sites that already hold server-side proof say so: the JWT_* events sit
  // after jwt.verify(), and LOGIN_SUCCESS is only reached once a legacy login has
  // actually completed. Everything else is classified from the request, where the
  // only thing worth trusting is a token our own secret validates.
  const evidence = opts.serverVerified === true ? 'verified' : credentialState(req);
  const identified = isLegitimateLegacyUse(evidence);

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
