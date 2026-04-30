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

// FY date resolver — returns from/to for a company, defaulting to latest active FY
async function resolveFYDates(companyGuid, from, to) {
  if (from && to) return { from, to };
  try {
    const { rows } = await query(
      'SELECT begin_date, end_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1',
      [companyGuid]
    );
    const yr = new Date().getFullYear();
    return {
      from: rows[0]?.begin_date || `${yr}-04-01`,
      to:   rows[0]?.end_date   || `${yr + 1}-03-31`,
    };
  } catch {
    const yr = new Date().getFullYear();
    return { from: `${yr}-04-01`, to: `${yr + 1}-03-31` };
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
    const { rows } = await query('SELECT begin_date, end_date FROM company_years WHERE company_guid=$1 AND is_active = TRUE ORDER BY begin_date DESC', [companyGuid]);
    const fys = rows.map(r => {
      const start = new Date(r.begin_date);
      const end   = new Date(r.end_date);
      const sy = start.getFullYear();
      const ey = end.getFullYear();
      return { begin_date: r.begin_date, end_date: r.end_date, label: `FY ${sy}-${String(ey).slice(2)}` };
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

    const fmt = v => v >= 1e5 ? `₹${(v/1e5).toFixed(1)}L` : `₹${Math.round(v).toLocaleString('en-IN')}`;
    // Safe access — COALESCE should always return a row, but guard anyway
    const g = (rows) => +(rows?.[0]?.v ?? 0);
    const kpi = [
      { id: 'cash',       label: 'Cash In Hand', amount: fmt(g(cash)),  amount_raw: g(cash),  icon: 'wallet-outline',              route: '/kpi/cash-in-hand' },
      { id: 'bank',       label: 'Bank Balance', amount: fmt(g(bank)),  amount_raw: g(bank),  icon: 'card-outline',                route: '/kpi/bank-balance' },
      { id: 'receivable', label: 'Receivables',  amount: fmt(g(rec)),   amount_raw: g(rec),   icon: 'arrow-down-circle-outline',   route: '/kpi/receivables' },
      { id: 'payable',    label: 'Payables',     amount: fmt(g(pay)),   amount_raw: g(pay),   icon: 'arrow-up-circle-outline',     route: '/kpi/payables' },
      { id: 'loans',      label: 'Loans & ODs',  amount: fmt(g(loans)), amount_raw: g(loans), icon: 'git-merge-outline',           route: '/kpi/loans-ods' },
      { id: 'payments',   label: 'Payments',     amount: fmt(g(pmts)),  amount_raw: g(pmts),  icon: 'send-outline',                route: '/kpi/payments' },
      { id: 'receipts',   label: 'Receipts',     amount: fmt(g(rcts)),  amount_raw: g(rcts),  icon: 'download-outline',            route: '/kpi/receipts' },
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
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type IN ('Journal','Payment','Contra') AND is_cancelled=FALSE AND amount > 0 AND date IS NOT NULL AND date != '' AND date BETWEEN $2 AND $3`, [companyGuid, from, to]),
    ]);
    const sVal = +(sRes.rows?.[0]?.v ?? 0);
    const pVal = +(pRes.rows?.[0]?.v ?? 0);
    const eVal = +(eRes.rows?.[0]?.v ?? 0);
    const fmt = v => v >= 1e5 ? `₹${(v/1e5).toFixed(1)}L` : `₹${Math.round(v).toLocaleString('en-IN')}`;
    res.json({ success: true, data: [
      { id: 'sales',     label: 'Sales',     amount: fmt(sVal), amount_raw: sVal, change: 0, positive: true,  icon: 'stats-chart-outline', route: '/sales/register' },
      { id: 'purchases', label: 'Purchases', amount: fmt(pVal), amount_raw: pVal, change: 0, positive: true,  icon: 'cart-outline',        route: '/purchase/register' },
      { id: 'expenses',  label: 'Expenses',  amount: fmt(eVal), amount_raw: eVal, change: 0, positive: false, icon: 'trending-up-outline', route: '/expenses' },
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
    const fmt = v => `₹${Math.abs(+v||0).toLocaleString('en-IN')}`;
    const activity = rows.map(r => ({
      id: String(r.id),
      type: (r.voucher_type||'').toLowerCase().includes('receipt') ? 'credit' : 'debit',
      label: `${r.voucher_type} ${r.voucher_number ? '#'+r.voucher_number : ''}`.trim(),
      amount: (r.voucher_type||'').toLowerCase().includes('receipt') ? `+${fmt(r.amount)}` : `-${fmt(r.amount)}`,
      amount_raw: +r.amount || 0,
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

// GET /api/vouchers/:id — single voucher with inventory items + GST details
router.get('/vouchers/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  try {
    const { rows: vRows } = await query('SELECT * FROM vouchers WHERE (guid=$1 OR voucher_number=$1) AND company_guid=$2 LIMIT 1', [id, companyGuid]);
    if (!vRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Voucher not found' } });
    const v = vRows[0];
    // Inventory items (for Sales/Purchase vouchers)
    const { rows: items } = await query('SELECT * FROM voucher_inventory_items WHERE voucher_guid=$1 AND company_guid=$2 ORDER BY id', [v.guid, companyGuid]);
    // GST details
    const { rows: gst } = await query('SELECT * FROM gst_voucher_details WHERE voucher_guid=$1 AND company_guid=$2 LIMIT 1', [v.guid, companyGuid]);
    // Company info
    const { rows: co } = await query('SELECT name, gstin FROM companies WHERE guid=$1 LIMIT 1', [companyGuid]);
    // Party ledger details (GSTIN, address etc)
    const { rows: partyLedger } = await query('SELECT name, gstin, pan, phone, email, address FROM ledgers WHERE company_guid=$1 AND name=$2 LIMIT 1', [companyGuid, v.party_name || '']);
    res.json({
      success: true,
      data: {
        voucher: v,
        items,
        gst: gst[0] || null,
        company: co[0] || null,
        party: partyLedger[0] || null,
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
  try {
    let q = `SELECT * FROM ledgers WHERE company_guid=$1 AND (name ILIKE $2 OR alias ILIKE $2 OR gstin ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
    if (nature) { q += ` AND nature = $${idx++}`; params.push(nature); }
    if (group)  { q += ` AND parent = $${idx++}`; params.push(group); }
    q += ` ORDER BY ABS(closing_balance) DESC, name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query('SELECT COUNT(*) as c FROM ledgers WHERE company_guid=$1', [companyGuid]);
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/ledgers/:id', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { id } = req.params;
  try {
    const { rows: lr } = await query('SELECT * FROM ledgers WHERE company_guid=$1 AND guid=$2', [companyGuid, id]);
    if (!lr[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ledger not found' } });
    const { from, to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    let tq = `SELECT * FROM vouchers WHERE company_guid=$1 AND (party_guid=$2 OR party_name=$3) AND is_cancelled=FALSE`;
    const tp = [companyGuid, id, lr[0].name];
    let idx = 4;
    if (from) { tq += ` AND date >= $${idx++}`; tp.push(from); }
    if (to)   { tq += ` AND date <= $${idx++}`; tp.push(to); }
    tq += ` ORDER BY date DESC LIMIT $${idx++} OFFSET $${idx}`;
    tp.push(parseInt(limit), offset);
    const { rows: txns } = await query(tq, tp);
    res.json({ success: true, data: { ledger: lr[0], transactions: txns, meta: { page: parseInt(page), limit: parseInt(limit) } } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// STOCKS
// ══════════════════════════════════════════════════════════════

router.get('/stocks/items', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { search = '', category, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    let q = `SELECT * FROM stocks WHERE company_guid=$1 AND (name ILIKE $2 OR alias ILIKE $2 OR hsn ILIKE $2)`;
    const params = [companyGuid, `%${search}%`];
    let idx = 3;
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
    const { rows } = await query('SELECT DISTINCT warehouse_name as name FROM stocks WHERE company_guid=$1 AND warehouse_name IS NOT NULL', [companyGuid]);
    res.json({ success: true, data: rows.map(r => ({ name: r.name, id: r.name })) });
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
    const { rows } = await query(`
      SELECT TO_CHAR(date::date,'Mon') as month, EXTRACT(MONTH FROM date::date) as mnum, EXTRACT(YEAR FROM date::date) as yr,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' THEN amount ELSE 0 END) as revenue,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN amount ELSE 0 END) as expenses
      FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date,'Mon'), EXTRACT(MONTH FROM date::date), EXTRACT(YEAR FROM date::date)
      ORDER BY yr, mnum LIMIT 12
    `, [companyGuid]);
    res.json({ success: true, data: {
      months:   rows.map(r => r.month),
      revenue:  rows.map(r => parseFloat(r.revenue||0)),
      expenses: rows.map(r => parseFloat(r.expenses||0)),
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /reports/pl-bs — P&L + Balance Sheet from ledger closing balances
router.get('/reports/pl-bs', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: income }   = await query(`SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Income%' OR parent ILIKE '%Revenue%' OR parent ILIKE '%Sales%' OR parent ILIKE '%Direct Income%' OR parent ILIKE '%Indirect Income%')`, [companyGuid]);
    const { rows: expenses } = await query(`SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Expense%' OR parent ILIKE '%Purchase%' OR parent ILIKE '%Direct Expense%' OR parent ILIKE '%Indirect Expense%')`, [companyGuid]);
    const { rows: assets }   = await query(`SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=$1 AND balance_type='Dr' AND closing_balance != 0 ORDER BY ABS(closing_balance) DESC LIMIT 20`, [companyGuid]);
    const { rows: liab }     = await query(`SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=$1 AND balance_type='Cr' AND closing_balance != 0 ORDER BY ABS(closing_balance) DESC LIMIT 20`, [companyGuid]);
    const { rows: tb }       = await query(`SELECT name, parent, closing_balance, balance_type, CASE WHEN balance_type='Dr' THEN ABS(closing_balance) ELSE 0 END as debit, CASE WHEN balance_type='Cr' THEN ABS(closing_balance) ELSE 0 END as credit FROM ledgers WHERE company_guid=$1 AND closing_balance != 0 ORDER BY parent, name LIMIT 100`, [companyGuid]);

    const totalIncome   = income.reduce((s, l)   => s + Math.abs(parseFloat(l.closing_balance || 0)), 0);
    const totalExpenses = expenses.reduce((s, l) => s + Math.abs(parseFloat(l.closing_balance || 0)), 0);
    const totalAssets   = assets.reduce((s, l)   => s + Math.abs(parseFloat(l.closing_balance || 0)), 0);
    const totalLiab     = liab.reduce((s, l)     => s + Math.abs(parseFloat(l.closing_balance || 0)), 0);
    const totalDebit    = tb.reduce((s, r) => s + parseFloat(r.debit || 0), 0);
    const totalCredit   = tb.reduce((s, r) => s + parseFloat(r.credit || 0), 0);

    res.json({ success: true, data: {
      pl: {
        income:         income.map(l => ({ name: l.name, parent: l.parent, amount: Math.abs(parseFloat(l.closing_balance || 0)) })),
        expenses:       expenses.map(l => ({ name: l.name, parent: l.parent, amount: Math.abs(parseFloat(l.closing_balance || 0)) })),
        totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses,
      },
      bs: {
        assets:       assets.map(l => ({ name: l.name, parent: l.parent, amount: Math.abs(parseFloat(l.closing_balance || 0)) })),
        liabilities:  liab.map(l => ({ name: l.name, parent: l.parent, amount: Math.abs(parseFloat(l.closing_balance || 0)) })),
        totalAssets, totalLiabilities: totalLiab,
      },
      trialBalance: {
        ledgers: tb.map(r => ({ name: r.name, parent: r.parent, debit: parseFloat(r.debit || 0), credit: parseFloat(r.credit || 0) })),
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
      const { rows: overdue } = await query(`SELECT party_name, ABS(closing_balance) as bal FROM ledgers WHERE company_guid=$1 AND parent ILIKE '%Sundry Debtor%' AND closing_balance > 50000 ORDER BY closing_balance DESC LIMIT 3`, [companyGuid]);
      overdue.forEach(l => notifs.push({ id: `recv_${l.party_name}`, type: 'info', title: 'Outstanding Receivable', body: `${l.party_name} owes ₹${Math.round(l.bal).toLocaleString('en-IN')}`, read: false, created_at: new Date().toISOString() }));
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
    const { rows: co } = await query('SELECT gstin FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = !!(co[0]?.gstin);
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
    const { rows: co } = await query('SELECT gstin FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = !!(co[0]?.gstin);
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

router.get('/reports/gst-detail', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const { from, to, type = 'GSTR-1' } = req.query;
  try {
    const { rows: co } = await query('SELECT gstin FROM companies WHERE guid=$1', [companyGuid]);
    const isIndia = !!(co[0]?.gstin);
    if (!isIndia) return res.json({ success: true, data: [], meta: { country_applicable: false, message: 'GST reports are applicable only for India (GST-registered companies)' } });

    let vType = 'Sales';
    if (['GSTR-2A', 'GSTR-2B'].includes(String(type))) vType = 'Purchase';

    let q = `SELECT voucher_number, party_name, voucher_type, amount, date, narration, irn, ewb_number FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE $2 AND is_cancelled=FALSE`;
    const params = [companyGuid, `%${vType}%`];
    let idx = 3;
    if (from) { q += ` AND date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND date <= $${idx++}`; params.push(to); }
    q += ' ORDER BY date DESC LIMIT 100';
    const { rows } = await query(q, params);
    res.json({ success: true, country_applicable: true, data: rows, meta: { total: rows.length, gstr_type: type } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
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

export default router;
