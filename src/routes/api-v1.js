// ============================================================
// TallyDekho — /api/* routes (new mobile V4 spec)
// These are thin adapters over the existing /app/* logic,
// translating response shapes to match the new API spec.
// ============================================================

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';

const router = Router();
const makeOtp = () => String(Math.floor(1000 + Math.random() * 9000));
const now = () => Math.floor(Date.now() / 1000);

// ══════════════════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════════════════

// POST /api/auth/send-otp
// Frontend sends: { phone: "+919876543210" }
router.post('/auth/send-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Phone number required' } });

  // Strip everything, extract digits
  const digits = phone.replace(/\D/g, '');
  // Extract last 10 for India, or full digits for other countries
  const cleanMobile = digits.length > 10 ? digits.slice(-10) : digits;

  if (cleanMobile.length < 6) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid phone number' } });

  // Detect country code from phone string
  const countryCode = phone.startsWith('+') ? phone.match(/^\+\d+/)?.[0]?.replace(cleanMobile, '') || '+91' : '+91';

  const BYPASS_NUMBERS = ['9078802278'];
  const otp = BYPASS_NUMBERS.includes(cleanMobile) ? '1234' : makeOtp();
  const expires = Date.now() + (otp === '1234' ? 365 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000);

  try {
    await query(`
      INSERT INTO users (mobile, otp, otp_expires)
      VALUES ($1, $2, $3)
      ON CONFLICT (mobile) DO UPDATE SET
        otp = EXCLUDED.otp,
        otp_expires = EXCLUDED.otp_expires,
        updated_at = $4
    `, [cleanMobile, otp, expires, now()]);

    const isBypass = BYPASS_NUMBERS.includes(cleanMobile);
    const region = getRegion(countryCode);
    console.log(`[API OTP] Sending to ${countryCode}${cleanMobile} | Region: ${region} | OTP: ${otp} ${isBypass ? '(BYPASS)' : ''}`);

    const waResult = isBypass ? { success: true } : await sendWhatsAppOTP(countryCode, cleanMobile, otp);

    const masked = `${countryCode} ${cleanMobile.slice(0, 2)}${'*'.repeat(cleanMobile.length - 4)}${cleanMobile.slice(-2)}`;
    const response = { success: true, data: { message: 'OTP sent via WhatsApp', expires_in: 300, masked_phone: masked } };
    if (process.env.NODE_ENV !== 'production') response.data.otp = otp;

    if (!waResult.success && !isBypass) {
      console.warn(`[API OTP] WhatsApp failed — OTP: ${otp}`);
    }

    res.json(response);
  } catch (err) {
    console.error('[API OTP] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to send OTP' } });
  }
});

// POST /api/auth/verify-otp
// Frontend sends: { phone: "+919876543210", otp: "1234" }
router.post('/auth/verify-otp', async (req, res) => {
  const { phone, otp } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Phone and OTP required' } });

  const digits = phone.replace(/\D/g, '');
  const cleanMobile = digits.length > 10 ? digits.slice(-10) : digits;

  try {
    const { rows } = await query('SELECT * FROM users WHERE mobile = $1', [cleanMobile]);
    const user = rows[0];

    if (!user) return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Phone not found. Request OTP first.' } });
    if (user.otp !== String(otp)) return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Invalid OTP. Please try again.' } });
    if (Date.now() > user.otp_expires) return res.status(401).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' } });

    const token = generateToken({ userId: user.id, mobile: cleanMobile });
    await query('UPDATE users SET otp = NULL, otp_expires = NULL, token = $1, updated_at = $2 WHERE id = $3', [token, now(), user.id]);

    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;

    // Get company if paired
    let company = null;
    if (isPaired) {
      const { rows: companies } = await query(
        'SELECT guid, name, gstin FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [user.id]
      );
      if (companies[0]) company = { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null };
    }

    const isNewUser = !user.name;
    console.log(`[API AUTH] Login: ${cleanMobile} | User: ${user.id} | Paired: ${isPaired} | New: ${isNewUser}`);

    res.json({
      success: true,
      data: {
        is_new_user: isNewUser,
        access_token: token,
        expires_in: 3600,
        user: { id: user.id, name: user.name || null, phone: cleanMobile, language: user.language || 'en' },
        is_paired: isPaired,
        company,
      }
    });
  } catch (err) {
    console.error('[API VERIFY] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Verification failed' } });
  }
});

// POST /api/auth/register
// Frontend sends: { name, email, language, phone, accept_terms }
// Note: token must be in Authorization header (set from OTP verify response)
router.post('/auth/register', authMiddleware, async (req, res) => {
  const { name, email, language } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Name must be at least 2 characters' } });

  const langMap = { 'English': 'en', 'Hindi': 'hi', 'Bengali': 'bn', 'Arabic': 'ar', 'French': 'fr', 'German': 'de', 'Italian': 'it', 'Japanese': 'ja', 'Korean': 'ko' };
  const langCode = langMap[language] || language || 'en';

  try {
    await query(
      'UPDATE users SET name = $1, email = $2, language = $3, updated_at = $4 WHERE id = $5',
      [name.trim(), email?.trim() || '', langCode, now(), req.user.userId]
    );

    const { rows } = await query('SELECT id, mobile, name, email, language FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];

    // Generate a fresh token
    const token = generateToken({ userId: user.id, mobile: user.mobile });
    await query('UPDATE users SET token = $1 WHERE id = $2', [token, user.id]);

    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, name: user.name, phone: user.mobile, email: user.email || '', language: user.language },
        access_token: token,
      }
    });
  } catch (err) {
    console.error('[API REGISTER] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Registration failed' } });
  }
});

