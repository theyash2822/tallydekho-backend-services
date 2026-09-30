/**
 * Hourly payment reminder job — customers only (Dr / receivable bills).
 *
 * - Reminder time and "days before due" are evaluated in IST, not server time.
 * - bill_outstanding.due_date is TEXT (YYYY-MM-DD); the desktop still sends it
 *   empty, so a bill without one is treated as due DEFAULT_CREDIT_DAYS after its
 *   bill date.
 * - payment_reminder_log has a unique slot (company, party, bill, reminder,
 *   channel, IST day), so a re-run never messages a customer twice.
 * - Channels: WhatsApp (Cronberry) and SMS (Proactive). Email is skipped until
 *   Amazon SES is configured. The app user gets one push summary per run.
 */
import { query } from '../db/schema.js';
import { authorize } from './authorizationService.js';
import { sendPaymentReminder as sendWhatsAppReminder } from './whatsapp.js';
import { sendPaymentReminderSms } from './sms.js';
import { sendPaymentReminderEmail } from './email.js';
import { sendPushNotification } from './push.js';
import { DEFAULT_CREDIT_DAYS } from '../utils/billOutstanding.js';

export { DEFAULT_CREDIT_DAYS };
const MAX_BILLS_PER_REMINDER = 200;
const IST = 'Asia/Kolkata';

/** { hour: 0-23, day: 'YYYY-MM-DD' } in IST. */
export function istNow(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return { hour: parseInt(parts.hour, 10), day: `${parts.year}-${parts.month}-${parts.day}` };
}

