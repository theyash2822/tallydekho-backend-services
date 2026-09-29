/**
 * Stock alert multi-channel dispatch.
 * Channels: Expo push, email (user profile), WhatsApp (user mobile).
 * Delivery providers may be unconfigured — we still build payloads and
 * return { skipped: 'not_configured' } so wiring is ready.
 */
import { query } from '../db/schema.js';
import { sendLowStockPush, sendPushNotification } from './push.js';
import { sendEmail } from './email.js';
import { sendPaymentReminder as sendWhatsAppReminder } from './whatsapp.js';

function channelOn(obj, key) {
  if (!obj || typeof obj !== 'object') return false;
  return obj[key] === true;
}

function parseExpiryDays(expiryAlerts) {
  return Math.max(1, parseInt(expiryAlerts?.daysBefore ?? 30, 10) || 30);
}

function emailConfigured() {
  const key = process.env.AWS_SES_ACCESS_KEY || '';
  return Boolean(key) && !key.startsWith('DUMMY');
}

function whatsappConfigured() {
  // Stock alerts need their own template — do not reuse payment-reminder until set
  return Boolean(
    (process.env.CRONBERRY_TOKEN || process.env.WHATSAPP_API_KEY) &&
    (process.env.CRONBERRY_STOCK_TEMPLATE || process.env.WHATSAPP_STOCK_TEMPLATE)
  );
}

async function getUserContact(userId) {
  const { rows } = await query(
    `SELECT id, mobile, email, notification_settings FROM users WHERE id=$1 LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function getPushTokens(userId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (token) token FROM push_tokens
     WHERE user_id=$1 ORDER BY token, updated_at DESC`,
    [userId]
  );
  return rows.map((r) => r.token).filter(Boolean);
}

/** Deduplicate tokens per user — keep newest row per token. */
export async function pruneDuplicatePushTokens(userId) {
  await query(
    `DELETE FROM push_tokens a
     USING push_tokens b
     WHERE a.user_id = $1 AND b.user_id = $1
       AND a.token = b.token AND a.id < b.id`,
    [userId]
  ).catch(() => {});
}

/**
 * Send one stock alert event across enabled channels.
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.companyGuid
 * @param {object} opts.alertFlags — { inApp, email, whatsapp } from inventory settings
 * @param {object} opts.payload — { kind, title, body, itemName, qty, daysLeft, route }
 */
export async function dispatchStockAlert({ userId, companyGuid, alertFlags = {}, payload }) {
  const user = await getUserContact(userId);
  if (!user) return { ok: false, error: 'user_not_found' };

  const global = user.notification_settings || {};
  const results = {};

  // Push (Expo) — inApp chip means device/inbox alerts
  const wantPush = global.push_enabled !== false && (alertFlags.inApp !== false);
  if (wantPush) {
    await pruneDuplicatePushTokens(userId);
    const tokens = await getPushTokens(userId);
    if (tokens.length) {
      try {
        if (payload.kind === 'low_stock') {
          results.push = await sendLowStockPush(tokens, {
            itemName: payload.itemName,
            currentStock: payload.qty,
            reorderPoint: payload.threshold,
            companyGuid,
          });
        } else {
          results.push = await sendPushNotification(tokens, {
            title: payload.title,
            body: payload.body,
            data: { type: payload.kind || 'stock_alert', companyGuid, route: payload.route },
          });
        }
      } catch (e) {
        results.push = { success: false, error: e.message };
      }
    } else {
      results.push = { skipped: 'no_token' };
    }
  } else {
    results.push = { skipped: 'disabled' };
  }

  // Email — profile email; SES may not be configured yet
  const wantEmail = channelOn(alertFlags, 'email') && global.email_enabled !== false;
  if (wantEmail) {
    if (!user.email) {
      results.email = { skipped: 'no_email' };
    } else if (!emailConfigured()) {
      results.email = { skipped: 'not_configured', to: user.email, title: payload.title, body: payload.body };
      console.log('[stockAlert] email ready (provider later): user', userId, payload.title);
    } else {
      try {
        const html = `
          <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 32px; border: 1px solid #E5E7EB; border-radius: 12px;">
            <h2 style="color: #1A1A1A;">${payload.title || 'Stock Alert'}</h2>
            <p style="color: #555; font-size: 15px;">${payload.body || ''}</p>
            <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;">
            <p style="color: #AEACA8; font-size: 12px;">TallyDekho · Stock Alerts</p>
          </div>`;
        results.email = await sendEmail({
          to: user.email,
          subject: payload.title || 'TallyDekho Stock Alert',
          html,
        });
      } catch (e) {
        results.email = { success: false, error: e.message };
      }
    }
  } else {
    results.email = { skipped: 'disabled' };
  }

  // WhatsApp — profile mobile
  const wantWa = channelOn(alertFlags, 'whatsapp') && global.whatsapp_enabled !== false;
  if (wantWa) {
    const mobile = String(user.mobile || '').replace(/\D/g, '');
    if (!mobile || mobile.length < 10) {
      results.whatsapp = { skipped: 'no_mobile' };
    } else if (!whatsappConfigured()) {
      results.whatsapp = { skipped: 'not_configured', to: mobile, title: payload.title, body: payload.body };
      console.log('[stockAlert] whatsapp ready (provider later): user', userId, payload.title);
    } else {
      try {
        results.whatsapp = await sendWhatsAppReminder({
          countryCode: '+91',
          mobile: mobile.slice(-10),
          partyName: 'You',
          businessName: 'TallyDekho',
          amountDue: String(payload.qty ?? ''),
          invoiceNo: payload.itemName || payload.kind || 'stock',
          invoiceDate: '',
          dueDate: '',
          contactNumber: '',
          templateName: process.env.CRONBERRY_STOCK_TEMPLATE || process.env.WHATSAPP_STOCK_TEMPLATE,
        });
      } catch (e) {
        results.whatsapp = { success: false, error: e.message };
      }
    }
  } else {
    results.whatsapp = { skipped: 'disabled' };
  }

  return { ok: true, results };
}

