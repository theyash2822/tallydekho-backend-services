#!/usr/bin/env node
/**
 * RBAC Phase 7 — legacy auth observation report.
 *
 * Turns `legacy_auth_events` counters into the daily verdict required by
 * RBAC_PHASE7_OBSERVATION.md. Run against PRODUCTION.
 *
 * A day is CLEAN when the server verified zero real uses of a legacy auth path.
 *
 * Two things count as real, and both are established by the server, never by
 * anything the caller sends:
 *
 *   LEGACY_JWT_ACCEPTED / LEGACY_JWT_REJECTED
 *     a token our own JWT_SECRET validated — only this server can mint one
 *
 *   LEGACY_LOGIN_SUCCESS
 *     a legacy login actually completed: the OTP matched, or a token we issued
 *     verified, and the server went on to issue or confirm credentials
 *
 * Everything else is attempt volume:
 *
 *   LEGACY_APP_AUTH_HIT with no verified credential
 *     anyone can POST to an unauthenticated login route; reported, never blocking
 *
 * Client headers (x-client-platform, x-app-version) are attribution only. They
 * cannot make an event blocking, so a stranger cannot jam the cutover with two
 * header lines, and they cannot make one non-blocking, so a real client cannot
 * slip past by withholding them. See isLegitimateLegacyUse() in
 * src/services/legacyAuthTelemetry.js.
 *
 * Usage:
 *   node scripts/report-legacy-auth-usage.mjs             # last 7 days
 *   DAYS=14 node scripts/report-legacy-auth-usage.mjs
 *   STRICT=1 node scripts/report-legacy-auth-usage.mjs    # exit 1 if any identified hits
 *   MARKDOWN=1 node scripts/report-legacy-auth-usage.mjs  # rows for the observation doc
 *
 * Exit codes: 0 clean · 1 identified legacy usage (STRICT=1) · 2 telemetry missing
 */
import 'dotenv/config';
import { query } from '../src/db/schema.js';

const DAYS = Number(process.env.DAYS || 7);
const STRICT = process.env.STRICT === '1';
const MARKDOWN = process.env.MARKDOWN === '1';

async function main() {
  const { rows: exists } = await query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = 'legacy_auth_events'
     ) AS present`
  );
  if (!exists[0].present) {
    console.error('legacy_auth_events table is missing — deploy the instrumented build first.');
    console.error('Without it a clean day CANNOT be verified from the database.');
    process.exit(2);
  }

  const { rows: days } = await query(
    // The day is formatted in SQL on purpose. Reading it as a JS Date and calling
    // toISOString() renders local midnight in UTC, which shifts the date backwards
    // for any positive offset — IST reported 2026-09-18 as 2026-09-17, silently
    // filing a verdict against the wrong observation day.
    `SELECT to_char(day, 'YYYY-MM-DD') AS day,
            SUM(hits) FILTER (WHERE identified_client) AS identified_hits,
            SUM(hits) FILTER (WHERE NOT identified_client) AS unattributed_hits,
            SUM(hits) FILTER (WHERE event_type = 'LEGACY_JWT_ACCEPTED') AS jwt_accepted,
            SUM(hits) FILTER (WHERE event_type = 'LEGACY_JWT_REJECTED') AS jwt_rejected,
            SUM(hits) FILTER (WHERE event_type = 'LEGACY_APP_AUTH_HIT') AS app_auth_hits,
            SUM(hits) FILTER (WHERE event_type = 'LEGACY_LOGIN_SUCCESS') AS login_success
       FROM legacy_auth_events
      WHERE day >= CURRENT_DATE - ($1::int - 1)
      GROUP BY day
      ORDER BY day DESC`,
    [DAYS]
  );

  const n = (v) => Number(v || 0);

  console.log(`=== legacy auth observation — last ${DAYS} day(s) ===`);
  if (!days.length) {
    console.log('no legacy auth events recorded in the window');
  }

  if (MARKDOWN) {
    console.log('\n| Date | Verified legacy JWT | Successful legacy login | Unverified attempts | Blocking total | Verified clean day |');
    console.log('| ---- | ------------------- | ----------------------- | ------------------- | -------------- | ------------------ |');
  }

  let identifiedTotal = 0;
  for (const row of days) {
    const date = row.day;
    const identified = n(row.identified_hits);
    identifiedTotal += identified;
    if (MARKDOWN) {
      const verifiedJwt = n(row.jwt_accepted) + n(row.jwt_rejected);
      console.log(
        `| ${date} | ${verifiedJwt} | ${n(row.login_success)} | ${n(row.unattributed_hits)} | ${identified} | ${identified === 0 ? 'YES' : 'NO'} |`
      );
    } else {
      console.log(
        `${date}  blocking=${identified}  attempts=${n(row.unattributed_hits)}  ` +
          `[verified_jwt=${n(row.jwt_accepted) + n(row.jwt_rejected)} ` +
          `login_success=${n(row.login_success)} ` +
          `app_auth_hits=${n(row.app_auth_hits)}]  ` +
          `→ ${identified === 0 ? 'CLEAN' : 'NOT CLEAN'}`
      );
    }
  }

  const { rows: offenders } = await query(
    `SELECT platform, app_version, event_type, route_class, SUM(hits) AS hits, MAX(last_seen) AS last_seen
       FROM legacy_auth_events
      WHERE identified_client AND day >= CURRENT_DATE - ($1::int - 1)
      GROUP BY platform, app_version, event_type, route_class
      ORDER BY hits DESC
      LIMIT 25`,
    [DAYS]
  );

  if (offenders.length) {
    console.log('\nserver-verified legacy usage (migrate these clients, then restart the clock):');
    for (const o of offenders) {
      // Clients do not send identification headers yet, so most blocking events
      // are attributed by server evidence alone. Say that, rather than printing
      // "unknown vunknown" and implying data is missing.
      const who =
        o.platform === 'unknown' && o.app_version === 'unknown'
          ? 'platform/version not declared'
          : `${o.platform} v${o.app_version}`;
      const how =
        o.event_type === 'LEGACY_LOGIN_SUCCESS'
          ? 'completed a legacy login'
          : 'presented a token we minted';
      console.log(
        `  ${how} — ${who}  ${o.route_class} hits=${o.hits} last=${new Date(o.last_seen).toISOString()}`
      );
    }
  } else {
    console.log('\nno server-verified legacy auth usage in the window');
  }

  console.log(`\nblocking legacy usage in window: ${identifiedTotal}`);
  if (STRICT && identifiedTotal > 0) {
    console.error('STRICT: server-verified legacy auth usage present — day is NOT clean');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
