// TallyDekho Scheduler — Auto Payment Reminders + Compliance Alerts
// Uses node-cron to run daily jobs based on per-user settings

import cron from 'node-cron';
import { query } from '../db/schema.js';
import { sendPaymentReminder } from './notifications.js';
import { sendCompliancePush } from './push.js';

let schedulerStarted = false;

export function startScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;

  console.log('[Scheduler] Starting TallyDekho job scheduler...');

  // ─── Payment Reminders — runs every hour, checks per-user configured time ───
  // Checks all users, finds invoices due soon, sends reminders if time matches
  cron.schedule('0 * * * *', async () => {
    try {
      await runPaymentReminderJob();
    } catch (err) {
      console.error('[Scheduler] Payment reminder job failed:', err.message);
    }
  });

  // ─── Compliance Reminders — runs daily at 8 AM ────────────────────────────
  cron.schedule('0 8 * * *', async () => {
    try {
      await runComplianceReminderJob();
    } catch (err) {
      console.error('[Scheduler] Compliance reminder job failed:', err.message);
    }
  });

  console.log('[Scheduler] Jobs registered: payment reminders (hourly), compliance (8AM daily)');
}

// ─── Payment Reminder Job ─────────────────────────────────────────────────────
async function runPaymentReminderJob() {
  const now = new Date();
  const currentHour = now.getHours();

  // Get all users who have payment reminders configured
  const { rows: users } = await query(`
    SELECT u.id, u.mobile, u.email,
           u.alert_settings,
           u.notification_settings
    FROM users u
    WHERE u.alert_settings IS NOT NULL
      AND u.alert_settings->'payment_reminders' IS NOT NULL
  `);

  for (const user of users) {
    try {
      const reminderConfig = user.alert_settings?.payment_reminders || {};
      const reminders = reminderConfig.reminders || [];

      for (const reminder of reminders) {
        if (!reminder.enabled) continue;

        // Parse configured time — e.g. "09:00 AM"
        const configHour = parseHour(reminder.time);
        if (configHour !== currentHour) continue; // not time yet

        const daysBefore = reminder.daysBefore || 0;
        const channels = reminder.channels || { whatsapp: true };
        const threshold = parseFloat(reminderConfig.threshold) || 0; // min invoice amount to trigger reminder

        // Find outstanding bills due in `daysBefore` days for this user's companies
        const targetDate = new Date();
        targetDate.setDate(targetDate.getDate() + daysBefore);
        const targetDateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD

        const { rows: bills } = await query(`
          SELECT bo.ledger_name, bo.amount, bo.due_date, bo.voucher_no,
                 bo.voucher_date, bo.company_guid,
                 c.name AS company_name,
                 l.mobile AS party_mobile, l.email AS party_email
          FROM bill_outstanding bo
          JOIN companies c ON c.guid = bo.company_guid
          LEFT JOIN ledgers l ON l.company_guid = bo.company_guid AND l.name = bo.ledger_name
          WHERE bo.company_guid IN (
            SELECT guid FROM companies WHERE user_id=$1
          )
          AND DATE(TO_TIMESTAMP(bo.due_date::bigint / 1000)) = $2::date
          AND bo.amount >= $3
          AND bo.ledger_name NOT IN (${buildExclusions(reminder.exceptions)})
          LIMIT 50
        `, [user.id, targetDateStr, threshold]);

        if (bills.length === 0) continue;

        // Get user's push tokens
        const { rows: tokenRows } = await query(
          'SELECT token FROM push_tokens WHERE user_id=$1', [user.id]
        );
        const pushTokens = tokenRows.map(r => r.token);

        for (const bill of bills) {
          const partyMobile = bill.party_mobile?.replace(/\D/g, '').slice(-10);
          const dueDate = formatDate(bill.due_date);
          const amount = Math.round(parseFloat(bill.amount || 0)).toLocaleString('en-IN');

          await sendPaymentReminder({
            mobile:       partyMobile,
            email:        channels.email ? bill.party_email : null,
            countryCode:  '+91',
            partyName:    bill.ledger_name,
            businessName: bill.company_name,
            amountDue:    amount,
            invoiceNo:    bill.voucher_no || '',
            invoiceDate:  formatDate(bill.voucher_date),
            dueDate,
            contactNumber: user.mobile || '',
            channels: {
              whatsapp: channels.whatsapp && !!partyMobile,
              email:    channels.email && !!bill.party_email,
              sms:      channels.sms && !!partyMobile,
              push:     false, // push is only for app user's own notifications, not client reminders
            },
          });

          console.log(`[Scheduler] Reminder sent: ${bill.ledger_name} | ₹${amount} | due ${dueDate}`);
        }
      }
    } catch (err) {
      console.error(`[Scheduler] Failed for user ${user.id}:`, err.message);
    }
  }
}

// ─── Compliance Reminder Job ──────────────────────────────────────────────────
async function runComplianceReminderJob() {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

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

      const daysUntilGSTR1 = daysUntilMonthEnd(7);  // GSTR-1 due 11th
      const daysUntilGSTR3B = daysUntilMonthEnd(15); // GSTR-3B due 20th

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
function parseHour(timeStr) {
  if (!timeStr) return -1;
  // Handles "09:00 AM", "5:00 PM", "14:00"
  const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return -1;
  let h = parseInt(match[1], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return h;
}

function formatDate(val) {
  if (!val) return '';
  // Handles epoch ms or YYYY-MM-DD
  if (typeof val === 'number' || /^\d{10,}$/.test(val)) {
    return new Date(parseInt(val)).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  return val;
}

function buildExclusions(exceptions) {
  if (!exceptions || exceptions.length === 0) return "'__none__'";
  return exceptions.map(e => `'${e.replace(/'/g, "''")}'`).join(',');
}

function daysUntilMonthEnd(dayOfMonth) {
  const now = new Date();
  const dueDate = new Date(now.getFullYear(), now.getMonth(), dayOfMonth);
  if (dueDate < now) dueDate.setMonth(dueDate.getMonth() + 1);
  return Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));
}

export default { startScheduler };
