// WhatsApp OTP Service — Cronberry WABA
// Works for both India (+91) and Dubai (+971) and any country code
import axios from 'axios';

const WABA_URL = process.env.CRONBERRY_URL || 'https://crmapi.cronberry.com/api/v1/messages';
const WABA_TOKEN = `Bearer ${process.env.CRONBERRY_TOKEN || ''}`;
const TEMPLATE_NAME = process.env.CRONBERRY_TEMPLATE || 'otp_international';

/**
 * Send OTP via WhatsApp (Cronberry WABA)
 * Works for India (+91), Dubai (+971), and all international numbers
 * @param {string} countryCode — e.g. "+91", "+971", "+1"
 * @param {string} mobile — digits only, e.g. "9820012345"
 * @param {string} otp — 4-digit OTP string
 */
export async function sendWhatsAppOTP(countryCode, mobile, otp) {
  // Normalize country code — strip leading +
  const cc = countryCode.replace(/^\+/, '');

  // Build recipient number — countryCode + mobile (no + prefix)
  const to = `${cc}${mobile}`;

  const data = JSON.stringify({
    to,
    recipient_type: 'individual',
    type: 'template',
    template: {
      language: {
        policy: 'deterministic',
        code: 'en',
      },
      name: TEMPLATE_NAME,
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: otp,
            },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [
            {
              type: 'text',
              text: otp,
            },
          ],
        },
      ],
    },
  });

  try {
    const response = await axios.request({
      method: 'post',
      maxBodyLength: Infinity,
      url: WABA_URL,
      headers: {
        'Content-Type': 'application/json',
        Authorization: WABA_TOKEN,
      },
      data,
      timeout: 10000,
    });

    console.log(`[WABA] OTP sent to +${to} | status: ${response.status}`);
    return { success: true, response: response.data };
  } catch (err) {
    const status = err.response?.status;
    const msg = err.response?.data?.message || err.message;
    console.error(`[WABA] Failed to send OTP to +${to} | ${status} | ${msg}`);
    return { success: false, error: msg, status };
  }
}

/**
 * Detect region from country code for logging/analytics
 */
export function getRegion(countryCode) {
  const cc = countryCode.replace(/^\+/, '');
  if (cc === '91') return 'India';
  if (cc === '971') return 'UAE/Dubai';
  if (cc === '1') return 'USA/Canada';
  if (cc === '44') return 'UK';
  if (cc === '65') return 'Singapore';
  return 'International';
}

/**
 * Send Payment Reminder via WhatsApp (Cronberry WABA)
 * Template: "payment reminder"
 * Variables:
 *   {{1}} party_name      — e.g. "Ashish Lokendrasingh"
 *   {{2}} business_name   — your company name
 *   {{3}} amount_due      — e.g. "₹5,000"
 *   {{4}} invoice_no      — e.g. "INV-001"
 *   {{5}} invoice_date    — e.g. "02/05/2026"
 *   {{6}} due_date        — e.g. "15/05/2026"
 *   {{7}} contact_number  — your contact number
 */
export async function sendPaymentReminder({ 
  countryCode = '+91', mobile, 
  partyName, businessName, amountDue, 
  invoiceNo, invoiceDate, dueDate, contactNumber,
  templateName // optional override from user settings
}) {
  const cc = (countryCode || '+91').replace(/^\+/, '');
  const to = `${cc}${mobile}`;
  const resolvedTemplate = templateName || process.env.CRONBERRY_REMINDER_TEMPLATE || 'payment reminder';

  const data = JSON.stringify({
    to,
    recipient_type: 'individual',
    type: 'template',
    template: {
      language: { policy: 'deterministic', code: 'en' },
      name: resolvedTemplate,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: partyName       || 'Customer'     }, // {{1}}
            { type: 'text', text: businessName    || 'Company'      }, // {{2}}
            { type: 'text', text: amountDue       || '₹0'           }, // {{3}}
            { type: 'text', text: invoiceNo       || ''             }, // {{4}}
            { type: 'text', text: invoiceDate     || ''             }, // {{5}}
            { type: 'text', text: dueDate         || ''             }, // {{6}}
            { type: 'text', text: contactNumber   || ''             }, // {{7}}
          ],
        },
      ],
    },
  });

  try {
    const { default: axios } = await import('axios');
    const response = await axios.request({
      method: 'post',
      maxBodyLength: Infinity,
      url: process.env.CRONBERRY_URL || 'https://crmapi.cronberry.com/api/v1/messages',
      headers: {
        'Authorization': `Bearer ${process.env.CRONBERRY_TOKEN || ''}`,
        'Content-Type': 'application/json',
      },
      data,
    });
    return { success: true, data: response.data };
  } catch (err) {
    // The provider echoes the request back on failure, template variables and
    // all. Log the message it chose, not the body we sent it.
    const msg = err?.response?.data?.message || err.message;
    console.error(`[WhatsApp Reminder] failed | ${err?.response?.status || 'no status'} | ${msg}`);
    return { success: false, error: msg };
  }
}
