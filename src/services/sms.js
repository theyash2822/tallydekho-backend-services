// SMS Service — Proactive SMS
// Used for: SMS OTP, Payment Reminders
import axios from 'axios';

const BASE_URL    = process.env.PROACTIVE_SMS_BASE_URL       || 'https://api.proactivesms.in/api';
const API_KEY     = process.env.PROACTIVE_SMS_API_KEY        || '';
const SENDER_ID   = process.env.PROACTIVE_SMS_SENDER_ID      || 'TALLYD';
const OTP_TPL     = process.env.PROACTIVE_SMS_OTP_TEMPLATE_ID      || '';
const REMIND_TPL  = process.env.PROACTIVE_SMS_REMINDER_TEMPLATE_ID || '';

function isDummy() {
  return !API_KEY || API_KEY.startsWith('DUMMY');
}

// ─── Send OTP SMS ─────────────────────────────────────────────────────────────
export async function sendOTPSms(mobileNumber, otp, countryCode = '+91') {
  if (isDummy()) {
    console.log(`[SMS MOCK] OTP ${otp} → ${countryCode}${mobileNumber}`);
    return { success: true, mock: true };
  }

  // Normalize mobile — strip country code prefix if present
  const mobile = mobileNumber.replace(/^\+?91/, '').replace(/\D/g, '');
  const message = `${otp} is your TallyDekho OTP. Valid for 5 minutes. Do not share.`;

  try {
    const res = await axios.post(`${BASE_URL}/send-sms`, {
      apiKey:     API_KEY,
      senderId:   SENDER_ID,
      mobile:     `91${mobile}`,
      message,
      templateId: OTP_TPL,
    }, { timeout: 8000 });

    console.log(`[SMS] OTP sent to ${mobile} | status: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error(`[SMS] OTP failed to ${mobile} | ${msg}`);
    return { success: false, error: msg };
  }
}

// ─── Send Payment Reminder SMS ────────────────────────────────────────────────
export async function sendPaymentReminderSms({
  mobile, partyName, businessName,
  amountDue, invoiceNo, dueDate,
}) {
  if (isDummy()) {
    console.log(`[SMS MOCK] Reminder → ${mobile}`);
    return { success: true, mock: true };
  }

  const cleanMobile = mobile.replace(/^\+?91/, '').replace(/\D/g, '');
  // DLT template format — variables match your approved template
  const message = `Dear ${partyName}, your invoice ${invoiceNo} of Rs.${amountDue} from ${businessName} is due on ${dueDate}. Please pay at earliest. -TallyDekho`;

  try {
    const res = await axios.post(`${BASE_URL}/send-sms`, {
      apiKey:     API_KEY,
      senderId:   SENDER_ID,
      mobile:     `91${cleanMobile}`,
      message,
      templateId: REMIND_TPL,
    }, { timeout: 8000 });

    console.log(`[SMS] Reminder sent to ${cleanMobile} | status: ${res.status}`);
    return { success: true, data: res.data };
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error(`[SMS] Reminder failed to ${cleanMobile} | ${msg}`);
    return { success: false, error: msg };
  }
}

export default { sendOTPSms, sendPaymentReminderSms };
