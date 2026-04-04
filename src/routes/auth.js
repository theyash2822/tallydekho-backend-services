// Auth routes — OTP login via WhatsApp
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';

const router = Router();
const makeOtp = () => String(Math.floor(1000 + Math.random() * 9000));
const now = () => Math.floor(Date.now() / 1000);

// ─── POST /app/send-otp ───────────────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { mobileNumber, countryCode = '+91' } = req.body;
  if (!mobileNumber) return res.status(400).json({ status: false, message: 'Mobile number required' });

  const cleanMobile = mobileNumber.replace(/\D/g, '');
  if (cleanMobile.length < 6) return res.status(400).json({ status: false, message: 'Invalid mobile number' });

  const otp = makeOtp();
  const expires = Date.now() + 5 * 60 * 1000;
  const region = getRegion(countryCode);

  try {
    await query(`
      INSERT INTO users (mobile, otp, otp_expires)
      VALUES ($1, $2, $3)
      ON CONFLICT (mobile) DO UPDATE SET
        otp = EXCLUDED.otp,
        otp_expires = EXCLUDED.otp_expires,
        updated_at = $4
    `, [cleanMobile, otp, expires, now()]);

    console.log(`[OTP] Sending to ${countryCode}${cleanMobile} | Region: ${region} | OTP: ${otp}`);
    const waResult = await sendWhatsAppOTP(countryCode, cleanMobile, otp);

    if (!waResult.success) {
      console.warn(`[OTP] WhatsApp failed — OTP: ${otp}`);
      if (process.env.NODE_ENV !== 'production') {
        return res.json({ status: true, message: 'OTP generated (WhatsApp failed)', data: { otp } });
      }
      return res.json({ status: true, message: 'OTP sent to your WhatsApp number' });
    }

    const response = { status: true, message: 'OTP sent to your WhatsApp number' };
    if (process.env.NODE_ENV !== 'production') response.data = { otp };
    res.json(response);
  } catch (err) {
    console.error('[OTP] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to send OTP' });
  }
});

// ─── POST /app/verify-otp ─────────────────────────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  const { mobileNumber, otp, countryCode = '+91' } = req.body;
  if (!mobileNumber || !otp) return res.status(400).json({ status: false, message: 'Mobile number and OTP required' });

  const cleanMobile = mobileNumber.replace(/\D/g, '');

  try {
    const { rows } = await query('SELECT * FROM users WHERE mobile = $1', [cleanMobile]);
    const user = rows[0];

    if (!user) return res.status(401).json({ status: false, message: 'Mobile number not found. Please request OTP first.' });
    if (user.otp !== String(otp)) return res.status(401).json({ status: false, message: 'Invalid OTP. Please try again.' });
    if (Date.now() > user.otp_expires) return res.status(401).json({ status: false, message: 'OTP has expired. Please request a new one.' });

    const token = generateToken({ userId: user.id, mobile: cleanMobile });

    await query(`UPDATE users SET otp = NULL, otp_expires = NULL, token = $1, updated_at = $2 WHERE id = $3`,
      [token, now(), user.id]);

    // Check if device is paired
    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;

    console.log(`[AUTH] Login: ${countryCode}${cleanMobile} | User: ${user.id} | Paired: ${isPaired}`);

    res.json({
      status: true,
      message: 'OTP verified successfully',
      data: {
        token,
        isPaired,
        user: { id: user.id, mobile: cleanMobile, name: user.name || null, language: user.language || 'English' },
      },
    });
  } catch (err) {
    console.error('[VERIFY-OTP] Error:', err.message);
    res.status(500).json({ status: false, message: 'Verification failed' });
  }
});

// ─── POST /app/verify — verify token ─────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: false, message: 'Token required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = rows[0];
    if (!user) return res.json({ status: false, data: { valid: false } });

    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;

    res.json({
      status: true,
      data: { valid: true, name: user.name || null, isPaired, language: user.language || 'English', mobile: user.mobile },
    });
  } catch {
    res.json({ status: false, data: { valid: false } });
  }
});

// ─── POST /app/onboarding ─────────────────────────────────────────────────────
router.post('/onboarding', authMiddleware, async (req, res) => {
  const { name, language } = req.body || {};
  try {
    await query('UPDATE users SET name = $1, language = $2, updated_at = $3 WHERE id = $4',
      [name?.trim() || '', language || 'English', now(), req.user.userId]);
    res.json({ status: true, message: 'Profile saved successfully' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to save profile' });
  }
});

export default router;
