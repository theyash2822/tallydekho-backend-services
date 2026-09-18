#!/usr/bin/env node
/**
 * RBAC Phase 7 — legacy auth observation report.
 *
 * Turns `legacy_auth_events` counters into the daily verdict required by
 * RBAC_PHASE7_OBSERVATION.md. Run against PRODUCTION.
 *
 * A day is CLEAN when zero legacy hits came from an IDENTIFIED client, meaning
 * one that presented a token our own JWT_SECRET validates, or that declared both
 * x-client-platform and x-app-version. The credential is the signal that matters,
 * since no shipped client sends those headers yet; see isIdentifiedClient() in
 * src/services/legacyAuthTelemetry.js for the full rationale.
 *
 * Unattributed traffic — forged or malformed tokens, scanners, bots — is reported
 * separately and does not by itself reset the clean-day clock; the operator decides
 * using the split.
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
            SUM(hits) FILTER (WHERE event_type = 'LEGACY_APP_AUTH_HIT') AS app_auth_hits
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
    console.log('\n| Date | Legacy JWT accepted | Supported /app/auth hits | Identified clients | Verified clean day |');
    console.log('| ---- | ------------------- | ------------------------ | ------------------ | ------------------ |');
  }

  let identifiedTotal = 0;
  for (const row of days) {
    const date = row.day;
    const identified = n(row.identified_hits);
    identifiedTotal += identified;
    if (MARKDOWN) {
      console.log(
        `| ${date} | ${n(row.jwt_accepted)} | ${n(row.app_auth_hits)} | ${identified} | ${identified === 0 ? 'YES' : 'NO'} |`
      );
    } else {
      console.log(
        `${date}  identified=${identified}  unattributed=${n(row.unattributed_hits)}  ` +
          `jwt_accepted=${n(row.jwt_accepted)}  jwt_rejected=${n(row.jwt_rejected)}  ` +
          `app_auth=${n(row.app_auth_hits)}  → ${identified === 0 ? 'CLEAN' : 'NOT CLEAN'}`
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
    console.log('\nidentified clients still using legacy auth (migrate these, then restart the clock):');
    for (const o of offenders) {
      // Until clients send the identification headers, most identified events are
      // attributed by credential alone, so say that rather than printing
      // "unknown vunknown" and implying the data is missing.
      const who =
        o.platform === 'unknown' && o.app_version === 'unknown'
          ? 'verified credential (platform/version not declared)'
          : `${o.platform} v${o.app_version}`;
      console.log(
        `  ${who}  ${o.event_type} ${o.route_class} hits=${o.hits} last=${new Date(o.last_seen).toISOString()}`
      );
    }
  } else {
    console.log('\nno identified client used a legacy auth path in the window');
  }

  console.log(`\nidentified legacy hits in window: ${identifiedTotal}`);
  if (STRICT && identifiedTotal > 0) {
    console.error('STRICT: identified legacy auth usage present — day is NOT clean');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
