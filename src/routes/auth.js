// Auth routes — OTP login via WhatsApp
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';

// Pre-auth token — issued after OTP, before 2FA PIN verified
// Has limited scope: only usable for /app/verify-pin and /app/reset-pin
const generatePreAuthToken = (userId, mobile) =>
  jwt.sign({ userId, mobile, scope: 'pre_auth' }, process.env.JWT_SECRET, { expiresIn: '5m' });

// Middleware to verify pre-auth token (for PIN verify step)
const preAuthMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return res.status(401).json({ status: false, message: 'Pre-auth token required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.scope !== 'pre_auth') return res.status(401).json({ status: false, message: 'Invalid token scope' });
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ status: false, message: 'Pre-auth token expired or invalid' });
  }
};

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

    // ── 2FA check ──────────────────────────────────────────────────────────
    if (user.two_fa_enabled && user.two_fa_pin_hash) {
      // Clear OTP but DO NOT issue a full token yet — issue a scoped pre-auth token instead
      await query('UPDATE users SET otp = NULL, otp_expires = NULL, updated_at = $1 WHERE id = $2', [now(), user.id]);
      const preAuthToken = generatePreAuthToken(user.id, cleanMobile);
      console.log(`[AUTH] 2FA required for user ${user.id}`);
      return res.json({
        status: true,
        message: '2FA verification required',
        data: {
          requires2FA: true,
          biometric_enabled: user.biometric_enabled || false,
          pre_auth_token: preAuthToken,
        },
      });
    }

    // ── No 2FA — issue full token ───────────────────────────────────────────
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
        requires2FA: false,
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

// ─── POST /app/verify-pin ─────────────────────────────────────────────────────
// Called after OTP when 2FA is enabled. Requires pre_auth_token.
// On success: issues a full JWT.
router.post('/verify-pin', preAuthMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ status: false, message: 'PIN required' });

  try {
    const { rows } = await query(
      'SELECT id, mobile, name, language, two_fa_pin_hash FROM users WHERE id=$1',
      [req.user.userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ status: false, message: 'User not found' });

    const match = await bcrypt.compare(String(pin), user.two_fa_pin_hash);
    if (!match) return res.status(401).json({ status: false, message: 'Incorrect PIN. Try again.' });

    const token = generateToken({ userId: user.id, mobile: user.mobile });
    await query('UPDATE users SET token = $1, updated_at = $2 WHERE id = $3', [token, now(), user.id]);

    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id=$1 AND paired=TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;
    const isNewUser = !user.name;

    console.log(`[2FA] PIN verified for user ${user.id}`);
    res.json({
      status: true,
      message: 'PIN verified successfully',
      data: {
        token,
        isPaired,
        isNewUser,
        user: { id: user.id, mobile: user.mobile, name: user.name || null, language: user.language || 'English' },
      },
    });
  } catch (err) {
    console.error('[verify-pin]', err.message);
    res.status(500).json({ status: false, message: 'Verification failed' });
  }
});

// ─── POST /app/set-pin ────────────────────────────────────────────────────────
// Set or update the 2FA PIN. Requires full auth token.
router.post('/set-pin', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ status: false, message: 'PIN must be at least 4 characters' });

  try {
    const hash = await bcrypt.hash(String(pin), 10);
    await query(
      'UPDATE users SET two_fa_pin_hash=$1, two_fa_enabled=TRUE, updated_at=$2 WHERE id=$3',
      [hash, now(), req.user.userId]
    );
    console.log(`[2FA] PIN set for user ${req.user.userId}`);
    res.json({ status: true, message: '2FA PIN set successfully' });
  } catch (err) {
    console.error('[set-pin]', err.message);
    res.status(500).json({ status: false, message: 'Failed to set PIN' });
  }
});

// ─── POST /app/reset-pin ──────────────────────────────────────────────────────
// Reset PIN using a freshly verified OTP (pre_auth_token from verify-otp with 2FA bypassed).
// Flow: user requests OTP → verifies OTP with reset_pin=true → gets pre_auth_token → sets new PIN here.
router.post('/reset-pin', preAuthMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ status: false, message: 'PIN must be at least 4 characters' });

  try {
    const hash = await bcrypt.hash(String(pin), 10);
    await query(
      'UPDATE users SET two_fa_pin_hash=$1, two_fa_enabled=TRUE, updated_at=$2 WHERE id=$3',
      [hash, now(), req.user.userId]
    );

    // After reset, issue a full token so user can log in
    const { rows } = await query('SELECT mobile, name, language FROM users WHERE id=$1', [req.user.userId]);
    const user = rows[0];
    const token = generateToken({ userId: req.user.userId, mobile: user.mobile });
    await query('UPDATE users SET token=$1 WHERE id=$2', [token, req.user.userId]);

    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id=$1 AND paired=TRUE LIMIT 1', [req.user.userId]);
    console.log(`[2FA] PIN reset for user ${req.user.userId}`);
    res.json({
      status: true,
      message: 'PIN reset successfully',
      data: {
        token,
        isPaired: devices.length > 0,
        isNewUser: !user.name,
        user: { id: req.user.userId, mobile: user.mobile, name: user.name || null, language: user.language || 'English' },
      },
    });
  } catch (err) {
    console.error('[reset-pin]', err.message);
    res.status(500).json({ status: false, message: 'Failed to reset PIN' });
  }
});

// ─── DELETE /app/remove-pin ───────────────────────────────────────────────────
// Disable 2FA entirely. Requires full auth + correct current PIN.
router.delete('/remove-pin', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ status: false, message: 'Current PIN required to disable 2FA' });

  try {
    const { rows } = await query('SELECT two_fa_pin_hash FROM users WHERE id=$1', [req.user.userId]);
    const user = rows[0];
    if (!user?.two_fa_pin_hash) return res.json({ status: true, message: '2FA already disabled' });

    const match = await bcrypt.compare(String(pin), user.two_fa_pin_hash);
    if (!match) return res.status(401).json({ status: false, message: 'Incorrect PIN' });

    await query(
      'UPDATE users SET two_fa_enabled=FALSE, two_fa_pin_hash=NULL, updated_at=$1 WHERE id=$2',
      [now(), req.user.userId]
    );
    console.log(`[2FA] Disabled for user ${req.user.userId}`);
    res.json({ status: true, message: '2FA disabled' });
  } catch (err) {
    console.error('[remove-pin]', err.message);
    res.status(500).json({ status: false, message: 'Failed to disable 2FA' });
  }
});

// ─── PATCH /app/set-biometric ─────────────────────────────────────────────────
// Enable/disable biometric login.
router.patch('/set-biometric', authMiddleware, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ status: false, message: 'enabled (boolean) required' });
  try {
    await query('UPDATE users SET biometric_enabled=$1, updated_at=$2 WHERE id=$3', [enabled, now(), req.user.userId]);
    res.json({ status: true, message: `Biometric ${enabled ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// ─── GET /app/two-fa-status ───────────────────────────────────────────────────
// Get current 2FA status for the profile screen.
router.get('/two-fa-status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT two_fa_enabled, biometric_enabled FROM users WHERE id=$1',
      [req.user.userId]
    );
    const u = rows[0] || {};
    res.json({ status: true, data: { two_fa_enabled: u.two_fa_enabled || false, biometric_enabled: u.biometric_enabled || false } });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

export default router;