export function addDaysIso(isoDay, days) {
  const d = new Date(`${isoDay}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "09:00 AM" / "5:00 PM" / "14:00" → hour, else -1. */
export function parseHour(timeStr) {
  if (!timeStr) return -1;
  const match = String(timeStr).match(/(\d+):(\d+)\s*(AM|PM)?/i);
  if (!match) return -1;
  let h = parseInt(match[1], 10);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === 'PM' && h !== 12) h += 12;
  if (meridiem === 'AM' && h === 12) h = 0;
  return h >= 0 && h < 24 ? h : -1;
}

export function formatIndianDate(isoDay) {
  if (!isoDay) return '';
  const d = new Date(`${String(isoDay).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const realKey = (v) => Boolean(v) && !String(v).startsWith('DUMMY');

/** Placeholder keys count as not configured, so no fake "sent" rows are logged. */
export function channelAvailability(env = process.env) {
  return {
    whatsapp: realKey(env.CRONBERRY_TOKEN),
    sms: realKey(env.PROACTIVE_SMS_API_KEY),
    email: realKey(env.AWS_SES_ACCESS_KEY),
  };
}

function cleanMobile(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

export async function findDueBills(userId, targetDay, threshold, exceptions) {
  const { rows } = await query(
    `SELECT bo.company_id, c.guid AS company_guid, c.workspace_id, c.name AS company_name,
            bo.ledger_name, bo.bill_name, bo.bill_date, bo.pending_amount, d.due::text AS due_day,
            COALESCE(NULLIF(l.mobile, ''), NULLIF(l.phone, '')) AS party_mobile,
            NULLIF(l.email, '') AS party_email
       FROM bill_outstanding bo
       JOIN companies c ON c.id = bo.company_id
       JOIN workspace_memberships m
         ON m.workspace_id = c.workspace_id AND m.user_id = $1 AND m.status = 'ACTIVE'
       LEFT JOIN ledgers l ON l.company_id = bo.company_id AND l.name = bo.ledger_name
       CROSS JOIN LATERAL (
         SELECT CASE
           WHEN bo.due_date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN LEFT(bo.due_date, 10)::date
           WHEN bo.bill_date ~ '^\\d{4}-\\d{2}-\\d{2}' THEN LEFT(bo.bill_date, 10)::date + $5::int
         END AS due
       ) d
      WHERE UPPER(COALESCE(bo.bill_type, '')) = 'DR'
        AND COALESCE(bo.pending_amount, 0) > 0
        AND bo.pending_amount >= $3
        AND d.due = $2::date
        AND NOT (bo.ledger_name = ANY($4::text[]))
      ORDER BY bo.company_id, bo.ledger_name, bo.bill_name
      LIMIT ${MAX_BILLS_PER_REMINDER}`,
    [userId, targetDay, threshold, exceptions, DEFAULT_CREDIT_DAYS]
  );
  return rows;
}

async function canSeeReceivables(userId, bill) {
  const res = await authorize({
    userId,
    workspaceId: bill.workspace_id,
    capability: 'financials.receivables.view',
    companyGuid: bill.company_guid,
  });
  return res.decision === 'ALLOW';
}

/** Claims the slot; false if this bill/reminder/channel already went out today. */
async function claimSlot(userId, bill, reminderId, channel, sendDay) {
  const { rowCount } = await query(
    `INSERT INTO payment_reminder_log
       (company_id, user_id, party_name, bill_name, amount, due_date, reminder_id, channel, status, send_day)
     VALUES ($1, $2, $3, $4, $5, $6::date, $7, $8, 'sending', $9::date)
     ON CONFLICT (company_id, party_name, bill_name, reminder_id, channel, send_day) DO NOTHING`,
    [bill.company_id, userId, bill.ledger_name, bill.bill_name, bill.pending_amount, bill.due_day, reminderId, channel, sendDay]
  );
  return rowCount > 0;
}

async function finishSlot(bill, reminderId, channel, sendDay, ok, error) {
  await query(
    `UPDATE payment_reminder_log SET status = $1, error = $2, sent_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE company_id = $3 AND party_name = $4 AND bill_name = $5 AND reminder_id = $6 AND channel = $7 AND send_day = $8::date`,
    [ok ? 'sent' : 'failed', ok ? null : String(error || 'Send failed').slice(0, 500),
      bill.company_id, bill.ledger_name, bill.bill_name, reminderId, channel, sendDay]
  );
}

function senderFor(channel, bill, ctx) {
  const common = {
    partyName: bill.ledger_name,
    businessName: bill.company_name,
    amountDue: Math.round(Number(bill.pending_amount || 0)).toLocaleString('en-IN'),
    invoiceNo: bill.bill_name || '',
    invoiceDate: formatIndianDate(bill.bill_date),
    dueDate: formatIndianDate(bill.due_day),
    contactNumber: ctx.contactNumber,
  };
  const mobile = cleanMobile(bill.party_mobile);
  if (channel === 'whatsapp' && mobile) {
    return () => sendWhatsAppReminder({ countryCode: '+91', mobile, templateName: ctx.templateName, ...common });
  }
  if (channel === 'sms' && mobile) return () => sendPaymentReminderSms({ mobile, ...common });
  if (channel === 'email' && bill.party_email) return () => sendPaymentReminderEmail({ toEmail: bill.party_email, ...common });
  return null;
}

async function runReminder(user, config, reminder, now, available) {
  const reminderId = String(reminder.id || reminder.name || `d${reminder.daysBefore || 0}`);
  const targetDay = addDaysIso(now.day, Math.max(0, parseInt(reminder.daysBefore, 10) || 0));
  const threshold = parseFloat(config.threshold) || 0;
  const exceptions = Array.isArray(reminder.exceptions) ? reminder.exceptions.map(String) : [];
  const wanted = reminder.channels || { whatsapp: true };
  const channels = ['whatsapp', 'sms', 'email'].filter((ch) => wanted[ch] && available[ch]);
  if (!channels.length) return 0;

  const bills = await findDueBills(user.id, targetDay, threshold, exceptions);
  const allowed = new Map();
  let sent = 0;
  for (const bill of bills) {
    const key = `${bill.company_id}`;
    if (!allowed.has(key)) allowed.set(key, await canSeeReceivables(user.id, bill));
    if (!allowed.get(key)) continue;
    for (const channel of channels) {
      const send = senderFor(channel, bill, {
        contactNumber: user.mobile || '',
        templateName: config.template_name || undefined,
      });
      if (!send) continue;
      if (!(await claimSlot(user.id, bill, reminderId, channel, now.day))) continue;
      let ok = false;
      let error = null;
      try {
        const res = await send();
        ok = Boolean(res?.success);
        error = res?.error || res?.message || null;
      } catch (err) {
        error = err.message;
      }
      await finishSlot(bill, reminderId, channel, now.day, ok, error);
      if (ok) sent += 1;
      else console.error(`[PaymentReminders] ${channel} failed for company ${bill.company_id} bill ${bill.bill_name}: ${error}`);
    }
  }
  return sent;
}

export async function runPaymentReminderJob(date = new Date()) {
  const now = istNow(date);
  const available = channelAvailability();
  const { rows: users } = await query(
    `SELECT id, mobile, alert_settings->'payment_reminders' AS config
       FROM users
      WHERE alert_settings->'payment_reminders' IS NOT NULL`
  );
  const summary = { hour: now.hour, day: now.day, users: 0, sent: 0 };
  for (const user of users) {
    const config = user.config || {};
    const due = (Array.isArray(config.reminders) ? config.reminders : [])
      .filter((r) => r?.enabled && parseHour(r.time) === now.hour);
    if (!due.length) continue;
    summary.users += 1;
    let sentForUser = 0;
    for (const reminder of due) {
      try {
        sentForUser += await runReminder(user, config, reminder, now, available);
      } catch (err) {
        console.error(`[PaymentReminders] user ${user.id} reminder ${reminder.id || reminder.name}:`, err.message);
      }
    }
    summary.sent += sentForUser;
    if (sentForUser > 0) {
      const { rows: tokenRows } = await query('SELECT token FROM push_tokens WHERE user_id = $1', [user.id]);
      const tokens = tokenRows.map((r) => r.token);
      if (tokens.length) {
        await sendPushNotification(tokens, {
          title: 'Payment reminders sent',
          body: `${sentForUser} payment reminder${sentForUser === 1 ? '' : 's'} sent to your customers.`,
          data: { type: 'payment_reminders_sent', screen: '/settings/sent-reminders' },
        }).catch((err) => console.error('[PaymentReminders] summary push failed:', err.message));
      }
    }
  }
  return summary;
}
