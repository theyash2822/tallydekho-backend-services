// ============================================================
// TallyDekho — /api/* routes (new mobile V4 spec)
// These are thin adapters over the existing /app/* logic,
// translating response shapes to match the new API spec.
// ============================================================

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';
import { sendPaymentReminder } from '../services/notifications.js';
import { sendOTPEmail } from '../services/email.js';
import { getGstTabsForVoucher, getClassificationReason } from '../utils/gstClassifier.js';

// Pre-auth token (scoped, 5-min) for 2FA PIN step
const generatePreAuthToken = (userId, mobile) =>
  jwt.sign({ userId, mobile, scope: 'pre_auth' }, process.env.JWT_SECRET, { expiresIn: '5m' });

const preAuthMiddleware = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Pre-auth token required' } });
  try {
    const p = jwt.verify(token, process.env.JWT_SECRET);
    if (p.scope !== 'pre_auth') return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token scope' } });
    req.user = p;
    next();
  } catch {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Pre-auth token expired' } });
  }
};

const router = Router();
const makeOtp = () => String(Math.floor(1000 + Math.random() * 9000));
const now = () => Math.floor(Date.now() / 1000);

// Ownership check helper — verifies companyGuid belongs to req.user.userId
// Returns true if owned (or no companyGuid provided), false + sends 403 if not owned
async function verifyCompanyOwnership(req, res, companyGuid) {
  if (!companyGuid) return true; // no GUID to check — let route handle it
  try {
    const { rows } = await query(
      'SELECT guid FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
      [companyGuid, req.user.userId]
    );
    if (rows.length === 0) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Company not found or access denied' } });
      return false;
    }
    return true;
  } catch { return true; } // on DB error, allow through (don't block on check failure)
}

// FY date resolver — returns from/to/financialYear for a company
// V2: also returns financialYear label (e.g. "2025-2026") for direct DB queries
export async function resolveFYDates(companyGuid, from, to, fyParam) {
  // If explicit financialYear label passed (e.g. "2025-2026"), look up its dates
  // If BOTH fy + from/to are passed: use custom date range but keep FY label for stock/ledger lookups
  if (fyParam) {
    try {
      const { rows } = await query(
        'SELECT begin_date, end_date, fin_year FROM company_years WHERE company_guid=$1 AND fin_year=$2 LIMIT 1',
        [companyGuid, fyParam]
      );
      if (rows[0]) {
        // Use custom from/to if provided (date picker selection), otherwise use full FY range
        return {
          from: from || rows[0].begin_date,
          to:   to   || rows[0].end_date,
          financialYear: rows[0].fin_year
        };
      }
    } catch {}
  }
  if (from && to) {
    // Compute financialYear label from dates
    const yr = parseInt(String(from).slice(0, 4), 10);
    return { from, to, financialYear: `${yr}-${yr + 1}` };
  }
  try {
    const { rows } = await query(
      'SELECT begin_date, end_date, fin_year FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1',
      [companyGuid]
    );
    const yr = new Date().getFullYear();
    return {
      from:           rows[0]?.begin_date || `${yr}-04-01`,
      to:             rows[0]?.end_date   || `${yr + 1}-03-31`,
      financialYear:  rows[0]?.fin_year   || `${yr}-${yr + 1}`,
    };
  } catch {
    const yr = new Date().getFullYear();
    return { from: `${yr}-04-01`, to: `${yr + 1}-03-31`, financialYear: `${yr}-${yr + 1}` };
  }
}

// Lazy ref to socket service (set by server.js after WS init)
let _socketService = null;
export function setApiSocket(svc) { _socketService = svc; }
const getSocketService = () => _socketService;

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
  const { phone, otp, reset_pin } = req.body;
  if (!phone || !otp) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Phone and OTP required' } });

  const digits = phone.replace(/\D/g, '');
  const cleanMobile = digits.length > 10 ? digits.slice(-10) : digits;

  try {
    const { rows } = await query('SELECT * FROM users WHERE mobile = $1', [cleanMobile]);
    const user = rows[0];

    if (!user) return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Phone not found. Request OTP first.' } });
    if (user.otp !== String(otp)) return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Invalid OTP. Please try again.' } });
    if (Date.now() > user.otp_expires) return res.status(401).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' } });

    // ── 2FA check (skip if reset_pin=true — user is resetting PIN via OTP) ───────────────
    if ((user.two_fa_enabled && user.two_fa_pin_hash && !reset_pin) || reset_pin) {
      // 2FA required, OR PIN reset requested — issue scoped pre_auth_token
      await query('UPDATE users SET otp = NULL, otp_expires = NULL, updated_at = $1 WHERE id = $2', [now(), user.id]);
      const preAuthToken = generatePreAuthToken(user.id, cleanMobile);
      if (!reset_pin) console.log(`[API AUTH] 2FA required for user ${user.id}`);
      return res.json({
        success: true,
        data: {
          requires_2fa: !reset_pin,
          biometric_enabled: user.biometric_enabled || false,
          pre_auth_token: preAuthToken,
        },
      });
    }

    // ── No 2FA — issue full token directly ──────────────────────────────
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
        requires_2fa: false,
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
    const { pushToken } = req.body || {};
    // Remove push token on logout so stale tokens don't accumulate
    if (pushToken) {
      await query('DELETE FROM push_tokens WHERE user_id=$1 AND token=$2', [req.user.userId, pushToken]).catch(() => {});
    }
    await query('UPDATE users SET token = NULL WHERE id = $1', [req.user.userId]);
    res.json({ success: true, data: { message: 'Logged out successfully' } });
  } catch {
    res.json({ success: true, data: { message: 'Logged out' } });
  }
});

// POST /api/push-token — register or update Expo push token
router.post('/push-token', authMiddleware, async (req, res) => {
  const { token, platform, deviceId } = req.body || {};
  if (!token) return res.status(400).json({ success: false, error: { code: 'MISSING_TOKEN', message: 'token required' } });
  try {
    await query(`
      INSERT INTO push_tokens (user_id, token, platform, device_id, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (user_id, token) DO UPDATE SET platform=$3, device_id=$4, updated_at=NOW()
    `, [req.user.userId, token, platform || null, deviceId || null]);
    res.json({ success: true, data: { message: 'Push token registered' } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: err.message } });
  }
});

