// TallyDekho Scheduler — Auto Payment Reminders + Compliance Alerts
// All jobs run on Indian time (Asia/Kolkata), whatever the server's timezone.

import cron from 'node-cron';
import { query } from '../db/schema.js';
import { sendCompliancePush } from './push.js';
import { runPaymentReminderJob, istNow } from './paymentReminderJob.js';
import { sweepStaleSyncRuns } from '../utils/syncRuns.js';

const IST_CRON = { timezone: 'Asia/Kolkata' };

let schedulerStarted = false;

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[Scheduler] Starting TallyDekho job scheduler...');

  // Sync runs whose desktop stopped sending heartbeats are closed even when no new sync
  // starts for that company (R2 / S7).
  cron.schedule('* * * * *', async () => {
    try {
      const swept = await sweepStaleSyncRuns(query);
      if (swept) console.log(`[Scheduler] sync runs abandoned after lease expiry: ${swept}`);
    } catch (err) {
      console.warn('[Scheduler] sync-run sweep failed:', err.message);
    }
  });

  // ─── Payment Reminders — runs every hour, checks per-user configured time ───
  // Checks all users, finds invoices due soon, sends reminders if time matches
  cron.schedule('0 * * * *', async () => {
    try {
      const summary = await runPaymentReminderJob();
      if (summary.sent > 0) console.log('[Scheduler] Payment reminders:', JSON.stringify(summary));
    } catch (err) {
      console.error('[Scheduler] Payment reminder job failed:', err.message);
    }
  }, IST_CRON);

  // ─── Compliance Reminders — runs daily at 8 AM IST ────────────────────────
  cron.schedule('0 8 * * *', async () => {
    try {
      await runComplianceReminderJob();
    } catch (err) {
      console.error('[Scheduler] Compliance reminder job failed:', err.message);
    }
  }, IST_CRON);

  // ─── Workspace grace: ownership transfer / reset / close ──────────────────
  cron.schedule('*/15 * * * *', async () => {
    try {
      const { processWorkspaceGraceJobs } = await import('./workspaceService.js');
      const result = await processWorkspaceGraceJobs();
      const n =
        (result.transfers?.length || 0) +
        (result.resets?.length || 0) +
        (result.closes?.length || 0);
      if (n > 0) console.log('[Scheduler] workspace grace jobs:', JSON.stringify(result));
    } catch (err) {
      console.error('[Scheduler] Workspace grace job failed:', err.message);
    }
  }, IST_CRON);

  // ─── HSN master — daily 3 AM; downloads only if older than 15 days ─────────
  cron.schedule('0 3 * * *', async () => {
    try {
      const { maybeRefreshHsnMaster } = await import('./hsnMaster.js');
      const result = await maybeRefreshHsnMaster({ maxAgeDays: 15 });
      console.log('[Scheduler] HSN master:', JSON.stringify(result));
    } catch (err) {
      console.error('[Scheduler] HSN refresh failed:', err.message);
    }
  }, IST_CRON);

  // ─── Stock alerts (low / negative / expiry) — daily 9 AM IST ─────────────────
  cron.schedule('0 9 * * *', async () => {
    try {
      const { runStockAlertJob } = await import('./stockAlertDispatch.js');
      const result = await runStockAlertJob();
      console.log('[Scheduler] Stock alerts:', JSON.stringify(result));
    } catch (err) {
      console.error('[Scheduler] Stock alert job failed:', err.message);
    }
  }, IST_CRON);

  setImmediate(async () => {
    try {
      const { ensureHsnBootstrap, maybeRefreshHsnMaster } = await import('./hsnMaster.js');
      const boot = await ensureHsnBootstrap();
      console.log('[Scheduler] HSN bootstrap:', JSON.stringify(boot));
      const refresh = await maybeRefreshHsnMaster({ maxAgeDays: 15 });
      if (!refresh.skipped) console.log('[Scheduler] HSN initial refresh:', JSON.stringify(refresh));
    } catch (e) {
      console.warn('[Scheduler] HSN bootstrap:', e.message);
    }
  });

  console.log('[Scheduler] Jobs registered (IST): payment reminders (hourly), compliance (8AM), workspace grace (15m), HSN (daily/15d), stock alerts (9AM)');
}

// ─── Compliance Reminder Job ──────────────────────────────────────────────────
async function runComplianceReminderJob() {
  const { rows: users } = await query(`
    SELECT u.id, u.alert_settings
    FROM users u
    WHERE u.alert_settings IS NOT NULL
  `);

  for (const user of users) {
    try {
      const compliance = user.alert_settings?.compliance || {};
      const { rows: tokenRows } = await query('SELECT token FROM push_tokens WHERE user_id=$1', [user.id]);
      const tokens = tokenRows.map(r => r.token);
      if (tokens.length === 0) continue;

      const daysUntilGSTR1 = daysUntilDayOfMonth(11);
      const daysUntilGSTR3B = daysUntilDayOfMonth(20);

      if (daysUntilGSTR1 === (compliance.gstr1FilingDays ?? 3)) {
        await sendCompliancePush(tokens, {
          title: 'GSTR-1 Filing Reminder',
          message: `GSTR-1 is due in ${daysUntilGSTR1} days. File before the 11th.`,
          type: 'gstr1',
        });
      }

      if (daysUntilGSTR3B === (compliance.gstr3bFilingDays ?? 3)) {
        await sendCompliancePush(tokens, {
          title: 'GSTR-3B Filing Reminder',
          message: `GSTR-3B is due in ${daysUntilGSTR3B} days. File before the 20th.`,
          type: 'gstr3b',
        });
      }
    } catch (err) {
      console.error(`[Scheduler] Compliance failed for user ${user.id}:`, err.message);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
/**
 * Days from today (IST) to the next occurrence of `dayOfMonth`. Filing for month M
 * is due on that day of M+1, so "today is the due day" returns 0, not 30.
 */
export function daysUntilDayOfMonth(dayOfMonth, date = new Date()) {
  const today = istNow(date).day;
  const [y, m, d] = today.split('-').map(Number);
  const todayUtc = Date.UTC(y, m - 1, d);
  let due = Date.UTC(y, m - 1, dayOfMonth);
  if (due < todayUtc) due = Date.UTC(y, m, dayOfMonth);
  return Math.round((due - todayUtc) / 86400000);
}

export default { startScheduler };
