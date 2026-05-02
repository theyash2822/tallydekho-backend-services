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

  const BYPASS_NUMBERS = ['9078802278'];
  const otp = BYPASS_NUMBERS.includes(mobileNumber.replace(/\D/g, '')) ? '1234' : makeOtp();
  const expires = Date.now() + (otp === '1234' ? 365 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000);
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

    // Skip WhatsApp for test/bypass numbers
    const isBypass = ['9078802278'].includes(cleanMobile);

    console.log(`[OTP] Sending to ${countryCode}${cleanMobile} | Region: ${region} | OTP: ${otp} ${isBypass ? '(BYPASS)' : ''}`);
    const waResult = isBypass
      ? { success: true }
      : await sendWhatsAppOTP(countryCode, cleanMobile, otp);

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

    // isNewUser = true if name is not set (never completed onboarding)
    const isNewUser = !user.name;

    console.log(`[AUTH] Login: ${countryCode}${cleanMobile} | User: ${user.id} | Paired: ${isPaired} | New: ${isNewUser}`);

    res.json({
      status: true,
      message: 'OTP verified successfully',
      data: {
        token,
        isPaired,
        isNewUser,
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

// ─── GET /app/me ─────────────────────────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT id, mobile, name, email, language FROM users WHERE id = $1', [req.user.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ status: false, message: 'User not found' });

    // Also return company + pairing status so the mobile can restore context on fresh install
    const { rows: devices } = await query(
      'SELECT paired FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
      [req.user.userId]
    );
    const isPaired = !!(devices[0]?.paired);
    let company = null;
    if (isPaired) {
      const { rows: cos } = await query(
        'SELECT guid, name, gstin FROM companies WHERE user_id = $1 ORDER BY synced_at DESC NULLS LAST, id ASC LIMIT 1',
        [req.user.userId]
      );
      if (cos[0]) company = { guid: cos[0].guid, name: cos[0].name, gstin: cos[0].gstin || null };
    }

    res.json({
      status: true,
      data: {
        id: user.id, mobile: user.mobile, name: user.name || '', email: user.email || '', language: user.language || 'English',
        company,
        is_paired: isPaired,
      }
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch profile' });
  }
});

// ─── POST /app/me ─────────────────────────────────────────────────────────────
router.post('/me', authMiddleware, async (req, res) => {
  const { name, email, language } = req.body || {};
  try {
    await query('UPDATE users SET name = $1, email = $2, language = $3, updated_at = $4 WHERE id = $5',
      [name?.trim() || '', email?.trim() || '', language || 'English', now(), req.user.userId]);
    res.json({ status: true, message: 'Profile updated successfully' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to update profile' });
  }
});

// ─── POST /app/onboarding ─────────────────────────────────────────────────────
router.post('/onboarding', authMiddleware, async (req, res) => {
  const { name, email, language } = req.body || {};
  try {
    await query('UPDATE users SET name = $1, email = $2, language = $3, updated_at = $4 WHERE id = $5',
      [name?.trim() || '', email?.trim() || '', language || 'English', now(), req.user.userId]);
    res.json({ status: true, message: 'Profile saved successfully' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to save profile' });
  }
});

// ─── GET /app/user-settings ──────────────────────────────────────────────────
router.get('/user-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, voucher_config FROM users WHERE id=$1',
      [req.user.userId]
    );
    res.json({ status: true, data: rows[0] || {} });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to get settings' });
  }
});

// ─── PATCH /app/user-settings ─────────────────────────────────────────────────
router.patch('/user-settings', authMiddleware, async (req, res) => {
  const { language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, voucher_config } = req.body || {};
  try {
    await query(`
      UPDATE users SET
        language = COALESCE($1, language),
        currency = COALESCE($2, currency),
        number_format = COALESCE($3, number_format),
        date_format = COALESCE($4, date_format),
        theme = COALESCE($5, theme),
        kpi_autoscroll = COALESCE($6, kpi_autoscroll),
        decimal_places = COALESCE($7, decimal_places),
        voucher_config = COALESCE($8, voucher_config),
        updated_at = $9
      WHERE id = $10
    `, [language, currency, number_format, date_format, theme,
        kpi_autoscroll !== undefined ? kpi_autoscroll : null,
        decimal_places !== undefined ? decimal_places : null,
        voucher_config ? JSON.stringify(voucher_config) : null,
        now(), req.user.userId]);
    res.json({ status: true, message: 'Settings updated' });
  } catch (err) {
    console.error('[user-settings PATCH]', err);
    res.status(500).json({ status: false, message: 'Failed to update settings' });
  }
});

export default router;

// GET /app/notification-settings
router.get('/notification-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT notification_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.notification_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// PATCH /app/notification-settings
router.patch('/notification-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET notification_settings = notification_settings || $1::jsonb WHERE id=$2',
      [JSON.stringify(req.body || {}), req.user.userId]);
    res.json({ status: true, message: 'Notification settings saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// GET /app/alert-settings
router.get('/alert-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT alert_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.alert_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// PATCH /app/alert-settings
router.patch('/alert-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET alert_settings = alert_settings || $1::jsonb WHERE id=$2',
      [JSON.stringify(req.body || {}), req.user.userId]);
    res.json({ status: true, message: 'Alert settings saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// GET /app/integration-settings
router.get('/integration-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT integration_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.integration_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// PATCH /app/integration-settings
router.patch('/integration-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET integration_settings = integration_settings || $1::jsonb WHERE id=$2',
      [JSON.stringify(req.body || {}), req.user.userId]);
    res.json({ status: true, message: 'Integration settings saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});