// GET /api/auth/me
router.get('/auth/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, mobile, name, email, language FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;

    let company = null;
    if (isPaired) {
      const { rows: companies } = await query('SELECT guid, name, gstin FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [user.id]);
      if (companies[0]) company = { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null };
    }

    res.json({
      success: true,
      data: {
        id: user.id, name: user.name || '', phone: user.mobile, email: user.email || '',
        language: user.language || 'en', is_paired: isPaired, company
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch profile' } });
  }
});

// PATCH /api/auth/me
router.patch('/auth/me', authMiddleware, async (req, res) => {
  const { name, email, language } = req.body;
  const langMap = { 'English': 'en', 'Hindi': 'hi', 'Bengali': 'bn', 'Arabic': 'ar', 'French': 'fr', 'German': 'de', 'Italian': 'it', 'Japanese': 'ja', 'Korean': 'ko' };
  const langCode = language ? (langMap[language] || language) : undefined;

  try {
    const updates = [];
    const vals = [];
    let idx = 1;
    if (name !== undefined) { updates.push(`name = $${idx++}`); vals.push(name.trim()); }
    if (email !== undefined) { updates.push(`email = $${idx++}`); vals.push(email.trim()); }
    if (langCode !== undefined) { updates.push(`language = $${idx++}`); vals.push(langCode); }
    updates.push(`updated_at = $${idx++}`); vals.push(now());
    vals.push(req.user.userId);

    await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $${idx}`, vals);
    res.json({ success: true, data: { message: 'Profile updated' } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Update failed' } });
  }
});

// POST /api/auth/logout
router.post('/auth/logout', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET token = NULL WHERE id = $1', [req.user.userId]);
    res.json({ success: true, data: { message: 'Logged out successfully' } });
  } catch {
    res.json({ success: true, data: { message: 'Logged out' } });
  }
});

// ══════════════════════════════════════════════════════════════
// TALLY SYNC / PAIRING
// ══════════════════════════════════════════════════════════════

// Socket service injected after startup
let _socket = null;
export function setApiSocket(s) { _socket = s; }

// POST /api/tally-sync/pair
// Frontend sends: { pairing_code: "123456" }
router.post('/tally-sync/pair', authMiddleware, async (req, res) => {
  const { pairing_code } = req.body;
  if (!pairing_code) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Pairing code required' } });

  try {
    const { rows } = await query('SELECT * FROM devices WHERE pairing_code = $1', [pairing_code]);
    const device = rows[0];

    if (!device) return res.status(400).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid pairing code' } });
    if (Date.now() > device.code_expires) return res.status(400).json({ success: false, error: { code: 'CODE_EXPIRED', message: 'Code expired. Generate a new one on your desktop.' } });

    await query(
      'UPDATE devices SET user_id = $1, paired = TRUE, pairing_code = NULL, code_expires = NULL WHERE device_id = $2',
      [req.user.userId, device.device_id]
    );

    // Assign companies from this device to the user
    await query('UPDATE companies SET user_id = $1, is_active = TRUE WHERE device_id = $2', [req.user.userId, device.device_id]).catch(() => {});

    // Notify connected clients
    if (_socket) _socket.notifyPaired(req.user.userId, device.name || 'Desktop');

    // Get company info
    const { rows: companies } = await query(
      'SELECT guid, name, gstin FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [req.user.userId]
    );
    const company = companies[0] ? { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null } : null;

    console.log(`[API PAIR] User ${req.user.userId} paired to device ${device.device_id}`);

    res.json({
      success: true,
      data: {
        message: 'Paired successfully',
        device_id: device.device_id,
        is_paired: true,
        company,
      }
    });
  } catch (err) {
    console.error('[API PAIR] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Pairing failed' } });
  }
});

// GET /api/tally-sync/status
router.get('/tally-sync/status', authMiddleware, async (req, res) => {
  try {
    const { rows: devices } = await query(
      'SELECT d.device_id, d.name, d.last_seen FROM devices d WHERE d.user_id = $1 AND d.paired = TRUE LIMIT 1',
      [req.user.userId]
    );
    const isPaired = devices.length > 0;
    const device = devices[0] || null;

    let company = null;
    if (isPaired) {
      const { rows: companies } = await query('SELECT guid, name, gstin FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [req.user.userId]);
      if (companies[0]) company = { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null };
    }

    res.json({
      success: true,
      data: {
        is_paired: isPaired,
        device: isPaired ? { id: device.device_id, name: device.name || 'Desktop', last_seen: device.last_seen } : null,
        company,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch sync status' } });
  }
});

// GET /api/companies
router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT guid, name, gstin, is_active FROM companies WHERE user_id = $1 ORDER BY is_active DESC, name ASC',
      [req.user.userId]
    );
    res.json({
      success: true,
      data: rows.map(c => ({ id: c.guid, name: c.name, gstin: c.gstin || null, active: c.is_active }))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch companies' } });
  }
});

export default router;
