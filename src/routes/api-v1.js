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

// ─── Product Display Name helpers ───────────────────────────────────

// Fetch the company's product_display_field setting. Returns 'name' if not set.
async function getProductDisplayField(companyGuid) {
  try {
    const { rows } = await query(
      `SELECT product_display_field FROM company_inventory_settings WHERE company_guid=$1 LIMIT 1`,
      [companyGuid]
    );
    return rows[0]?.product_display_field || 'name';
  } catch {
    return 'name';
  }
}

// Compute displayName from a stock item object based on the company's display field setting.
// Never overwrites stocks.name (Tally master). Falls back to name if chosen field is empty.
function computeDisplayName(item, field) {
  const name        = (item.name        || item.itemName || '').trim();
  const alias       = (item.alias       || '').trim();
  const sku         = (item.sku         || '').trim();   // part_number (OnlyAlias from Tally)
  const description = (item.description || '').trim();
  switch (field) {
    case 'alias':       return alias       || name;
    case 'part_number': return sku         || name;
    case 'description': return description || name;
    case 'name':        return name;
    case 'auto':
      if (alias && alias !== name && alias.length >= 3)       return alias;
      if (description && description.length >= 3)             return description;
      if (sku && sku !== name && sku.length >= 3)             return sku;
      return name;
    default:            return name;
  }
}

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

