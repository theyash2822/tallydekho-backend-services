// Email Service — Amazon SES via Nodemailer
// Used for: Email OTP verification, Payment Reminders, general notifications
import nodemailer from 'nodemailer';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const FROM_EMAIL = process.env.AWS_SES_FROM_EMAIL || 'noreply@tallydekho.com';
const REGION     = process.env.AWS_SES_REGION     || 'ap-south-1';

// Build SES-backed Nodemailer transport
function createTransport() {
  if (!process.env.AWS_SES_ACCESS_KEY || process.env.AWS_SES_ACCESS_KEY.startsWith('DUMMY')) {
    console.warn('[Email] AWS SES not configured — using ethereal test transport');
    return null; // will use mock in dev
  }
  return nodemailer.createTransport({
    SES: {
      ses: new SESClient({
        region: REGION,
        credentials: {
          accessKeyId:     process.env.AWS_SES_ACCESS_KEY,
          secretAccessKey: process.env.AWS_SES_SECRET_KEY,
        },
      }),
      aws: { SendEmailCommand },
    },
  });
}

let _transport = null;
function getTransport() {
  if (!_transport) _transport = createTransport();
  return _transport;
}

// ─── Send OTP Email ──────────────────────────────────────────────────────────
export async function sendOTPEmail(toEmail, otp) {
  const subject = 'Your TallyDekho OTP';
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: auto; padding: 32px; border: 1px solid #E5E7EB; border-radius: 12px;">
      <h2 style="color: #1A1A1A; margin-bottom: 8px;">TallyDekho</h2>
      <p style="color: #555; font-size: 15px;">Your One-Time Password (OTP) for email verification is:</p>
      <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #1A1A1A; margin: 24px 0; text-align: center;">
        ${otp}
      </div>
      <p style="color: #777; font-size: 13px;">This OTP is valid for 5 minutes. Do not share it with anyone.</p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;">
      <p style="color: #AEACA8; font-size: 12px;">TallyDekho · Made in India 🇮🇳</p>
    </div>
  `;

  return sendEmail({ to: toEmail, subject, html });
}

// ─── Send Payment Reminder Email ─────────────────────────────────────────────
export async function sendPaymentReminderEmail({
  toEmail, partyName, businessName,
  amountDue, invoiceNo, invoiceDate, dueDate, contactNumber,
}) {
  const subject = `Payment Reminder — ${invoiceNo} — ₹${amountDue}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 32px; border: 1px solid #E5E7EB; border-radius: 12px;">
      <h2 style="color: #1A1A1A;">Payment Reminder</h2>
      <p style="color: #555; font-size: 15px;">Dear <strong>${partyName}</strong>,</p>
      <p style="color: #555;">This is a friendly reminder from <strong>${businessName}</strong> for the following outstanding amount:</p>
      <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
        <tr style="background: #F9F9F7;">
          <td style="padding: 10px 14px; color: #787774; font-size: 13px;">Invoice No</td>
          <td style="padding: 10px 14px; font-weight: 600; color: #1A1A1A;">${invoiceNo}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; color: #787774; font-size: 13px;">Invoice Date</td>
          <td style="padding: 10px 14px; color: #1A1A1A;">${invoiceDate}</td>
        </tr>
        <tr style="background: #F9F9F7;">
          <td style="padding: 10px 14px; color: #787774; font-size: 13px;">Due Date</td>
          <td style="padding: 10px 14px; color: #C0392B; font-weight: 600;">${dueDate}</td>
        </tr>
        <tr>
          <td style="padding: 10px 14px; color: #787774; font-size: 13px;">Amount Due</td>
          <td style="padding: 10px 14px; font-size: 20px; font-weight: bold; color: #1A1A1A;">₹${amountDue}</td>
        </tr>
      </table>
      <p style="color: #555; font-size: 14px;">Please process the payment at your earliest convenience.</p>
      <p style="color: #555; font-size: 14px;">For queries, contact us at: <strong>${contactNumber}</strong></p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;">
      <p style="color: #AEACA8; font-size: 12px;">${businessName} · Powered by TallyDekho</p>
    </div>
  `;

  return sendEmail({ to: toEmail, subject, html });
}

// ─── Ownership transfer confirmation ─────────────────────────────────────────
export async function sendOwnershipConfirmEmail({ toEmail, workspaceName, confirmUrl, step, total = 3 }) {
  const subject = `Confirm ownership transfer (${step}/${total}) — ${workspaceName || 'Workspace'}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 32px; border: 1px solid #E5E7EB; border-radius: 12px;">
      <h2 style="color: #1A1A1A;">Ownership transfer confirmation</h2>
      <p style="color: #555; font-size: 15px;">
        Confirm step <strong>${step}</strong> of <strong>${total}</strong> for transferring ownership of
        <strong>${workspaceName || 'your workspace'}</strong>.
      </p>
      <p style="margin: 24px 0;">
        <a href="${confirmUrl}" style="display:inline-block;background:#1A1A1A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
          Confirm transfer (${step}/${total})
        </a>
      </p>
      <p style="color: #777; font-size: 13px;">If you did not start this transfer, ignore this email or revoke it in Settings.</p>
      <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;">
      <p style="color: #AEACA8; font-size: 12px;">TallyDekho · Made in India</p>
    </div>
  `;
  return sendEmail({ to: toEmail, subject, html });
}

export async function sendLifecycleConfirmEmail({
  toEmail, workspaceName, confirmUrl, step, total = 3, kind = 'RESET',
}) {
  const label = kind === 'CLOSE' ? 'close' : 'reset';
  const subject = `Confirm workspace ${label} (${step}/${total}) — ${workspaceName || 'Workspace'}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: auto; padding: 32px; border: 1px solid #E5E7EB; border-radius: 12px;">
      <h2 style="color: #1A1A1A;">Confirm workspace ${label}</h2>
      <p style="color: #555; font-size: 15px;">
        Confirm step <strong>${step}</strong> of <strong>${total}</strong> to ${label}
        <strong>${workspaceName || 'your workspace'}</strong>.
      </p>
      <p style="margin: 24px 0;">
        <a href="${confirmUrl}" style="display:inline-block;background:#B91C1C;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
          Confirm ${label} (${step}/${total})
        </a>
      </p>
      <p style="color: #777; font-size: 13px;">If you did not request this, ignore this email.</p>
    </div>
  `;
  return sendEmail({ to: toEmail, subject, html });
}

// ─── Core send function ───────────────────────────────────────────────────────
export async function sendEmail({ to, subject, html, text }) {
  const transport = getTransport();

  if (!transport) {
    // Dev mode — log and return mock success
    console.log(`[Email MOCK] To: ${to} | Subject: ${subject}`);
    return { success: true, mock: true };
  }

  try {
    const info = await transport.sendMail({
      from: `TallyDekho <${FROM_EMAIL}>`,
      to,
      subject,
      html,
      text: text || html.replace(/<[^>]*>/g, ''),
    });
    console.log(`[Email] Sent to ${to} | MessageId: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Failed to ${to} | ${err.message}`);
    return { success: false, error: err.message };
  }
}

export default { sendOTPEmail, sendPaymentReminderEmail, sendOwnershipConfirmEmail, sendEmail };
