// WhatsApp OTP Service — Cronberry WABA
// Works for both India (+91) and Dubai (+971) and any country code
import axios from 'axios';

const WABA_URL = 'https://crmapi.cronberry.com/api/v1/messages';
const WABA_TOKEN = 'Bearer Pskq6moUauaczstu5pFem2VU5ERVJTQ09SRQm3lg4mqDURnYRitEQj45NRP3xBNpo558iH7tTPwREFTSAAnS5OCSvrrfa8ycySIwQWd3eDbGOREFTSAZUq1yV39PEW7XS575Pi9qPt8FDq1tmo';
const TEMPLATE_NAME = 'otp_international';

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