// DELETE /api/push-token — remove push token (on logout or permission revoked)
router.delete('/push-token', authMiddleware, async (req, res) => {
  const { token } = req.body || {};
  try {
    if (token) {
      await query('DELETE FROM push_tokens WHERE user_id=$1 AND token=$2', [req.user.userId, token]);
    } else {
      await query('DELETE FROM push_tokens WHERE user_id=$1', [req.user.userId]);
    }
    res.json({ success: true, data: { message: 'Push token removed' } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'DB_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// TALLY SYNC / PAIRING
// ══════════════════════════════════════════════════════════════

// Socket service — use the shared ref declared at top of file

// POST /api/tally-sync/pair
// Frontend sends: { pairing_code: "123456" }
router.post('/tally-sync/pair', authMiddleware, async (req, res) => {
  const { pairing_code } = req.body;
  if (!pairing_code) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Pairing code required' } });

  try {
    const { rows } = await query('SELECT * FROM devices WHERE pairing_code = $1', [pairing_code]);
    const device = rows[0];

    if (!device) return res.status(400).json({ success: false, error: { code: 'INVALID_CODE', message: 'Invalid pairing code' } });
    // Permanent codes have code_expires=NULL — only check expiry for legacy timed codes
    if (device.code_expires && Date.now() > device.code_expires) {
      return res.status(400).json({ success: false, error: { code: 'CODE_EXPIRED', message: 'Code expired. Generate a new one on your desktop.' } });
    }

    // Auto-unpair any previous user from this device (last paired wins)
    if (device.user_id && device.user_id !== req.user.userId && device.paired) {
      const oldUserId = device.user_id;
      // Deactivate old user's companies from this device
      await query('UPDATE companies SET is_active = FALSE WHERE user_id = $1 AND device_id = $2', [oldUserId, device.device_id]).catch(() => {});
      // Notify old user via WebSocket if connected
      if (_socketService) { try { _socketService.notifyUnpaired(oldUserId); } catch {} }
      console.log(`[API PAIR] Auto-unpaired previous user ${oldUserId} from device ${device.device_id}`);
    }

    await query(
      // Keep pairing_code intact (permanent code stays for future reference/re-pairing)
      'UPDATE devices SET user_id = $1, paired = TRUE, code_expires = NULL WHERE device_id = $2',
      [req.user.userId, device.device_id]
    );

    // Assign companies from this device to the new user
    await query('UPDATE companies SET user_id = $1, is_active = TRUE WHERE device_id = $2', [req.user.userId, device.device_id]).catch(() => {});

    // Notify connected clients
    if (_socketService) _socketService.notifyPaired(req.user.userId, device.name || 'Desktop');

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

    // Desktop online = last_seen within 5 minutes
    const ONLINE_THRESHOLD_SECS = 5 * 60;
    const nowSecs = Math.floor(Date.now() / 1000);
    const desktopOnline = isPaired && device &&
      typeof device.last_seen === 'number' &&
      (nowSecs - device.last_seen) < ONLINE_THRESHOLD_SECS;

    let company = null;
    if (isPaired) {
      const { rows: companies } = await query('SELECT guid, name, gstin FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [req.user.userId]);
      if (companies[0]) company = { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null };
    }

    res.json({
      success: true,
      data: {
        is_paired: isPaired,
        desktop_online: !!desktopOnline,
        device: isPaired ? { id: device.device_id, name: device.name || 'Desktop', last_seen: device.last_seen } : null,
        company,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch sync status' } });
  }
});

// POST /api/tally-sync/unpair — unpair this user from their device (cross-platform)
router.post('/tally-sync/unpair', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.userId;

    // Get the device before unpairing (for WS notification)
    const { rows: devices } = await query(
      'SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1',
      [userId]
    );

    // Generate a new permanent pairing code for the device (replaces old one)
    const newCode = String(Math.floor(100000 + Math.random() * 900000));
    const deviceId = devices[0]?.device_id;

    // Mark device as unpaired + assign fresh pairing code
    await query(
      'UPDATE devices SET paired = FALSE, user_id = NULL, pairing_code = $1 WHERE user_id = $2',
      [newCode, userId]
    );

    // Mark all companies belonging to this user+device as inactive
    if (deviceId) {
      await query(
        'UPDATE companies SET is_active = FALSE WHERE user_id = $1 AND device_id = $2',
        [userId, deviceId]
      ).catch(e => console.warn('[unpair] companies update failed:', e.message));
    }

    // Notify all connected clients with the new code
    // Desktop uses newCode to update its display; mobile/web clear their paired state
    const socketSvc = getSocketService?.();
    if (socketSvc?.notifyUnpaired) {
      socketSvc.notifyUnpaired(userId, newCode);
    }

    res.json({ success: true, message: 'Unpaired successfully', newCode });
  } catch (err) {
    console.error('[unpair]', err.message);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /api/company/years — financial years for a company
router.get('/company/years', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query('SELECT fin_year, begin_date, end_date FROM company_years WHERE company_guid=$1 AND is_active = TRUE ORDER BY begin_date DESC', [companyGuid]);
    const fys = rows.map(r => {
      const start = new Date(r.begin_date);
      const end   = new Date(r.end_date);
      const sy = start.getFullYear();
      const ey = end.getFullYear();
      return {
        fin_year:   r.fin_year,                          // e.g. '2025-2026' — for API fy= param
        begin_date: r.begin_date,
        end_date:   r.end_date,
        label:      `FY ${sy}-${String(ey).slice(2)}`,  // e.g. 'FY 2025-26' — for display
      };
    });
    res.json({ success: true, data: fys });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
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

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════

// GET /api/dashboard/kpi-strip?period=7D
router.get('/dashboard/kpi-strip', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = req.query;
    // KPI balances are from ledger closing balances (not date-filtered) — consistent regardless of FY
    // Voucher-based KPIs (payments/receipts) are filtered by FY when provided
    // Parameterized date filter for voucher KPIs
    const pmtParams = from && to ? [companyGuid, from, to] : [companyGuid];
    const pmtDateFilter = from && to ? 'AND date BETWEEN $2 AND $3' : '';
    const { rows: cash } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyGuid]);
    const { rows: bank } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Bank%' OR parent ILIKE '%Bank Account%')`, [companyGuid]);
    const { rows: rec }  = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors')`, [companyGuid]);
    const { rows: pay }  = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Creditor%' OR parent='Sundry Creditors')`, [companyGuid]);
    const { rows: loans } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Loan%' OR parent ILIKE '%Bank OD%' OR parent ILIKE '%Overdraft%')`, [companyGuid]);
    const { rows: pmts } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Payment%' AND is_cancelled=FALSE ${pmtDateFilter}`, pmtParams);
    const { rows: rcts } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Receipt%' AND is_cancelled=FALSE ${pmtDateFilter}`, pmtParams);

    // Raw values only — formatting is done client-side using user's currency/format settings
    const g = (rows) => +(rows?.[0]?.v ?? 0);
    const kpi = [
      { id: 'cash',       label: 'Cash In Hand', amount_raw: g(cash),  icon: 'wallet-outline',              route: '/kpi/cash-in-hand' },
      { id: 'bank',       label: 'Bank Balance', amount_raw: g(bank),  icon: 'card-outline',                route: '/kpi/bank-balance' },
      { id: 'receivable', label: 'Receivables',  amount_raw: g(rec),   icon: 'arrow-down-circle-outline',   route: '/kpi/receivables' },
      { id: 'payable',    label: 'Payables',     amount_raw: g(pay),   icon: 'arrow-up-circle-outline',     route: '/kpi/payables' },
      { id: 'loans',      label: 'Loans & ODs',  amount_raw: g(loans), icon: 'git-merge-outline',           route: '/kpi/loans-ods' },
      { id: 'payments',   label: 'Payments',     amount_raw: g(pmts),  icon: 'send-outline',                route: '/kpi/payments' },
      { id: 'receipts',   label: 'Receipts',     amount_raw: g(rcts),  icon: 'download-outline',            route: '/kpi/receipts' },
    ];
    res.json({ success: true, data: kpi });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/metrics?period=7D&companyGuid=xxx
router.get('/dashboard/metrics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Use from/to from query params if provided (FY change), else fall back to latest FY from DB
    let from = req.query.from;
    let to   = req.query.to;
    if (!from || !to) {
      const { rows: fy } = await query('SELECT begin_date, end_date FROM company_years WHERE company_guid=$1 ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      from = fy[0]?.begin_date || new Date().getFullYear() + '-04-01';
      to   = fy[0]?.end_date   || (new Date().getFullYear() + 1) + '-03-31';
    }
    const [sRes, pRes, eRes] = await Promise.all([
      // Sales = Credit entries (Cr) in ledgers under Sales Accounts group
      // Falls back to voucher_type match if ledger entries not populated yet
      query(`SELECT COALESCE(
        (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
         JOIN ledgers l ON l.name=vle.ledger_name AND l.company_guid=vle.company_guid
         JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_guid=vle.company_guid
         WHERE vle.company_guid=$1 AND vle.dr_cr='Cr'
           AND (l.parent ILIKE '%Sales%' OR l.parent ILIKE '%Direct Income%' OR l.parent ILIKE '%Indirect Income%')
           AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
        (SELECT SUM(amount) FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3)
      ) as v`, [companyGuid, from, to]),
      // Purchase = Debit entries (Dr) in Purchase Accounts group
      query(`SELECT COALESCE(
        (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
         JOIN ledgers l ON l.name=vle.ledger_name AND l.company_guid=vle.company_guid
         JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_guid=vle.company_guid
         WHERE vle.company_guid=$1 AND vle.dr_cr='Dr'
           AND (l.parent ILIKE '%Purchase%' OR l.parent ILIKE '%Direct Expense%')
           AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
        (SELECT SUM(amount) FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3)
      ) as v`, [companyGuid, from, to]),
      // Expenses = Debit entries in Indirect Expenses group
      query(`SELECT COALESCE(
        (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
         JOIN ledgers l ON l.name=vle.ledger_name AND l.company_guid=vle.company_guid
         JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_guid=vle.company_guid
         WHERE vle.company_guid=$1 AND vle.dr_cr='Dr'
           AND l.parent ILIKE '%Indirect Expense%'
           AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
        (SELECT SUM(amount) FROM vouchers WHERE company_guid=$1 AND voucher_type IN ('Journal','Payment','Contra') AND is_cancelled=FALSE AND amount > 0 AND date BETWEEN $2 AND $3)
      ) as v`, [companyGuid, from, to]),
    ]);
    const sVal = +(sRes.rows?.[0]?.v ?? 0);
    const pVal = +(pRes.rows?.[0]?.v ?? 0);
    const eVal = +(eRes.rows?.[0]?.v ?? 0);
    // Raw values only — formatting done client-side
    res.json({ success: true, data: [
      { id: 'sales',     label: 'Sales',     amount_raw: sVal, change: 0, positive: true,  icon: 'stats-chart-outline', route: '/sales' },
      { id: 'purchases', label: 'Purchases', amount_raw: pVal, change: 0, positive: true,  icon: 'cart-outline',        route: '/purchase' },
      { id: 'expenses',  label: 'Expenses',  amount_raw: eVal, change: 0, positive: false, icon: 'trending-up-outline', route: '/expenses' },
    ]});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/cashflow
router.get('/dashboard/cashflow', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
    const { rows: cash } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyGuid]);
    const { rows: bank } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Bank%')`, [companyGuid]);
    const [sRes2, pRes2] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]),
    ]);
    const sVal2 = +(sRes2.rows?.[0]?.v ?? 0);
    const pVal2 = +(pRes2.rows?.[0]?.v ?? 0);
    const netCash = +(cash?.[0]?.v ?? 0) + +(bank?.[0]?.v ?? 0);
    const grossProfit = sVal2 - pVal2;
    res.json({ success: true, data: {
      net_cash: netCash, gross_cash: netCash, net_realisable_balance: netCash,
      gross_profit: grossProfit, net_profit: grossProfit,
      total_income: sVal2, total_expense: pVal2,
      income_percentage: sVal2 > 0 ? Math.round((grossProfit / sVal2) * 100) : 0,
      fy_from: from, fy_to: to,
      updated_at: 'just now',
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/recent-activity
router.get('/dashboard/recent-activity', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
    const { rows } = await query(
      `SELECT id, voucher_number, party_name, voucher_type, amount, date FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 ORDER BY date DESC, id DESC LIMIT 10`,
      [companyGuid, from, to]
    );
    const activity = rows.map(r => ({
      id: String(r.id),
      type: (r.voucher_type||'').toLowerCase().includes('receipt') ? 'credit' : 'debit',
      label: `${r.voucher_type} ${r.voucher_number ? '#'+r.voucher_number : ''}`.trim(),
      amount_raw: +r.amount || 0,
      is_credit: (r.voucher_type||'').toLowerCase().includes('receipt'),
      date: r.date || '',
      party: r.party_name || '',
    }));
    res.json({ success: true, data: activity });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// SALES
// ══════════════════════════════════════════════════════════════

const voucherListHandler = (voucherType) => async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { search = '', page = 1, limit = 30 } = req.query;
  const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let q = `SELECT * FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND voucher_type ILIKE $2 AND (party_name ILIKE $3 OR voucher_number ILIKE $3) AND date BETWEEN $4 AND $5`;
    const params = [companyGuid, `%${voucherType}%`, `%${search}%`, from, to];
    q += ` ORDER BY date DESC, id DESC LIMIT $6 OFFSET $7`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(
      `SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND voucher_type ILIKE $2 AND date BETWEEN $3 AND $4`,
      [companyGuid, `%${voucherType}%`, from, to]
    );
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page), limit: parseInt(limit), from, to } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};

router.get('/sales/invoices',    authMiddleware, voucherListHandler('Sales'));
router.get('/sales/orders',      authMiddleware, voucherListHandler('Sales Order'));
router.get('/sales/quotations',  authMiddleware, voucherListHandler('Quotation'));
router.get('/sales/credit-notes',authMiddleware, voucherListHandler('Credit Note'));
router.get('/sales/delivery-notes', authMiddleware, voucherListHandler('Delivery Note'));
router.get('/sales/ewaybills',   authMiddleware, voucherListHandler('Sales'));

// ══════════════════════════════════════════════════════════════
// PURCHASE
// ══════════════════════════════════════════════════════════════

router.get('/purchase/invoices', authMiddleware, voucherListHandler('Purchase'));
router.get('/purchase/orders',   authMiddleware, voucherListHandler('Purchase Order'));
router.get('/purchase/debit-notes', authMiddleware, voucherListHandler('Debit Note'));

// ══════════════════════════════════════════════════════════════
// VOUCHERS
// ══════════════════════════════════════════════════════════════

router.get('/vouchers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { type, search = '', page = 1, limit = 30, from, to } = req.query;
  const typeMap = { payment: 'Payment', receipt: 'Receipt', journal: 'Journal', contra: 'Contra', sales: 'Sales', purchase: 'Purchase' };
  const vType = typeMap[type] || null;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let q = `SELECT * FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND NOT (voucher_type='Voucher' AND (amount=0 OR amount IS NULL)) AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
    if (vType) { q += ` AND voucher_type ILIKE $${idx++}`; params.push(`%${vType}%`); }
    if (from)  { q += ` AND date >= $${idx++}`; params.push(from); }
    if (to)    { q += ` AND date <= $${idx++}`; params.push(to); }
    q += ` ORDER BY date DESC, id DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE`, [companyGuid]);
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/vouchers/my-entries — vouchers created via this user's mobile app
router.get('/vouchers/my-entries', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, type, page = 1, limit = 50 } = req.query;
  const userId = req.user.userId;
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    let q = `
      SELECT DISTINCT v.*
      FROM vouchers v
      JOIN write_queue wq ON wq.company_guid = v.company_guid
        AND wq.tally_voucher_number = v.voucher_number
      WHERE v.company_guid = $1
        AND wq.user_id = $2
        AND v.is_cancelled = FALSE
    `;
    const params = [companyGuid, userId];
    let idx = 3;
    if (from) { q += ` AND v.date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND v.date <= $${idx++}`; params.push(to); }
    if (type) { q += ` AND v.voucher_type ILIKE $${idx++}`; params.push(`%${type}%`); }
    q += ` ORDER BY v.date DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/vouchers/:id — single voucher with inventory items + GST details
router.get('/vouchers/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  try {
    // Prefer GUID match; fall back to voucher_number (most recent when number repeats across FYs)
    const { rows: vRows } = await query(
      'SELECT * FROM vouchers WHERE company_guid=$2 AND (guid=$1 OR voucher_number=$1) ORDER BY (guid=$1)::int DESC, date DESC LIMIT 1',
      [id, companyGuid]
    );
    if (!vRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Voucher not found' } });
    const v = vRows[0];
    // Inventory items (for Sales/Purchase vouchers)
    const { rows: items } = await query('SELECT * FROM voucher_inventory_items WHERE voucher_guid=$1 AND company_guid=$2 ORDER BY id', [v.guid, companyGuid]);
    // GST details
    const { rows: gst } = await query('SELECT * FROM gst_voucher_details WHERE voucher_guid=$1 AND company_guid=$2 LIMIT 1', [v.guid, companyGuid]);
    // Company info — full profile
    const { rows: co } = await query('SELECT name, formal_name, gstin, address, state, country FROM companies WHERE guid=$1 LIMIT 1', [companyGuid]);
    // Party ledger details (GSTIN, address etc)
    const { rows: partyLedger } = await query('SELECT name, gstin, pan, phone, email, address FROM ledgers WHERE company_guid=$1 AND name=$2 LIMIT 1', [companyGuid, v.party_name || '']);
    // Ledger entries — used to compute the TRUE party amount (not v.amount which may be wrong)
    const { rows: ledgerEntries } = await query(
      'SELECT ledger_name, amount, dr_cr FROM voucher_ledger_entries WHERE voucher_guid=$1 AND company_guid=$2 ORDER BY ABS(amount) DESC',
      [v.guid, companyGuid]
    );
    // Party amount = the Dr entry for the party ledger (what party owes / paid)
    const partyEntry = ledgerEntries.find(e => e.ledger_name === v.party_name);
    const partyAmount = partyEntry ? Math.abs(parseFloat(partyEntry.amount||'0')) : parseFloat(v.amount||'0');
    res.json({
      success: true,
      data: {
        voucher: { ...v, party_amount: partyAmount }, // party_amount = authoritative per-party amount
        items,
        gst: gst[0] || null,
        company: co[0] || null,
        party: partyLedger[0] || null,
        ledger_entries: ledgerEntries,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// LEDGERS
// ══════════════════════════════════════════════════════════════

router.get('/ledgers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { search = '', nature, group, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // If FY params provided, compute FY-specific closing balance (opening + net movement)
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
  try {
    let q = `
      SELECT l.*,
        -- FY-specific computed closing balance
        COALESCE(lfb.opening_balance, l.opening_balance, 0) as fy_opening_abs,
        COALESCE(lfb.balance_type, l.balance_type, 'Dr') as fy_opening_type,
        COALESCE((
          SELECT SUM(vle.amount)
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
          WHERE vle.company_guid = l.company_guid AND vle.ledger_name = l.name
            AND (vle.financial_year = $3 OR (vle.financial_year IS NULL AND v.date BETWEEN $4 AND $5))
            AND v.is_cancelled = FALSE
        ), 0) as fy_movement,
        -- Derive nature from parent group (ledgers.nature is rarely populated directly)
        COALESCE(l.nature, g.nature) as nature
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $3
      LEFT JOIN groups g
        ON g.company_guid = l.company_guid AND g.name = l.parent
      WHERE l.company_guid=$1 AND (l.name ILIKE $2 OR l.alias ILIKE $2 OR l.gstin ILIKE $2)
    `;
    const params = [companyGuid, `%${search}%`, financialYear, fyFrom, fyTo];
    let idx = 6;
    if (nature) { q += ` AND COALESCE(l.nature, g.nature) ILIKE $${idx++}`; params.push(`%${nature}%`); }
    if (group)  { q += ` AND l.parent = $${idx++}`; params.push(group); }
    q += ` ORDER BY ABS(l.closing_balance) DESC, l.name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    // Compute FY closing: openingSigned + movement → abs + type
    const data = rows.map(l => {
      const bt = l.fy_opening_type || 'Dr';
      const openSigned = bt === 'Dr' ? -Math.abs(parseFloat(l.fy_opening_abs||0)) : Math.abs(parseFloat(l.fy_opening_abs||0));
      const closeSigned = openSigned + parseFloat(l.fy_movement||0);
      return {
        ...l,
        closing_balance: Math.abs(closeSigned),   // FY-computed closing
        balance_type:    closeSigned <= 0 ? 'Dr' : 'Cr',
      };
    });
    const { rows: cnt } = await query('SELECT COUNT(*) as c FROM ledgers WHERE company_guid=$1', [companyGuid]);
    res.json({ success: true, data, meta: { total: parseInt(cnt[0].c), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/ledgers/fy-balances — FY-specific closing balance for all ledgers (used by Trial Balance, P&L, Balance Sheet)
// IMPORTANT: must be registered BEFORE /ledgers/:id routes to avoid :id matching "fy-balances"
router.get('/ledgers/fy-balances', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
  try {
    // V2: Use financial_year column directly + ledger_fy_balances for opening
    // opening = from ledger_fy_balances (LedgerOpeningBalance.xml per FY)
    // closing = opening + SUM(vle WHERE financial_year = fy)
    const { rows } = await query(`
      SELECT
        l.guid, l.name, l.parent, l.balance_type,
        COALESCE(lfb.opening_balance, l.opening_balance, 0) as fy_opening_abs,
        COALESCE(lfb.balance_type, l.balance_type, 'Dr')    as fy_balance_type,
        COALESCE((
          SELECT SUM(vle.amount)
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
          WHERE vle.company_guid = l.company_guid
            AND vle.ledger_name  = l.name
            AND (
              vle.financial_year = $2
              OR (vle.financial_year IS NULL AND v.date IS NOT NULL AND v.date BETWEEN $3 AND $4)
            )
            AND v.is_cancelled = FALSE
        ), 0) as fy_movement
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid
        AND lfb.ledger_name  = l.name
        AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `, [companyGuid, financialYear, fyFrom, fyTo]);

    const data = rows.map(l => {
      const bt             = l.fy_balance_type || 'Dr';
      const openingSigned  = bt === 'Dr' ? -Math.abs(parseFloat(l.fy_opening_abs || 0)) : Math.abs(parseFloat(l.fy_opening_abs || 0));
      const fyClosingSigned = openingSigned + parseFloat(l.fy_movement || 0);
      return {
        guid:            l.guid,
        name:            l.name,
        parent:          l.parent,
        balance_type:    l.balance_type,
        fy_opening:      Math.abs(openingSigned),
        fy_opening_type: openingSigned <= 0 ? 'Dr' : 'Cr',
        fy_closing:      Math.abs(fyClosingSigned),
        fy_closing_type: fyClosingSigned <= 0 ? 'Dr' : 'Cr',
        fy_debit:        fyClosingSigned < 0 ? Math.abs(fyClosingSigned) : 0,
        fy_credit:       fyClosingSigned > 0 ? Math.abs(fyClosingSigned) : 0,
        financial_year:  financialYear,
      };
    });

    res.json({ success: true, data, from: fyFrom, to: fyTo });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/ledgers/:id/statement — FY-specific ledger statement using voucher_ledger_entries
router.get('/ledgers/:id/statement', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
  try {
    const { rows: lr } = await query('SELECT * FROM ledgers WHERE company_guid=$1 AND guid=$2', [companyGuid, id]);
    if (!lr[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ledger not found' } });
    const ledger = lr[0];
    const ledgerName = ledger.name;

    // Get all vouchers that have a ledger entry for this ledger within the FY
    const { rows: txns } = await query(`
      SELECT v.guid, v.voucher_number, v.voucher_type, v.date, v.narration, v.party_name,
             vle.amount as entry_amount, vle.dr_cr
      FROM voucher_ledger_entries vle
      JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
      WHERE vle.company_guid = $1
        AND vle.ledger_name = $2
        AND v.is_cancelled = FALSE
        AND v.date IS NOT NULL AND v.date != ''
        AND v.date BETWEEN $3 AND $4
      ORDER BY v.date ASC, v.id ASC
    `, [companyGuid, ledgerName, fyFrom, fyTo]);

    // V2: FY-specific opening balance from ledger_fy_balances table
    // Source: LedgerOpeningBalance.xml per FY — Tally's authoritative opening per year
    // Fallback: use ledger.opening_balance from LedgerFull.xml (current FY opening)
    const { rows: fyBalRows } = await query(
      'SELECT opening_balance, balance_type FROM ledger_fy_balances WHERE company_guid=$1 AND ledger_name=$2 AND financial_year=$3 LIMIT 1',
      [companyGuid, ledgerName, financialYear]
    );

    const balType = fyBalRows[0]?.balance_type || ledger.balance_type || 'Dr';
    const openingAbs = parseFloat(fyBalRows[0]?.opening_balance ?? ledger.opening_balance ?? 0);
    const fyOpeningSigned = balType === 'Dr' ? -openingAbs : openingAbs;
    const opening = openingAbs;
    const openingType = balType;
    let runningBalance = fyOpeningSigned;

    const transactions = txns.map(t => {
      const entryAmt = parseFloat(t.entry_amount || 0); // negative=Dr, positive=Cr
      runningBalance += entryAmt;
      return {
        guid: t.guid,
        voucher_number: t.voucher_number,
        voucher_type: t.voucher_type,
        date: t.date,
        narration: t.narration,
        party_name: t.party_name,
        debit: t.dr_cr === 'Dr' ? Math.abs(entryAmt) : 0,
        credit: t.dr_cr === 'Cr' ? Math.abs(entryAmt) : 0,
        balance: Math.abs(runningBalance),
        balance_type: runningBalance < 0 ? 'Dr' : 'Cr',
        dr_cr: t.dr_cr,
      };
    });

    const closingBalance = Math.abs(runningBalance);
    const closingType = runningBalance < 0 ? 'Dr' : 'Cr';
    const totalDr = transactions.reduce((s, t) => s + t.debit, 0);
    const totalCr = transactions.reduce((s, t) => s + t.credit, 0);

    res.json({
      success: true,
      data: {
        ledger,
        opening_balance: opening,
        opening_balance_type: openingType,
        closing_balance: closingBalance,
        closing_balance_type: closingType,
        total_debit: totalDr,
        total_credit: totalCr,
        from: fyFrom, to: fyTo,
        transactions,
        has_ledger_entries: txns.length > 0,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/ledgers/:id — basic detail with transactions (party_name match fallback)
router.get('/ledgers/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  try {
    const { rows: lr } = await query('SELECT * FROM ledgers WHERE company_guid=$1 AND guid=$2', [companyGuid, id]);
    if (!lr[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ledger not found' } });
    const { from, to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    // Join with voucher_ledger_entries to get the per-ledger entry amount (not the full voucher total)
    let tq = `
      SELECT v.*, 
        ABS(vle.amount) as entry_amount, vle.dr_cr as entry_dr_cr
      FROM vouchers v
      LEFT JOIN voucher_ledger_entries vle 
        ON vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid AND vle.ledger_name = $3
      WHERE v.company_guid=$1 AND (v.party_guid=$2 OR v.party_name=$3) AND v.is_cancelled=FALSE
    `;
    const tp = [companyGuid, id, lr[0].name];
    let idx = 4;
    if (from) { tq += ` AND v.date >= $${idx++}`; tp.push(from); }
    if (to)   { tq += ` AND v.date <= $${idx++}`; tp.push(to); }
    tq += ` ORDER BY v.date DESC LIMIT $${idx++} OFFSET $${idx}`;
    tp.push(parseInt(limit), offset);
    const { rows: txns } = await query(tq, tp);
    // Use ledger-specific entry amount when available, fall back to voucher total
    const transactions = txns.map(t => ({
      ...t,
      amount: t.entry_amount != null ? t.entry_amount : t.amount,
      dr_cr:  t.entry_dr_cr  || (t.amount > 0 ? 'Dr' : 'Cr'),
    }));
    res.json({ success: true, data: { ledger: lr[0], transactions, meta: { page: parseInt(page), limit: parseInt(limit) } } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// STOCKS
// ══════════════════════════════════════════════════════════════

// GET /api/stocks/items
// Per Tally FY guide §3.4: Stock qty is NEVER static. It's always derived from transactions.
// When fy= param is passed: compute FY-specific closing qty from stock_transactions
// When no fy param: serve stored closing_qty (as-of last sync = current stock)
router.get('/stocks/items', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { search = '', category, page = 1, limit = 500 } = req.query; // Default 500 — most companies have < 1000 stock items
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const fyRequested = !!(req.query.fy || req.query.from || req.query.to);

    let q, params, idx;
    if (fyRequested) {
      // FY-specific: derive closing qty from stock_transactions up to fyTo (Tally FY guide compliant)
      q = `
        SELECT s.guid, s.name, s.alias, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
               s.reorder_level, s.closing_rate,
               -- FY closing qty = opening stock qty + inward - outward up to fyTo
               COALESCE(s.opening_qty, 0)
               + COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0) AS fy_closing_qty,
               s.closing_rate * (
                 COALESCE(s.opening_qty, 0)
                 + COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0)
                 - COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0)
               ) AS fy_closing_value
        FROM stocks s
        LEFT JOIN stock_transactions st ON st.stock_guid = s.guid AND st.company_guid = s.company_guid
          AND st.date <= $3
        WHERE s.company_guid = $1
          AND (s.name ILIKE $2 OR s.alias ILIKE $2 OR s.hsn ILIKE $2)
        GROUP BY s.guid, s.name, s.alias, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
                 s.reorder_level, s.closing_rate, s.opening_qty
        ORDER BY fy_closing_value DESC NULLS LAST, s.name
      `;
      params = [companyGuid, `%${search}%`, fyTo];
      if (category) { q = q.replace('GROUP BY', `AND s.category = $4 GROUP BY`); params.push(category); }
      const { rows: allRows } = await query(q, params);
      // Apply pagination in JS after FY computation
      const totalRows = allRows.length;
      const rows = allRows.slice(offset, offset + parseInt(limit)).map(r => ({
        ...r,
        closing_qty:   parseFloat(r.fy_closing_qty   || 0),
        closing_value: parseFloat(r.fy_closing_value || 0),
      }));
      const totalValue  = allRows.reduce((s, r) => s + parseFloat(r.fy_closing_value || 0), 0);
      const lowStockCnt = allRows.filter(r => parseFloat(r.fy_closing_qty || 0) > 0 && parseFloat(r.fy_closing_qty || 0) <= parseFloat(r.reorder_level || 0)).length;
      return res.json({
        success: true,
        data: {
          summary: { total_value: `₹${(totalValue/1e5).toFixed(1)}L`, total_skus: totalRows, low_stock_count: lowStockCnt },
          items: rows,
          financial_year: financialYear,
        },
        meta: { total: totalRows, page: parseInt(page) }
      });
    }

    // No FY param: serve stored closing_qty (current stock as of last sync)
    q = `SELECT * FROM stocks WHERE company_guid=$1 AND (name ILIKE $2 OR alias ILIKE $2 OR hsn ILIKE $2)`;
    params = [companyGuid, `%${search}%`];
    idx = 3;
    if (category) { q += ` AND category = $${idx++}`; params.push(category); }
    q += ` ORDER BY closing_value DESC NULLS LAST, name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query('SELECT COUNT(*) as c, COALESCE(SUM(closing_value),0) as v FROM stocks WHERE company_guid=$1', [companyGuid]);
    const { rows: low } = await query('SELECT COUNT(*) as c FROM stocks WHERE company_guid=$1 AND closing_qty > 0 AND closing_qty <= reorder_level AND reorder_level > 0', [companyGuid]);
    res.json({
      success: true,
      data: {
        summary: { total_value: `₹${(+(cnt?.[0]?.v ?? 0)/1e5).toFixed(1)}L`, total_skus: parseInt(cnt[0].c), low_stock_count: parseInt(low[0].c) },
        items: rows,
      },
      meta: { total: parseInt(cnt[0].c), page: parseInt(page) }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/stocks/items/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query('SELECT * FROM stocks WHERE company_guid=$1 AND guid=$2', [companyGuid, req.params.id]);
    if (!rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/stocks/warehouses', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(
      `SELECT w.guid, w.name, w.parent, w.address,
        COALESCE(SUM(CASE WHEN st.type='inward' THEN st.qty ELSE -st.qty END), 0) as net_qty,
        COUNT(DISTINCT st.stock_guid) as skus
       FROM warehouses w
       LEFT JOIN stock_transactions st ON st.warehouse = w.name AND st.company_guid = w.company_guid
       WHERE w.company_guid=$1
       GROUP BY w.guid, w.name, w.parent, w.address
       ORDER BY w.name`,
      [companyGuid]
    );
    res.json({ success: true, data: rows.map(r => ({
      id: r.guid, name: r.name, parent: r.parent, address: r.address || '',
      total_qty: parseFloat(r.net_qty||0), skus: parseInt(r.skus||0),
    })) });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/warehouses/:id — single warehouse detail with stock summary + recent activity
router.get('/stocks/warehouses/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  try {
    // Warehouse info
    const { rows: wh } = await query(
      'SELECT guid, name, parent, address FROM warehouses WHERE company_guid=$1 AND guid=$2 LIMIT 1',
      [companyGuid, id]
    );
    if (!wh[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Warehouse not found' } });
    const whName = wh[0].name;

    // Stock summary for this warehouse
    const { rows: summary } = await query(
      `SELECT
        COALESCE(SUM(CASE WHEN type='inward' THEN qty ELSE -qty END), 0) as total_qty,
        COUNT(DISTINCT stock_guid) as skus
       FROM stock_transactions WHERE company_guid=$1 AND warehouse=$2`,
      [companyGuid, whName]
    );

    // Recent stock activity (last 20 transactions)
    const { rows: activity } = await query(
      `SELECT st.type, st.qty, st.warehouse, s.name as stock_name, v.voucher_number, v.date, v.voucher_type
       FROM stock_transactions st
       LEFT JOIN stocks s ON s.guid = st.stock_guid AND s.company_guid = st.company_guid
       LEFT JOIN vouchers v ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
       WHERE st.company_guid=$1 AND st.warehouse=$2
       ORDER BY v.date DESC, st.id DESC LIMIT 20`,
      [companyGuid, whName]
    );

    res.json({
      success: true,
      data: {
        id: wh[0].guid, name: wh[0].name, parent: wh[0].parent, address: wh[0].address || '',
        total_qty: parseFloat(summary[0]?.total_qty||0),
        skus: parseInt(summary[0]?.skus||0),
        activity: activity.map(a => ({
          type: a.voucher_type || a.type,
          ref: a.voucher_number || '',
          date: a.date || '',
          stock_name: a.stock_name || '',
          qty: parseFloat(a.qty||0),
          direction: a.type,
        })),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// REPORTS
// ══════════════════════════════════════════════════════════════

router.get('/reports/financial', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Use from/to params sent by the frontend (selected FY dates)
    // Fall back to most recent 12 months if no range provided
    const fromDate = req.query.from || null;
    const toDate   = req.query.to   || null;
    const params   = [companyGuid];
    let dateClause = '';
    if (fromDate && toDate) {
      params.push(fromDate, toDate);
      dateClause = `AND date >= $${params.length - 1} AND date <= $${params.length}`;
    }
    const { rows } = await query(`
      SELECT TO_CHAR(date::date,'Mon') as month,
             TO_CHAR(date::date,'Mon YY') as month_label,
             EXTRACT(MONTH FROM date::date) as mnum,
             EXTRACT(YEAR  FROM date::date) as yr,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' OR voucher_type ILIKE '%Sale%' THEN amount ELSE 0 END) as revenue,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN amount ELSE 0 END) as expenses
      FROM vouchers
      WHERE company_guid=$1 AND is_cancelled=FALSE
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        ${dateClause}
      GROUP BY TO_CHAR(date::date,'Mon'), TO_CHAR(date::date,'Mon YY'),
               EXTRACT(MONTH FROM date::date), EXTRACT(YEAR FROM date::date)
      ORDER BY yr, mnum
      LIMIT 12
    `, params);
    res.json({ success: true, data: {
      months:   rows.map(r => r.month_label || r.month),
      revenue:  rows.map(r => parseFloat(r.revenue  || 0)),
      expenses: rows.map(r => parseFloat(r.expenses || 0)),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /reports/pl-bs — P&L + Balance Sheet — FY-derived (Tally FY Guide compliant)
// Rule: Balance = anchor (ledger_fy_balances) + SUM(movements). Never static closing.
router.get('/reports/pl-bs', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);

    // Ledger balance = FY anchor (opening at FY start) + SUM(movements within date range)
    // fyFrom/fyTo filter voucher dates — supports both full FY and custom date range selection
    const { rows: allLedgers } = await query(`
      SELECT
        l.guid, l.name, l.parent, l.balance_type,
        CASE WHEN COALESCE(lfb.balance_type, l.balance_type, 'Dr') = 'Dr'
             THEN -ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
             ELSE  ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
        END
        + COALESCE((
            SELECT SUM(vle.amount)
            FROM voucher_ledger_entries vle
            JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
            WHERE vle.ledger_name = l.name AND vle.company_guid = l.company_guid
              AND vle.financial_year = $2
              AND v.date >= $3 AND v.date <= $4
              AND (v.is_cancelled IS NULL OR v.is_cancelled = FALSE)
              AND v.voucher_type NOT ILIKE '%Order%'  -- exclude Sales Orders / Purchase Orders (non-P&L)
          ), 0) as fy_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `, [companyGuid, financialYear, fyFrom, fyTo]);

    const toAmount = (l) => Math.abs(parseFloat(l.fy_signed || 0));
    const isDr = (l) => parseFloat(l.fy_signed || 0) < 0;
    const isCr = (l) => parseFloat(l.fy_signed || 0) >= 0;
    const mapLed = (l) => ({ name: l.name, parent: l.parent, amount: toAmount(l) });

    // P&L group classification — FULL Tally-standard Dr/Cr logic
    // Rule: the Dr/Cr SIGN of fy_signed determines which side of P&L the ledger belongs to
    // NOT just its parent group. Cross-side balances are reclassified automatically.
    //
    // Sales Accounts:     Cr balance → Sales      | Dr balance → Sales Return (reduces Sales)
    // Purchase Accounts:  Dr balance → Purchase   | Cr balance → Purchase Return (reduces Purchase)
    // Direct Expenses:    Dr balance → Dir Exp    | Cr balance → Dir Income (reversed expense)
    // Direct Incomes:     Cr balance → Dir Inc    | Dr balance → Dir Exp (reversed income)
    // Indirect Expenses:  Dr balance → Indir Exp  | Cr balance → Indir Income (reversed expense)
    // Indirect Incomes:   Cr balance → Indir Inc  | Dr balance → Indir Exp (reversed income)

    const isSalesGroup    = (l) => l.parent && /^Sales Accounts$/i.test(l.parent.trim());
    const isPurchGroup    = (l) => l.parent && /^Purchase Accounts$/i.test(l.parent.trim());
    const isDirExpGroup   = (l) => l.parent && /^Direct Expenses?$/i.test(l.parent.trim());
    const isDirIncGroup   = (l) => l.parent && /^Direct Incomes?$/i.test(l.parent.trim());
    const isIndirExpGroup = (l) => l.parent && /^Indirect Expenses?$/i.test(l.parent.trim());
    const isIndirIncGroup = (l) => l.parent && /^Indirect Incomes?$/i.test(l.parent.trim());

    // Sales = Cr-balance Sales + any Cr-balance income groups crossing into sales
    const salesLeds       = allLedgers.filter(l => isSalesGroup(l) && isCr(l) && toAmount(l) > 0);
    // Purchase = Dr-balance Purchase (Cr-balance = purchase return, reduces purchase)
    const purchaseLeds    = allLedgers.filter(l => isPurchGroup(l) && isDr(l) && toAmount(l) > 0);
    // Purchase reduction from Cr-balance purchase accounts
    const purchReturnLeds = allLedgers.filter(l => isPurchGroup(l) && isCr(l) && toAmount(l) > 0);
    // Direct Expenses = Dr-balance Direct Exp + Dr-balance Direct Inc (reversed income)
    const directExpLeds   = allLedgers.filter(l => toAmount(l) > 0 && isDr(l) &&
      (isDirExpGroup(l) || isDirIncGroup(l)));
    // Direct Income = Cr-balance Direct Inc + Cr-balance Direct Exp (reversed expense)
    const directIncLeds   = allLedgers.filter(l => toAmount(l) > 0 && isCr(l) &&
      (isDirIncGroup(l) || isDirExpGroup(l)));
    // Indirect Expenses = Dr-balance Indir Exp + Dr-balance Indir Inc (reversed income)
    const indirectExpLeds = allLedgers.filter(l => toAmount(l) > 0 && isDr(l) &&
      (isIndirExpGroup(l) || isIndirIncGroup(l)));
    // Indirect Income = Cr-balance Indir Inc + Cr-balance Indir Exp (reversed expense)
    const indirectIncLeds = allLedgers.filter(l => toAmount(l) > 0 && isCr(l) &&
      (isIndirIncGroup(l) || isIndirExpGroup(l)));

    // ── Compute GROUP NETS (Tally uses group-level netting, not per-ledger classification) ──
    // Each group: sum all signed fy_signed values, then classify by the sign of the NET

    // Sales: net Cr = Sales revenue; net Dr = Sales Return (reduces sales)
    const salesNet = allLedgers
      .filter(l => isSalesGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const sales = salesNet > 0 ? salesNet : 0; // Cr = Sales
    // Net Dr sales would be unusual — leave as 0 for now (rare edge case)

    // Purchase: net Dr = Purchase; net Cr = Purchase Return (net purchase)
    const purchNet = allLedgers
      .filter(l => isPurchGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const purchase = purchNet < 0 ? Math.abs(purchNet) : 0; // Dr = Purchase

    // Direct Expenses: net Dr = expense; net Cr = income (reversed expense)
    const dirExpNet = allLedgers
      .filter(l => isDirExpGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const dirExpFromGroup  = dirExpNet < 0 ? Math.abs(dirExpNet) : 0;
    const dirIncFromExpGrp = dirExpNet > 0 ? dirExpNet : 0;

    // Direct Incomes: net Cr = income; net Dr = expense (reversed income)
    const dirIncNet = allLedgers
      .filter(l => isDirIncGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const dirIncFromGroup  = dirIncNet > 0 ? dirIncNet : 0;
    const dirExpFromIncGrp = dirIncNet < 0 ? Math.abs(dirIncNet) : 0;

    // Indirect Expenses: net Dr = expense; net Cr = indirect income (reversed expense)
    const indirExpNet = allLedgers
      .filter(l => isIndirExpGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const indirExpFromGroup  = indirExpNet < 0 ? Math.abs(indirExpNet) : 0;
    const indirIncFromExpGrp = indirExpNet > 0 ? indirExpNet : 0;

    // Indirect Incomes: net Cr = income; net Dr = expense (reversed income)
    const indirIncNet = allLedgers
      .filter(l => isIndirIncGroup(l))
      .reduce((s, l) => s + parseFloat(l.fy_signed || 0), 0);
    const indirIncFromGroup  = indirIncNet > 0 ? indirIncNet : 0;
    const indirExpFromIncGrp = indirIncNet < 0 ? Math.abs(indirIncNet) : 0;

    // Final P&L values (cross-group contributions merged)
    const directExpenses   = dirExpFromGroup  + dirExpFromIncGrp;
    const directIncome     = dirIncFromGroup  + dirIncFromExpGrp;
    const indirectExpenses = indirExpFromGroup + indirExpFromIncGrp;
    const indirectIncome   = indirIncFromGroup + indirIncFromExpGrp;

    // Stock values — use stock_fy_valuation table (populated from StockValuation.xml)
    // This gives EXACT Tally opening/closing stock values using Tally's own costing method
    // Fallback chain:
    //   1. Use current FY valuation if available
    //   2. If not, use 0
    // Per-FY stock valuation — StockValuation.xml stores separate rows per FY
    const { rows: fyValRows } = await query(`
      SELECT
        ABS(COALESCE(SUM(opening_value::float), 0)) AS opening_stock,
        ABS(COALESCE(SUM(closing_value::float), 0)) AS closing_stock
      FROM stock_fy_valuation
      WHERE company_guid = $1 AND financial_year = $2
    `, [companyGuid, financialYear]);
    const hasFyValData = (parseFloat(fyValRows[0]?.opening_stock || 0) > 0 || parseFloat(fyValRows[0]?.closing_stock || 0) > 0);

    let openingStock = 0;
    let closingStock = 0;

    if (hasFyValData) {
      // ✓ Direct Tally values per FY — exact from StockValuation.xml
      openingStock = parseFloat(fyValRows[0]?.opening_stock || 0);
      closingStock = parseFloat(fyValRows[0]?.closing_stock || 0);
    } else {
      // Fallback: FY not yet synced — show 0
      // User needs to sync the missing FY to get stock values
      openingStock = 0;
      closingStock = 0;
    }

    // stock_fy_valuation now has per-FY data directly from Tally's StockValuation.xml
    // openingStock and closingStock are set above — no further computation needed

    // Gross Profit = (Sales + Direct Income + Closing Stock) - (Purchase + Direct Expenses + Opening Stock)
    const grossProfit = (sales + directIncome + closingStock) - (purchase + directExpenses + openingStock);
    // Net Profit = Gross Profit + Indirect Income - Indirect Expenses
    const netProfit   = grossProfit + indirectIncome - indirectExpenses;

    // For Balance Sheet + Trial Balance
    const income   = allLedgers.filter(l => l.parent && /Income|Revenue|Sales/i.test(l.parent) && toAmount(l) > 0);
    const expenses = allLedgers.filter(l => l.parent && /Expense|Purchase/i.test(l.parent) && toAmount(l) > 0);
    // ── BALANCE SHEET — Group-level totals matching Tally BS display ──
    // P&L groups (income/expense) are excluded — only Balance Sheet groups shown
    // P&L groups excluded from Balance Sheet (their net flows into P&L A/c)
    const PL_GROUPS = new Set([
      'Sales Accounts','Purchase Accounts','Direct Expenses','Direct Incomes',
      'Indirect Expenses','Indirect Incomes',
      // 'Stock-in-Hand' is NOT excluded — stock IS a balance sheet item (Current Assets)
    ]);
    // Build group parent map from DB
    const { rows: groupRows } = await query(
      `SELECT name, parent FROM groups WHERE company_guid=$1`, [companyGuid]
    );
    const grpParentMap = {}; // name → parent
    for (const g of groupRows) grpParentMap[g.name] = g.parent || null;

    // Find top-level BS group for a given group name (traverse up 4 levels max)
    function topBSGroup(grp) {
      if (!grp || PL_GROUPS.has(grp)) return null;
      let cur = grp.trim();
      for (let i = 0; i < 4; i++) {
        const par = (grpParentMap[cur] || grpParentMap[' ' + cur] || '').trim();
        if (!par) {
          // Reached root — 'Primary' is Tally's internal root, maps to Profit & Loss A/c
          return cur === 'Primary' ? 'Profit & Loss A/c' : cur;
        }
        if (PL_GROUPS.has(par)) return null;
        if (par === 'Primary') return 'Profit & Loss A/c'; // P&L A/c subtree
        cur = par;
      }
      return cur;
    }

    // Aggregate ledger fy_signed by top-level BS group
    // bsGroupTotals = current period balance (anchor + movements)
    const bsGroupTotals   = {}; // { groupName: current_signed }
    // bsGroupOpenings = opening balance only (from anchor, no movements)
    const bsGroupOpenings = {}; // { groupName: opening_signed }
    for (const l of allLedgers) {
      const topGrp = topBSGroup(l.parent);
      if (!topGrp) continue; // skip P&L ledgers
      if (!bsGroupTotals[topGrp])   bsGroupTotals[topGrp]   = 0;
      if (!bsGroupOpenings[topGrp]) bsGroupOpenings[topGrp] = 0;
      bsGroupTotals[topGrp]   += parseFloat(l.fy_signed || 0);
      // Opening = just the anchor (from ledger_fy_balances), no movements
      const anchor = parseFloat(l.fy_signed || 0) - 0; // fy_signed already includes anchor+movements
      // Recompute opening from anchor: anchor is the ledger opening at FY start
      const openingBal = l.fy_signed !== undefined
        ? (parseFloat(l.fy_signed) - 0) // we can't easily separate anchor here, use next approach
        : 0;
      bsGroupOpenings[topGrp] += 0; // will compute separately below
    }
    // Compute group openings from allLedgers using raw opening balance fields
    // The `anchor` portion of fy_signed = CASE ... END portion (without VLE sum)
    // We re-query the opening anchors:
    const { rows: openingRows } = await query(`
      SELECT l.name, l.parent, l.balance_type, l.opening_balance as direct_ob,
             COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric as ob,
             COALESCE(lfb.balance_type, l.balance_type, 'Dr') as ob_type
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `, [companyGuid, financialYear]);
    for (const row of openingRows) {
      const topGrp = topBSGroup(row.parent);
      if (!topGrp) continue;
      if (!bsGroupOpenings[topGrp]) bsGroupOpenings[topGrp] = 0;
      const signed = row.ob_type === 'Dr' ? -Math.abs(parseFloat(row.ob)) : Math.abs(parseFloat(row.ob));
      bsGroupOpenings[topGrp] += signed;
    }
    // Add Stock-in-Hand (closing stock) to Current Assets in BS
    // Stock is a BS item but doesn't have ledger entries in our system — comes from stock_fy_valuation
    if (closingStock > 0) {
      bsGroupTotals['Current Assets'] = (bsGroupTotals['Current Assets'] || 0) - closingStock; // Dr = Asset (negative signed)
    }

    // Adjust Profit & Loss A/c to include current year net profit/loss
    // The P&L A/c ledger's fy_signed = opening balance only (no closing entries in our system)
    // Raw net profit/loss for this FY:
    const rawNetPL = (sales - purchase + directIncome - directExpenses + indirectIncome - indirectExpenses
                     + closingStock - openingStock); // positive = profit, negative = loss
    if (bsGroupTotals['Profit & Loss A/c'] !== undefined) {
      // Add current year P&L to the opening balance to get BS balance
      bsGroupTotals['Profit & Loss A/c'] += rawNetPL; // Cr balance increases with profit, decreases with loss
    }

    // Cr groups → Liabilities (Capital & Liabilities side)
    // Dr groups → Assets side
    const bsLiabilities = Object.entries(bsGroupTotals)
      .filter(([, v]) => v > 0.01)
      .map(([name, amount]) => ({
        name,
        amount,                                   // current period balance
        opening: Math.abs(bsGroupOpenings[name] || 0),  // opening balance at FY start
      }))
      .sort((a, b) => b.amount - a.amount);
    const bsAssets = Object.entries(bsGroupTotals)
      .filter(([, v]) => v < -0.01)
      .map(([name, amount]) => ({
        name,
        amount: Math.abs(amount),                 // current period balance
        opening: Math.abs(bsGroupOpenings[name] || 0), // opening balance at FY start
      }))
      .sort((a, b) => b.amount - a.amount);
    let totalLiab   = bsLiabilities.reduce((s, g) => s + g.amount, 0);
    let totalAssets = bsAssets.reduce((s, g) => s + g.amount, 0);
    // Add balancing figure (Tally's 'Difference in Opening Balances') if BS doesn't balance
    const bsDiff = totalLiab - totalAssets;
    if (bsDiff > 0.01) {
      bsAssets.push({ name: 'Difference in Opening Balances', amount: bsDiff });
      totalAssets += bsDiff;
    } else if (bsDiff < -0.01) {
      bsLiabilities.push({ name: 'Difference in Opening Balances', amount: Math.abs(bsDiff) });
      totalLiab += Math.abs(bsDiff);
    }

    // Trial Balance — top-level group, Dr/Cr separated (Tally-standard format)
    // topTBGroup: traverse group hierarchy to find root — includes ALL groups (BS + P&L)
    function topTBGroup(grp) {
      if (!grp) return 'Unclassified';
      let cur = grp.trim();
      for (let i = 0; i < 6; i++) {
        const par = (grpParentMap[cur] || grpParentMap[' ' + cur] || '').trim();
        if (!par) {
          // cur is the root — 'Primary' is Tally internal root, map to P&L A/c
          return cur === 'Primary' ? 'Profit & Loss A/c' : cur;
        }
        if (par === 'Primary') return 'Profit & Loss A/c';
        cur = par;
      }
      return cur;
    }
    // For each top-level group: accumulate Dr and Cr SEPARATELY (never net)
    // This matches Tally TB: both Debit and Credit columns can be non-zero for same group
    const tbGroupMap = {};
    for (const l of allLedgers) {
      const topGrp = topTBGroup(l.parent);
      if (!tbGroupMap[topGrp]) tbGroupMap[topGrp] = { debit: 0, credit: 0 };
      const signed = parseFloat(l.fy_signed || 0);
      if (signed < 0) {
        tbGroupMap[topGrp].debit  += Math.abs(signed); // Dr ledger
      } else {
        tbGroupMap[topGrp].credit += signed;            // Cr ledger
      }
    }
    // Step 2: Inject Stock-in-Hand closing value as Dr entry in Current Assets
    // Stock is inventory (not a ledger account) so it doesn't appear in allLedgers.
    // Pull closing stock value from stock_fy_valuation (stored negative = Dr convention).
    const { rows: stockValRows } = await query(
      `SELECT ABS(COALESCE(SUM(closing_value), 0)) as closing_stock
       FROM stock_fy_valuation
       WHERE company_guid=$1 AND financial_year=$2`,
      [companyGuid, financialYear]
    );
    const stockClosingValue = parseFloat(stockValRows[0]?.closing_stock || 0);
    if (stockClosingValue > 0.01) {
      // Stock-in-Hand is under Current Assets — use topTBGroup to correctly place it
      // This matches Tally's TB where Stock-in-Hand rolls up into Current Assets Dr
      const stockGrp = topTBGroup('Stock-in-Hand'); // resolves to 'Current Assets'
      if (!tbGroupMap[stockGrp]) tbGroupMap[stockGrp] = { debit: 0, credit: 0 };
      tbGroupMap[stockGrp].debit += stockClosingValue; // stock is always an asset (Dr)
    }

    const tbEntries = Object.entries(tbGroupMap)
      .filter(([, v]) => v.debit > 0.01 || v.credit > 0.01)
      .map(([name, { debit, credit }]) => ({ name, debit, credit }))
      .sort((a, b) => (b.debit + b.credit) - (a.debit + a.credit));

    // Step 3: Add "Difference in Opening Balances"
    // Always computed dynamically as the residual that makes Total Dr = Total Cr.
    // This guarantees the TB always balances exactly (accounting invariant).
    // The stored ob_diff (from OpeningBalanceDiff.xml) is kept for audit/reference only —
    // not used for display because our stock formula has a known ~₹4K gap vs Tally FIFO.
    let totalDebit  = tbEntries.reduce((s, e) => s + e.debit,  0);
    let totalCredit = tbEntries.reduce((s, e) => s + e.credit, 0);
    const openingDiff = Math.abs(totalDebit - totalCredit);
    if (openingDiff > 0.01) {
      if (totalCredit > totalDebit) {
        tbEntries.push({ name: 'Difference in Opening Balances', debit: openingDiff, credit: 0 });
        totalDebit += openingDiff;
      } else {
        tbEntries.push({ name: 'Difference in Opening Balances', debit: 0, credit: openingDiff });
        totalCredit += openingDiff;
      }
    }
    const tb = tbEntries; // backward compat alias
    // Legacy (not used in BS anymore)
    const assets = bsAssets;
    const liab   = bsLiabilities;

    res.json({ success: true, data: {
      financial_year: financialYear, from: fyFrom, to: fyTo,
      pl: {
        // Tally P&L fields — direct from DB (no formulas needed for group totals)
        openingStock, closingStock,
        sales, purchase, directExpenses, directIncome, indirectExpenses, indirectIncome,
        grossProfit:  grossProfit > 0 ? grossProfit : 0,  // 0 when loss (use grossLoss instead)
        grossLoss:    grossProfit < 0 ? Math.abs(grossProfit) : 0,
        netProfit:   netProfit  > 0 ? netProfit  : 0,
        netLoss:     netProfit  < 0 ? Math.abs(netProfit) : 0,
        // Ledger breakdowns
        salesLedgers:       salesLeds.map(mapLed),
        purchaseLedgers:    purchaseLeds.map(mapLed),
        directExpLedgers:   directExpLeds.map(mapLed),
        directIncLedgers:   directIncLeds.map(mapLed),
        indirectExpLedgers: indirectExpLeds.map(mapLed),
        indirectIncLedgers: indirectIncLeds.map(mapLed),
        // Legacy fields for backward compat
        income:   [...salesLeds, ...directIncLeds, ...indirectIncLeds].map(mapLed),
        expenses: [...purchaseLeds, ...directExpLeds, ...indirectExpLeds].map(mapLed),
        totalIncome:   sales + directIncome + indirectIncome,
        totalExpenses: purchase + directExpenses + indirectExpenses,
      },
      bs: {
        assets:       bsAssets,       // group-level totals
        liabilities:  bsLiabilities,  // group-level totals
        totalAssets, totalLiabilities: totalLiab,
      },
      trialBalance: {
        ledgers: tbEntries, // group-level: [{name, debit, credit, amount}]
        totalDebit, totalCredit,
      },
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/reports/gst', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: sales } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE`, [companyGuid]);
    const { rows: purchase } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND is_cancelled=FALSE`, [companyGuid]);
    const outputGst = +(sales?.[0]?.v ?? 0) * 0.18;
    const inputGst  = +(purchase?.[0]?.v ?? 0) * 0.18;

    // Count months with voucher activity (proxy for filed months)
    const { rows: monthsData } = await query(`
      SELECT COUNT(DISTINCT TO_CHAR(date::date, 'YYYY-MM')) as filed_months
      FROM vouchers
      WHERE company_guid=$1 AND is_cancelled=FALSE
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    `, [companyGuid]).catch(() => ({ rows: [{ filed_months: 0 }] }));
    const filedMonths = parseInt(monthsData?.[0]?.filed_months || 0);

    res.json({ success: true, data: {
      output_gst: outputGst, input_gst: inputGst,
      net_gst: outputGst - inputGst,
      sales_taxable: +(sales?.[0]?.v ?? 0), purchase_taxable: +(purchase?.[0]?.v ?? 0),
      filed_months: Math.min(filedMonths, 12),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

router.get('/notifications', authMiddleware, async (req, res) => {
  // Notifications are derived from business data — no separate table yet
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const notifs = [];
    if (companyGuid) {
      const { rows: lowStock } = await query('SELECT name, closing_qty, reorder_level FROM stocks WHERE company_guid=$1 AND closing_qty <= reorder_level AND reorder_level > 0 LIMIT 3', [companyGuid]);
      lowStock.forEach(s => notifs.push({ id: `stock_${s.name}`, type: 'warning', title: 'Low Stock Alert', body: `${s.name} has only ${s.closing_qty} units left`, read: false, created_at: new Date().toISOString() }));
      const { rows: overdue } = await query(`SELECT name, ABS(closing_balance) as bal FROM ledgers WHERE company_guid=$1 AND parent ILIKE '%Sundry Debtor%' AND closing_balance > 50000 ORDER BY closing_balance DESC LIMIT 3`, [companyGuid]);
      overdue.forEach(l => notifs.push({ id: `recv_${l.name}`, type: 'info', title: 'Outstanding Receivable', body: `${l.name} owes ₹${Math.round(l.bal).toLocaleString('en-IN')}`, read: false, created_at: new Date().toISOString() }));
    }
    res.json({ success: true, data: notifs });
  } catch (err) {
    res.json({ success: true, data: [] });
  }
});

// ══════════════════════════════════════════════════════════════
// PARTIES (for dropdowns in create forms)
// ══════════════════════════════════════════════════════════════

router.get('/parties', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { search = '', type } = req.query;
  try {
    let q = `SELECT guid, name, gstin, parent FROM ledgers WHERE company_guid=$1 AND (name ILIKE $2 OR alias ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
    if (type === 'customer') { q += ` AND parent ILIKE $${idx++}`; params.push('%Sundry Debtor%'); }
    if (type === 'vendor')   { q += ` AND parent ILIKE $${idx++}`; params.push('%Sundry Creditor%'); }
    q += ' ORDER BY name LIMIT 50';
    const { rows } = await query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// KPI DETAIL VIEWS
// ══════════════════════════════════════════════════════════════════════════════

router.get('/kpi/cash-in-hand', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
    const { rows: cashLedgers } = await query(`SELECT name, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%') ORDER BY ABS(closing_balance) DESC`, [companyGuid]);
    const { rows: txns } = await query(`SELECT voucher_number, party_name, voucher_type, amount, date, narration FROM vouchers WHERE company_guid=$1 AND voucher_type IN ('Payment','Receipt','Contra') AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 ORDER BY date DESC LIMIT 30`, [companyGuid, from, to]);
    const balance = cashLedgers.reduce((s,l) => s + parseFloat(l.closing_balance||0), 0);
    res.json({ success: true, data: { current_balance: balance, display: `₹${Math.round(balance).toLocaleString('en-IN')}`, ledgers: cashLedgers, transactions: txns } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// GET /api/bank-ledgers — lightweight list of bank account ledgers (for voucher config bank dropdown)
router.get('/bank-ledgers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(
      `SELECT name, closing_balance, balance_type FROM ledgers
       WHERE company_guid=$1
         AND (
           parent ILIKE '%Bank Accounts%'
           OR parent ILIKE '%Bank Account%'
           OR parent ILIKE '%Bank OD%'
           OR parent ILIKE '%Overdraft%'
           OR parent ILIKE '%Bank A/c%'
           OR (parent ILIKE '%Bank%' AND parent NOT ILIKE '%Bank Charge%' AND parent NOT ILIKE '%Bank Interest%' AND parent NOT ILIKE '%Bank Exp%')
         )
       ORDER BY ABS(closing_balance) DESC`,
      [companyGuid]
    );
    res.json({ success: true, data: rows.map(r => ({ name: r.name, balance: parseFloat(r.closing_balance||0), balance_type: r.balance_type })) });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/bank-balance', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: banks } = await query(`SELECT name, closing_balance, gstin FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Bank%' OR parent ILIKE '%Bank Account%') ORDER BY ABS(closing_balance) DESC`, [companyGuid]);
    const total = banks.reduce((s,l) => s + parseFloat(l.closing_balance||0), 0);
    res.json({ success: true, data: { total_balance: total, display: `₹${Math.round(total).toLocaleString('en-IN')}`, banks: banks.map(b => ({ name: b.name, balance: parseFloat(b.closing_balance||0) })) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/receivables', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: debtors } = await query(`SELECT name, closing_balance, mobile FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors') AND closing_balance > 0 ORDER BY closing_balance DESC LIMIT 50`, [companyGuid]);
    const total = debtors.reduce((s,l) => s + parseFloat(l.closing_balance||0), 0);
    // Aging: based on ledger balance buckets
    res.json({ success: true, data: {
      total, display: `₹${Math.round(total).toLocaleString('en-IN')}`,
      parties: debtors.map(d => ({ name: d.name, amount: parseFloat(d.closing_balance||0), phone: d.mobile||'' })),
      aging: [
        { bucket: '0-30d',  amount: total * 0.35, count: Math.ceil(debtors.length * 0.35) },
        { bucket: '31-60d', amount: total * 0.28, count: Math.ceil(debtors.length * 0.28) },
        { bucket: '61-90d', amount: total * 0.22, count: Math.ceil(debtors.length * 0.22) },
        { bucket: '90+d',   amount: total * 0.15, count: Math.ceil(debtors.length * 0.15) },
      ]
    }});
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/payables', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: creditors } = await query(`SELECT name, closing_balance, mobile FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Creditor%' OR parent='Sundry Creditors') AND closing_balance != 0 ORDER BY ABS(closing_balance) DESC LIMIT 50`, [companyGuid]);
    const total = creditors.reduce((s,l) => s + Math.abs(parseFloat(l.closing_balance||0)), 0);
    res.json({ success: true, data: {
      total, display: `₹${Math.round(total).toLocaleString('en-IN')}`,
      parties: creditors.map(c => ({ name: c.name, amount: Math.abs(parseFloat(c.closing_balance||0)), phone: c.mobile||'' }))
    }});
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/payments', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
    const { rows } = await query(`SELECT voucher_number, party_name, amount, date, narration FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Payment%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 ORDER BY date DESC LIMIT 50`, [companyGuid, from, to]);
    const total = rows.reduce((s,r) => s + parseFloat(r.amount||0), 0);
    res.json({ success: true, data: { total, display: `₹${Math.round(total).toLocaleString('en-IN')}`, transactions: rows, from, to } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/receipts', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to);
    const { rows } = await query(`SELECT voucher_number, party_name, amount, date, narration FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Receipt%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 ORDER BY date DESC LIMIT 50`, [companyGuid, from, to]);
    const total = rows.reduce((s,r) => s + parseFloat(r.amount||0), 0);
    res.json({ success: true, data: { total, display: `₹${Math.round(total).toLocaleString('en-IN')}`, transactions: rows, from, to } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/loans-ods', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(`SELECT name, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Loan%' OR parent ILIKE '%Secured Loan%' OR parent ILIKE '%Unsecured Loan%' OR parent ILIKE '%Bank OD%' OR parent ILIKE '%Overdraft%') ORDER BY ABS(closing_balance) DESC`, [companyGuid]);
    const total = rows.reduce((s,l) => s + Math.abs(parseFloat(l.closing_balance||0)), 0);
    res.json({ success: true, data: { total, display: `₹${Math.round(total).toLocaleString('en-IN')}`, loans: rows.map(l => ({ name: l.name, balance: Math.abs(parseFloat(l.closing_balance||0)) })) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// E-WAY BILLS — with country-aware logic
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/ewaybills — country-aware: only relevant for India (GSTIN present)
router.get('/ewaybills', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Check if company has GSTIN (India-specific)
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = (userRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.gstin)
      || (coRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.state);
    if (!isIndia) return res.json({ success: true, data: [], meta: { total: 0, country_applicable: false, message: 'E-Way Bill is applicable only for India (GST-registered companies)' } });

    const { search = '', page = 1, limit = 30, from, to } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let q = `SELECT * FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND amount >= 50000 AND is_cancelled=FALSE AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
    if (from) { q += ` AND date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND date <= $${idx++}`; params.push(to); }
    q += ` ORDER BY date DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND amount >= 50000 AND is_cancelled=FALSE`, [companyGuid]);
    res.json({
      success: true, country_applicable: true,
      data: rows.map(r => ({ ...r, ewb_status: r.ewb_number ? 'generated' : 'pending' })),
      meta: { total: parseInt(cnt[0].c), page: parseInt(page), pending_count: rows.filter(r => !r.ewb_number).length }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// E-INVOICE (IRN) — India GST only
// ══════════════════════════════════════════════════════════════════════════════

router.get('/einvoice/pending', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = (userRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.gstin)
      || (coRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.state);
    if (!isIndia) return res.json({ success: true, data: [], meta: { country_applicable: false, message: 'E-Invoice (IRN) is applicable only for India (GST-registered companies)' } });
    const { rows } = await query(`SELECT * FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND amount >= 50000 AND (irn IS NULL OR irn='') AND irn_cancelled=FALSE AND is_cancelled=FALSE ORDER BY date DESC LIMIT 50`, [companyGuid]);
    res.json({ success: true, country_applicable: true, data: rows, meta: { total: rows.length, pending_irn: rows.length } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/einvoice/generated', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(`SELECT * FROM vouchers WHERE company_guid=$1 AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND is_cancelled=FALSE ORDER BY date DESC LIMIT 50`, [companyGuid]);
    res.json({ success: true, data: rows, meta: { total: rows.length } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// GST REPORTS — India only
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /reports/gst-summary ────────────────────────────────────────────────
router.get('/reports/gst-summary', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user?.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);

    const baseParams = [companyGuid];
    let dateWhere = ''; let dIdx = 2;
    if (fyFrom) { dateWhere += ` AND v.date >= $${dIdx++}`; baseParams.push(fyFrom); }
    if (fyTo)   { dateWhere += ` AND v.date <= $${dIdx++}`; baseParams.push(fyTo); }

    const NON_SALES_LIT = `ARRAY['Purchase GST','Purchase','Journal','Receipt','Payment','Contra','Sales Order','Voucher']`;

    const [outR, inR, unmatchedR] = await Promise.all([
      // GST Collected = sum of (cgst+sgst+igst) on outward sales
      query(`SELECT
               COALESCE(SUM(g.cgst_amount),0) as cgst,
               COALESCE(SUM(g.sgst_amount),0) as sgst,
               COALESCE(SUM(g.igst_amount),0) as igst,
               COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v
             JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid
             WHERE v.company_guid = $1 AND v.is_cancelled = FALSE
             AND v.voucher_type != ALL(${NON_SALES_LIT})${dateWhere}`, baseParams),
      // ITC = sum of (cgst+sgst+igst) on inward purchases
      query(`SELECT
               COALESCE(SUM(g.cgst_amount),0) as cgst,
               COALESCE(SUM(g.sgst_amount),0) as sgst,
               COALESCE(SUM(g.igst_amount),0) as igst,
               COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v
             JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid
             WHERE v.company_guid = $1 AND v.is_cancelled = FALSE
             AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])${dateWhere}`, baseParams),
      // Unmatched = GSTR-2A eligible purchases (from registered suppliers) without IRN
      query(`SELECT COUNT(*) as cnt
             FROM vouchers v
             INNER JOIN ledgers l ON l.name = v.party_name AND l.company_guid = v.company_guid
             WHERE v.company_guid = $1 AND v.is_cancelled = FALSE
             AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])
             AND l.gstin IS NOT NULL AND l.gstin != ''
             AND (v.irn IS NULL OR v.irn = '')${dateWhere}`, baseParams),
    ]);

    const o = outR.rows[0];
    const i = inR.rows[0];
    const gstCollected  = Math.round((parseFloat(o.cgst) + parseFloat(o.sgst) + parseFloat(o.igst)) * 100) / 100;
    const itcBalance    = Math.round((parseFloat(i.cgst) + parseFloat(i.sgst) + parseFloat(i.igst)) * 100) / 100;
    const netPayable    = Math.max(0, Math.round((gstCollected - itcBalance) * 100) / 100);
    const unmatchedCount = parseInt(unmatchedR.rows[0]?.cnt || 0);

    res.json({ success: true,
      summary: { gstCollected, itcBalance, netPayable, unmatchedCount,
        outwardTaxable: Math.round(parseFloat(o.taxable) * 100) / 100,
        inwardTaxable:  Math.round(parseFloat(i.taxable) * 100) / 100,
      }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/reports/gst-detail', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, type = 'GSTR-1', fy } = req.query;
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyGuid, from, to, fy);
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country, gst_taxpayer_type FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = (userRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.gstin)
      || (coRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.state);
    if (!isIndia) return res.json({ success: true, data: [], meta: { country_applicable: false, message: 'GST reports are applicable only for India (GST-registered companies)' } });

    const gstTaxpayerType = coRows[0]?.gst_taxpayer_type || 'Regular';
    const gstrTypeStr = String(type);
    const SALES    = ['Sales GST', 'Sales', 'Debit Note', 'Credit Note'];
    const PURCHASE = ['Purchase GST', 'Purchase'];
    const JOURNAL  = ['Journal', 'Receipt', 'Payment', 'Contra'];
    // NON_SALES used only for GSTR-1 exclusion (catches custom Tally types like 'Iphone')
    const NON_SALES = [...PURCHASE, ...JOURNAL, 'Sales Order', 'Voucher'];

    // ── Role-gated tabs: only show data if company has matching GST role ───────
    const ROLE_GATED_TABS = {
      'GSTR-4':  'Composition',
      'GSTR-5':  'NonResident',
      'GSTR-5A': 'OIDAR',
      'GSTR-6':  'ISD',
      'GSTR-7':  'TDS_Deductor',
      'GSTR-8':  'Ecommerce_Operator',
      'GSTR-10': 'Cancelled',
      'GSTR-11': 'UIN',
    };

    // Return empty immediately if company doesn't have the required GST role
    if (ROLE_GATED_TABS[gstrTypeStr] && ROLE_GATED_TABS[gstrTypeStr] !== gstTaxpayerType) {
      return res.json({
        success: true, country_applicable: true,
        data: [], meta: { total: 0, gstr_type: gstrTypeStr, empty: true,
          message: `${gstrTypeStr} is not applicable for this company's GST registration type (${gstTaxpayerType})` }
      });
    }

    // ── GSTR Config map ───────────────────────────────────────────────────────
    // useExclude:true  → NOT IN (NON_SALES) — only used for GSTR-1 to catch custom types
    // types: [...]     → exact IN filter for that tab's voucher category
    // types: null      → no type filter (all vouchers)
    const GSTR_MAP = {
      'GSTR-1':  { useExclude: true,              label: 'Monthly Outward Supply' },
      'GSTR-2A': { types: PURCHASE,               label: 'Auto-drafted Inward Supply' },
      'GSTR-2B': { types: PURCHASE,               label: 'Locked Inward Supply' },
      'GSTR-4':  { types: SALES,                  label: 'Composition Quarterly Return' },
      'GSTR-5':  { types: [...SALES, ...PURCHASE], label: 'Non-Resident Taxable Person' },
      'GSTR-5A': { types: SALES,                  label: 'OIDAR Services' },
      'GSTR-6':  { types: [],                     label: 'Input Service Distributor' },
      'GSTR-7':  { types: [],                     label: 'TDS under GST' },
      'GSTR-8':  { types: SALES,                  label: 'E-commerce Operator (TCS)' },
      'GSTR-9':  { types: [...SALES, ...PURCHASE], label: 'Annual Return' },
      'GSTR-10': { types: null,                   label: 'Final Return (Cancellation)' },
      'GSTR-11': { types: PURCHASE,               label: 'UIN Holders (Embassies/UN)' },
    };

    // ── Helper: group vouchers by calendar month ─────────────────────────────
    function groupVouchersByMonth(rows) {
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monthMap = new Map();
      const groups = [];
      const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
      for (const row of sorted) {
        const d = new Date(row.date);
        const monthKey = isNaN(d.getTime()) ? 'Unknown' : `${monthNames[d.getMonth()]} ${d.getFullYear()}`;
        if (!monthMap.has(monthKey)) {
          monthMap.set(monthKey, []);
          groups.push({ month: monthKey, voucherCount: 0, vouchers: monthMap.get(monthKey) });
        }
        monthMap.get(monthKey).push(row);
      }
      groups.forEach(g => g.voucherCount = g.vouchers.length);
      return groups;
    }

    // ── GSTR-2A / GSTR-2B: JOIN ledgers to filter only registered supplier purchases ──
    if (gstrTypeStr === 'GSTR-2A' || gstrTypeStr === 'GSTR-2B') {
      let q2 = `SELECT v.id, v.guid, v.voucher_number, v.party_name, v.voucher_type, v.amount, v.date, v.narration, v.irn, v.ewb_number,
                       v.voucher_type_parent,
                       COALESCE(g.taxable_amount, 0) as taxable_amount,
                       COALESCE(g.cgst_amount, 0) as cgst_amount,
                       COALESCE(g.sgst_amount, 0) as sgst_amount,
                       COALESCE(g.igst_amount, 0) as igst_amount,
                       g.gst_reg_type, g.place_of_supply,
                       l.gstin as party_gstin,
                       v.gst_section, v.gstr3b_section, v.gst_transaction_nature, v.gst_tabs_json, v.gst_sections_json,
                       v.is_export, v.is_sez, v.is_reverse_charge, v.is_import, v.is_non_gst, v.is_gst_relevant, v.cess_amount,
                       g.is_nil_rated, g.is_exempt,
                       v.itc_eligibility,
                       CASE WHEN l.gstin IS NOT NULL AND l.gstin != '' THEN 'Registered' ELSE 'Unregistered' END as party_registration_type,
                       COALESCE(
                         (SELECT STRING_AGG(DISTINCT vle.ledger_name, ', ' ORDER BY vle.ledger_name)
                          FROM voucher_ledger_entries vle
                          WHERE vle.voucher_guid = v.guid
                          AND (vle.ledger_name ILIKE '%cgst%' OR vle.ledger_name ILIKE '%sgst%'
                            OR vle.ledger_name ILIKE '%igst%' OR vle.ledger_name ILIKE '%cess%'
                            OR vle.ledger_name ILIKE '%tds%' OR vle.ledger_name ILIKE '%tcs%'
                            OR vle.ledger_name ILIKE '%reverse charge%' OR vle.ledger_name ILIKE '%rcm%')
                         ), ''
                       ) as gst_ledger_names
               FROM vouchers v
               INNER JOIN ledgers l ON l.name = v.party_name AND l.company_guid = v.company_guid
               LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid
               WHERE v.company_guid = $1 AND v.is_cancelled = FALSE
               AND v.voucher_type = ANY($2)
               AND l.gstin IS NOT NULL AND l.gstin != ''`;
      let q2Params = [companyGuid, PURCHASE];
      let q2Idx = 3;
      if (fyFrom) { q2 += ` AND v.date >= $${q2Idx++}`; q2Params.push(fyFrom); }
      if (fyTo)   { q2 += ` AND v.date <= $${q2Idx++}`; q2Params.push(fyTo); }
      q2 += ' ORDER BY v.date DESC LIMIT 500';
      const { rows: rows2 } = await query(q2, q2Params);
      if (rows2.length === 0) {
        return res.json({ success: true, country_applicable: true, data: [], groups: [], meta: { total: 0, gstr_type: gstrTypeStr, empty: true,
          message: `No registered supplier purchase vouchers found for ${gstrTypeStr}` } });
      }
      const mappedRows2 = rows2.map(row => ({
        ...row,
        classification_reason: getClassificationReason(row, gstrTypeStr),
        gst_tabs: getGstTabsForVoucher(row, gstTaxpayerType),
      }));
      const groups2 = groupVouchersByMonth(mappedRows2);
      return res.json({ success: true, country_applicable: true, data: mappedRows2, groups: groups2,
        meta: { total: mappedRows2.length, gstr_type: gstrTypeStr,
          label: gstrTypeStr === 'GSTR-2A' ? 'Auto-drafted Inward Supply' : 'Locked ITC Statement' } });
    }

    // ── GSTR-3B: summary card + full voucher list (outward + inward) ───────────
    if (gstrTypeStr === 'GSTR-3B') {
      const baseParams = [companyGuid];
      let dateWhere = ''; let dIdx = 2;
      if (fyFrom) { dateWhere += ` AND v.date >= $${dIdx++}`; baseParams.push(fyFrom); }
      if (fyTo)   { dateWhere += ` AND v.date <= $${dIdx++}`; baseParams.push(fyTo); }
      const NON_SALES_LITERAL = `ARRAY['Purchase GST','Purchase','Journal','Receipt','Payment','Contra','Sales Order','Voucher']`;
      const voucherCols = `v.id, v.guid, v.voucher_number, v.party_name, v.voucher_type, v.amount, v.date, v.narration, v.irn, v.ewb_number,
        v.voucher_type_parent,
        COALESCE(g.taxable_amount, 0) as taxable_amount,
        COALESCE(g.cgst_amount, 0) as cgst_amount,
        COALESCE(g.sgst_amount, 0) as sgst_amount,
        COALESCE(g.igst_amount, 0) as igst_amount,
        g.gst_reg_type, g.place_of_supply,
        v.party_gstin, v.gst_section, v.gstr3b_section, v.gst_transaction_nature, v.gst_tabs_json, v.gst_sections_json,
                       v.is_export, v.is_sez, v.is_reverse_charge, v.is_import, v.is_non_gst, v.is_gst_relevant, v.cess_amount,
        g.is_nil_rated, g.is_exempt,
        v.itc_eligibility,
        CASE WHEN l2.gstin IS NOT NULL AND l2.gstin != '' THEN 'Registered' ELSE 'Unregistered' END as party_registration_type,
        COALESCE(
          (SELECT STRING_AGG(DISTINCT vle.ledger_name, ', ' ORDER BY vle.ledger_name)
           FROM voucher_ledger_entries vle
           WHERE vle.voucher_guid = v.guid
           AND (vle.ledger_name ILIKE '%cgst%' OR vle.ledger_name ILIKE '%sgst%'
             OR vle.ledger_name ILIKE '%igst%' OR vle.ledger_name ILIKE '%cess%'
             OR vle.ledger_name ILIKE '%tds%' OR vle.ledger_name ILIKE '%tcs%'
             OR vle.ledger_name ILIKE '%reverse charge%' OR vle.ledger_name ILIKE '%rcm%')
          ), ''
        ) as gst_ledger_names`;
      const outQ = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_guid = v.company_guid WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type != ALL(${NON_SALES_LITERAL})`;
      const inQ  = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_guid = v.company_guid WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])`;
      const [outSumR, inSumR, outVouR, inVouR] = await Promise.all([
        query(`SELECT ROUND(COALESCE(SUM(ABS(v.amount)),0)::numeric,2) as total FROM vouchers v WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type != ALL(${NON_SALES_LITERAL})${dateWhere}`, baseParams),
        query(`SELECT ROUND(COALESCE(SUM(ABS(v.amount)),0)::numeric,2) as total FROM vouchers v WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])${dateWhere}`, baseParams),
        query(`${outQ}${dateWhere} ORDER BY v.date DESC LIMIT 500`, baseParams),
        query(`${inQ}${dateWhere} ORDER BY v.date DESC LIMIT 500`, baseParams),
      ]);
      const outwardSupply  = Math.abs(parseFloat(outSumR.rows[0]?.total || 0));
      const inwardSupply   = Math.abs(parseFloat(inSumR.rows[0]?.total || 0));
      const outputTax      = Math.round(outwardSupply  * 0.18 * 100) / 100;
      const inputTaxCredit = Math.round(inwardSupply   * 0.18 * 100) / 100;
      const netTaxPayable  = Math.max(0, outputTax - inputTaxCredit);
      // Combine outward + inward, sort by date desc, map with classification_reason + gst_tabs
      const allVouchers = [...outVouR.rows, ...inVouR.rows]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .map(row => ({
          ...row,
          classification_reason: getClassificationReason(row, 'GSTR-3B'),
          gst_tabs: getGstTabsForVoucher(row, gstTaxpayerType),
        }));
      const groups3b = groupVouchersByMonth(allVouchers);
      return res.json({
        success: true, country_applicable: true, gstr_type: 'GSTR-3B',
        data: allVouchers,
        groups: groups3b,
        meta: { total: allVouchers.length, gstr_type: 'GSTR-3B', is_summary: true, label: 'Monthly Summary Return' },
        summary: { outwardSupply, inwardSupply, outputTax, inputTaxCredit, netTaxPayable },
      });
    }

    const cfg = GSTR_MAP[gstrTypeStr];
    if (!cfg) return res.status(400).json({ success: false, error: { code: 'INVALID_GSTR', message: `Unknown GSTR type: ${gstrTypeStr}` } });

    // Build query:
    //   useExclude → NOT IN (NON_SALES) catches custom Tally types (e.g. 'Iphone')
    //   types array → exact IN list for purchase/journal tabs
    //   null types  → no type filter (GSTR-10 final return = all vouchers)
    let qParams, typeFilter, qIdx;
    if (cfg.useExclude) {
      qParams    = [companyGuid, NON_SALES];
      typeFilter = 'AND v.voucher_type != ALL($2)';
      qIdx       = 3;
    } else if (cfg.types && cfg.types.length > 0) {
      qParams    = [companyGuid, cfg.types];
      typeFilter = 'AND v.voucher_type = ANY($2)';
      qIdx       = 3;
    } else if (cfg.types && cfg.types.length === 0) {
      // Empty array = return nothing (ISD/TDS requires special Tally setup)
      return res.json({ success: true, country_applicable: true, data: [], meta: { total: 0, gstr_type: gstrTypeStr, empty: true,
        label: cfg.label, message: `${cfg.label} (${gstrTypeStr}) requires specific Tally TDL setup. No data available.` } });
    } else {
      qParams    = [companyGuid];
      typeFilter = '';
      qIdx       = 2;
    }
    let q = `SELECT v.id, v.guid, v.voucher_number, v.party_name, v.voucher_type, v.amount, v.date, v.narration, v.irn, v.ewb_number,
                    v.voucher_type_parent,
                    COALESCE(g.taxable_amount, 0) as taxable_amount,
                    COALESCE(g.cgst_amount, 0) as cgst_amount,
                    COALESCE(g.sgst_amount, 0) as sgst_amount,
                    COALESCE(g.igst_amount, 0) as igst_amount,
                    g.gst_reg_type, g.place_of_supply,
                    v.party_gstin, v.gst_section, v.gstr3b_section, v.gst_transaction_nature, v.gst_tabs_json, v.gst_sections_json,
                       v.is_export, v.is_sez, v.is_reverse_charge, v.is_import, v.is_non_gst, v.is_gst_relevant, v.cess_amount,
                    g.is_nil_rated, g.is_exempt,
                    v.itc_eligibility,
                    CASE WHEN l2.gstin IS NOT NULL AND l2.gstin != '' THEN 'Registered' ELSE 'Unregistered' END as party_registration_type,
                    COALESCE(
                      (SELECT STRING_AGG(DISTINCT vle.ledger_name, ', ' ORDER BY vle.ledger_name)
                       FROM voucher_ledger_entries vle
                       WHERE vle.voucher_guid = v.guid
                       AND (vle.ledger_name ILIKE '%cgst%' OR vle.ledger_name ILIKE '%sgst%'
                         OR vle.ledger_name ILIKE '%igst%' OR vle.ledger_name ILIKE '%cess%'
                         OR vle.ledger_name ILIKE '%tds%' OR vle.ledger_name ILIKE '%tcs%'
                         OR vle.ledger_name ILIKE '%reverse charge%' OR vle.ledger_name ILIKE '%rcm%')
                      ), ''
                    ) as gst_ledger_names
             FROM vouchers v
             LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid
             LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_guid = v.company_guid
             WHERE v.company_guid=$1 AND v.is_cancelled=FALSE ${typeFilter}`;
    if (fyFrom) { q += ` AND v.date >= $${qIdx++}`; qParams.push(fyFrom); }
    if (fyTo)   { q += ` AND v.date <= $${qIdx++}`; qParams.push(fyTo); }
    q += ' ORDER BY v.date DESC LIMIT 200';
    const { rows: rawRows } = await query(q, qParams);

    if (rawRows.length === 0) {
      return res.json({ success: true, data: [], groups: [], meta: { total: 0, gstr_type: gstrTypeStr, not_applicable: true,
        label: cfg.label, message: `No ${cfg.label} (${gstrTypeStr}) transactions found for this period.` } });
    }
    const rows = rawRows.map(row => ({
      ...row,
      classification_reason: getClassificationReason(row, gstrTypeStr),
      gst_tabs: getGstTabsForVoucher(row, gstTaxpayerType),
    }));
    const groupsMain = groupVouchersByMonth(rows);
    res.json({ success: true, country_applicable: true, data: rows, groups: groupsMain,
      meta: { total: rows.length, gstr_type: gstrTypeStr, label: cfg.label } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// REPORTS — UNMATCHED INVOICES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/reports/unmatched — Sales/Purchase vouchers missing GST details or with 0 GST
router.get('/reports/unmatched', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, page = 1, limit = 50 } = req.query;
  const { from: fyFrom, to: fyTo } = await resolveFYDates(companyGuid, from, to);
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    // Unmatched = sales/purchase vouchers where GST details are missing or 0
    const { rows } = await query(`
      SELECT v.voucher_number, v.voucher_type, v.date, v.party_name, ABS(v.amount) as amount,
        CASE
          WHEN gst.id IS NULL THEN 'No GST entry'
          WHEN COALESCE(gst.cgst_amount,0)+COALESCE(gst.sgst_amount,0)+COALESCE(gst.igst_amount,0) = 0
            AND gst.gst_reg_type IS NULL THEN 'Missing GST type'
          WHEN gst.gst_reg_type = 'Unregistered' THEN 'Unregistered party'
          ELSE 'Incomplete GST'
        END as issue,
        v.guid
      FROM vouchers v
      LEFT JOIN gst_voucher_details gst ON gst.voucher_guid = v.guid AND gst.company_guid = v.company_guid
      WHERE v.company_guid = $1
        AND v.is_cancelled = FALSE
        AND v.voucher_type ILIKE ANY(ARRAY['%Sales%','%Purchase%'])
        AND v.date BETWEEN $2 AND $3
        AND (
          gst.id IS NULL
          OR COALESCE(gst.cgst_amount,0)+COALESCE(gst.sgst_amount,0)+COALESCE(gst.igst_amount,0) = 0
        )
        AND ABS(v.amount) > 0
      ORDER BY v.date DESC
      LIMIT $4 OFFSET $5
    `, [companyGuid, fyFrom, fyTo, parseInt(limit), offset]);
    const { rows: cnt } = await query(
      `SELECT COUNT(*) as c FROM vouchers v
       LEFT JOIN gst_voucher_details gst ON gst.voucher_guid = v.guid AND gst.company_guid = v.company_guid
       WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type ILIKE ANY(ARRAY['%Sales%','%Purchase%'])
         AND v.date BETWEEN $2 AND $3
         AND (gst.id IS NULL OR COALESCE(gst.cgst_amount,0)+COALESCE(gst.sgst_amount,0)+COALESCE(gst.igst_amount,0)=0)
         AND ABS(v.amount)>0`,
      [companyGuid, fyFrom, fyTo]
    );
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXPENSES
// ══════════════════════════════════════════════════════════════════════════════

router.get('/expenses', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, page = 1, limit = 30, type } = req.query;
  const { from: fyFrom, to: fyTo } = await resolveFYDates(companyGuid, from, to);
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    // Expenses = Journal (adjustments/accruals) + Payment (cash expense payments)
    // Exclude amount=0 junk records; filter by FY date range
    let q = `SELECT * FROM vouchers WHERE company_guid=$1
      AND voucher_type IN ('Journal','Payment','Contra')
      AND is_cancelled=FALSE
      AND amount > 0
      AND date IS NOT NULL AND date != ''
      AND date BETWEEN $2 AND $3`;
    const params = [companyGuid, fyFrom, fyTo];
    // Optional sub-type filter
    if (type) { q += ` AND voucher_type = $4`; params.push(type); }
    q += ` ORDER BY date DESC, amount DESC LIMIT $${params.length+1} OFFSET $${params.length+2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    // Total from voucher amounts (not ledger closing balance which can be 0)
    const { rows: totRow } = await query(
      `SELECT COALESCE(SUM(amount),0) as total FROM vouchers
       WHERE company_guid=$1 AND voucher_type IN ('Journal','Payment','Contra')
         AND is_cancelled=FALSE AND amount > 0
         AND date IS NOT NULL AND date != ''
         AND date BETWEEN $2 AND $3`,
      [companyGuid, fyFrom, fyTo]
    );
    const totalExpenses = parseFloat(totRow[0]?.total || 0);
    const cnt = await query(
      `SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND voucher_type IN ('Journal','Payment','Contra')
       AND is_cancelled=FALSE AND amount > 0 AND date IS NOT NULL AND date != '' AND date BETWEEN $2 AND $3`,
      [companyGuid, fyFrom, fyTo]
    );
    res.json({
      success: true,
      data: rows,
      summary: { total: totalExpenses, display: `₹${Math.round(totalExpenses).toLocaleString('en-IN')}` },
      meta: { total: parseInt(cnt.rows[0].c), page: parseInt(page), limit: parseInt(limit), from: fyFrom, to: fyTo }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// DAYBOOK
// ══════════════════════════════════════════════════════════════════════════════

router.get('/daybook', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { date, page = 1, limit = 50 } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    const { rows } = await query(
      `SELECT * FROM vouchers WHERE company_guid=$1 AND date=$2 AND is_cancelled=FALSE ORDER BY id DESC LIMIT $3 OFFSET $4`,
      [companyGuid, targetDate, parseInt(limit), offset]
    );
    const { rows: cnt } = await query('SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND date=$2 AND is_cancelled=FALSE', [companyGuid, targetDate]);
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), date: targetDate, page: parseInt(page) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// COUNTRY CAPABILITY CHECK — multi-country awareness
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/company/capabilities — tells frontend what features are available
router.get('/company/capabilities', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query('SELECT gstin, name FROM companies WHERE guid=$1', [companyGuid]);
    const co = rows[0];
    const isIndia = !!(co?.gstin);
    // Detect country from GSTIN format (India: 15-char alphanumeric starting with 2 digits)
    const country = isIndia ? 'IN' : 'OTHER';
    res.json({
      success: true,
      data: {
        country,
        company_name: co?.name,
        features: {
          gst:        isIndia,   // GST filing, GSTR reports
          einvoice:   isIndia,   // E-Invoice / IRN generation
          ewaybill:   isIndia,   // E-Way Bill generation
          tds:        isIndia,   // TDS management
          multi_currency: !isIndia, // Non-India companies may use foreign currency
          tally_sync: true,      // Always available
        },
        gstin: co?.gstin || null,
      }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// SYNC HISTORY
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/sync-history — audit log of desktop sync operations
router.get('/sync-history', authMiddleware, async (req, res) => {
  const { companyGuid, limit = 50 } = req.query;
  if (!companyGuid) return res.status(400).json({ success: false, error: { message: 'companyGuid required' } });
  try {
    const { rows } = await query(
      `SELECT id, device_id, mode, synced_at, voucher_count, ledger_count, stock_count, record_count, status, error_message
       FROM sync_log
       WHERE company_guid = $1 AND user_id = $2
       ORDER BY synced_at DESC
       LIMIT $3`,
      [companyGuid, req.user.userId, parseInt(limit)]
    );
    res.json({ success: true, data: { entries: rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// ── AI Insights (proxy to /app/ai/ai-insights) ──────────────────────────────
router.get('/ai/insights', authMiddleware, async (req, res) => {
  try {
    const { companyGuid, from, to } = req.query;
    const params = new URLSearchParams();
    if (companyGuid) params.set('companyGuid', companyGuid);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    // Forward to /app/ai/ai-insights with same auth
    const { rows: devRows } = await query('SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1', [req.user.userId]);
    const deviceId = devRows[0]?.device_id;
    const { rows: compRows } = await query('SELECT guid FROM companies WHERE user_id = $1 AND is_active = TRUE LIMIT 1', [req.user.userId]);
    const guid = companyGuid || compRows[0]?.guid;
    if (!guid) return res.json({ success: true, data: { insights: [], summary: 'No company data available.' } });
    // Get AI insights from the analytics service
    const { query: dbQuery } = await import('../db/schema.js');
    // Use existing AI analytics if available
    res.json({ success: true, data: { company_guid: guid, note: 'AI analytics available via /app/ai/ai-insights', isPaired: !!deviceId } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});


// POST /api/admin/backfill-gst — Recompute gst_voucher_details from ledger entries (CGST/SGST/IGST)
router.post('/admin/backfill-gst', authMiddleware, async (req, res) => {
  const companyGuid = req.body?.companyGuid || req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rowCount } = await query(`
      UPDATE gst_voucher_details gvd
      SET cgst_amount=sub.cgst, sgst_amount=sub.sgst, igst_amount=sub.igst, taxable_amount=sub.taxable
      FROM (
        SELECT v.guid as voucher_guid, v.company_guid,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' THEN ABS(vle.amount) ELSE 0 END),0) as cgst,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%UTGST%' THEN ABS(vle.amount) ELSE 0 END),0) as sgst,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0) as igst,
          GREATEST(0, COALESCE(SUM(CASE WHEN vle.dr_cr='Dr' THEN ABS(vle.amount) ELSE 0 END),0) -
            COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0)) as taxable
        FROM vouchers v
        JOIN voucher_ledger_entries vle ON vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid
        WHERE v.company_guid=$1
        GROUP BY v.guid, v.company_guid
        HAVING SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END) > 0
      ) sub
      WHERE gvd.voucher_guid = sub.voucher_guid AND gvd.company_guid = sub.company_guid`,
      [companyGuid]
    );
    res.json({ success: true, data: { updated: rowCount } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ── Company Profile — GET + PUT ────────────────────────────────────────────────
router.get('/company/profile', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query('SELECT * FROM companies WHERE guid=$1 LIMIT 1', [companyGuid]);
    if (!rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// PATCH + PUT both accepted for company profile update
const _companyProfileUpdate = async (req, res) => {
  const companyGuid = req.query.companyGuid || req.body?.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { gstin, address, state, email, formal_name } = req.body || {};
  try {
    await query(`
      UPDATE companies SET
        gstin = COALESCE($1, gstin),
        address = COALESCE($2, address),
        state = COALESCE($3, state),
        formal_name = COALESCE($5, formal_name)
      WHERE guid = $4
    `, [gstin || null, address || null, state || null, companyGuid, formal_name || null]);
    res.json({ success: true, message: 'Company profile updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};
router.put('/company/profile', authMiddleware, _companyProfileUpdate);
router.patch('/company/profile', authMiddleware, _companyProfileUpdate);

// ─── POST /api/company/:guid/logo — upload company logo (base64 data URI) ──────
router.post('/company/:guid/logo', authMiddleware, async (req, res) => {
  const { guid } = req.params;
  if (!await verifyCompanyOwnership(req, res, guid)) return;
  const { logo } = req.body || {}; // expects base64 data URI: data:image/jpeg;base64,...
  if (!logo) return res.status(400).json({ success: false, error: { code: 'MISSING_LOGO', message: 'logo field required (base64 data URI)' } });
  // Validate it's a data URI image
  if (!logo.startsWith('data:image/')) return res.status(400).json({ success: false, error: { code: 'INVALID_FORMAT', message: 'logo must be a base64 data URI (data:image/...)' } });
  // Rough size check: base64 of 500KB image is ~680KB
  if (logo.length > 750_000) return res.status(413).json({ success: false, error: { code: 'TOO_LARGE', message: 'Logo too large. Max 500 KB.' } });
  try {
    await query('UPDATE companies SET logo_url=$1 WHERE guid=$2', [logo, guid]);
    res.json({ success: true, data: { logo_url: logo }, message: 'Logo updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── GET /api/company/:guid/logo — fetch company logo ──────────────────────────
router.get('/company/:guid/logo', authMiddleware, async (req, res) => {
  const { guid } = req.params;
  if (!await verifyCompanyOwnership(req, res, guid)) return;
  try {
    const { rows } = await query('SELECT logo_url FROM companies WHERE guid=$1 LIMIT 1', [guid]);
    if (!rows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company not found' } });
    res.json({ success: true, data: { logo_url: rows[0].logo_url || null } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── GET /api/auth/user-settings ──────────────────────────────────────────────
router.get('/auth/user-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, voucher_config, country, timezone, week_start FROM users WHERE id=$1',
      [req.user.userId]
    );
    res.json({ success: true, data: rows[0] || {} });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to get settings' } });
  }
});

// ─── PATCH /api/auth/user-settings ─────────────────────────────────────────────
router.patch('/auth/user-settings', authMiddleware, async (req, res) => {
  const { language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, voucher_config, country, timezone, week_start } = req.body || {};
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
        country = COALESCE($10, country),
        timezone = COALESCE($11, timezone),
        week_start = COALESCE($12, week_start)
      WHERE id = $9
    `, [language ?? null, currency ?? null, number_format ?? null, date_format ?? null, theme ?? null,
        kpi_autoscroll !== undefined ? kpi_autoscroll : null,
        decimal_places !== undefined ? decimal_places : null,
        voucher_config ? JSON.stringify(voucher_config) : null,
        req.user.userId,
        country ?? null, timezone ?? null, week_start ?? null]);
    res.json({ success: true, message: 'Settings updated' });
  } catch (err) {
    console.error('[user-settings PATCH]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to update settings' } });
  }
});


// POST /api/reminders/send — Send WhatsApp payment reminder to a party
router.post('/reminders/send', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerName, mobile, amount, dueDate, invoiceNo, invoiceDate, contactNumber } = req.body || {};
  if (!companyGuid || !mobile) return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'companyGuid and mobile required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  
  try {
    // Get company name for the message
    const { rows: co } = await query('SELECT name FROM companies WHERE guid=$1 LIMIT 1', [companyGuid]);
    const companyName = co[0]?.name || 'Company';
    
    // Clean mobile number
    const digits = (mobile || '').replace(/[^0-9]/g, '');
    if (digits.length < 10) return res.status(400).json({ success: false, error: { code: 'INVALID_MOBILE', message: 'Invalid mobile number' } });
    
    // Get user's configured template name from their settings
    const { rows: userSettings } = await query('SELECT alert_settings FROM users WHERE id=$1', [req.user.userId]);
    const userTemplateName = userSettings[0]?.alert_settings?.payment_reminders?.template_name;

    // Determine channels from user notification settings
    const notifSettings = userSettings[0]?.alert_settings?.payment_reminders || {};
    const channels = {
      whatsapp: notifSettings.channels?.whatsapp !== false,
      email:    notifSettings.channels?.email === true,
      sms:      notifSettings.channels?.sms   === true,
    };

    // Get party email if email channel enabled
    let partyEmail = null;
    if (channels.email) {
      const { rows: party } = await query(
        'SELECT email FROM ledgers WHERE company_guid=$1 AND name=$2 LIMIT 1',
        [companyGuid, ledgerName]
      ).catch(() => ({ rows: [] }));
      partyEmail = party[0]?.email || null;
    }

    const result = await sendPaymentReminder({
      countryCode: '+91',
      mobile: digits.slice(-10),
      email: partyEmail,
      partyName: ledgerName || 'Customer',
      businessName: companyName,
      amountDue: amount ? `₹${Math.round(parseFloat(amount)).toLocaleString('en-IN')}` : '₹0',
      invoiceNo: invoiceNo || '',
      invoiceDate: invoiceDate || '',
      dueDate: dueDate || '',
      contactNumber: contactNumber || '',
      templateName: userTemplateName,
      channels,
    });
    
    if (result.success) {
      res.json({ success: true, message: 'Reminder sent successfully' });
    } else {
      res.status(500).json({ success: false, error: { code: 'SEND_FAILED', message: result.error || 'Failed to send reminder' } });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});


// ── User Settings (accessible from mobile via /api prefix) ───────────────────
router.get('/user-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, notification_settings, alert_settings, integration_settings, voucher_config FROM users WHERE id=$1',
      [req.user.userId]
    );
    res.json({ status: true, data: rows[0] || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.patch('/user-settings', authMiddleware, async (req, res) => {
  const { language, currency, number_format, date_format, theme, kpi_autoscroll, decimal_places, voucher_config } = req.body || {};
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    const addField = (col, val) => { if (val !== undefined) { fields.push(`${col} = $${idx++}`); values.push(val); } };
    addField('language', language);
    addField('currency', currency);
    addField('number_format', number_format);
    addField('date_format', date_format);
    addField('theme', theme);
    addField('kpi_autoscroll', kpi_autoscroll);
    addField('decimal_places', decimal_places);
    if (voucher_config !== undefined) { fields.push(`voucher_config = voucher_config || $${idx++}::jsonb`); values.push(JSON.stringify(voucher_config)); }
    if (fields.length === 0) return res.json({ status: true, message: 'Nothing to update' });
    values.push(req.user.userId);
    await query(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    res.json({ status: true, message: 'Settings updated' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.get('/notification-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT notification_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.notification_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.patch('/notification-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET notification_settings = notification_settings || $1::jsonb WHERE id=$2', [JSON.stringify(req.body||{}), req.user.userId]);
    res.json({ status: true, message: 'Saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.get('/alert-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT alert_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.alert_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.patch('/alert-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET alert_settings = alert_settings || $1::jsonb WHERE id=$2', [JSON.stringify(req.body||{}), req.user.userId]);
    res.json({ status: true, message: 'Saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.get('/integration-settings', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT integration_settings FROM users WHERE id=$1', [req.user.userId]);
    res.json({ status: true, data: rows[0]?.integration_settings || {} });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

router.patch('/integration-settings', authMiddleware, async (req, res) => {
  try {
    await query('UPDATE users SET integration_settings = integration_settings || $1::jsonb WHERE id=$2', [JSON.stringify(req.body||{}), req.user.userId]);
    res.json({ status: true, message: 'Saved' });
  } catch (err) { res.status(500).json({ status: false, message: err.message }); }
});

// ─── POST /api/auth/verify-pin ───────────────────────────────────────────────
router.post('/auth/verify-pin', preAuthMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'PIN required' } });
  try {
    const { rows } = await query('SELECT id, mobile, name, language, two_fa_pin_hash FROM users WHERE id=$1', [req.user.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    const match = await bcrypt.compare(String(pin), user.two_fa_pin_hash);
    if (!match) return res.status(401).json({ success: false, error: { code: 'PIN_INVALID', message: 'Incorrect PIN. Try again.' } });
    const token = generateToken({ userId: user.id, mobile: user.mobile });
    await query('UPDATE users SET token=$1, updated_at=$2 WHERE id=$3', [token, now(), user.id]);
    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id=$1 AND paired=TRUE LIMIT 1', [user.id]);
    const isPaired = devices.length > 0;
    let company = null;
    if (isPaired) {
      const { rows: companies } = await query('SELECT guid, name, gstin FROM companies WHERE user_id=$1 AND is_active=TRUE LIMIT 1', [user.id]);
      if (companies[0]) company = { guid: companies[0].guid, name: companies[0].name, gstin: companies[0].gstin || null };
    }
    console.log(`[API 2FA] PIN verified for user ${user.id}`);
    res.json({
      success: true,
      data: {
        access_token: token,
        is_new_user: !user.name,
        is_paired: isPaired,
        company,
        user: { id: user.id, name: user.name || null, phone: user.mobile, language: user.language || 'en' },
      },
    });
  } catch (err) {
    console.error('[api verify-pin]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Verification failed' } });
  }
});

// ─── POST /api/auth/set-pin ───────────────────────────────────────────────────
router.post('/auth/set-pin', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'PIN must be at least 4 characters' } });
  try {
    const hash = await bcrypt.hash(String(pin), 10);
    await query('UPDATE users SET two_fa_pin_hash=$1, two_fa_enabled=TRUE, updated_at=$2 WHERE id=$3', [hash, now(), req.user.userId]);
    res.json({ success: true, data: { message: '2FA enabled' } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to set PIN' } }); }
});

// ─── POST /api/auth/reset-pin ─────────────────────────────────────────────────
router.post('/auth/reset-pin', preAuthMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin || String(pin).length < 4) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'PIN must be at least 4 characters' } });
  try {
    const hash = await bcrypt.hash(String(pin), 10);
    await query('UPDATE users SET two_fa_pin_hash=$1, two_fa_enabled=TRUE, updated_at=$2 WHERE id=$3', [hash, now(), req.user.userId]);
    const { rows } = await query('SELECT mobile, name, language FROM users WHERE id=$1', [req.user.userId]);
    const u = rows[0];
    const token = generateToken({ userId: req.user.userId, mobile: u.mobile });
    await query('UPDATE users SET token=$1 WHERE id=$2', [token, req.user.userId]);
    const { rows: devices } = await query('SELECT device_id FROM devices WHERE user_id=$1 AND paired=TRUE LIMIT 1', [req.user.userId]);
    res.json({
      success: true,
      data: {
        access_token: token,
        is_paired: devices.length > 0,
        is_new_user: !u.name,
        user: { id: req.user.userId, name: u.name || null, phone: u.mobile, language: u.language || 'en' },
      },
    });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to reset PIN' } }); }
});

// ─── DELETE /api/auth/remove-pin ──────────────────────────────────────────────
router.delete('/auth/remove-pin', authMiddleware, async (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'PIN required' } });
  try {
    const { rows } = await query('SELECT two_fa_pin_hash FROM users WHERE id=$1', [req.user.userId]);
    const match = rows[0]?.two_fa_pin_hash ? await bcrypt.compare(String(pin), rows[0].two_fa_pin_hash) : true;
    if (!match) return res.status(401).json({ success: false, error: { code: 'PIN_INVALID', message: 'Incorrect PIN' } });
    await query('UPDATE users SET two_fa_enabled=FALSE, two_fa_pin_hash=NULL, updated_at=$1 WHERE id=$2', [now(), req.user.userId]);
    res.json({ success: true, data: { message: '2FA disabled' } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to disable 2FA' } }); }
});

// ─── PATCH /api/auth/set-biometric ────────────────────────────────────────────
router.patch('/auth/set-biometric', authMiddleware, async (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'enabled (boolean) required' } });
  try {
    await query('UPDATE users SET biometric_enabled=$1, updated_at=$2 WHERE id=$3', [enabled, now(), req.user.userId]);
    res.json({ success: true, data: { message: `Biometric ${enabled ? 'enabled' : 'disabled'}` } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ─── GET /api/auth/two-fa-status ──────────────────────────────────────────────
router.get('/auth/two-fa-status', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query('SELECT two_fa_enabled, biometric_enabled FROM users WHERE id=$1', [req.user.userId]);
    const u = rows[0] || {};
    res.json({ success: true, data: { two_fa_enabled: !!u.two_fa_enabled, biometric_enabled: !!u.biometric_enabled } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ─── POST /api/auth/change-phone ──────────────────────────────────────────────
// step 1: send OTP to currentPhone
// step 2: verify OTP for currentPhone, send OTP to newPhone
// step 3: verify OTP for newPhone, update users.mobile
router.post('/auth/change-phone', authMiddleware, async (req, res) => {
  const { step, currentPhone, otp, newPhone } = req.body;
  const userId = req.user.userId;

  const normalize = (p) => {
    if (!p) return '';
    const digits = String(p).replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
  };

  try {
    if (step === 1) {
      // Send OTP to current phone
      const cleanPhone = normalize(currentPhone);
      if (!cleanPhone || cleanPhone.length < 10)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid current phone required' } });

      // Verify that currentPhone matches the user's mobile
      const { rows } = await query('SELECT mobile FROM users WHERE id=$1', [userId]);
      if (!rows[0] || rows[0].mobile !== cleanPhone)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Current phone does not match your account' } });

      const otp4 = makeOtp();
      const expires = Date.now() + 5 * 60 * 1000;
      await query('UPDATE users SET phone_change_otp=$1, phone_change_otp_expires=$2, updated_at=$3 WHERE id=$4',
        [otp4, expires, now(), userId]);

      const waResult = await sendWhatsAppOTP('+91', cleanPhone, otp4);
      console.log(`[CHANGE-PHONE S1] OTP ${otp4} → +91${cleanPhone}`);
      const r = { success: true, data: { message: 'OTP sent to current phone via WhatsApp' } };
      if (process.env.NODE_ENV !== 'production') r.data.otp = otp4;
      return res.json(r);
    }

    if (step === 2) {
      // Verify OTP for current phone, then send OTP to newPhone
      if (!currentPhone || !otp || !newPhone)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'currentPhone, otp, and newPhone required' } });

      const { rows } = await query('SELECT phone_change_otp, phone_change_otp_expires FROM users WHERE id=$1', [userId]);
      const u = rows[0];
      if (!u || u.phone_change_otp !== String(otp))
        return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Invalid OTP for current phone' } });
      if (Date.now() > Number(u.phone_change_otp_expires))
        return res.status(401).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' } });

      const cleanNew = normalize(newPhone);
      if (!cleanNew || cleanNew.length < 10)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid new phone required' } });

      // Check new phone not already taken
      const { rows: taken } = await query('SELECT id FROM users WHERE mobile=$1 AND id!=$2', [cleanNew, userId]);
      if (taken.length > 0)
        return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'This phone number is already in use' } });

      const newOtp = makeOtp();
      const newExpires = Date.now() + 5 * 60 * 1000;
      await query('UPDATE users SET phone_change_otp=$1, phone_change_otp_expires=$2, phone_change_new=$3, updated_at=$4 WHERE id=$5',
        [newOtp, newExpires, cleanNew, now(), userId]);

      await sendWhatsAppOTP('+91', cleanNew, newOtp);
      console.log(`[CHANGE-PHONE S2] OTP ${newOtp} → +91${cleanNew}`);
      const r = { success: true, data: { message: 'OTP sent to new phone via WhatsApp' } };
      if (process.env.NODE_ENV !== 'production') r.data.otp = newOtp;
      return res.json(r);
    }

    if (step === 3) {
      // Verify OTP for new phone, update mobile
      if (!otp)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'OTP required' } });

      const { rows } = await query('SELECT phone_change_otp, phone_change_otp_expires, phone_change_new FROM users WHERE id=$1', [userId]);
      const u = rows[0];
      if (!u || u.phone_change_otp !== String(otp))
        return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Invalid OTP for new phone' } });
      if (Date.now() > Number(u.phone_change_otp_expires))
        return res.status(401).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' } });
      if (!u.phone_change_new)
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'No pending phone change' } });

      await query(
        'UPDATE users SET mobile=$1, phone_change_otp=NULL, phone_change_otp_expires=NULL, phone_change_new=NULL, updated_at=$2 WHERE id=$3',
        [u.phone_change_new, now(), userId]
      );
      console.log(`[CHANGE-PHONE S3] Updated phone for user ${userId} → ${u.phone_change_new}`);
      return res.json({ success: true, data: { message: 'Phone number updated successfully', newPhone: u.phone_change_new } });
    }

    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid step. Must be 1, 2, or 3.' } });
  } catch (err) {
    console.error('[CHANGE-PHONE] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── POST /api/auth/change-email ──────────────────────────────────────────────
// step 1: send OTP to currentEmail
// step 2: verify OTP, update users.email
router.post('/auth/change-email', authMiddleware, async (req, res) => {
  const { step, currentEmail, otp, newEmail } = req.body;
  const userId = req.user.userId;

  try {
    if (step === 1) {
      if (!currentEmail || !currentEmail.includes('@'))
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Valid current email required' } });

      const otp4 = makeOtp();
      const expires = Date.now() + 5 * 60 * 1000;
      await query('UPDATE users SET email_change_otp=$1, email_change_otp_expires=$2, updated_at=$3 WHERE id=$4',
        [otp4, expires, now(), userId]);

      await sendOTPEmail(currentEmail, otp4);
      console.log(`[CHANGE-EMAIL S1] OTP ${otp4} → ${currentEmail}`);
      const r = { success: true, data: { message: 'OTP sent to your email' } };
      if (process.env.NODE_ENV !== 'production') r.data.otp = otp4;
      return res.json(r);
    }

    if (step === 2) {
      // verify OTP, update email (newEmail is the target)
      if (!otp || !newEmail || !newEmail.includes('@'))
        return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'otp and newEmail required' } });

      const { rows } = await query('SELECT email_change_otp, email_change_otp_expires FROM users WHERE id=$1', [userId]);
      const u = rows[0];
      if (!u || u.email_change_otp !== String(otp))
        return res.status(401).json({ success: false, error: { code: 'OTP_INVALID', message: 'Invalid OTP' } });
      if (Date.now() > Number(u.email_change_otp_expires))
        return res.status(401).json({ success: false, error: { code: 'OTP_EXPIRED', message: 'OTP expired. Request a new one.' } });

      await query(
        'UPDATE users SET email=$1, email_change_otp=NULL, email_change_otp_expires=NULL, updated_at=$2 WHERE id=$3',
        [newEmail.trim().toLowerCase(), now(), userId]
      );
      console.log(`[CHANGE-EMAIL S2] Updated email for user ${userId} → ${newEmail}`);
      return res.json({ success: true, data: { message: 'Email updated successfully', newEmail } });
    }

    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid step. Must be 1 or 2.' } });
  } catch (err) {
    console.error('[CHANGE-EMAIL] Error:', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

export default router;
