// Unified Notification Service — TallyDekho
// Channels: WhatsApp (Cronberry), Email (Amazon SES), SMS (Proactive)
// Each function tries all requested channels and returns combined result

import { sendWhatsAppOTP, sendPaymentReminder as sendWhatsAppReminder } from './whatsapp.js';
import { sendOTPEmail, sendPaymentReminderEmail } from './email.js';
import { sendOTPSms, sendPaymentReminderSms } from './sms.js';
import { sendPaymentReminderPush } from './push.js';
import { query } from '../db/schema.js';

/**
 * Send OTP via all available/requested channels
 * @param {object} opts
 * @param {string} opts.mobile       — digits only (no country code)
 * @param {string} opts.countryCode  — e.g. '+91'
 * @param {string} opts.email        — optional, send email OTP if provided
 * @param {string} opts.otp          — 4-6 digit OTP string
 * @param {object} opts.channels     — { whatsapp: true, email: true, sms: false }
 */
export async function sendOTP({ mobile, countryCode = '+91', email, otp, channels = {} }) {
  const results = {};
  const tasks = [];

  const useWhatsApp = channels.whatsapp !== false; // default on
  const useEmail    = channels.email === true && !!email;
  const useSMS      = channels.sms === true && !!mobile;

  if (useWhatsApp && mobile) {
    tasks.push(
      sendWhatsAppOTP(countryCode, mobile, otp)
        .then(r => { results.whatsapp = r; })
        .catch(e => { results.whatsapp = { success: false, error: e.message }; })
    );
  }

  if (useEmail && email) {
    tasks.push(
      sendOTPEmail(email, otp)
        .then(r => { results.email = r; })
        .catch(e => { results.email = { success: false, error: e.message }; })
    );
  }

  if (useSMS && mobile) {
    tasks.push(
      sendOTPSms(mobile, otp, countryCode)
        .then(r => { results.sms = r; })
        .catch(e => { results.sms = { success: false, error: e.message }; })
    );
  }

  await Promise.allSettled(tasks);

  const anySuccess = Object.values(results).some(r => r?.success);
  return { success: anySuccess, channels: results };
}

/**
 * Send Payment Reminder via requested channels
 * @param {object} opts
 * @param {string} opts.mobile
 * @param {string} opts.email          — optional
 * @param {string} opts.countryCode
 * @param {string} opts.partyName
 * @param {string} opts.businessName
 * @param {string} opts.amountDue
 * @param {string} opts.invoiceNo
 * @param {string} opts.invoiceDate
 * @param {string} opts.dueDate
 * @param {string} opts.contactNumber
 * @param {object} opts.channels       — { whatsapp: true, email: false, sms: false }
 * @param {string} opts.templateName   — optional WhatsApp template override
 */
export async function sendPaymentReminder({
  mobile, email, countryCode = '+91',
  partyName, businessName, amountDue,
  invoiceNo, invoiceDate, dueDate, contactNumber,
  channels = { whatsapp: true },
  templateName,
  userId,       // for push token lookup
  companyGuid,  // for push notification data
}) {
  const results = {};
  const tasks = [];

  // Get push tokens for user if push channel enabled
  if (channels.push && userId) {
    try {
      const { rows } = await query('SELECT token FROM push_tokens WHERE user_id=$1', [userId]);
      const tokens = rows.map(r => r.token);
      if (tokens.length > 0) {
        tasks.push(
          sendPaymentReminderPush(tokens, {
            partyName, amountDue, invoiceNo, dueDate,
            companyGuid,
          })
            .then(r => { results.push_notification = r; })
            .catch(e => { results.push_notification = { success: false, error: e.message }; })
        );
      }
    } catch (e) {
      results.push_notification = { success: false, error: e.message };
    }
  }

  if (channels.whatsapp && mobile) {
    tasks.push(
      sendWhatsAppReminder({
        countryCode, mobile, partyName, businessName,
        amountDue, invoiceNo, invoiceDate, dueDate, contactNumber,
        templateName,
      })
        .then(r => { results.whatsapp = r; })
        .catch(e => { results.whatsapp = { success: false, error: e.message }; })
    );
  }

  if (channels.email && email) {
    tasks.push(
      sendPaymentReminderEmail({
        toEmail: email, partyName, businessName,
        amountDue, invoiceNo, invoiceDate, dueDate, contactNumber,
      })
        .then(r => { results.email = r; })
        .catch(e => { results.email = { success: false, error: e.message }; })
    );
  }

  if (channels.sms && mobile) {
    tasks.push(
      sendPaymentReminderSms({
        mobile, partyName, businessName,
        amountDue, invoiceNo, dueDate,
      })
        .then(r => { results.sms = r; })
        .catch(e => { results.sms = { success: false, error: e.message }; })
    );
  }

  await Promise.allSettled(tasks);

  const anySuccess = Object.values(results).some(r => r?.success);
  return { success: anySuccess, channels: results };
}

/**
 * Send email verification OTP (profile email change)
 */
export async function sendEmailVerificationOTP(email, otp) {
  return sendOTPEmail(email, otp);
}