/**
 * Daily scan: for each active user with inventory companies, emit low/neg/expiry
 * alerts (limited per company to avoid push storms).
 */
export async function runStockAlertJob() {
  const { rows: users } = await query(`
    SELECT u.id, u.mobile, u.email, u.notification_settings
    FROM users u
    WHERE EXISTS (
      SELECT 1 FROM workspace_memberships m
      WHERE m.user_id = u.id AND m.status = 'ACTIVE'
    )
  `);

  let dispatched = 0;
  for (const user of users) {
    try {
      const { rows: companies } = await query(
        `SELECT c.id, c.guid FROM companies c
         JOIN workspace_memberships m ON m.workspace_id = c.workspace_id
         WHERE m.user_id = $1 AND m.status = 'ACTIVE'
         LIMIT 5`,
        [user.id]
      );
      for (const co of companies) {
        const { rows: settRows } = await query(
          `SELECT low_stock_alerts, negative_stock_alerts, expiry_alerts, default_low_stock_level
           FROM company_inventory_settings WHERE company_id=$1 LIMIT 1`,
          [co.id]
        );
        const sett = settRows[0] || {};
        const lowFlags = sett.low_stock_alerts || { inApp: true };
        const negFlags = sett.negative_stock_alerts || { inApp: true };
        const expFlags = sett.expiry_alerts || { inApp: true, daysBefore: 30 };
        const threshold = parseInt(sett.default_low_stock_level ?? 20, 10) || 20;
        const daysBefore = parseExpiryDays(expFlags);

        if (lowFlags.inApp || lowFlags.email || lowFlags.whatsapp) {
          const { rows: low } = await query(
            `SELECT name, closing_qty FROM stocks
             WHERE company_id=$1 AND closing_qty > 0 AND closing_qty <= $2
             ORDER BY closing_qty ASC LIMIT 3`,
            [co.id, threshold]
          );
          for (const item of low) {
            await dispatchStockAlert({
              userId: user.id,
              companyGuid: co.guid,
              alertFlags: lowFlags,
              payload: {
                kind: 'low_stock',
                title: 'Low Stock Alert',
                body: `${item.name} has only ${item.closing_qty} units left`,
                itemName: item.name,
                qty: item.closing_qty,
                threshold,
                route: '/stocks/low-stock',
              },
            });
            dispatched += 1;
          }
        }

        if (negFlags.inApp || negFlags.email || negFlags.whatsapp) {
          const { rows: neg } = await query(
            `SELECT name, closing_qty FROM stocks
             WHERE company_id=$1 AND closing_qty < 0
             ORDER BY closing_qty ASC LIMIT 2`,
            [co.id]
          );
          for (const item of neg) {
            await dispatchStockAlert({
              userId: user.id,
              companyGuid: co.guid,
              alertFlags: negFlags,
              payload: {
                kind: 'negative_stock',
                title: 'Negative Stock',
                body: `${item.name} is at ${item.closing_qty} units`,
                itemName: item.name,
                qty: item.closing_qty,
                route: '/stocks/negative-stock',
              },
            });
            dispatched += 1;
          }
        }

        if (expFlags.inApp || expFlags.email || expFlags.whatsapp) {
          const { rows: exp } = await query(
            `SELECT ba.stock_item_name AS name, ba.batch_name, ba.expiry_date
             FROM batch_allocations ba
             WHERE ba.company_id=$1
               AND ba.expiry_date IS NOT NULL AND TRIM(ba.expiry_date) != ''
               AND ba.expiry_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
               AND ba.expiry_date::date <= (CURRENT_DATE + ($2::int || ' days')::interval)
             ORDER BY ba.expiry_date ASC LIMIT 3`,
            [co.id, daysBefore]
          );
          for (const item of exp) {
            await dispatchStockAlert({
              userId: user.id,
              companyGuid: co.guid,
              alertFlags: expFlags,
              payload: {
                kind: 'expiry',
                title: 'Expiry Approaching',
                body: `${item.name}${item.batch_name ? ` (${item.batch_name})` : ''} expires ${item.expiry_date}`,
                itemName: item.name,
                route: '/stocks/expiry-schedule',
              },
            });
            dispatched += 1;
          }
        }
      }
    } catch (e) {
      console.warn('[stockAlertJob] user', user.id, e.message);
    }
  }
  return { dispatched };
}

export default { dispatchStockAlert, runStockAlertJob, pruneDuplicatePushTokens };
