// Auth routes — OTP login via WhatsApp (Cronberry WABA)
// Works for India (+91), Dubai (+971), and all international numbers
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { getDb } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';

const router = Router();

// Generate 4-digit OTP
const makeOtp = () => String(Math.floor(1000 + Math.random() * 9000));

// ─── POST /app/send-otp ───────────────────────────────────────────────────────
router.post('/send-otp', async (req, res) => {
  const { mobileNumber, countryCode = '+91' } = req.body;

  if (!mobileNumber) {
    return res.status(400).json({ status: false, message: 'Mobile number required' });
  }

  // Validate: mobile should be digits only
  const cleanMobile = mobileNumber.replace(/\D/g, '');
  if (cleanMobile.length < 6) {
    return res.status(400).json({ status: false, message: 'Invalid mobile number' });
  }

  const db = getDb();
  const otp = makeOtp();
  const expires = Date.now() + 5 * 60 * 1000; // 5 minutes
  const region = getRegion(countryCode);

  // Upsert user
  db.prepare(`
    INSERT INTO users (mobile, otp, otp_expires)
    VALUES (?, ?, ?)
    ON CONFLICT(mobile) DO UPDATE SET
      otp = excluded.otp,
      otp_expires = excluded.otp_expires,
      updated_at = unixepoch()
  `).run(cleanMobile, otp, expires);

  console.log(`[OTP] Sending to ${countryCode}${cleanMobile} | Region: ${region} | OTP: ${otp}`);

  // Send via WhatsApp (Cronberry WABA)
  const waResult = await sendWhatsAppOTP(countryCode, cleanMobile, otp);

  if (!waResult.success) {
    console.warn(`[OTP] WhatsApp send failed — OTP still valid for testing: ${otp}`);
    // Don't block the user — OTP is still saved in DB
    // In dev mode, include OTP in response for testing
    if (process.env.NODE_ENV !== 'production') {
      return res.json({
        status: true,
        message: 'OTP generated (WhatsApp delivery failed — check logs)',
        data: { otp }, // Remove in production
      });
    }
    // In production, still return success so user doesn't know if number exists
    return res.json({ status: true, message: 'OTP sent to your WhatsApp number' });
  }

  const response = { status: true, message: 'OTP sent to your WhatsApp number' };
  // In dev, include OTP for easier testing
  if (process.env.NODE_ENV !== 'production') response.data = { otp };

  res.json(response);
});

// ─── POST /app/verify-otp ─────────────────────────────────────────────────────
router.post('/verify-otp', (req, res) => {
  const { mobileNumber, otp, countryCode = '+91' } = req.body;

  if (!mobileNumber || !otp) {
    return res.status(400).json({ status: false, message: 'Mobile number and OTP required' });
  }

  const cleanMobile = mobileNumber.replace(/\D/g, '');
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE mobile = ?').get(cleanMobile);

  if (!user) {
    return res.status(401).json({ status: false, message: 'Mobile number not found. Please request OTP first.' });
  }

  if (user.otp !== String(otp)) {
    return res.status(401).json({ status: false, message: 'Invalid OTP. Please try again.' });
  }

  if (Date.now() > user.otp_expires) {
    return res.status(401).json({ status: false, message: 'OTP has expired. Please request a new one.' });
  }

  // Generate JWT token
  const token = generateToken({ userId: user.id, mobile: cleanMobile });

  // Clear OTP, save token
  db.prepare(`
    UPDATE users SET otp = NULL, otp_expires = NULL, token = ?, updated_at = unixepoch()
    WHERE id = ?
  `).run(token, user.id);

  console.log(`[AUTH] Login success: ${countryCode}${cleanMobile} | User: ${user.id}`);

  res.json({
    status: true,
    message: 'OTP verified successfully',
    data: {
      token,
      user: {
        id: user.id,
        mobile: cleanMobile,
        name: user.name,
        language: user.language || 'English',
      },
    },
  });
});

// ─── POST /app/verify — verify existing token ─────────────────────────────────
router.post('/verify', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: false, message: 'Token required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    res.json({ status: true, data: { valid: true, payload } });
  } catch {
    res.json({ status: false, data: { valid: false } });
  }
});

// ─── POST /app/onboarding ─────────────────────────────────────────────────────
router.post('/onboarding', authMiddleware, (req, res) => {
  const { name, language } = req.body || {};
  const db = getDb();
  db.prepare('UPDATE users SET name=?, language=?, updated_at=unixepoch() WHERE id=?')
    .run(name?.trim() || '', language || 'English', req.user.userId);
  res.json({ status: true, message: 'Profile saved successfully' });
});

export default router;
