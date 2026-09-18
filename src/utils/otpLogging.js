/**
 * OTPs are credentials. They must never reach production logs, where they are
 * retained and readable long after the 5-minute validity window.
 *
 * Local development still needs the code (no WhatsApp/SMS delivery), so it is
 * emitted only outside production.
 */
export function devOtpSuffix(otp) {
  if (process.env.NODE_ENV === 'production') return '';
  return ` | OTP: ${otp}`;
}