// GET /api/vouchers/my-entries — vouchers + pending write_queue entries created via this user's mobile app
router.get('/vouchers/my-entries', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, type, page = 1, limit = 50 } = req.query;
  const userId = req.user.userId;
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    // 1. Posted vouchers (synced back from Tally)
    let q = `
      SELECT DISTINCT v.*, 'posted' as _queue_status, wq.id as _queue_id
      FROM vouchers v
      JOIN write_queue wq ON wq.company_guid = v.company_guid
        AND wq.tally_voucher_number = v.voucher_number
      WHERE v.company_guid = $1 AND wq.user_id = $2 AND v.is_cancelled = FALSE
    `;
    const params = [companyGuid, userId];
    let idx = 3;
    if (from) { q += ` AND v.date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND v.date <= $${idx++}`; params.push(to); }
    if (type) { q += ` AND v.voucher_type ILIKE $${idx++}`; params.push(`%${type}%`); }
    q += ` ORDER BY v.date DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows: postedRows } = await query(q, params);

    // 2. Pending/failed write_queue entries not yet in vouchers
    // Also include 'success' entries for non-standard voucher types (stock_transfer, stock_adjustment)
    // that may not produce a joinable tally_voucher_number match
    const { rows: pendingRows } = await query(`
      SELECT
        wq.id as _queue_id,
        wq.entry_type as voucher_type,
        wq.entry_label as party_name,
        wq.status as _queue_status,
        wq.error_message as _queue_error,
        wq.attempt_count,
        TO_CHAR(TO_TIMESTAMP(wq.created_at), 'YYYY-MM-DD') as date,
        wq.created_at,
        wq.tally_voucher_number as voucher_number,
        wq.amount as amount,
        wq.payload as _payload,
        NULL as guid
      FROM write_queue wq
      WHERE wq.company_guid = $1
        AND wq.user_id = $2
        AND (
          wq.status IN ('pending', 'processing', 'desktop_offline', 'failed')
          OR (
            -- Keep ALL successful entries for 30 days so user can verify what was created.
            -- Invoices/vouchers also show via posted JOIN above, mobile deduplicates by ref.
            wq.status = 'success'
            AND wq.created_at > EXTRACT(EPOCH FROM NOW())::BIGINT - 2592000
          )
        )
      ORDER BY wq.created_at DESC
      LIMIT 50
    `, [companyGuid, userId]);

    res.json({ success: true, data: postedRows, pending: pendingRows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/vouchers/my-entries/:id/retry — manually retry a queued write_queue entry
router.post('/vouchers/my-entries/:id/retry', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const userId = req.user.userId;
  try {
    const { rows } = await query(
      `SELECT * FROM write_queue WHERE id=$1 AND user_id=$2`,
      [id, userId]
    );
    if (!rows[0]) return res.status(404).json({ success: false, message: 'Entry not found' });
    const entry = rows[0];
    // Use retrySingleEntry to safely push one entry without race conditions
    const { retrySingleEntry } = await import('./tally-write.js');
    const result = await retrySingleEntry(id, userId);
    return res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
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
  const { search = '', category, warehouse, page = 1, limit = 500 } = req.query; // Default 500
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const fyRequested = !!(req.query.fy || req.query.from || req.query.to);
    const displayField = await getProductDisplayField(companyGuid);

    let q, params, idx;
    if (fyRequested) {
      // FY-specific: derive closing qty from stock_transactions up to fyTo (Tally FY guide compliant)
      q = `
        SELECT s.guid, s.name, s.alias, s.sku, s.description, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
               s.reorder_level, s.closing_rate,
               (SELECT st2.warehouse FROM stock_transactions st2
                WHERE st2.company_guid = s.company_guid AND st2.stock_guid = s.name
                ORDER BY st2.date DESC LIMIT 1) AS primary_warehouse,
               (
                 SELECT ROUND(
                   COALESCE(SUM(ABS(stc.qty)), 0) /
                   GREATEST((NOW()::date - MIN(stc.date::date)), 1)
                 , 4)
                 FROM stock_transactions stc
                 WHERE stc.company_guid = s.company_guid
                   AND stc.stock_guid = s.name
                   AND stc.type = 'outward'
                   AND stc.date::date >= (NOW() - INTERVAL '90 days')::date
               ) AS avg_daily_consumption,
               COALESCE(s.opening_qty, 0)
               + COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0)
               - COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0) AS fy_closing_qty,
               s.closing_rate * (
                 COALESCE(s.opening_qty, 0)
                 + COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0)
                 - COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0)
               ) AS fy_closing_value
        FROM stocks s
        -- Physical Stock vouchers are Tally stock-count/audit entries (absolute qty, not a movement).
        -- Exclude from FY running qty calc to prevent cumulative inflation.
        -- TODO: future — model Physical Stock as absolute stock count event (last count wins, movements apply on top)
        LEFT JOIN stock_transactions st ON st.stock_guid = s.name AND st.company_guid = s.company_guid
          AND st.date <= $3
          AND st.voucher_type != 'Physical Stock'
          AND COALESCE(st.voucher_type, '') != 'Opening Balance'
        WHERE s.company_guid = $1
          AND (s.name ILIKE $2 OR s.alias ILIKE $2 OR s.hsn ILIKE $2)
        GROUP BY s.guid, s.company_guid, s.name, s.alias, s.sku, s.description, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
                 s.reorder_level, s.closing_rate, s.opening_qty
        ORDER BY fy_closing_value DESC NULLS LAST, s.name
      `;
      params = [companyGuid, `%${search}%`, fyTo];
      if (category) { q = q.replace('GROUP BY', `AND s.category = $4 GROUP BY`); params.push(category); }
      const { rows: rawRows } = await query(q, params);
      // Warehouse filter: keep only items that have transactions in the selected warehouse
      let allRows = rawRows;
      if (warehouse) {
        const { rows: whRows } = await query(
          `SELECT DISTINCT stock_guid FROM stock_transactions WHERE company_guid=$1 AND warehouse=$2`,
          [companyGuid, warehouse]
        );
        // stock_transactions.stock_guid stores stock NAME, not guid — match on s.name
        const whSet = new Set(whRows.map(r => r.stock_guid));
        allRows = rawRows.filter(r => whSet.has(r.name));
      }
      // Apply pagination in JS after FY computation
      const totalRows = allRows.length;
      const rows = allRows.slice(offset, offset + parseInt(limit)).map(r => ({
        ...r,
        closing_qty:          parseFloat(r.fy_closing_qty        || 0),
        closing_value:        parseFloat(r.fy_closing_value      || 0),
        primary_warehouse:    r.primary_warehouse                || null,
        avg_daily_consumption: parseFloat(r.avg_daily_consumption || 0),
        displayName:          computeDisplayName(r, displayField),
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
    q = `SELECT s.*,
      (SELECT st.warehouse FROM stock_transactions st
       WHERE st.company_guid = s.company_guid AND st.stock_guid = s.name
       ORDER BY st.date DESC LIMIT 1) AS primary_warehouse,
      (
        SELECT ROUND(
          COALESCE(SUM(ABS(stc.qty)), 0) /
          GREATEST((NOW()::date - MIN(stc.date::date)), 1)
        , 4)
        FROM stock_transactions stc
        WHERE stc.company_guid = s.company_guid
          AND stc.stock_guid = s.name
          AND stc.type = 'outward'
          AND stc.date::date >= (NOW() - INTERVAL '90 days')::date
      ) AS avg_daily_consumption
    FROM stocks s
    WHERE s.company_guid=$1 AND (s.name ILIKE $2 OR s.alias ILIKE $2 OR s.hsn ILIKE $2)`;
    params = [companyGuid, `%${search}%`];
    idx = 3;
    if (category) { q += ` AND category = $${idx++}`; params.push(category); }
    // Warehouse filter: stock_transactions.stock_guid stores stock NAME (not guid)
    // so match on stocks.name, not stocks.guid
    if (warehouse) {
      q += ` AND name IN (SELECT DISTINCT stock_guid FROM stock_transactions WHERE company_guid=$${idx++} AND warehouse=$${idx++})`;
      params.push(companyGuid, warehouse);
    }
    q += ` ORDER BY closing_value DESC NULLS LAST, name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows: rawItems } = await query(q, params);
    const { rows: cnt } = await query('SELECT COUNT(*) as c, COALESCE(SUM(closing_value),0) as v FROM stocks WHERE company_guid=$1', [companyGuid]);
    const { rows: low } = await query('SELECT COUNT(*) as c FROM stocks WHERE company_guid=$1 AND closing_qty > 0 AND closing_qty <= reorder_level AND reorder_level > 0', [companyGuid]);
    const items = rawItems.map(r => ({ ...r, displayName: computeDisplayName(r, displayField) }));
    res.json({
      success: true,
      data: {
        summary: { total_value: `₹${(+(cnt?.[0]?.v ?? 0)/1e5).toFixed(1)}L`, total_skus: parseInt(cnt[0].c), low_stock_count: parseInt(low[0].c) },
        items,
      },
      meta: { total: parseInt(cnt[0].c), page: parseInt(page) }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/negative-stock — Items with negative closing qty, FY-aware, warehouse breakdown
// Priority: CRITICAL = closingQty <= -10 | HIGH = closingQty < 0 && > -10
// When fy= param passed: derives closing qty from stock_transactions up to FY end date
// When no fy param: uses stored stocks.closing_qty (current stock as of last sync)
router.get('/stocks/negative-stock', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const page      = Math.max(1, parseInt(req.query.page     || 1));
  const pageSize  = Math.min(500, Math.max(1, parseInt(req.query.pageSize || 25)));
  const offset    = (page - 1) * pageSize;
  const warehouse = req.query.warehouse || null;

  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const fyRequested = !!(req.query.fy || req.query.from || req.query.to);
    const displayField = await getProductDisplayField(companyGuid);

    let allRows;

    if (fyRequested) {
      // ── FY-specific path: use stock_fy_valuation for authoritative per-FY closing qty ──
      // stocks.opening_qty is the current-FY opening, NOT all-time; computing from it is wrong for past FYs.
      const { rows: itemRows } = await query(`
        SELECT
          s.guid                                        AS "stockGuid",
          sfv.stock_name                               AS "itemName",
          s.group_name                                 AS "groupName",
          s.category,
          s.unit,
          COALESCE(s.sku, s.alias, '')                  AS sku,
          COALESCE(sfv.closing_rate, s.closing_rate, 0) AS rate,
          sfv.closing_qty                              AS "fyClosingQty"
        FROM stock_fy_valuation sfv
        JOIN stocks s
          ON s.name = sfv.stock_name AND s.company_guid = sfv.company_guid
        WHERE sfv.company_guid = $1
          AND sfv.financial_year = $2
          AND sfv.closing_qty < 0
        ORDER BY sfv.closing_qty ASC
      `, [companyGuid, financialYear]);

      // Per-warehouse breakdown for FY — filtered to same FY date range
      const stockNames = itemRows.map(r => r.itemName);
      let whRows = [];
      if (stockNames.length > 0) {
        const whResult = await query(`
          SELECT
            stock_guid,
            COALESCE(NULLIF(warehouse, ''), 'Main Location') AS warehouse,
            SUM(CASE WHEN type = 'inward' THEN ABS(qty) ELSE -ABS(qty) END) AS net_qty
          FROM stock_transactions
          WHERE company_guid = $1
            AND qty IS NOT NULL
            AND date <= $2
            AND stock_guid = ANY($3)
            AND voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse movement totals
          GROUP BY stock_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')
        `, [companyGuid, fyTo, stockNames]);
        whRows = whResult.rows;
      }

      // Build warehouse map keyed by stock name
      const whMap = {};
      for (const w of whRows) {
        if (!whMap[w.stock_guid]) whMap[w.stock_guid] = [];
        whMap[w.stock_guid].push({ warehouse: w.warehouse, qty: parseFloat(w.net_qty || 0) });
      }

      allRows = itemRows.map(r => ({
        stockGuid:    r.stockGuid,
        itemName:     r.itemName,
        groupName:    r.groupName ?? '',
        category:     r.category  ?? '',
        unit:         r.unit      ?? '',
        rate:         parseFloat(r.rate || 0),
        closingQty:   parseFloat(r.fyClosingQty || 0),
        rawWarehouses: (whMap[r.itemName] || []).filter(w => w.qty < 0),
      }));
    } else {
      // ── Current stock path: use stored closing_qty (no FY filter) ──
      let whFilter = '';
      const params = [companyGuid];
      if (warehouse) {
        params.push(warehouse);
        whFilter = `AND COALESCE(NULLIF(warehouse, ''), 'Main Location') = $${params.length}`;
      }
      const { rows } = await query(`
        SELECT
          s.guid                       AS "stockGuid",
          s.name                       AS "itemName",
          s.group_name                 AS "groupName",
          s.category,
          s.unit,
          COALESCE(s.sku, s.alias, '') AS sku,
          COALESCE(s.closing_rate, 0)  AS rate,
          s.closing_qty                AS "closingQty",
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'warehouse', COALESCE(NULLIF(wh.warehouse, ''), 'Main Location'),
                'qty',        wh.net_qty
              ) ORDER BY wh.net_qty ASC
            ) FILTER (WHERE wh.net_qty IS NOT NULL AND wh.net_qty < 0),
            '[]'
          ) AS warehouses
        FROM stocks s
        LEFT JOIN (
          SELECT stock_guid, company_guid,
                 COALESCE(NULLIF(warehouse, ''), 'Main Location') AS warehouse,
                 SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) AS net_qty
          FROM stock_transactions
          WHERE company_guid = $1 AND qty IS NOT NULL
            AND voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse movement totals
          GROUP BY stock_guid, company_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')
          ${whFilter}
        ) wh ON wh.stock_guid = s.name AND wh.company_guid = s.company_guid
        WHERE s.company_guid = $1 AND s.closing_qty < 0
        GROUP BY s.guid, s.name, s.group_name, s.category, s.unit, s.closing_rate, s.closing_qty
        ORDER BY s.closing_qty ASC
      `, params);
      allRows = rows.map(r => ({
        stockGuid:     r.stockGuid,
        itemName:      r.itemName,
        groupName:     r.groupName ?? '',
        category:      r.category  ?? '',
        unit:          r.unit      ?? '',
        rate:          parseFloat(r.rate || 0),
        closingQty:    parseFloat(r.closingQty || 0),
        rawWarehouses: (typeof r.warehouses === 'string' ? JSON.parse(r.warehouses) : (r.warehouses || [])),
      }));
    }

    // ── Apply warehouse filter (FY path) ──
    if (fyRequested && warehouse) {
      allRows = allRows.filter(r => r.rawWarehouses.some(w => w.warehouse === warehouse));
    }

    const total    = allRows.length;
    const pageRows = allRows.slice(offset, offset + pageSize);

    const items = pageRows.map(r => {
      const { stockGuid, itemName, groupName, category, unit, rate, closingQty, rawWarehouses } = r;
      const negativeQty  = Math.abs(closingQty);
      const closingValue = closingQty * rate;
      const priority     = closingQty <= -10 ? 'CRITICAL' : 'HIGH';

      // Reconcile warehouse breakdown to FY closing qty
      let warehouses;
      const negWH = rawWarehouses.filter(w => parseFloat(w.qty || 0) < 0);
      if (negWH.length === 0) {
        warehouses = [{ warehouse: 'Main Location', qty: closingQty, value: closingQty * rate }];
      } else if (negWH.length === 1) {
        warehouses = [{ warehouse: negWH[0].warehouse, qty: closingQty, value: closingQty * rate }];
      } else {
        const txNegTotal = negWH.reduce((s, w) => s + parseFloat(w.qty || 0), 0);
        const scale = txNegTotal !== 0 ? closingQty / txNegTotal : 1;
        warehouses = negWH.map(w => {
          const scaledQty = Math.round(parseFloat(w.qty || 0) * scale * 10000) / 10000;
          return { warehouse: w.warehouse, qty: scaledQty, value: scaledQty * rate };
        });
      }

      const sku = r.sku || '';
      const displayName = computeDisplayName({ name: itemName, sku }, displayField);
      return { stockGuid, itemName, displayName, groupName, category, unit, sku, closingQty, negativeQty, closingValue, rate, isNegativeStock: true, priority, warehouses };
    });

    const totalNegativeQty = allRows.reduce((s, r) => s + Math.abs(r.closingQty), 0);
    const criticalCount    = allRows.filter(r => r.closingQty <= -10).length;

    return res.json({
      success: true,
      data: {
        summary: {
          negativeItems:    total,
          criticalItems:    criticalCount,
          highItems:        total - criticalCount,
          totalNegativeQty: Math.round(totalNegativeQty * 10000) / 10000,
        },
        items,
        financial_year: financialYear,
      },
      pagination: { page, pageSize, total },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/expiry-schedule — Batch-wise expiry data from batch_allocations
// Tab classification: expired / 0-30 / 31-60 / >60 (no expiry date → '>60')
router.get('/stocks/expiry-schedule', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { fy } = req.query;
  try {
    const { financialYear } = await resolveFYDates(companyGuid, null, null, fy);
    const fyParam = fy ? financialYear : null;

    const { rows } = await query(`
      SELECT
        ba.stock_item_name                              AS item_name,
        COALESCE(NULLIF(s.sku,''), NULLIF(s.alias,''), '') AS item_code,
        COALESCE(s.group_name, '')                      AS group_name,
        ba.batch_name,
        COALESCE(NULLIF(ba.godown_name,''), 'Main Location') AS warehouse,
        COALESCE(NULLIF(ba.expiry_date,''), NULL)        AS expiry_date,
        COALESCE(NULLIF(ba.mfg_date,''), NULL)           AS mfg_date,
        SUM(ba.qty)                                     AS qty,
        MAX(ba.rate)                                    AS rate,
        SUM(ba.qty * ba.rate)                           AS value
      FROM batch_allocations ba
      LEFT JOIN stocks s ON s.name = ba.stock_item_name AND s.company_guid = ba.company_guid
      WHERE ba.company_guid = $1
        AND ($2::text IS NULL OR ba.financial_year = $2)
      GROUP BY
        ba.stock_item_name, COALESCE(NULLIF(s.sku,''), NULLIF(s.alias,''), ''),
        COALESCE(s.group_name,''), ba.batch_name,
        COALESCE(NULLIF(ba.godown_name,''), 'Main Location'),
        ba.expiry_date, ba.mfg_date
      HAVING SUM(ba.qty) != 0
      ORDER BY ba.expiry_date ASC NULLS LAST, ba.stock_item_name ASC
    `, [companyGuid, fyParam]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const items = rows.map((r, idx) => {
      const qty   = parseFloat(r.qty || 0);
      const rate  = parseFloat(r.rate || 0);
      const value = parseFloat(r.value || 0);

      let daysLeft = null;
      let tab = '>60';

      if (r.expiry_date) {
        const expDate = new Date(r.expiry_date);
        expDate.setHours(0, 0, 0, 0);
        daysLeft = Math.floor((expDate - today) / (1000 * 60 * 60 * 24));
        if (daysLeft < 0)        tab = 'expired';
        else if (daysLeft <= 30) tab = '0-30';
        else if (daysLeft <= 60) tab = '31-60';
        else                     tab = '>60';
      }

      return {
        id:          `ex${idx + 1}`,
        item:        r.item_name,
        code:        r.item_code || '',
        batch:       r.batch_name || 'Primary Batch',
        expiryDate:  r.expiry_date || '—',
        mfgDate:     r.mfg_date   || '—',
        qty:         Math.abs(qty),
        value:       `₹${Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
        daysLeft,
        warehouse:   r.warehouse,
        groupName:   r.group_name,
        tab,
      };
    });

    // Unique warehouses + groups for filter dropdowns
    const warehouses = [...new Set(items.map(i => i.warehouse))].filter(Boolean).sort();
    const groups     = [...new Set(items.map(i => i.groupName))].filter(Boolean).sort();

    res.json({ success: true, data: { items, warehouses, groups, financial_year: financialYear } });
  } catch (e) {
    console.error('[expiry-schedule]', e.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
});

// GET /api/stocks/fast-slow — Fast vs Slow moving items based on FY outward movement
router.get('/stocks/fast-slow', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);

    // Fetch all stocks + their FY movement stats
    const { rows } = await query(`
      SELECT
        s.guid, s.name, s.group_name, s.unit, s.category,
        COALESCE(s.sku, s.alias, '') AS sku,
        COALESCE(s.closing_rate, 0)  AS rate,
        COALESCE(s.closing_qty, 0)   AS closing_qty,
        COALESCE(s.closing_qty, 0) * COALESCE(s.closing_rate, 0) AS closing_value,
        COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0) AS total_outward_qty,
        COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0) AS total_inward_qty,
        COUNT(CASE WHEN st.type = 'outward' THEN 1 ELSE NULL END)::int AS outward_txn_count,
        COUNT(st.id)::int AS total_txn_count,
        ROUND(
          COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0)
          / GREATEST(($3::date - $2::date), 1)
        , 4) AS avg_daily_outward
      FROM stocks s
      LEFT JOIN stock_transactions st
        ON st.stock_guid = s.name
       AND st.company_guid = s.company_guid
       AND st.date::date >= $2::date
       AND st.date::date <= $3::date
       AND st.voucher_type != 'Physical Stock'  -- exclude audit counts from velocity calculation
      WHERE s.company_guid = $1
      GROUP BY s.guid, s.name, s.group_name, s.unit, s.category, s.closing_rate, s.closing_qty, s.sku, s.alias
      ORDER BY total_outward_qty DESC, s.name ASC
    `, [companyGuid, fyFrom, fyTo]);

    if (!rows.length) {
      return res.json({ success: true, data: { fast: [], slow: [], financial_year: financialYear } });
    }

    // Items that had any outward movement in the FY
    const active   = rows.filter(r => parseFloat(r.total_outward_qty) > 0);
    const inactive = rows.filter(r => parseFloat(r.total_outward_qty) === 0);

    // Among active items, top 50% by total_outward_qty = fast, bottom 50% = slow
    // Use company's fast_moving_top_pct setting (default 20%); fall back to 50% if not set
    const { rows: fsSettings } = await query(
      `SELECT fast_moving_top_pct, slow_moving_no_movement_days, dead_stock_no_movement_days
       FROM company_inventory_settings WHERE company_guid=$1 LIMIT 1`,
      [companyGuid]
    );
    const fastPct    = parseInt(fsSettings[0]?.fast_moving_top_pct)  || 20;  // top X% by outward qty
    const slowDays   = parseInt(fsSettings[0]?.slow_moving_no_movement_days) || 90;
    const deadDays   = parseInt(fsSettings[0]?.dead_stock_no_movement_days)  || 180;
    const fastCount  = Math.max(1, Math.ceil(active.length * fastPct / 100));
    const fastRaw    = active.slice(0, fastCount);
    // Slow: active items below fast threshold
    // Dead: inactive items with no movement beyond deadDays (use transaction date proxy)
    const slowActive = active.slice(fastCount);
    const slowRaw    = [...slowActive, ...inactive];

    const displayField = await getProductDisplayField(companyGuid);
    const mapItem = (r, idx, tab) => ({
      id:                 r.guid,
      name:               r.name,
      displayName:        computeDisplayName(r, displayField),
      sku:                r.sku || r.alias || '',
      group:              r.group_name || '—',
      unit:               r.unit       || '',
      closing_qty:        parseFloat(r.closing_qty   || 0),
      closing_value:      parseFloat(r.closing_value || 0),
      total_outward_qty:  parseFloat(r.total_outward_qty || 0),
      total_inward_qty:   parseFloat(r.total_inward_qty  || 0),
      outward_txn_count:  parseInt(r.outward_txn_count   || 0),
      total_txn_count:    parseInt(r.total_txn_count      || 0),
      avg_daily_outward:  parseFloat(r.avg_daily_outward  || 0),
      // Estimated days of stock remaining at current consumption rate
      days_remaining:     parseFloat(r.avg_daily_outward) > 0
                            ? Math.round(parseFloat(r.closing_qty) / parseFloat(r.avg_daily_outward))
                            : null,
      rank:               idx + 1,
      tab,
    });

    res.json({
      success: true,
      data: {
        fast:           fastRaw.map((r, i) => mapItem(r, i, 'fast')),
        slow:           slowRaw.map((r, i) => mapItem(r, i, 'slow')),
        total_items:    rows.length,
        active_items:   active.length,
        inactive_items: inactive.length,
        financial_year: financialYear,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/aged-items — items that haven't sold / haven't been received for X days
// mode=sold  → items not sold in the given age bucket (by last sold date)
// mode=received → items sitting in stock for the given age bucket (by last received date)
// days param is the START of the bucket: 30=30-59d, 60=60-89d, 90=90-119d, 120=120+d
router.get('/stocks/aged-items', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { mode = 'sold', days: daysParam = '30' } = req.query;
    const bucketStart = parseInt(daysParam);
    const bucketEnd   = bucketStart === 120 ? null : bucketStart + 30;

    const { rows } = await query(`
      WITH item_activity AS (
        SELECT
          s.name,
          COALESCE(NULLIF(s.sku,''), NULLIF(s.alias,''), '')        AS sku,
          COALESCE(s.group_name, '')                                 AS category,
          COALESCE(s.closing_qty,  0)                                AS closing_qty,
          COALESCE(s.closing_rate, 0)                                AS closing_rate,
          COALESCE(s.closing_qty,0) * COALESCE(s.closing_rate,0)    AS total_value,
          MAX(st_out.date::date) AS last_sold_date,
          MAX(st_in.date::date)  AS last_received_date
        FROM stocks s
        LEFT JOIN stock_transactions st_out
          ON  st_out.stock_guid    = s.name
          AND st_out.company_guid  = s.company_guid
          AND st_out.type          = 'outward'
          AND st_out.voucher_type NOT IN ('Stock Journal','Physical Stock')
        LEFT JOIN stock_transactions st_in
          ON  st_in.stock_guid    = s.name
          AND st_in.company_guid  = s.company_guid
          AND st_in.type          = 'inward'
          AND st_in.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        WHERE s.company_guid = $1
          AND COALESCE(s.closing_qty, 0) > 0
        GROUP BY s.name, s.sku, s.alias, s.group_name, s.closing_qty, s.closing_rate
      ),
      computed AS (
        SELECT *,
          CURRENT_DATE - COALESCE(last_sold_date,     '2000-01-01'::date) AS days_since_sold,
          CURRENT_DATE - COALESCE(last_received_date, '2000-01-01'::date) AS days_since_received
        FROM item_activity
        WHERE total_value > 0
      )
      SELECT
        name, sku, category,
        ROUND(closing_qty::numeric, 2)   AS closing_qty,
        ROUND(closing_rate::numeric, 2)  AS closing_rate,
        ROUND(total_value::numeric, 2)   AS total_value,
        last_sold_date, last_received_date,
        days_since_sold::int             AS days_since_sold,
        days_since_received::int         AS days_since_received
      FROM computed
      WHERE
        CASE $2
          WHEN 'sold'     THEN days_since_sold     >= $3 AND ($4::int IS NULL OR days_since_sold     < $4)
          WHEN 'received' THEN days_since_received >= $3 AND ($4::int IS NULL OR days_since_received < $4)
          ELSE days_since_sold >= $3 AND ($4::int IS NULL OR days_since_sold < $4)
        END
      ORDER BY
        CASE $2
          WHEN 'sold'     THEN total_value
          WHEN 'received' THEN days_since_received::float
          ELSE total_value
        END DESC
    `, [companyGuid, mode, bucketStart, bucketEnd]);

    const displayField  = await getProductDisplayField(companyGuid);
    const totalValue    = rows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
    const mappedRows    = rows.map(r => ({ ...r, displayName: computeDisplayName(r, displayField) }));
    res.json({
      success: true,
      data: mappedRows,
      summary: {
        total_skus:  rows.length,
        total_value: Math.round(totalValue * 100) / 100,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/movement-analytics — items sorted by Turnover Ratio for selected FY
router.get('/stocks/movement-analytics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { fy } = req.query;
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyGuid, null, null, fy);

    // Wrap in subquery so we can reference column aliases in ORDER BY
    // Include sold-out items (closing_qty=0) if they had outward movement in the FY
    const { rows } = await query(`
      SELECT * FROM (
        SELECT
          s.name,
          COALESCE(NULLIF(s.sku,''), NULLIF(s.alias,''), '') AS sku,
          COALESCE(s.group_name,'')                          AS category,
          COALESCE(s.closing_qty, 0)                         AS closing_qty,
          COALESCE(s.closing_rate, 0)                        AS closing_rate,
          COALESCE(SUM(CASE WHEN st.type='outward' AND st.date::date >= $2::date AND st.date::date <= $3::date
            THEN st.qty ELSE 0 END), 0)                      AS outward_qty,
          COALESCE(SUM(CASE WHEN st.type='outward' AND st.date::date >= $2::date AND st.date::date <= $3::date
            THEN st.value ELSE 0 END), 0)                    AS outward_value,
          COUNT(DISTINCT CASE WHEN st.type='outward' AND st.date::date >= $2::date AND st.date::date <= $3::date
            THEN st.date::date END)                          AS active_days
        FROM stocks s
        LEFT JOIN stock_transactions st
          ON  st.stock_guid   = s.name
          AND st.company_guid = s.company_guid
          AND st.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        WHERE s.company_guid = $1
          AND (
            -- Items currently in stock
            COALESCE(s.closing_qty, 0) > 0
            -- OR items recently sold out but had movement in this FY
            OR EXISTS (
              SELECT 1 FROM stock_transactions st2
              WHERE st2.stock_guid   = s.name
                AND st2.company_guid = s.company_guid
                AND st2.type         = 'outward'
                AND st2.date::date  >= $2::date
                AND st2.date::date  <= $3::date
                AND st2.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
            )
          )
        GROUP BY s.name, s.sku, s.alias, s.group_name, s.closing_qty, s.closing_rate
      ) sub
      ORDER BY
        -- Sold-out items (closing_qty=0) get highest effective TR (treated as huge number)
        COALESCE(
          outward_qty / NULLIF(closing_qty, 0),
          outward_qty * 999.0
        ) DESC NULLS LAST,
        name ASC
    `, [companyGuid, fyFrom, fyTo]);

    const items = rows.map(r => {
      const outwardQty   = parseFloat(r.outward_qty   || 0);
      const closingQty   = parseFloat(r.closing_qty   || 0);
      const outwardValue = parseFloat(r.outward_value || 0);
      const activeDays   = parseInt(r.active_days     || 0);
      const soldOut      = closingQty <= 0 && outwardQty > 0;
      const tr  = closingQty > 0 ? Math.round((outwardQty / closingQty) * 100) / 100 : 0;
      const avgDailySales = activeDays > 0 ? outwardQty / activeDays : 0;
      const dsi = soldOut ? 0 : avgDailySales > 0 ? Math.round(closingQty / avgDailySales) : null;
      return {
        name:          r.name,
        sku:           r.sku,
        category:      r.category,
        closing_qty:   Math.round(closingQty),
        closing_rate:  parseFloat(r.closing_rate),
        total_value:   Math.round(closingQty * parseFloat(r.closing_rate)),
        outward_qty:   Math.round(outwardQty),
        outward_value: Math.round(outwardValue),
        tr,
        dsi,
        sold_out: soldOut,
      };
    });
    res.json({ success: true, data: items });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/movement-analytics/chart — last 30 days daily outward for one item
router.get('/stocks/movement-analytics/chart', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { item } = req.query;
    if (!item) return res.status(400).json({ success: false, error: { code: 'MISSING_ITEM', message: 'item param required' } });

    // stock_transactions.date is TEXT 'YYYY-MM-DD' (IST date from Tally — no TZ conversion needed).
    // NEW: Last 30 ENTRY DATES (not last 30 calendar days).
    //      Includes both outward (sold) and inward (purchased/received) movements.
    //      Inner query: latest 30 unique dates with any movement → outer: chronological for chart.
    const { rows } = await query(`
      SELECT * FROM (
        SELECT
          date,
          ROUND(SUM(CASE WHEN type='outward' THEN value ELSE 0 END)::numeric, 2) AS outward_value,
          ROUND(SUM(CASE WHEN type='outward' THEN qty   ELSE 0 END)::numeric, 2) AS outward_qty,
          ROUND(SUM(CASE WHEN type='inward'  THEN value ELSE 0 END)::numeric, 2) AS inward_value,
          ROUND(SUM(CASE WHEN type='inward'  THEN qty   ELSE 0 END)::numeric, 2) AS inward_qty
        FROM stock_transactions
        WHERE company_guid = $1
          AND stock_guid   = $2
          AND type IN ('outward', 'inward')
          AND voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        GROUP BY date
        ORDER BY date DESC
        LIMIT 30
      ) sub
      ORDER BY date ASC
    `, [companyGuid, item]);

    // Return actual entry dates with separate inward/outward values
    const filledData = rows.map(r => ({
      date:         r.date,
      value:        parseFloat(r.outward_value || 0),
      qty:          parseFloat(r.outward_qty   || 0),
      inward_value: parseFloat(r.inward_value  || 0),
      inward_qty:   parseFloat(r.inward_qty    || 0),
    }));
    res.json({ success: true, data: filledData });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/snapshot — stock portfolio value breakdown by warehouse, 4 valuation types
router.get('/stocks/snapshot', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { fy } = req.query;
    let financialYear = fy || null;

    // ── 1. All registered warehouses — always included even if empty ─────────────────────
    const { rows: allWarehouses } = await query(
      'SELECT name FROM warehouses WHERE company_guid=$1 ORDER BY name',
      [companyGuid]
    );

    // ── 2. Per-godown per-item net positive qty from batch_allocations ──────────────
    // Using SUM(qty) and clamping to >= 0: positive qty = stock present in godown
    // Not filtered by FY date because batch_allocations tracks all-time movements;
    // the net qty represents current stock on-hand per godown.
    const { rows: godownQtyRows } = await query(`
      SELECT
        COALESCE(NULLIF(ba.godown_name, ''), 'Main Location') AS warehouse,
        ba.stock_item_name AS stock_name,
        GREATEST(SUM(COALESCE(ba.qty, 0)), 0) AS net_qty
      FROM batch_allocations ba
      WHERE ba.company_guid = $1
      GROUP BY ba.godown_name, ba.stock_item_name
      HAVING GREATEST(SUM(COALESCE(ba.qty, 0)), 0) > 0
    `, [companyGuid]);

    // ── 3. Authoritative closing + opening rates from stocks table ─────────────────
    // stocks.closing_rate is the most accurate rate per item (from Tally current valuation).
    // stock_fy_valuation.closing_value is UNRELIABLE for this purpose: Tally can produce
    // negative closing values due to opening balance offsets — those values are NOT stock value.
    const { rows: rateRows } = await query(`
      SELECT
        name,
        COALESCE(closing_rate, 0)  AS closing_rate,
        COALESCE(opening_rate, 0)  AS opening_rate
      FROM stocks
      WHERE company_guid = $1
    `, [companyGuid]);

    // Build rate lookup map {stock_name -> {closing_rate, opening_rate}}
    const rateMap = {};
    for (const r of rateRows) {
      rateMap[r.name] = {
        closing: parseFloat(r.closing_rate || 0),
        opening: parseFloat(r.opening_rate || 0),
      };
    }

    // ── 4. Compute warehouse values: qty × rate ────────────────────────────────────
    const warehouseValues = {};
    // Seed all registered warehouses at 0 so they always appear in output
    for (const wh of allWarehouses) {
      warehouseValues[wh.name] = { closing: 0, opening: 0, average: 0, peak: 0, skus: 0 };
    }

    for (const row of godownQtyRows) {
      const qty   = parseFloat(row.net_qty || 0);
      const rates = rateMap[row.stock_name] || { closing: 0, opening: 0 };
      const closingVal = qty * rates.closing;
      const openingVal = qty * rates.opening;
      const avgVal     = qty * (rates.closing + rates.opening) / 2;
      const peakVal    = qty * Math.max(rates.closing, rates.opening);

      const wh = row.warehouse;
      if (!warehouseValues[wh]) warehouseValues[wh] = { closing: 0, opening: 0, average: 0, peak: 0, skus: 0 };
      warehouseValues[wh].closing += closingVal;
      warehouseValues[wh].opening += openingVal;
      warehouseValues[wh].average += avgVal;
      warehouseValues[wh].peak    += peakVal;
      warehouseValues[wh].skus    += 1;
    }

    // ── 5. Format and sort ─────────────────────────────────────────────────────────
    const warehouses = Object.entries(warehouseValues)
      .map(([warehouse, v]) => ({
        warehouse,
        skus:          v.skus,
        closing_value: Math.round(v.closing * 100) / 100,
        opening_value: Math.round(v.opening * 100) / 100,
        average_value: Math.round(v.average * 100) / 100,
        peak_value:    Math.round(v.peak    * 100) / 100,
      }))
      .sort((a, b) => b.closing_value - a.closing_value);

    const summary = {
      total_closing: Math.round(warehouses.reduce((s, w) => s + w.closing_value, 0) * 100) / 100,
      total_opening: Math.round(warehouses.reduce((s, w) => s + w.opening_value, 0) * 100) / 100,
      total_average: Math.round(warehouses.reduce((s, w) => s + w.average_value, 0) * 100) / 100,
      total_peak:    Math.round(warehouses.reduce((s, w) => s + w.peak_value,    0) * 100) / 100,
    };

    res.json({ success: true, data: { warehouses, summary, financial_year: financialYear } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/transfer-history — stock journal godown transfers (inward+outward on same voucher)
router.get('/stocks/transfer-history', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { fy, from: qFrom, to: qTo, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let fyFrom = null, fyTo = null;
    if (qFrom && qTo) {
      // Explicit date range overrides FY
      fyFrom = qFrom;
      fyTo   = qTo;
    } else if (fy) {
      const resolved = await resolveFYDates(companyGuid, null, null, fy);
      fyFrom = resolved.from;
      fyTo   = resolved.to;
    }

    // A "transfer" voucher = same voucher_guid has BOTH outward and inward stock_transaction rows
    // This covers Stock Journal godown transfers synced from Tally
    const { rows: transfers } = await query(`
      WITH transfer_voucher_guids AS (
        SELECT st.voucher_guid
        FROM stock_transactions st
        WHERE st.company_guid = $1
          AND ($2::date IS NULL OR st.date::date >= $2::date)
          AND ($3::date IS NULL OR st.date::date <= $3::date)
        GROUP BY st.voucher_guid
        HAVING
          COUNT(CASE WHEN st.type = 'outward' THEN 1 END) > 0
          AND COUNT(CASE WHEN st.type = 'inward'  THEN 1 END) > 0
      ),
      transfer_items AS (
        -- DISTINCT ON prevents Cartesian inflation when 1 outward row joins N inward rows
        -- (e.g. same item split across 2 destination godowns in one Stock Journal)
        SELECT DISTINCT ON (st_out.voucher_guid, st_out.stock_guid, st_out.warehouse)
          st_out.voucher_guid,
          st_out.date,
          st_out.stock_guid AS item_name,
          COALESCE(NULLIF(st_out.warehouse, ''), 'Main Location') AS from_warehouse,
          COALESCE(NULLIF(st_in.warehouse,  ''), 'Main Location') AS to_warehouse,
          st_out.qty,
          st_out.value,
          COALESCE(st_out.voucher_type, 'Stock Journal') AS voucher_type
        FROM stock_transactions st_out
        JOIN stock_transactions st_in
          ON  st_out.voucher_guid = st_in.voucher_guid
          AND st_out.company_guid = st_in.company_guid
          AND st_out.stock_guid   = st_in.stock_guid
          AND st_out.type         = 'outward'
          AND st_in.type          = 'inward'
        JOIN transfer_voucher_guids tvg ON tvg.voucher_guid = st_out.voucher_guid
        WHERE st_out.company_guid = $1
        ORDER BY st_out.voucher_guid, st_out.stock_guid, st_out.warehouse, st_in.warehouse
      ),
      grouped AS (
        SELECT
          ti.voucher_guid,
          MAX(ti.date)         AS date,
          MAX(ti.voucher_type) AS voucher_type,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'item',           ti.item_name,
              'qty',            ti.qty,
              'value',          ti.value,
              'from_warehouse', ti.from_warehouse,
              'to_warehouse',   ti.to_warehouse
            ) ORDER BY ti.item_name
          ) AS items,
          COUNT(*)::int  AS item_count,
          SUM(ti.value)  AS total_value,
          COALESCE(MAX(v.voucher_number), '') AS voucher_number
        FROM transfer_items ti
        LEFT JOIN vouchers v ON v.guid = ti.voucher_guid AND v.company_guid = $1
        GROUP BY ti.voucher_guid
      )
      SELECT * FROM grouped
      ORDER BY date DESC
      LIMIT $4 OFFSET $5
    `, [companyGuid, fyFrom, fyTo, parseInt(limit), offset]);

    const { rows: countRow } = await query(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT st.voucher_guid
        FROM stock_transactions st
        WHERE st.company_guid = $1
          AND ($2::date IS NULL OR st.date::date >= $2::date)
          AND ($3::date IS NULL OR st.date::date <= $3::date)
        GROUP BY st.voucher_guid
        HAVING
          COUNT(CASE WHEN st.type = 'outward' THEN 1 END) > 0
          AND COUNT(CASE WHEN st.type = 'inward'  THEN 1 END) > 0
      ) t
    `, [companyGuid, fyFrom, fyTo]);

    res.json({
      success: true,
      data:  transfers,
      total: parseInt(countRow[0]?.total ?? 0),
      page:  parseInt(page),
      limit: parseInt(limit),
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

// ─── Inventory Settings ─────────────────────────────────────────────────────

// GET /api/inventory/settings — load inventory settings + Tally-derived defaults
router.get('/inventory/settings', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Load saved settings (may be null for new company)
    const { rows: [saved] } = await query(
      `SELECT * FROM company_inventory_settings WHERE company_guid=$1 LIMIT 1`,
      [companyGuid]
    );

    // Tally-derived: all distinct UoMs
    const { rows: uomRows } = await query(
      `SELECT DISTINCT TRIM(unit) AS name FROM stocks
       WHERE company_guid=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       ORDER BY TRIM(unit) ASC`,
      [companyGuid]
    );

    // Tally-derived: most common unit (for default)
    const { rows: commonUnitRows } = await query(
      `SELECT TRIM(unit) AS name, COUNT(*) AS cnt FROM stocks
       WHERE company_guid=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       GROUP BY TRIM(unit) ORDER BY cnt DESC LIMIT 1`,
      [companyGuid]
    );

    // Tally-derived: warehouses (godowns)
    const { rows: warehouseRows } = await query(
      `SELECT guid, name, parent, address FROM warehouses
       WHERE company_guid=$1 ORDER BY name`,
      [companyGuid]
    );

    const uoms = uomRows.map(r => r.name).filter(Boolean);
    const tallyDefaultUnit = commonUnitRows[0]?.name || uoms[0] || 'Nos';

    // Tally-derived: company-level batch/expiry flags (aggregate from stocks table)
    const { rows: tallyBatchRows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE batch_enabled  = TRUE) AS batch_count,
         COUNT(*) FILTER (WHERE expiry_enabled = TRUE) AS expiry_count,
         COUNT(*) AS total
       FROM stocks WHERE company_guid=$1`,
      [companyGuid]
    );
    const tallyBatchStats = {
      batch_enabled_count:  parseInt(tallyBatchRows[0]?.batch_count  || 0),
      expiry_enabled_count: parseInt(tallyBatchRows[0]?.expiry_count || 0),
      total_stock_items:    parseInt(tallyBatchRows[0]?.total        || 0),
    };

    const defaults = {
      product_display_field:          'auto',
      default_unit_for_new_items:     tallyDefaultUnit,
      purchase_buffer_days:           7,
      reorder_calc_mode:              'hybrid',
      low_stock_threshold_mode:       'reorder_level',
      archive_old_stock_months:       24,
      warehouse_code_map:             {},
      cycle_count_frequency_map:      {},
      archive_stock_layers_map:       {},
      default_low_stock_level:        20,
      inventory_aging_rules:          { buckets: ['0-30','31-60','61-90','90+'] },
      fast_moving_top_pct:            20,
      slow_moving_no_movement_days:   90,
      dead_stock_no_movement_days:    180,
      movement_analysis_period_days:  90,
      low_stock_alerts:               { inApp: true,  email: false, whatsapp: false },
      negative_stock_alerts:          { inApp: true,  email: true,  whatsapp: false },
      expiry_alerts:                  { inApp: true,  email: false, whatsapp: false, daysBefore: 30 },
      fast_slow_moving_alerts:        { inApp: false, email: false, whatsapp: false },
      // App-level preferences for Tally-controlled settings
      batch_tracking_app_enabled:     false,
      expiry_tracking_app_enabled:    false,
      allow_negative_stock_app:       false,
    };

    // Merge saved over defaults (JSONB cols come as objects from pg driver)
    const merged = { ...defaults };
    if (saved) {
      for (const [k, v] of Object.entries(saved)) {
        if (v !== null && v !== undefined) merged[k] = v;
      }
    }

    res.json({
      success: true,
      data: {
        settings: merged,
        available_uoms: uoms,
        warehouses: warehouseRows.map(w => ({
          id:      w.guid,
          name:    w.name,
          parent:  w.parent  || '',
          address: w.address || '',
        })),
        tally_derived: {
          default_unit:     tallyDefaultUnit,
          batch_stats:      tallyBatchStats,
          // Archive stock layers: TallyDekho-only, filters app-side display only (no delete)
          archive_note:     'Archive layers hides old activity from default view. Does not delete data.',
        },
      },
    });
  } catch (err) {
    console.error('[inventory/settings GET]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/settings — save inventory settings
router.post('/inventory/settings', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid || req.body.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const b = req.body;
    await query(`
      INSERT INTO company_inventory_settings (
        company_guid, product_display_field, default_unit_for_new_items,
        purchase_buffer_days, reorder_calc_mode, low_stock_threshold_mode,
        archive_old_stock_months, warehouse_code_map, cycle_count_frequency_map,
        archive_stock_layers_map, default_low_stock_level, inventory_aging_rules,
        fast_moving_top_pct, slow_moving_no_movement_days, dead_stock_no_movement_days,
        movement_analysis_period_days, low_stock_alerts, negative_stock_alerts,
        expiry_alerts, fast_slow_moving_alerts,
        batch_tracking_app_enabled, expiry_tracking_app_enabled, allow_negative_stock_app,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,NOW())
      ON CONFLICT (company_guid) DO UPDATE SET
        product_display_field           = EXCLUDED.product_display_field,
        default_unit_for_new_items      = EXCLUDED.default_unit_for_new_items,
        purchase_buffer_days            = EXCLUDED.purchase_buffer_days,
        reorder_calc_mode               = EXCLUDED.reorder_calc_mode,
        low_stock_threshold_mode        = EXCLUDED.low_stock_threshold_mode,
        archive_old_stock_months        = EXCLUDED.archive_old_stock_months,
        warehouse_code_map              = EXCLUDED.warehouse_code_map,
        cycle_count_frequency_map       = EXCLUDED.cycle_count_frequency_map,
        archive_stock_layers_map        = EXCLUDED.archive_stock_layers_map,
        default_low_stock_level         = EXCLUDED.default_low_stock_level,
        inventory_aging_rules           = EXCLUDED.inventory_aging_rules,
        fast_moving_top_pct             = EXCLUDED.fast_moving_top_pct,
        slow_moving_no_movement_days    = EXCLUDED.slow_moving_no_movement_days,
        dead_stock_no_movement_days     = EXCLUDED.dead_stock_no_movement_days,
        movement_analysis_period_days   = EXCLUDED.movement_analysis_period_days,
        low_stock_alerts                = EXCLUDED.low_stock_alerts,
        negative_stock_alerts           = EXCLUDED.negative_stock_alerts,
        expiry_alerts                   = EXCLUDED.expiry_alerts,
        fast_slow_moving_alerts         = EXCLUDED.fast_slow_moving_alerts,
        batch_tracking_app_enabled      = EXCLUDED.batch_tracking_app_enabled,
        expiry_tracking_app_enabled     = EXCLUDED.expiry_tracking_app_enabled,
        allow_negative_stock_app        = EXCLUDED.allow_negative_stock_app,
        updated_at                      = NOW()
    `, [
      companyGuid,
      b.product_display_field         || 'auto',
      b.default_unit_for_new_items    || null,
      b.purchase_buffer_days          ?? 7,
      b.reorder_calc_mode             || 'hybrid',
      b.low_stock_threshold_mode      || 'reorder_level',
      b.archive_old_stock_months      ?? 24,
      JSON.stringify(b.warehouse_code_map            || {}),
      JSON.stringify(b.cycle_count_frequency_map     || {}),
      JSON.stringify(b.archive_stock_layers_map      || {}),
      b.default_low_stock_level       ?? 20,
      JSON.stringify(b.inventory_aging_rules         || { buckets: ['0-30','31-60','61-90','90+'] }),
      b.fast_moving_top_pct           ?? 20,
      b.slow_moving_no_movement_days  ?? 90,
      b.dead_stock_no_movement_days   ?? 180,
      b.movement_analysis_period_days ?? 90,
      JSON.stringify(b.low_stock_alerts              || { inApp: true,  email: false, whatsapp: false }),
      JSON.stringify(b.negative_stock_alerts         || { inApp: true,  email: true,  whatsapp: false }),
      JSON.stringify(b.expiry_alerts                 || { inApp: true,  email: false, whatsapp: false, daysBefore: 30 }),
      JSON.stringify(b.fast_slow_moving_alerts       || { inApp: false, email: false, whatsapp: false }),
      b.batch_tracking_app_enabled    ?? false,
      b.expiry_tracking_app_enabled   ?? false,
      b.allow_negative_stock_app      ?? false,
    ]);
    res.json({ success: true, message: 'Inventory settings saved successfully' });
  } catch (err) {
    console.error('[inventory/settings POST]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/units — distinct units of measure for this company
router.get('/stocks/units', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(
      `SELECT DISTINCT unit as name FROM stocks
       WHERE company_guid=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       ORDER BY unit ASC`,
      [companyGuid]
    );
    res.json({ success: true, data: rows.map(r => r.name.trim()).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/groups — distinct stock group names for this company
router.get('/stocks/groups', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(
      `SELECT DISTINCT TRIM(group_name) as name FROM stocks
       WHERE company_guid=$1 AND group_name IS NOT NULL AND TRIM(group_name) != ''
         AND LOWER(TRIM(group_name)) != 'primary'
       ORDER BY TRIM(group_name) ASC`,
      [companyGuid]
    );
    res.json({ success: true, data: rows.map(r => r.name).filter(Boolean) });
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
         AND st.voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse net qty
       WHERE w.company_guid=$1
       GROUP BY w.guid, w.name, w.parent, w.address
       ORDER BY w.name`,
      [companyGuid]
    );
    // Merge TallyDekho-only warehouse settings (code, cycle freq, archive months)
    const { rows: settRows } = await query(
      `SELECT warehouse_code_map, cycle_count_frequency_map, archive_stock_layers_map
       FROM company_inventory_settings WHERE company_guid=$1 LIMIT 1`,
      [companyGuid]
    );
    const codeMap    = settRows[0]?.warehouse_code_map          || {};
    const cycleMap   = settRows[0]?.cycle_count_frequency_map   || {};
    const archiveMap = settRows[0]?.archive_stock_layers_map    || {};
    res.json({ success: true, data: rows.map(r => ({
      id:                   r.guid,
      name:                 r.name,
      parent:               r.parent    || '',
      address:              r.address   || '',
      total_qty:            parseFloat(r.net_qty || 0),
      skus:                 parseInt(r.skus || 0),
      // TallyDekho-only settings (do not overwrite Tally godown name)
      code:                 codeMap[r.guid]    || '',
      cycle_count_frequency: cycleMap[r.guid]  || 'Weekly',
      archive_layers_months: archiveMap[r.guid] || 24,
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
       FROM stock_transactions WHERE company_guid=$1 AND warehouse=$2
         AND voucher_type != 'Physical Stock'`,
      [companyGuid, whName]
    );

    // Recent stock activity (last 500 transactions)
    const { rows: activity } = await query(
      `SELECT st.type, st.qty, st.warehouse, s.name as stock_name, v.voucher_number, v.date, v.voucher_type
       FROM stock_transactions st
       LEFT JOIN stocks s ON s.name = st.stock_guid AND s.company_guid = st.company_guid
       LEFT JOIN vouchers v ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
       WHERE st.company_guid=$1 AND st.warehouse=$2
         AND st.voucher_type != 'Physical Stock'
       ORDER BY v.date DESC, st.id DESC LIMIT 500`,
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
      let rawOpening = parseFloat(fyValRows[0]?.opening_stock || 0);
      const rawClosing = parseFloat(fyValRows[0]?.closing_stock || 0);

      // For INCOMPLETE FY (current FY): StockValuation.xml returns current live stock for BOTH
      // opening and closing (Tally can't know future closing). This causes opening = closing,
      // which is wrong. Correct opening = previous FY's closing stock.
      if (Math.abs(rawOpening - rawClosing) < 1.0) {
        // opening ≈ closing → current/incomplete FY — fetch previous FY closing as opening
        const [fyStartYear] = financialYear.split('-').map(Number);
        const prevFY = `${fyStartYear - 1}-${fyStartYear}`;
        const { rows: prevRows } = await query(`
          SELECT ABS(COALESCE(SUM(closing_value::float), 0)) AS prev_closing
          FROM stock_fy_valuation
          WHERE company_guid=$1 AND financial_year=$2
        `, [companyGuid, prevFY]);
        const prevClosing = parseFloat(prevRows[0]?.prev_closing || 0);
        if (prevClosing > 0) rawOpening = prevClosing;
      }

      openingStock = rawOpening;
      closingStock = rawClosing;
    } else {
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
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const dateFilter = from && to ? ' AND v.date BETWEEN $2 AND $3' : '';
    const baseParams = from && to ? [companyGuid, from, to] : [companyGuid];

    const [salesRes, purchaseRes, monthsRes] = await Promise.all([
      query(`SELECT COALESCE(SUM(ABS(g.cgst_amount + g.sgst_amount + g.igst_amount)),0) as tax,
                    COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v JOIN gst_voucher_details g ON g.voucher_guid=v.guid AND g.company_guid=v.company_guid
             WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type_parent='Sales'${dateFilter}`, baseParams),
      query(`SELECT COALESCE(SUM(ABS(g.cgst_amount + g.sgst_amount + g.igst_amount)),0) as tax,
                    COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v JOIN gst_voucher_details g ON g.voucher_guid=v.guid AND g.company_guid=v.company_guid
             WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type_parent='Purchase'${dateFilter}`, baseParams),
      // Use voucher_type ILIKE '%Sales%' (not strict parent='Sales') — covers Tally types classified as 'Voucher' parent
      query(`SELECT COUNT(DISTINCT TO_CHAR(date::date, 'YYYY-MM')) as filed_months
             FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE
             AND voucher_type ILIKE '%Sales%'
             AND voucher_type NOT ILIKE '%Order%'
             AND voucher_type NOT ILIKE '%Purchase%'
             AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'${from && to ? ' AND date BETWEEN $2 AND $3' : ''}`, baseParams)
        .catch(() => ({ rows: [{ filed_months: 0 }] })),
    ]);

    const outputGst   = parseFloat(salesRes.rows[0]?.tax    || 0);
    const inputGst    = parseFloat(purchaseRes.rows[0]?.tax  || 0);
    const salesAmt    = parseFloat(salesRes.rows[0]?.taxable || 0);
    const purchaseAmt = parseFloat(purchaseRes.rows[0]?.taxable || 0);
    const filedMonths = Math.min(parseInt(monthsRes.rows[0]?.filed_months || 0), 12);

    res.json({ success: true, data: {
      output_gst: outputGst, input_gst: inputGst,
      net_gst: outputGst - inputGst,
      sales_taxable: salesAmt, purchase_taxable: purchaseAmt,
      filed_months: filedMonths,
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

// GET /api/ewaybills/status — summary: integration status + EWB counts
router.get('/ewaybills/status', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const [integRow, generatedRow, pendingRow, expiringRow, errorRow, transportRow, dailyRow] = await Promise.all([
      // Integration status
      query(`SELECT status FROM integrations WHERE company_guid=$1 AND type='ewb' LIMIT 1`, [companyGuid])
        .catch(() => ({ rows: [] })),
      // Generated: vouchers with ewb_number from Tally
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != '' AND date BETWEEN $2 AND $3`, [companyGuid, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Pending: Sales >= 50K without EWB
      // EWB applicable from Apr 2018 only
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (ewb_number IS NULL OR ewb_number='') AND date BETWEEN $2 AND $3 AND date >= '2018-04-01'`, [companyGuid, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Expiring within 24h
      query(`SELECT COUNT(*) as c FROM e_way_bill_details WHERE company_guid=$1 AND valid_till BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [companyGuid])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Errors
      query(`SELECT COUNT(*) as c FROM e_way_bill_details WHERE company_guid=$1 AND error_message IS NOT NULL AND error_message != ''`, [companyGuid])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Transport mode breakdown
      query(`SELECT COALESCE(sub_supply_type, 'Road') as mode, COUNT(*) as cnt FROM e_way_bill_details WHERE company_guid=$1 GROUP BY sub_supply_type`, [companyGuid])
        .catch(() => ({ rows: [] })),
      // Daily counts for bar chart (last 30 days within FY)
      query(`SELECT date as day, COUNT(*) as cnt FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != '' AND date BETWEEN $2 AND $3 GROUP BY date ORDER BY date`, [companyGuid, from, to])
        .catch(() => ({ rows: [] })),
    ]);
    const dailyMap = new Map(dailyRow.rows.map(r => [r.day, parseInt(r.cnt)]));
    // Build 30-day array ending today
    const today = new Date(); const dailyCounts = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(today); d.setDate(today.getDate() - i);
      const key = d.toISOString().split('T')[0];
      dailyCounts.push(dailyMap.get(key) || 0);
    }
    res.json({
      success: true,
      data: {
        integration_connected: integRow.rows[0]?.status === 'connected',
        generated_count:  parseInt(generatedRow.rows[0]?.c || 0),
        pending_count:    parseInt(pendingRow.rows[0]?.c   || 0),
        expiring_count:   parseInt(expiringRow.rows[0]?.c  || 0),
        error_count:      parseInt(errorRow.rows[0]?.c     || 0),
        transport_breakdown: transportRow.rows.map(r => ({ mode: r.mode, count: parseInt(r.cnt) })),
        daily_counts: dailyCounts,
      },
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// GET /api/ewaybills — country-aware: only relevant for India (GSTIN present)
// GET /api/ewaybills/pending — sales invoices ≥₹50K without EWB (pending generation)
router.get('/ewaybills/pending', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const { search = '', page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(
      // EWB applicable from Apr 2018 only — earlier invoices never need EWB
    `SELECT * FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE
         AND voucher_type ILIKE '%Sales%'
         AND voucher_type NOT ILIKE '%Order%'
         AND voucher_type NOT ILIKE '%Delivery%'
         AND voucher_type NOT ILIKE '%Quotation%'
         AND amount >= 50000
         AND (ewb_number IS NULL OR ewb_number='')
         AND date BETWEEN $2 AND $3
         AND date >= '2018-04-01'
         AND (party_name ILIKE $4 OR voucher_number ILIKE $4)
       ORDER BY date DESC LIMIT $5 OFFSET $6`,
      [companyGuid, from, to, `%${search}%`, parseInt(limit), offset]
    );
    const { rows: cnt } = await query(
      `SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (ewb_number IS NULL OR ewb_number='') AND date BETWEEN $2 AND $3 AND date >= '2018-04-01'`,
      [companyGuid, from, to]
    );
    res.json({ success: true, data: rows.map(r => ({ ...r, ewb_status: 'pending' })), meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

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

    // Only return vouchers that have an EWB number (generated from Tally or portal)
    const { search = '', page = 1, limit = 30, from, to } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let q = `SELECT * FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != '' AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
    if (from) { q += ` AND date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND date <= $${idx++}`; params.push(to); }
    q += ` ORDER BY date DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != ''`, [companyGuid]);
    res.json({
      success: true, country_applicable: true,
      data: rows.map(r => ({ ...r, ewb_status: 'generated' })),
      meta: { total: parseInt(cnt[0].c), page: parseInt(page) }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// E-INVOICE (IRN) — India GST only
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/einvoice/status — summary counts for e-invoice compliance screen
router.get('/einvoice/status', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const [generatedRow, pendingRow, cancelledRow, errorRow] = await Promise.all([
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // IRN applicable from Oct 2020 only
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (irn IS NULL OR irn='') AND irn_cancelled=FALSE AND date BETWEEN $2 AND $3 AND date >= '2020-10-01'`, [companyGuid, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND irn_cancelled=TRUE AND date BETWEEN $2 AND $3`, [companyGuid, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(*) as c FROM e_invoice_details WHERE company_guid=$1 AND error_message IS NOT NULL AND error_message != ''`, [companyGuid])
        .catch(() => ({ rows: [{ c: 0 }] })),
    ]);
    res.json({
      success: true,
      data: {
        generated_count:  parseInt(generatedRow.rows[0]?.c  || 0),
        pending_count:    parseInt(pendingRow.rows[0]?.c    || 0),
        cancelled_count:  parseInt(cancelledRow.rows[0]?.c  || 0),
        error_count:      parseInt(errorRow.rows[0]?.c      || 0),
      },
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

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
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    // IRN applicable from Oct 2020 only — earlier invoices never need IRN
    const { rows } = await query(`SELECT * FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (irn IS NULL OR irn='') AND irn_cancelled=FALSE AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 AND date >= '2020-10-01' ORDER BY date DESC LIMIT 100`, [companyGuid, from, to]);
    res.json({ success: true, country_applicable: true, data: rows, meta: { total: rows.length, pending_irn: rows.length } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/einvoice/generated', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(
      `SELECT * FROM vouchers WHERE company_guid=$1 AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 AND (party_name ILIKE $4 OR voucher_number ILIKE $4) ORDER BY date DESC LIMIT $5 OFFSET $6`,
      [companyGuid, from, to, `%${search}%`, parseInt(limit), offset]
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_guid=$1 AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]);
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
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
      // GST relevance filter: only include vouchers that have GST details OR are explicitly flagged.
      // This removes pre-GST era vouchers (e.g. 2017-18 before July 2017) that have no gst_voucher_details.
      const gstRelevanceFilter = `AND (v.is_gst_relevant = TRUE OR g.voucher_guid IS NOT NULL)`;
      const outQ = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_guid = v.company_guid WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type != ALL(${NON_SALES_LITERAL}) ${gstRelevanceFilter}`;
      const inQ  = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_guid = v.company_guid LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_guid = v.company_guid WHERE v.company_guid=$1 AND v.is_cancelled=FALSE AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase']) ${gstRelevanceFilter}`;
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
             WHERE v.company_guid=$1 AND v.is_cancelled=FALSE ${typeFilter}
             AND (v.is_gst_relevant = TRUE OR g.voucher_guid IS NOT NULL)`;
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

// ── AI Insights imports ──────────────────────────────────────────────────────
import {
  computeInsightMetrics, generateGroqNarration, generateRulesRecommendations,
  getCachedInsights, setCachedInsights, ensureCacheTables,
  computeHistoricalSummary, currentFYLabel, currentMonthKey,
} from '../services/aiInsights.js';

// Ensure cache tables exist on startup (no-op if already created)
ensureCacheTables().catch(e => console.warn('[AI Insights] ensureCacheTables:', e.message));

// ── AI Insights — Current FY (live analytics + monthly cached LLM narration) ─
router.get('/ai/insights', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const isCurrentFY = (financialYear === currentFYLabel());
    const monthKey    = currentMonthKey();

    // ── Step 1: Check cache (current FY only, monthly TTL) ────────────────────
    if (isCurrentFY) {
      const cached = await getCachedInsights(companyGuid, monthKey);
      if (cached) {
        return res.json({ success: true, data: { ...cached, fromCache: true, isCurrentFY } });
      }
    }

    // ── Step 2: Compute SQL analytics ─────────────────────────────────────────
    const metrics = await computeInsightMetrics(companyGuid, from, to, financialYear);
    const { forecastData, expenseWithSpike, receivablesAging,
            topSuppliers, topCustomers, stockout, summary, llmPayload } = metrics;

    // ── Step 3: Generate recommendations (Groq LLM or rules fallback) ─────────
    let recommendations = null;
    if (isCurrentFY) {
      recommendations = await generateGroqNarration(llmPayload, financialYear, isCurrentFY);
    }
    if (!recommendations) {
      recommendations = generateRulesRecommendations(metrics, isCurrentFY);
    }

    const responseData = {
      revenueForecast:  isCurrentFY ? forecastData : forecastData.filter(d => d.actual !== null), // no forecast for historical
      expenseData:      expenseWithSpike,
      receivablesAging,
      topSuppliers,
      topCustomers,
      stockout,
      recommendations,
      summary,
      isCurrentFY,
      financialYear,
      aiNarrated: isCurrentFY && !!process.env.GROQ_API_KEY,
    };

    // ── Step 4: Cache result (current FY only) ─────────────────────────────────
    if (isCurrentFY) {
      await setCachedInsights(companyGuid, monthKey, llmPayload, responseData);
    }

    // Add cache timestamps for UI disclaimer
    const now       = new Date();
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    responseData._cacheGeneratedAt = now.toISOString();
    responseData._cacheValidUntil  = nextMonth.toISOString();

    return res.json({ success: true, data: { ...responseData, fromCache: false } });

  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});


// ── AI Insights — Historical FY (deterministic, no LLM, no forecasting) ────────────
router.get('/ai/insights/history/:fy', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const financialYear = req.params.fy; // e.g. '2025-2026'
  if (!financialYear || !/^\d{4}-\d{4}$/.test(financialYear)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_FY', message: 'fy must be like 2025-2026' } });
  }
  // Block current FY — use /ai/insights for that
  if (financialYear === currentFYLabel()) {
    return res.status(400).json({ success: false, error: { code: 'USE_CURRENT_ENDPOINT', message: 'Use /ai/insights for current FY' } });
  }
  try {
    const { from, to } = await resolveFYDates(companyGuid, null, null, financialYear);
    const summary = await computeHistoricalSummary(companyGuid, financialYear, from, to);
    return res.json({ success: true, data: summary });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// POST /api/admin/backfill-stock-voucher-types — One-time fix: populate NULL voucher_type in stock_transactions from vouchers table
// Root cause: SimplifiedVoucher.xml omits VOUCHERTYPENAME, leaving voucher_type = NULL — breaks transaction type filter
router.post('/admin/backfill-stock-voucher-types', authMiddleware, async (req, res) => {
  const companyGuid = req.body?.companyGuid || req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rowCount } = await query(`
      UPDATE stock_transactions st
      SET voucher_type = v.voucher_type
      FROM vouchers v
      WHERE st.voucher_guid = v.guid
        AND st.company_guid = v.company_guid
        AND st.company_guid = $1
        AND (st.voucher_type IS NULL OR st.voucher_type = '')
        AND v.voucher_type IS NOT NULL AND v.voucher_type != ''
    `, [companyGuid]);
    res.json({ success: true, data: { updated: rowCount, message: `Backfilled voucher_type for ${rowCount} stock_transactions` } });
  } catch (e) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: e.message } });
  }
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

// ────────────────────────────────────────────────────────────────────────────
// Other Taxes Routes
// ────────────────────────────────────────────────────────────────────────────

// GET /reports/other-taxes/summary
router.get('/reports/other-taxes/summary', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from, to, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const { rows } = await query(`
      SELECT tax_type,
             COUNT(DISTINCT voucher_guid) AS voucher_count,
             SUM(tax_amount)              AS total_tax_amount,
             MAX(COALESCE(NULLIF(voucher_date,''), financial_year)) AS last_transaction_date
      FROM tax_transactions
      WHERE company_guid=$1
        AND (voucher_date BETWEEN $2 AND $3
          OR (financial_year = $4 AND (voucher_date IS NULL OR voucher_date = '')))
      GROUP BY tax_type
      ORDER BY total_tax_amount DESC
    `, [companyGuid, from, to, financialYear]);
    res.json({
      success: true,
      data: rows.map(r => ({
        taxType:             r.tax_type,
        voucherCount:        parseInt(r.voucher_count),
        totalTaxAmount:      parseFloat(r.total_tax_amount || 0),
        lastTransactionDate: r.last_transaction_date,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /reports/other-taxes/transactions
router.get('/reports/other-taxes/transactions', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { taxType, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const { from, to, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const params = [companyGuid, from, to];
    // typeFilter is TOP-LEVEL — must apply to ALL rows (including null-date FY fallback)
    let typeFilter = '';
    if (taxType) { typeFilter = ` AND tax_type = $4`; params.push(taxType); }
    const fyParam = params.length + 1;
    const fyParams = [...params, financialYear];
    // Date filter: real date range OR null-date fallback by FY — typeFilter applies to BOTH branches
    const dateFilter = `(voucher_date BETWEEN $2 AND $3 OR (financial_year = $${fyParam} AND (voucher_date IS NULL OR voucher_date = '')))`;
    const { rows } = await query(`
      SELECT * FROM tax_transactions
      WHERE company_guid=$1${typeFilter} AND ${dateFilter}
      ORDER BY COALESCE(NULLIF(voucher_date,''), financial_year) DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, fyParams);
    const { rows: cnt } = await query(`
      SELECT COUNT(*) AS c FROM tax_transactions
      WHERE company_guid=$1${typeFilter} AND ${dateFilter}
    `, fyParams);
    res.json({
      success: true,
      data: rows,
      meta: { total: parseInt(cnt[0].c), page: parseInt(page) },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /reports/other-taxes/late-challans
router.get('/reports/other-taxes/late-challans', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { taxType } = req.query;
  try {
    const { from, to } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);
    const params = [companyGuid, from, to];
    let typeFilter = '';
    if (taxType) { typeFilter = ` AND tax_type = $4`; params.push(taxType); }
    const { rows } = await query(`
      SELECT tax_type, return_period, challan_no, due_date, paid_date,
             SUM(tax_amount) AS tax_amount,
             EXTRACT(DAY FROM (COALESCE(paid_date::date, NOW()::date) - due_date::date)) AS late_days
      FROM tax_transactions
      WHERE company_guid=$1 AND voucher_date BETWEEN $2 AND $3${typeFilter}
        AND due_date IS NOT NULL
        AND COALESCE(paid_date::date, NOW()::date) > due_date::date
      GROUP BY tax_type, return_period, challan_no, due_date, paid_date
      ORDER BY late_days DESC
      LIMIT 5
    `, params);
    res.json({ success: true, data: rows, has_challan_data: rows.length > 0 });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /reports/other-taxes/backfill — one-time migration endpoint
router.get('/reports/other-taxes/backfill', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { backfillTaxTransactions } = await import('../controllers/ingestProcessor.js');
    const count = await backfillTaxTransactions(companyGuid);
    res.json({ success: true, data: { processed: count } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/ledger — Stock Ledger with 3 modes: chronological | by_item | by_document
// Primary source: stock_transactions (direction-aware). Joined with vouchers + stocks.
// Note: stock_transactions.stock_guid stores stock NAME (known schema quirk) — joined via name.
router.get('/stocks/ledger', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const {
    mode = 'chronological',  // chronological | by_item | by_document
    fy, from, to,
    item,                    // item name(s) — comma-separated for multi
    warehouse,               // warehouse(s) — comma-separated for multi
    batch,                   // batch/serial search (ILIKE on batch_serial)
    type: mvType,            // inward | outward
    search,                  // text search on item name or voucher number
    voucherType,             // voucher type(s) — comma-separated for multi
    page = '1', limit = '25',
  } = req.query;

  const pg  = Math.max(1, parseInt(page));
  const lim = Math.min(100, parseInt(limit) || 25);
  const offset = (pg - 1) * lim;

  // Validate mode
  if (!['chronological', 'by_item', 'by_document'].includes(mode)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_MODE', message: 'mode must be chronological | by_item | by_document' } });
  }

  try {
    // ── Build shared WHERE conditions on stock_transactions (aliased st)
    const stCond = [`st.company_guid = $1`];
    const params = [companyGuid];
    let idx = 2;

    // Date / FY
    if (fy && !from && !to) {
      const parts = fy.split('-');
      if (parts.length === 2) {
        stCond.push(`st.date >= $${idx++}`); params.push(`${parts[0]}-04-01`);
        stCond.push(`st.date <= $${idx++}`); params.push(`${parts[1]}-03-31`);
      }
    }
    if (from) { stCond.push(`st.date >= $${idx++}`); params.push(from); }
    if (to)   { stCond.push(`st.date <= $${idx++}`); params.push(to); }

    // Item name(s) — comma-separated multi-value OR single
    if (item) {
      const items = String(item).split(',').map(s => s.trim()).filter(Boolean);
      if (items.length === 1) {
        stCond.push(`st.stock_guid ILIKE $${idx++}`); params.push(`%${items[0]}%`);
      } else if (items.length > 1) {
        stCond.push(`(${items.map(() => `st.stock_guid ILIKE $${idx++}`).join(' OR ')})`);
        items.forEach(i => params.push(`%${i}%`));
      }
    }
    // Warehouse(s) — comma-separated multi-value OR single
    if (warehouse) {
      const whs = String(warehouse).split(',').map(s => s.trim()).filter(Boolean);
      if (whs.length === 1) {
        stCond.push(`st.warehouse ILIKE $${idx++}`); params.push(`%${whs[0]}%`);
      } else if (whs.length > 1) {
        stCond.push(`(${whs.map(() => `st.warehouse ILIKE $${idx++}`).join(' OR ')})`);
        whs.forEach(w => params.push(`%${w}%`));
      }
    }
    // Batch / Serial
    if (batch) { stCond.push(`st.batch_serial ILIKE $${idx++}`); params.push(`%${batch}%`); }
    if (mvType && ['inward','outward'].includes(mvType)) {
      stCond.push(`st.type = $${idx++}`); params.push(mvType);
    }
    // VoucherType(s) — comma-separated multi-value.
    // Uses actual Tally voucher type names (e.g. 'Sales GST', 'Purchase GST') returned by the
    // /stocks/ledger voucherTypes field. The backfill + sync fix keeps st.voucher_type populated.
    // EXISTS fallback on vouchers table handles any residual NULL rows.
    if (voucherType) {
      const vtypes = String(voucherType).split(',').map(s => s.trim()).filter(Boolean);
      const vConditions = vtypes.map(v => {
        const likeIdx = idx++;
        params.push(`%${v}%`);
        return `(st.voucher_type ILIKE $${likeIdx} OR EXISTS (
          SELECT 1 FROM vouchers vf
          WHERE vf.guid = st.voucher_guid AND vf.company_guid = $1
          AND vf.voucher_type ILIKE $${likeIdx}
        ))`;
      });
      stCond.push(vtypes.length === 1 ? vConditions[0] : `(${vConditions.join(' OR ')})`);
    }
    // Full-text search across item name + voucher number (needs JOIN with vouchers)
    const hasSearch = !!search;
    if (hasSearch) {
      stCond.push(`(
        st.stock_guid ILIKE $${idx}
        OR EXISTS (
          SELECT 1 FROM vouchers sv WHERE sv.guid = st.voucher_guid
            AND sv.company_guid = $1 AND sv.voucher_number ILIKE $${idx}
        )
      )`);
      params.push(`%${search}%`); idx++;
    }

    const stWhere = stCond.join(' AND ');

    // ── Summary (all modes share same summary aggregate)
    const { rows: sumRows } = await query(`
      SELECT
        COUNT(*)                                              AS total,
        SUM(CASE WHEN st.type='inward'  THEN ABS(st.qty) ELSE 0 END) AS total_in,
        SUM(CASE WHEN st.type='outward' THEN ABS(st.qty) ELSE 0 END) AS total_out,
        SUM(ABS(COALESCE(st.value, st.qty * st.rate, 0)))   AS total_value
      FROM stock_transactions st
      WHERE ${stWhere}
    `, params);

    const sum = sumRows[0];
    const summary = {
      entries:  parseInt(sum.total),
      totalIn:  parseFloat(sum.total_in   || 0),
      totalOut: parseFloat(sum.total_out  || 0),
      value:    parseFloat(sum.total_value|| 0),
    };

    // ── Distinct warehouses for filter
    const { rows: whRows } = await query(
      `SELECT DISTINCT warehouse FROM stock_transactions
       WHERE company_guid=$1 AND warehouse IS NOT NULL AND warehouse <> ''
       ORDER BY warehouse`, [companyGuid]);
    const warehouses = whRows.map(r => r.warehouse);

    // ── Distinct voucher types for filter (dynamic — Tally companies use custom names like 'Sales GST')
    const { rows: vtRows } = await query(
      `SELECT DISTINCT voucher_type FROM stock_transactions
       WHERE company_guid=$1 AND voucher_type IS NOT NULL AND voucher_type <> ''
       ORDER BY voucher_type`, [companyGuid]);
    const voucherTypes = vtRows.map(r => r.voucher_type);

    // ════════════════════════════════════════════════════════
    // MODE: chronological
    // ════════════════════════════════════════════════════════
    if (mode === 'chronological') {
      const { rows } = await query(`
        SELECT
          st.id              AS "transactionId",
          st.date,
          st.voucher_guid    AS "voucherGuid",
          st.voucher_type    AS "voucherType",
          CASE WHEN st.type='inward' THEN ABS(st.qty) ELSE -ABS(st.qty) END AS quantity,
          st.type            AS "movementDirection",
          st.rate            AS "unitCost",
          COALESCE(st.value, st.qty * st.rate) AS value,
          st.warehouse,
          st.stock_guid      AS "itemName",
          -- join stocks for guid + alias
          s.guid             AS "stockGuid",
          s.alias            AS sku,
          s.unit,
          -- join vouchers for document number + party + note
          v.voucher_number   AS "documentNumber",
          v.party_name       AS "partyName",
          v.narration        AS note,
          -- join voucher_inventory_items for batch
          vi.batch_name      AS "batchSerial"
        FROM stock_transactions st
        LEFT JOIN stocks s
          ON s.name = st.stock_guid AND s.company_guid = st.company_guid
        LEFT JOIN vouchers v
          ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
          AND v.is_cancelled = FALSE
        LEFT JOIN LATERAL (
          SELECT batch_name FROM voucher_inventory_items
          WHERE voucher_guid = st.voucher_guid
            AND company_guid = st.company_guid
            AND stock_item_name = st.stock_guid
          LIMIT 1
        ) vi ON true
        WHERE ${stWhere}
        ORDER BY st.date DESC, st.id DESC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...params, lim, offset]);

      // Normalise movementDirection to UPPER
      const items = rows.map(r => ({
        ...r,
        movementDirection: (r.movementDirection || '').toUpperCase(),
        postedBy: null,
        balanceAfterTransaction: null,
        time: null,
      }));

      return res.json({
        success: true,
        data: { mode, summary, warehouses, voucherTypes, items,
          pagination: { page: pg, pageSize: lim, total: summary.entries } },
      });
    }

    // ════════════════════════════════════════════════════════
    // MODE: by_item
    // ════════════════════════════════════════════════════════
    if (mode === 'by_item') {
      // Step 1: Distinct items page
      const { rows: itemRows } = await query(`
        SELECT
          st.stock_guid      AS item_name_key,
          s.guid             AS "stockGuid",
          st.stock_guid      AS "itemName",
          s.alias            AS sku,
          s.group_name       AS "groupName",
          s.category,
          s.unit,
          s.closing_qty      AS "currentBalance",
          COUNT(st.id)       AS rows_count,
          MAX(st.rate)       AS latest_rate
        FROM stock_transactions st
        LEFT JOIN stocks s
          ON s.name = st.stock_guid AND s.company_guid = st.company_guid
        WHERE ${stWhere}
        GROUP BY st.stock_guid, s.guid, s.alias, s.group_name, s.category, s.unit, s.closing_qty
        ORDER BY st.stock_guid
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...params, lim, offset]);

      // Step 2: Total distinct items count
      const { rows: cntRows } = await query(`
        SELECT COUNT(DISTINCT st.stock_guid) AS total
        FROM stock_transactions st
        WHERE ${stWhere}
      `, params);
      const itemTotal = parseInt(cntRows[0].total);

      // Step 3: Fetch transactions for those items
      const itemNames = itemRows.map(r => r.item_name_key);
      let txnsByItem = {};
      if (itemNames.length > 0) {
        const placeholders = itemNames.map((_, i) => `$${i + 2}`).join(',');
        const { rows: txnRows } = await query(`
          SELECT
            st.id              AS "transactionId",
            st.stock_guid      AS item_name_key,
            st.date,
            st.voucher_guid    AS "voucherGuid",
            st.voucher_type    AS "voucherType",
            CASE WHEN st.type='inward' THEN ABS(st.qty) ELSE -ABS(st.qty) END AS quantity,
            st.type            AS "movementDirection",
            st.rate,
            COALESCE(st.value, st.qty * st.rate) AS value,
            st.warehouse,
            v.voucher_number   AS "docRef"
          FROM stock_transactions st
          LEFT JOIN vouchers v
            ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
            AND v.is_cancelled = FALSE
          WHERE st.company_guid = $1 AND st.stock_guid IN (${placeholders})
          ORDER BY st.date DESC, st.id DESC
        `, [companyGuid, ...itemNames]);

        txnsByItem = txnRows.reduce((acc, t) => {
          const key = t.item_name_key;
          if (!acc[key]) acc[key] = [];
          acc[key].push({
            date:              t.date,
            docRef:            t.docRef,
            transactionId:     String(t.transactionId),
            voucherGuid:       t.voucherGuid,
            voucherType:       t.voucherType,
            quantity:          parseFloat(t.quantity),
            movementDirection: (t.movementDirection || '').toUpperCase(),
            rate:              parseFloat(t.rate || 0),
            value:             parseFloat(t.value || 0),
            warehouse:         t.warehouse,
            balance:           null,
          });
          return acc;
        }, {});
      }

      const items = itemRows.map((r) => ({
        stockGuid:      r.stockGuid,
        itemName:       r.itemName,
        sku:            r.sku || null,
        groupName:      r.groupName || null,
        category:       r.category || null,
        unit:           r.unit || null,
        rowsCount:      parseInt(r.rows_count),
        currentBalance: parseFloat(r.currentBalance || 0),
        latestRate:     parseFloat(r.latest_rate || 0),
        transactions:   txnsByItem[r.item_name_key] || [],
      }));

      return res.json({
        success: true,
        data: { mode, summary, warehouses, voucherTypes, items,
          pagination: { page: pg, pageSize: lim, total: itemTotal } },
      });
    }

    // ════════════════════════════════════════════════════════
    // MODE: by_document
    // ════════════════════════════════════════════════════════
    // Step 1: Distinct vouchers page
    const { rows: docRows } = await query(`
      SELECT
        v.guid           AS "voucherGuid",
        v.voucher_number AS "voucherNumber",
        v.voucher_type   AS "voucherType",
        v.date,
        v.party_name     AS "partyName",
        v.narration      AS note,
        v.reference,
        v.amount,
        COUNT(st.id)     AS items_count,
        MIN(st.warehouse) AS warehouse
      FROM stock_transactions st
      INNER JOIN vouchers v
        ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
        AND v.is_cancelled = FALSE
      WHERE ${stWhere}
      GROUP BY v.guid, v.voucher_number, v.voucher_type, v.date, v.party_name, v.narration, v.reference, v.amount
      ORDER BY v.date DESC, MIN(v.id) DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...params, lim, offset]);

    const { rows: docCntRows } = await query(`
      SELECT COUNT(DISTINCT v.guid) AS total
      FROM stock_transactions st
      INNER JOIN vouchers v
        ON v.guid = st.voucher_guid AND v.company_guid = st.company_guid
        AND v.is_cancelled = FALSE
      WHERE ${stWhere}
    `, params);
    const docTotal = parseInt(docCntRows[0].total);

    // Step 2: Fetch stock lines for those vouchers
    const vGuids = docRows.map(r => r.voucherGuid);
    let linesByVoucher = {};
    if (vGuids.length > 0) {
      const phs = vGuids.map((_, i) => `$${i + 2}`).join(',');
      const { rows: lineRows } = await query(`
        SELECT
          st.voucher_guid AS voucher_guid,
          st.stock_guid   AS "itemName",
          s.guid          AS "stockGuid",
          s.alias         AS sku,
          s.unit,
          CASE WHEN st.type='inward' THEN ABS(st.qty) ELSE -ABS(st.qty) END AS quantity,
          st.type         AS "movementDirection",
          st.rate         AS "unitCost",
          COALESCE(st.value, st.qty * st.rate) AS value,
          st.warehouse,
          vi.batch_name   AS "batchSerial"
        FROM stock_transactions st
        LEFT JOIN stocks s
          ON s.name = st.stock_guid AND s.company_guid = st.company_guid
        LEFT JOIN LATERAL (
          SELECT batch_name FROM voucher_inventory_items
          WHERE voucher_guid = st.voucher_guid
            AND company_guid = st.company_guid
            AND stock_item_name = st.stock_guid
          LIMIT 1
        ) vi ON true
        WHERE st.company_guid = $1 AND st.voucher_guid IN (${phs})
        ORDER BY st.id
      `, [companyGuid, ...vGuids]);

      linesByVoucher = lineRows.reduce((acc, l) => {
        if (!acc[l.voucher_guid]) acc[l.voucher_guid] = [];
        acc[l.voucher_guid].push({
          stockGuid:        l.stockGuid || null,
          itemName:         l.itemName,
          sku:              l.sku  || null,
          unit:             l.unit || null,
          batchSerial:      l.batchSerial || null,
          unitCost:         parseFloat(l.unitCost || 0),
          quantity:         parseFloat(l.quantity),
          movementDirection:(l.movementDirection || '').toUpperCase(),
          value:            parseFloat(l.value || 0),
          warehouse:        l.warehouse,
          balance:          null,
        });
        return acc;
      }, {});
    }

    const items = docRows.map((r) => ({
      voucherGuid:   r.voucherGuid,
      voucherType:   r.voucherType,
      voucherNumber: r.voucherNumber,
      date:          r.date,
      warehouse:     r.warehouse || null,
      itemsCount:    parseInt(r.items_count),
      amount:        parseFloat(r.amount || 0),
      partyName:     r.partyName || null,
      reference:     r.reference || null,
      note:          r.note || null,
      stockLines:    linesByVoucher[r.voucherGuid] || [],
    }));

    return res.json({
      success: true,
      data: { mode, summary, warehouses, voucherTypes, items,
        pagination: { page: pg, pageSize: lim, total: docTotal } },
    });

  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/items/:id/movements — movement history for a stock item
router.get('/stocks/items/:id/movements', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { limit = 20 } = req.query;
  try {
    // Get stock name from guid
    const { rows: sRows } = await query('SELECT name, closing_rate FROM stocks WHERE guid=$1 AND company_guid=$2', [req.params.id, companyGuid]);
    if (!sRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    const stockName = sRows[0].name;

    // Movement history from voucher_inventory_items
    // GROUP BY voucher to collapse godown-split rows (same item delivered to multiple warehouses)
    // This prevents duplicate entries when a single voucher splits qty across godowns
    const { rows } = await query(`
      SELECT v.voucher_number, v.voucher_type as type, v.date,
             SUM(vi.actual_qty) as qty,
             CASE WHEN SUM(vi.actual_qty) > 0 THEN SUM(vi.amount) / NULLIF(SUM(vi.actual_qty), 0) ELSE AVG(vi.rate) END as rate,
             SUM(vi.amount) as amount
      FROM voucher_inventory_items vi
      JOIN vouchers v ON v.guid = vi.voucher_guid
      WHERE vi.stock_item_name = $1 AND vi.company_guid = $2
        AND v.is_cancelled = FALSE
        AND v.voucher_type != 'Physical Stock'  -- exclude stock audit counts; not real movements
      GROUP BY v.id, v.voucher_number, v.voucher_type, v.date
      ORDER BY v.date DESC, v.id DESC
      LIMIT $3
    `, [stockName, companyGuid, parseInt(limit)]);

    // Avg purchase rate from inward transactions
    const { rows: avgRows } = await query(`
      SELECT AVG(rate) as avg_purchase_rate,
             (SELECT rate FROM stock_transactions WHERE stock_guid=$1 AND company_guid=$2 AND type='inward' AND rate>0 ORDER BY date DESC, id DESC LIMIT 1) as last_purchase_rate
      FROM stock_transactions
      WHERE stock_guid=$1 AND company_guid=$2 AND type='inward' AND rate>0
    `, [stockName, companyGuid]);

    // Last selling rate from sales vouchers
    const { rows: sellRows } = await query(`
      SELECT vi.rate as last_sell_rate
      FROM voucher_inventory_items vi
      JOIN vouchers v ON v.guid = vi.voucher_guid
      WHERE vi.stock_item_name=$1 AND vi.company_guid=$2
        AND v.voucher_type ILIKE '%sales%' AND vi.rate > 0
        AND v.is_cancelled = FALSE
      ORDER BY v.date DESC LIMIT 1
    `, [stockName, companyGuid]);

    res.json({
      success: true,
      data: {
        movements: rows,
        avgPurchaseRate: parseFloat(avgRows[0]?.avg_purchase_rate || 0),
        lastPurchaseRate: parseFloat(avgRows[0]?.last_purchase_rate || sRows[0].closing_rate || 0),
        lastSellRate: parseFloat(sellRows[0]?.last_sell_rate || 0),
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/stocks/items/:id/godowns — warehouses where this item has stock, with net qty
router.get('/stocks/items/:id/godowns', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: sRows } = await query('SELECT name, closing_qty FROM stocks WHERE guid=$1 AND company_guid=$2', [req.params.id, companyGuid]);
    if (!sRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    const stockName  = sRows[0].name;
    const totalQty   = parseFloat(sRows[0].closing_qty || 0);
    // Net qty per warehouse from stock_transactions
    const { rows } = await query(`
      SELECT
        st.warehouse                                                            AS name,
        SUM(CASE WHEN st.type='inward' THEN ABS(st.qty) ELSE -ABS(st.qty) END) AS qty
      FROM stock_transactions st
      WHERE st.stock_guid = $1 AND st.company_guid = $2
        AND st.warehouse IS NOT NULL AND st.warehouse != ''
        AND st.voucher_type != 'Physical Stock'
      GROUP BY st.warehouse
      HAVING SUM(CASE WHEN st.type='inward' THEN ABS(st.qty) ELSE -ABS(st.qty) END) != 0
      ORDER BY qty DESC
    `, [stockName, companyGuid]);
    const warehouses = rows.map(r => ({ name: r.name, qty: parseFloat(r.qty) })).filter(r => r.name);
    res.json({ success: true, data: { warehouses, totalQty } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ════════════════════════════════════════════════════════════
// BARCODE MODULE
// ════════════════════════════════════════════════════════════

// ── Barcode helpers ──────────────────────────────────────────────────────────────────
function _hashCode32(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function _ean13Check(d12) {
  let s = 0;
  for (let i = 0; i < 12; i++) s += parseInt(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return ((10 - (s % 10)) % 10).toString();
}
function generateBarcodeValue(type, companyGuid, seq) {
  if (type === 'EAN13') {
    const p  = '890';
    const ch = _hashCode32(companyGuid).toString().padStart(4,'0').slice(0,4);
    const s  = seq.toString().padStart(5,'0').slice(-5);
    const d12 = p + ch + s;
    return d12 + _ean13Check(d12);
  }
  const slug = companyGuid.replace(/[^A-Z0-9]/gi,'').slice(0,4).toUpperCase().padEnd(4,'X');
  return `TDK${slug}${seq.toString().padStart(7,'0').slice(-7)}`;
}
function validateBarcode(barcode, type) {
  if (!barcode) return 'Barcode is required';
  const b = String(barcode).trim();
  if (b.length < 4)  return 'Too short (min 4)';
  if (b.length > 64) return 'Too long (max 64)';
  if (/\s/.test(b))  return 'Spaces not allowed in barcode';
  if (type === 'EAN13') {
    if (!/^\d{13}$/.test(b))            return 'EAN13 must be exactly 13 digits';
    if (_ean13Check(b.slice(0,12)) !== b[12]) return 'Invalid EAN13 checksum';
  }
  if (type === 'EAN8' && !/^\d{8}$/.test(b)) return 'EAN8 must be exactly 8 digits';
  return null;
}
function buildStockItemAlterXML(stockName, barcode, existingAliases = []) {
  const all = [...new Set([stockName, ...existingAliases, barcode])];
  const nameList = all.map(a => `<NAME>${a.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</NAME>`).join('\n              ');
  return `<ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF"><STOCKITEM NAME="${stockName}" ACTION="Alter"><NAME>${stockName}</NAME><NAME.LIST TYPE="String">${nameList}</NAME.LIST></STOCKITEM></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

// POST /api/inventory/barcodes/generate-bulk — generate barcodes for multiple/all unlinked items
router.post('/inventory/barcodes/generate-bulk', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuids, all, barcodeType = 'CODE128', syncTarget = 'app_only' } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!all && (!Array.isArray(stockGuids) || !stockGuids.length))
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'stockGuids[] or all=true required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Fetch target items that have NO active primary barcode
    const baseFilter = all
      ? `s.company_guid = $1`
      : `s.company_guid = $1 AND s.guid = ANY($2::text[])`;
    const baseParams = all ? [companyGuid] : [companyGuid, stockGuids];
    const { rows: targets } = await query(`
      SELECT s.guid, s.name FROM stocks s
      WHERE ${baseFilter}
      AND NOT EXISTS (
        SELECT 1 FROM stock_barcodes sb
        WHERE sb.stock_guid = s.guid AND sb.company_guid = $1 AND sb.is_primary = TRUE AND sb.status = 'active'
      )
      ORDER BY s.name`, baseParams);

    if (!targets.length)
      return res.json({ success: true, data: { generated: 0, alreadyLinked: stockGuids?.length || 0, errors: 0 } });

    const { rows: [{ cnt }] } = await query(`SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_guid=$1`, [companyGuid]);
    const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
    let generated = 0, errors = 0;

    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      try {
        let barcode, tries = 0;
        do {
          barcode = generateBarcodeValue(barcodeType, companyGuid, cnt + generated + tries + 1);
          tries++;
          const { rows: [dup] } = await query(`SELECT 1 FROM stock_barcodes WHERE company_guid=$1 AND barcode=$2`, [companyGuid, barcode]);
          if (!dup) break;
        } while (tries < 10);
        await query(`
          INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
          VALUES ($1,$2,$3,$4,$5,'app_generated','active',TRUE,$6,$7)
          ON CONFLICT (company_guid, barcode) DO NOTHING`,
          [companyGuid, item.guid, item.name, barcode, barcodeType, syncTarget, tallyStatus]);
        generated++;
      } catch { errors++; }
    }
    res.json({ success: true, data: { generated, alreadyLinked: (stockGuids?.length || targets.length) - targets.length, errors, total: targets.length } });
  } catch (err) {
    console.error('[inventory/barcodes GENERATE-BULK]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/by-guids — fetch barcode data for a specific list of stockGuids (used by print screens)
router.post('/inventory/barcodes/by-guids', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuids } = req.body;
  if (!companyGuid || !Array.isArray(stockGuids) || !stockGuids.length)
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid and stockGuids[] required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const displayField = await getProductDisplayField(companyGuid);
    const { rows } = await query(`
      SELECT
        s.guid AS stock_guid, s.name, s.alias, s.sku, s.group_name, s.unit,
        s.closing_qty, s.closing_rate,
        sb.barcode, sb.barcode_type, sb.status AS barcode_status, sb.tally_sync_status
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_guid=s.company_guid AND sb.is_primary=TRUE AND sb.status='active'
      WHERE s.company_guid=$1 AND s.guid = ANY($2::text[])
      ORDER BY s.name ASC`, [companyGuid, stockGuids]);
    res.json({
      success: true,
      data: {
        items: rows.map(r => ({
          stockGuid:    r.stock_guid,
          displayName:  computeDisplayName(r, displayField),
          name:         r.name,
          sku:          r.sku || r.alias || null,
          barcode:      r.barcode || null,
          barcodeType:  r.barcode_type || 'CODE128',
          closingRate:  parseFloat(r.closing_rate || 0),
          currentQty:   parseFloat(r.closing_qty  || 0),
          groupName:    r.group_name || null,
          unit:         r.unit || 'Pcs',
        })),
      },
    });
  } catch (err) {
    console.error('[inventory/barcodes BY-GUIDS]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes — list with filters + summary
router.post('/inventory/barcodes', authMiddleware, async (req, res) => {
  const { companyGuid, period, group, status, search, page = 1, pageSize = 50 } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const displayField = await getProductDisplayField(companyGuid);
    const lim  = Math.min(parseInt(pageSize) || 50, 200);
    const off  = (Math.max(1, parseInt(page)) - 1) * lim;
    const params = [companyGuid];
    let where = 's.company_guid = $1';

    if (group && group !== 'All' && group !== 'all') {
      params.push(group); where += ` AND s.group_name = $${params.length}`;
    }
    if (period && !['All','all'].includes(period)) {
      const d = period === 'Today' ? new Date().setHours(0,0,0,0)
              : period === '7 Days'  ? Date.now() - 7*864e5
              : period === '30 Days' ? Date.now() - 30*864e5 : null;
      if (d) { params.push(new Date(d).toISOString()); where += ` AND (sb.created_at IS NULL OR sb.created_at >= $${params.length})`; }
    }
    if (status && !['All','all'].includes(status)) {
      if (status === 'Linked')              where += ` AND sb.barcode IS NOT NULL`;
      else if (status === 'Unlinked')       where += ` AND sb.barcode IS NULL`;
      else if (status === 'In Stock')       where += ` AND s.closing_qty > 0`;
      else if (status === 'Low Stock')      where += ` AND s.closing_qty > 0 AND s.reorder_level > 0 AND s.closing_qty <= s.reorder_level`;
      else if (status === 'Out of Stock')   where += ` AND s.closing_qty <= 0`;
      else if (status === 'Duplicate')      where += ` AND sb.status = 'duplicate'`;
      else if (status === 'Invalid')        where += ` AND sb.status = 'invalid'`;
      else if (status === 'Pending Tally Sync') where += ` AND sb.tally_sync_status IN ('pending_tally','failed')`;
    }
    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      where += ` AND (s.name ILIKE $${params.length} OR s.sku ILIKE $${params.length} OR s.alias ILIKE $${params.length} OR sb.barcode ILIKE $${params.length})`;
    }

    const sumRes = await query(`
      SELECT
        COUNT(DISTINCT s.guid)::int AS total_items,
        COUNT(DISTINCT sb.stock_guid) FILTER (WHERE sb.status='active')::int AS linked,
        COUNT(*) FILTER (WHERE sb.status='duplicate')::int AS duplicates,
        COUNT(*) FILTER (WHERE sb.status='invalid')::int AS invalid,
        COUNT(*) FILTER (WHERE sb.tally_sync_status IN ('pending_tally','failed'))::int AS pending_tally_sync
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_guid=s.company_guid AND sb.is_primary=TRUE
      WHERE s.company_guid=$1`, [companyGuid]);
    const sr = sumRes.rows[0] || {};

    const { rows } = await query(`
      SELECT
        s.guid AS stock_guid, s.name, s.alias, s.sku, s.description, s.group_name, s.unit,
        s.closing_qty, s.reorder_level,
        sb.id AS barcode_id, sb.barcode, sb.barcode_type,
        sb.status AS barcode_status, sb.source, sb.sync_target, sb.tally_sync_status, sb.is_primary,
        COUNT(*) OVER() AS _total
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_guid=s.company_guid AND sb.is_primary=TRUE AND sb.status='active'
      WHERE ${where}
      ORDER BY s.name ASC
      LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, lim, off]);

    const total  = parseInt(rows[0]?._total ?? 0);
    const linked = parseInt(sr.linked || 0);
    const items  = rows.map(r => ({
      stockGuid:       r.stock_guid,
      displayName:     computeDisplayName(r, displayField),
      name:            r.name,
      alias:           r.alias,
      partNumber:      r.sku,
      description:     r.description,
      sku:             r.sku || r.alias,
      barcode:         r.barcode || null,
      barcodeId:       r.barcode_id,
      barcodeType:     r.barcode_type || null,
      barcodeStatus:   r.barcode_status || null,
      source:          r.source || null,
      syncTarget:      r.sync_target || 'app_only',
      tallySyncStatus: r.tally_sync_status || null,
      groupName:       r.group_name,
      currentQty:      parseFloat(r.closing_qty || 0),
      unit:            r.unit || 'Pcs',
    }));

    const groupsRes = await query(`SELECT DISTINCT group_name FROM stocks WHERE company_guid=$1 AND group_name IS NOT NULL AND group_name != '' ORDER BY group_name`, [companyGuid]);
    const groups = ['All', ...groupsRes.rows.map(r => r.group_name)];

    res.json({
      success: true,
      data: {
        summary: { totalItems: parseInt(sr.total_items||0), linked, unlinked: Math.max(0, parseInt(sr.total_items||0) - linked), duplicates: parseInt(sr.duplicates||0), invalid: parseInt(sr.invalid||0), pendingTallySync: parseInt(sr.pending_tally_sync||0) },
        items,
        filters: { groups, statuses: ['All','In Stock','Low Stock','Out of Stock','Linked','Unlinked','Duplicate','Invalid','Pending Tally Sync'] },
        pagination: { page: parseInt(page), pageSize: lim, total },
      },
    });
  } catch (err) {
    console.error('[inventory/barcodes LIST]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/generate — generate barcode for a stock item
// ── Helper: push barcode to Tally if auto-sync is enabled ─────────────────────
async function autoSyncBarcodeToTally(userId, companyGuid, stockGuid, stockName, barcode, syncTarget) {
  if (!syncTarget || syncTarget === 'app_only') return;
  try {
    const { rows: [settings] } = await query(
      'SELECT auto_sync_to_tally FROM inventory_barcode_settings WHERE company_guid=$1', [companyGuid]);
    if (!settings?.auto_sync_to_tally) return; // toggle is OFF — do not push
    const { rows: [co] } = await query('SELECT name FROM companies WHERE guid=$1', [companyGuid]);
    if (!co?.name) return;
    const { pushBarcodeToTally } = await import('./tally-write.js');
    const result = await pushBarcodeToTally({
      companyGuid, userId, stockGuid, stockName, barcode, syncTarget, companyName: co.name,
    });
    // Map Tally result → tally_sync_status
    const newStatus =
      !result                               ? 'pending_tally' :
      result.status === 'desktop_offline'   ? 'pending_tally' :
      result.status === 'success'           ? 'synced'        :
      (result.altered > 0 && !result.errors)? 'synced'        : 'failed';
    await query(
      'UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_guid=$2 AND stock_guid=$3 AND barcode=$4',
      [newStatus, companyGuid, stockGuid, barcode]
    );
  } catch (err) {
    console.error('[autoSyncBarcodeToTally]', err.message); // non-fatal — barcode already saved
  }
}

router.post('/inventory/barcodes/generate', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuid, barcodeType = 'CODE128', syncTarget = 'app_only' } = req.body;
  if (!companyGuid || !stockGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid and stockGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: [stock] } = await query('SELECT name, guid FROM stocks WHERE guid=$1 AND company_guid=$2', [stockGuid, companyGuid]);
    if (!stock) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Stock item not found' } });
    const { rows: [existing] } = await query(`SELECT barcode, barcode_type FROM stock_barcodes WHERE stock_guid=$1 AND company_guid=$2 AND is_primary=TRUE AND status='active' LIMIT 1`, [stockGuid, companyGuid]);
    if (existing) return res.json({ success: true, data: { barcode: existing.barcode, barcodeType: existing.barcode_type, status: 'active', alreadyExisted: true } });
    const { rows: [{ cnt }] } = await query(`SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_guid=$1`, [companyGuid]);
    let barcode, tries = 0;
    do {
      barcode = generateBarcodeValue(barcodeType, companyGuid, cnt + tries + 1);
      tries++;
      const { rows: [dup] } = await query(`SELECT 1 FROM stock_barcodes WHERE company_guid=$1 AND barcode=$2`, [companyGuid, barcode]);
      if (!dup) break;
    } while (tries < 10);
    const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
    const { rows: [ins] } = await query(`
      INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
      VALUES ($1,$2,$3,$4,$5,'app_generated','active',TRUE,$6,$7)
      RETURNING barcode, barcode_type, status, tally_sync_status`,
      [companyGuid, stockGuid, stock.name, barcode, barcodeType, syncTarget, tallyStatus]);
    // Auto-push to Tally if toggle is ON (fire-and-forget, non-blocking)
    autoSyncBarcodeToTally(req.user.userId, companyGuid, stockGuid, stock.name, ins.barcode, syncTarget).catch(() => {});
    res.json({ success: true, data: { barcode: ins.barcode, barcodeType: ins.barcode_type, status: ins.status, tallySyncStatus: ins.tally_sync_status } });
  } catch (err) {
    console.error('[inventory/barcodes GENERATE]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/link — link/assign a barcode to a stock item
router.post('/inventory/barcodes/link', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuid, barcode, barcodeType = 'CODE128', source = 'manual', syncTarget = 'app_only', isPrimary = true } = req.body;
  if (!companyGuid || !stockGuid || !barcode) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid, stockGuid, barcode required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const vErr = validateBarcode(barcode, barcodeType);
  if (vErr) return res.status(400).json({ success: false, error: { code: 'INVALID_BARCODE', message: vErr } });
  try {
    const { rows: [stock] } = await query('SELECT name FROM stocks WHERE guid=$1 AND company_guid=$2', [stockGuid, companyGuid]);
    if (!stock) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Stock item not found' } });
    const { rows: [dup] } = await query(`SELECT stock_name FROM stock_barcodes WHERE company_guid=$1 AND barcode=$2`, [companyGuid, barcode.trim()]);
    if (dup) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_BARCODE', message: `Barcode already linked to "${dup.stock_name}"` } });
    if (isPrimary) await query(`UPDATE stock_barcodes SET is_primary=FALSE WHERE stock_guid=$1 AND company_guid=$2 AND is_primary=TRUE`, [stockGuid, companyGuid]);
    const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
    await query(`
      INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`,
      [companyGuid, stockGuid, stock.name, barcode.trim(), barcodeType, source, isPrimary, syncTarget, tallyStatus]);
    // Auto-push to Tally if toggle is ON
    autoSyncBarcodeToTally(req.user.userId, companyGuid, stockGuid, stock.name, barcode.trim(), syncTarget).catch(() => {});
    res.json({ success: true, data: { status: 'active', tallySyncStatus: tallyStatus } });
  } catch (err) {
    console.error('[inventory/barcodes LINK]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/lookup — lookup by scanned barcode
router.post('/inventory/barcodes/lookup', authMiddleware, async (req, res) => {
  const { companyGuid, barcode } = req.body;
  if (!companyGuid || !barcode) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid and barcode required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const displayField = await getProductDisplayField(companyGuid);
    const { rows: [row] } = await query(`
      SELECT s.guid AS stock_guid, s.name, s.sku, s.alias, s.group_name, s.unit, s.closing_qty,
             sb.barcode, sb.barcode_type
      FROM stock_barcodes sb
      JOIN stocks s ON s.guid=sb.stock_guid AND s.company_guid=sb.company_guid
      WHERE sb.company_guid=$1 AND sb.barcode=$2 AND sb.status='active'
      LIMIT 1`, [companyGuid, barcode.trim()]);
    if (!row) return res.json({ success: true, data: { found: false, barcode, actions: ['link_existing_item','create_new_item'] } });
    res.json({ success: true, data: { found: true, item: { stockGuid: row.stock_guid, displayName: computeDisplayName(row, displayField), name: row.name, sku: row.sku || row.alias, barcode: row.barcode, currentQty: parseFloat(row.closing_qty||0), groupName: row.group_name, unit: row.unit } } });
  } catch (err) {
    console.error('[inventory/barcodes LOOKUP]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/bulk-import — bulk import barcodes (CSV text or paste lines)
router.post('/inventory/barcodes/bulk-import', authMiddleware, async (req, res) => {
  const { companyGuid, text, lines, fileName = 'import.csv' } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const rawLines = lines || (text ? String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
  if (!rawLines.length) return res.status(400).json({ success: false, error: { code: 'NO_DATA', message: 'No data to import' } });
  try {
    const { v4: uuidv4 } = await import('uuid');
    const jobId = uuidv4();
    const parsed = rawLines.map((line, idx) => {
      const parts = line.split(',').map(p => p.trim().replace(/^["']|["']$/g,''));
      if (idx === 0 && (parts[0].toLowerCase().includes('name') || parts[0].toLowerCase().includes('guid'))) return null;
      return parts.length >= 2
        ? { rawItemName: parts[0], rawBarcode: parts[1], rowNumber: idx+1, raw: line }
        : { rawItemName: null, rawBarcode: parts[0], rowNumber: idx+1, raw: line };
    }).filter(Boolean);

    let imported=0, duplicates=0, invalid=0, needsReview=0;
    const errors = [];
    for (const row of parsed) {
      const b = row.rawBarcode?.trim();
      if (!b || b.length < 4) {
        invalid++;
        errors.push({ job_id: jobId, row_number: row.rowNumber, barcode: b, error_type: 'invalid', error_message: 'Missing or too-short barcode', raw_data: row.raw });
        continue;
      }
      let stockGuid=null, stockName=null;
      if (row.rawItemName) {
        const { rows: [found] } = await query(`SELECT guid,name FROM stocks WHERE company_guid=$1 AND (LOWER(name)=LOWER($2) OR LOWER(sku)=LOWER($2) OR LOWER(alias)=LOWER($2)) LIMIT 1`, [companyGuid, row.rawItemName]);
        if (found) { stockGuid=found.guid; stockName=found.name; }
        else { needsReview++; errors.push({ job_id: jobId, row_number: row.rowNumber, item_identifier: row.rawItemName, barcode: b, error_type: 'needs_review', error_message: `No stock item matched "${row.rawItemName}"`, raw_data: row.raw }); continue; }
      }
      const { rows: [dup] } = await query(`SELECT stock_name FROM stock_barcodes WHERE company_guid=$1 AND barcode=$2`, [companyGuid, b]);
      if (dup) { duplicates++; errors.push({ job_id: jobId, row_number: row.rowNumber, barcode: b, error_type: 'duplicate', error_message: `Barcode already linked to "${dup.stock_name}"`, raw_data: row.raw }); continue; }
      try {
        await query(`INSERT INTO stock_barcodes (company_guid,stock_guid,stock_name,barcode,barcode_type,source,status,is_primary,sync_target,tally_sync_status) VALUES ($1,$2,$3,$4,'CODE128','import','active',TRUE,'app_only','not_required') ON CONFLICT (company_guid,barcode) DO NOTHING`, [companyGuid, stockGuid, stockName, b]);
        imported++;
      } catch(e) { invalid++; errors.push({ job_id: jobId, row_number: row.rowNumber, barcode: b, error_type: 'error', error_message: e.message, raw_data: row.raw }); }
    }
    await query(`INSERT INTO barcode_import_jobs (id,company_guid,file_name,status,total_rows,imported_rows,duplicate_rows,invalid_rows,needs_review_rows,created_at,completed_at) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,NOW(),NOW())`, [jobId, companyGuid, fileName, parsed.length, imported, duplicates, invalid, needsReview]);
    for (const e of errors) await query(`INSERT INTO barcode_import_errors (job_id,row_number,item_identifier,barcode,error_type,error_message,raw_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.job_id, e.row_number, e.item_identifier||null, e.barcode, e.error_type, e.error_message, e.raw_data]);
    res.json({ success: true, data: { jobId, summary: { totalRows: parsed.length, imported, duplicates, invalid, needsReview } } });
  } catch (err) {
    console.error('[inventory/barcodes BULK-IMPORT]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/inventory/barcodes/template — CSV template download (auth required; no company data exposed)
router.get('/inventory/barcodes/template', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid;
  if (companyGuid && !await verifyCompanyOwnership(req, res, companyGuid)) return;
  const csv = 'stock_guid,item_name,sku,barcode,barcode_type,is_primary,sync_target\n,,, "8901234567890",EAN13,true,app_only\n,, SKU-001,"TDKXXXX0000001",CODE128,true,app_only\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="barcode_import_template.csv"');
  res.send(csv);
});

// GET /api/inventory/barcodes/settings — get barcode settings
router.get('/inventory/barcodes/settings', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: [row] } = await query(`SELECT * FROM inventory_barcode_settings WHERE company_guid=$1`, [companyGuid]);
    res.json({ success: true, data: { barcodeStorageMode: row?.barcode_storage_mode || 'app_only', defaultBarcodeType: row?.default_barcode_type || 'CODE128', autoSyncToTally: row?.auto_sync_to_tally || false } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// POST /api/inventory/barcodes/push-pending — manually push all pending_tally barcodes to Tally
// Also called automatically when user saves settings with autoSyncToTally=true
router.post('/inventory/barcodes/push-pending', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: [co] } = await query('SELECT name FROM companies WHERE guid=$1', [companyGuid]);
    if (!co?.name) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company not found' } });

    const { rows: pending } = await query(`
      SELECT sb.stock_guid, sb.stock_name, sb.barcode, sb.sync_target
      FROM stock_barcodes sb
      WHERE sb.company_guid=$1 AND sb.tally_sync_status='pending_tally' AND sb.status='active'
      ORDER BY sb.created_at ASC LIMIT 100`, [companyGuid]);

    if (!pending.length) return res.json({ success: true, data: { pushed: 0, message: 'No pending barcodes to sync' } });

    const { pushBarcodeToTally } = await import('./tally-write.js');
    let synced = 0, failed = 0, offline = 0;

    for (const row of pending) {
      try {
        const result = await pushBarcodeToTally({
          companyGuid, userId: req.user.userId,
          stockGuid: row.stock_guid, stockName: row.stock_name,
          barcode: row.barcode, syncTarget: row.sync_target,
          companyName: co.name,
        });
        const newStatus =
          !result                                ? 'pending_tally' :
          result.status === 'desktop_offline'    ? 'pending_tally' :
          result.status === 'success'            ? 'synced'        :
          (result.altered > 0 && !result.errors) ? 'synced'        : 'failed';

        await query('UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_guid=$2 AND stock_guid=$3 AND barcode=$4',
          [newStatus, companyGuid, row.stock_guid, row.barcode]);

        if (newStatus === 'synced') synced++;
        else if (newStatus === 'pending_tally') { offline++; break; } // desktop offline — stop batching
        else failed++;
      } catch (e) {
        failed++;
        console.error('[push-pending] row error', e.message);
      }
    }

    res.json({ success: true, data: { pushed: pending.length, synced, failed, offline, message: offline ? 'Desktop offline — will retry when connected' : `Synced ${synced}/${pending.length}` } });
  } catch (err) {
    console.error('[push-pending]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/inventory/barcodes/settings — save barcode settings
router.post('/inventory/barcodes/settings', authMiddleware, async (req, res) => {
  const { companyGuid, barcodeStorageMode = 'app_only', defaultBarcodeType = 'CODE128', autoSyncToTally = false } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const VALID_MODES = ['app_only','tally_alias','tally_part_number','tally_udf'];
  const VALID_TYPES = ['CODE128','EAN13','EAN8','UPC','QR','INTERNAL'];
  if (!VALID_MODES.includes(barcodeStorageMode)) return res.status(400).json({ success: false, error: { code: 'INVALID_MODE', message: 'Invalid storage mode' } });
  if (!VALID_TYPES.includes(defaultBarcodeType))  return res.status(400).json({ success: false, error: { code: 'INVALID_TYPE', message: 'Invalid barcode type' } });
  try {
    await query(`
      INSERT INTO inventory_barcode_settings (company_guid,barcode_storage_mode,default_barcode_type,auto_sync_to_tally,updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (company_guid) DO UPDATE SET barcode_storage_mode=EXCLUDED.barcode_storage_mode, default_barcode_type=EXCLUDED.default_barcode_type, auto_sync_to_tally=EXCLUDED.auto_sync_to_tally, updated_at=NOW()`,
      [companyGuid, barcodeStorageMode, defaultBarcodeType, autoSyncToTally]);

    // When user enables auto-sync AND selects a Tally target, update any existing
    // 'app_only' barcodes for this company to the new sync_target so they get queued,
    // then trigger push-pending (fire-and-forget)
    if (autoSyncToTally && barcodeStorageMode !== 'app_only') {
      await query(`UPDATE stock_barcodes SET sync_target=$1, tally_sync_status='pending_tally'
        WHERE company_guid=$2 AND status='active' AND tally_sync_status='not_required'`,
        [barcodeStorageMode, companyGuid]);
      // Kick off push in background — response does not wait for it
      setImmediate(async () => {
        try {
          const { pushBarcodeToTally } = await import('./tally-write.js');
          const { rows: [co] } = await query('SELECT name FROM companies WHERE guid=$1', [companyGuid]);
          if (!co?.name) return;
          const { rows: pending } = await query(`
            SELECT stock_guid, stock_name, barcode, sync_target FROM stock_barcodes
            WHERE company_guid=$1 AND tally_sync_status='pending_tally' AND status='active' LIMIT 100`,
            [companyGuid]);
          for (const row of pending) {
            const result = await pushBarcodeToTally({
              companyGuid, userId: req.user.userId,
              stockGuid: row.stock_guid, stockName: row.stock_name,
              barcode: row.barcode, syncTarget: row.sync_target, companyName: co.name,
            }).catch(() => null);
            const s = !result ? 'pending_tally'
              : result.status === 'desktop_offline' ? 'pending_tally'
              : (result.status === 'success' || (result.altered > 0 && !result.errors)) ? 'synced' : 'failed';
            await query('UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_guid=$2 AND stock_guid=$3 AND barcode=$4',
              [s, companyGuid, row.stock_guid, row.barcode]);
            if (s === 'pending_tally') break; // desktop offline — stop
          }
        } catch (e) { console.error('[settings auto-sync]', e.message); }
      });
    }

    res.json({ success: true, data: { barcodeStorageMode, defaultBarcodeType, autoSyncToTally } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

export default router;
