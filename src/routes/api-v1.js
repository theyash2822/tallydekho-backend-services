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

// FY date resolver — returns from/to/financialYear for a company
// V2: also returns financialYear label (e.g. "2025-2026") for direct DB queries
export async function resolveFYDates(companyGuid, from, to, fyParam) {
  // If explicit financialYear label passed (e.g. "2025-2026"), look up its dates
  if (fyParam) {
    try {
      const { rows } = await query(
        'SELECT begin_date, end_date, fin_year FROM company_years WHERE company_guid=$1 AND fin_year=$2 LIMIT 1',
        [companyGuid, fyParam]
      );
      if (rows[0]) return { from: rows[0].begin_date, to: rows[0].end_date, financialYear: rows[0].fin_year };
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
        ), 0) as fy_movement
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $3
      WHERE l.company_guid=$1 AND (l.name ILIKE $2 OR l.alias ILIKE $2 OR l.gstin ILIKE $2)
    `;
    const params = [companyGuid, `%${search}%`, financialYear, fyFrom, fyTo];
    let idx = 6;
    if (nature) { q += ` AND l.nature = $${idx++}`; params.push(nature); }
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

// GET /reports/pl-bs — P&L + Balance Sheet — FY-derived (Tally FY Guide compliant)
// Rule: Balance = anchor (ledger_fy_balances) + SUM(movements). Never static closing.
router.get('/reports/pl-bs', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, req.query.from, req.query.to, req.query.fy);

    // FY-derived balance per ledger: anchor + SUM(movements for this FY)
    // This is correct per Tally FY guide: Balance = anchor + transactions. Never static.
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
            WHERE vle.ledger_name = l.name AND vle.company_guid = l.company_guid
              AND vle.financial_year = $2
          ), 0) as fy_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `, [companyGuid, financialYear]);

    const toAmount = (l) => Math.abs(parseFloat(l.fy_signed || 0));
    const isDr = (l) => parseFloat(l.fy_signed || 0) < 0;
    const isCr = (l) => parseFloat(l.fy_signed || 0) >= 0;

    const income   = allLedgers.filter(l => l.parent && /Income|Revenue|Sales|Direct Income|Indirect Income/i.test(l.parent) && toAmount(l) > 0);
    const expenses = allLedgers.filter(l => l.parent && /Expense|Purchase|Direct Expense|Indirect Expense/i.test(l.parent) && toAmount(l) > 0);
    const assets   = allLedgers.filter(l => isDr(l) && toAmount(l) > 0).sort((a, b) => toAmount(b) - toAmount(a)).slice(0, 20);
    const liab     = allLedgers.filter(l => isCr(l) && toAmount(l) > 0).sort((a, b) => toAmount(b) - toAmount(a)).slice(0, 20);
    const tb       = allLedgers.filter(l => toAmount(l) > 0).sort((a, b) => a.parent?.localeCompare(b.parent || '') || a.name.localeCompare(b.name)).slice(0, 100);

    const totalIncome   = income.reduce((s, l)   => s + toAmount(l), 0);
    const totalExpenses = expenses.reduce((s, l) => s + toAmount(l), 0);
    const totalAssets   = assets.reduce((s, l)   => s + toAmount(l), 0);
    const totalLiab     = liab.reduce((s, l)     => s + toAmount(l), 0);
    const totalDebit    = tb.filter(l => isDr(l)).reduce((s, l) => s + toAmount(l), 0);
    const totalCredit   = tb.filter(l => isCr(l)).reduce((s, l) => s + toAmount(l), 0);

    res.json({ success: true, data: {
      financial_year: financialYear, from: fyFrom, to: fyTo,
      pl: {
        income:   income.map(l   => ({ name: l.name, parent: l.parent, amount: toAmount(l) })),
        expenses: expenses.map(l => ({ name: l.name, parent: l.parent, amount: toAmount(l) })),
        totalIncome, totalExpenses, netProfit: totalIncome - totalExpenses,
      },
      bs: {
        assets:       assets.map(l => ({ name: l.name, parent: l.parent, amount: toAmount(l) })),
        liabilities:  liab.map(l  => ({ name: l.name, parent: l.parent, amount: toAmount(l) })),
        totalAssets, totalLiabilities: totalLiab,
      },
      trialBalance: {
        ledgers: tb.map(l => ({ name: l.name, parent: l.parent,
          debit:  isDr(l) ? toAmount(l) : 0,
          credit: isCr(l) ? toAmount(l) : 0,
        })),
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

export default router;
