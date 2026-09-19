// ============================================================
// TallyDekho — /api/* routes (new mobile V4 spec)
// These are thin adapters over the existing /app/* logic,
// translating response shapes to match the new API spec.
// ============================================================

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { resolveWorkspaceMiddleware } from '../middleware/workspaceContext.js';
import {
  createDemoEntry,
  listDemoEntries,
  deleteDemoEntry,
  clearDemoEntries,
  toMyEntriesRow,
} from '../services/demoSimulatedEntryService.js';
import { pairDeviceToWorkspace, BindingError, unpairDevice } from '../services/deviceBinding.js';
import workspaceApi from './workspaceApi.js';
import { ensurePersonalWorkspace, getMemberScopes } from '../services/workspaceService.js';
import { loadMembership } from '../services/authorizationService.js';
import { buildStockDashboardInsights } from '../utils/stockDashboardInsights.js';
import { getUserPairingHints } from '../services/userPairingHints.js';
import { sendWhatsAppOTP, getRegion } from '../services/whatsapp.js';
import { sendPaymentReminder } from '../services/notifications.js';
import { sendOTPEmail } from '../services/email.js';
import { getGstTabsForVoucher, getClassificationReason } from '../utils/gstClassifier.js';
import { generateIRN } from '../utils/irnGenerator.js';
import { generateEWB } from '../utils/ewbGenerator.js';
import { resolveCreditNoteContext } from '../utils/creditNoteContext.js';
import { resolveDebitNoteContext } from '../utils/debitNoteContext.js';
import { buildGroupParentMap, inferLedgerNature } from '../utils/ledgerNature.js';
import { buildLoansOdsPayload } from '../modules/loans-ods/loansOdsService.js';
import { buildArApPayload } from '../modules/ar-ap/arApService.js';
import { buildPaymentReceiptPayload } from '../modules/kpi/paymentReceiptService.js';
import { buildCashInHandPayload, buildBankBalancePayload } from '../modules/kpi/cashBankService.js';
import { computeTrendPct, addDays } from '../modules/kpi/trendUtil.js';
import { listCostCentresForCompany } from '../services/costCentreListService.js';
import {
  resolveVoucherListParty,
} from '../utils/resolveVoucherListParty.js';
import {
  enrichNotification,
  stockNotification,
  receivableNotification,
  complianceNotification,
  invoiceNotification,
  parseReadNotificationIds,
} from '../utils/notificationAlerts.js';
import { verifyCompanyAccess, maskIfNeeded } from '../middleware/companyAccess.js';
import { resolveViewCapability } from '../middleware/viewCapability.js';
import { requireResolvedCompanyId } from '../utils/companyOwnership.js';
import { devOtpSuffix } from '../utils/otpLogging.js';

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

// After verifyCompanyAccess sets req.authz.masking, mask JSON responses
router.use((req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (req.authz?.masking) {
      try {
        return origJson(maskIfNeeded(req, body));
      } catch {
        return origJson(body);
      }
    }
    return origJson(body);
  };
  next();
});

router.use(workspaceApi);
const makeOtp = () => String(Math.floor(1000 + Math.random() * 9000));
const now = () => Math.floor(Date.now() / 1000);

// ─── Geo masters (Tally country / state-emirate-province) ───────────────────
// Public to authenticated users; not company-scoped (global Tally spellings).
router.get('/geo/countries', authMiddleware, async (_req, res) => {
  try {
    const { rows } = await query(
      `SELECT name, referred_as, division_label
       FROM geo_countries
       ORDER BY CASE WHEN name = 'India' THEN 0 ELSE 1 END, name ASC`
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/geo/states', authMiddleware, async (req, res) => {
  try {
    const country = String(req.query.country || '').trim();
    if (!country) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_COUNTRY', message: 'country query required' } });
    }
    const { rows: co } = await query(
      `SELECT name, referred_as, division_label FROM geo_countries WHERE name = $1`,
      [country]
    );
    if (!co.length) {
      return res.json({ success: true, data: [], meta: { country, referred_as: null, division_label: 'State' } });
    }
    const { rows } = await query(
      `SELECT state_name AS name FROM geo_states WHERE country_name = $1 ORDER BY state_name ASC`,
      [country]
    );
    res.json({
      success: true,
      data: rows,
      meta: {
        country: co[0].name,
        referred_as: co[0].referred_as,
        division_label: co[0].division_label || 'State',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── Product Display Name helpers ───────────────────────────────────

// Fetch the company's product_display_field setting. Returns 'name' if not set.
async function getProductDisplayField(companyId) {
  try {
    const { rows } = await query(
      `SELECT product_display_field FROM company_inventory_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
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

// Fail-closed company access (workspace + membership + company/FY scope + view capability).
async function verifyCompanyOwnership(req, res, companyGuid, capabilityOverride = undefined) {
  const fy = req.body?.fy || req.body?.financialYear || req.query?.fy || null;
  const mapped = capabilityOverride !== undefined
    ? capabilityOverride
    : resolveViewCapability(req);
  if (capabilityOverride === undefined && mapped == null) {
    res.status(403).json({
      success: false,
      error: { code: 'CAPABILITY_REQUIRED', message: 'Capability required for this route' },
    });
    return false;
  }
  const capability = mapped === '__scope_only__' ? null : mapped;
  return verifyCompanyAccess(req, res, companyGuid, {
    capability,
    financialYear: fy,
    responseShape: 'api-v1',
  });
}

// FY date resolver — returns from/to/financialYear for a company
// V2: also returns financialYear label (e.g. "2025-2026") for direct DB queries
export function normalizeFinYearLabel(fyParam) {
  if (!fyParam) return null;
  let s = String(fyParam).trim().replace(/^FY\s*/i, '');
  const full = s.match(/^(\d{4})-(\d{4})$/);
  if (full) return `${full[1]}-${full[2]}`;
  const short = s.match(/^(\d{4})-(\d{2})$/);
  if (short) {
    const y1 = parseInt(short[1], 10);
    const y2 = parseInt(short[2], 10);
    const endYear = y2 >= 100 ? y2 : (y2 < 50 ? 2000 + y2 : 1900 + y2);
    return endYear === y1 + 1 ? `${y1}-${endYear}` : `${y1}-${y1 + 1}`;
  }
  return s;
}

/** FY label variants stored in Tally sync (2024-2025 vs 2024-25) */
function fyLikePrefix(financialYear) {
  const fy = normalizeFinYearLabel(financialYear) || financialYear;
  return `${String(fy).slice(0, 4)}-%`;
}

function sqlLfbJoin(alias = 'lfb', fyIdx, prefixIdx) {
  return `(${alias}.financial_year = $${fyIdx} OR ${alias}.financial_year LIKE $${prefixIdx})`;
}

export async function resolveFYDates(companyId, from, to, fyParam) {
  const normalizedFy = normalizeFinYearLabel(fyParam);
  // If explicit financialYear label passed (e.g. "2025-2026"), look up its dates
  // If BOTH fy + from/to are passed: use custom date range but keep FY label for stock/ledger lookups
  if (normalizedFy) {
    try {
      let { rows } = await query(
        'SELECT begin_date, end_date, fin_year FROM company_years WHERE company_id=$1 AND fin_year=$2 LIMIT 1',
        [companyId, normalizedFy]
      );
      if (!rows[0]) {
        const startYear = normalizedFy.slice(0, 4);
        ({ rows } = await query(
          `SELECT begin_date, end_date, fin_year FROM company_years
           WHERE company_id=$1 AND fin_year LIKE $2
           ORDER BY begin_date DESC LIMIT 1`,
          [companyId, `${startYear}-%`]
        ));
      }
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
    try {
      const { rows } = await query(
        `SELECT fin_year, begin_date, end_date FROM company_years
         WHERE company_id=$1 AND begin_date::date <= $3::date AND end_date::date >= $2::date
         ORDER BY begin_date DESC LIMIT 1`,
        [companyId, from, to]
      );
      if (rows[0]) {
        return { from, to, financialYear: rows[0].fin_year };
      }
    } catch {}
    const yr = parseInt(String(from).slice(0, 4), 10);
    return { from, to, financialYear: `${yr}-${yr + 1}` };
  }
  try {
    const { rows } = await query(
      'SELECT begin_date, end_date, fin_year FROM company_years WHERE company_id=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1',
      [companyId]
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

  const BYPASS_NUMBERS = [];
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
    console.log(`[API OTP] Sending to ${countryCode}${cleanMobile} | Region: ${region}${isBypass ? ' (BYPASS)' : ''}${devOtpSuffix(otp)}`);

    const waResult = isBypass ? { success: true } : await sendWhatsAppOTP(countryCode, cleanMobile, otp);

    const masked = `${countryCode} ${cleanMobile.slice(0, 2)}${'*'.repeat(cleanMobile.length - 4)}${cleanMobile.slice(-2)}`;
    const response = { success: true, data: { message: 'OTP sent via WhatsApp', expires_in: 300, masked_phone: masked } };
    if (process.env.NODE_ENV !== 'production') response.data.otp = otp;

    if (!waResult.success && !isBypass) {
      console.warn(`[API OTP] WhatsApp send failed${devOtpSuffix(otp)}`);
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

    // ── No 2FA — issue session-backed access token ──────────────────────────────
    const { createAuthSession } = await import('../services/authSessionService.js');
    const session = await createAuthSession(user.id, { mobile: cleanMobile, clientType: 'app' });
    const token = session.accessToken;
    await query('UPDATE users SET otp = NULL, otp_expires = NULL, updated_at = $1 WHERE id = $2', [now(), user.id]);

    const { isPaired, company } = await getUserPairingHints(user.id);

    const isNewUser = !user.name;
    console.log(`[API AUTH] Login: ${cleanMobile} | User: ${user.id} | Paired: ${isPaired} | New: ${isNewUser}`);

    try {
      await ensurePersonalWorkspace(user.id);
    } catch (wsErr) {
      console.warn('[API AUTH] workspace bootstrap skipped:', wsErr.message);
    }

    res.json({
      success: true,
      data: {
        is_new_user: isNewUser,
        requires_2fa: false,
        access_token: token,
        refresh_token: session.refreshToken,
        session_id: session.sessionId,
        expires_in: session.accessExpiresIn || '15m',
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

    // Generate a fresh session-backed token
    const { createAuthSession } = await import('../services/authSessionService.js');
    const session = await createAuthSession(user.id, { mobile: user.mobile, clientType: 'app' });
    const token = session.accessToken;

    try {
      await ensurePersonalWorkspace(user.id);
    } catch (wsErr) {
      console.warn('[API REGISTER] workspace bootstrap skipped:', wsErr.message);
    }

    res.status(201).json({
      success: true,
      data: {
        user: { id: user.id, name: user.name, phone: user.mobile, email: user.email || '', language: user.language },
        access_token: token,
        refresh_token: session.refreshToken,
        session_id: session.sessionId,
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

    const { isPaired, company } = await getUserPairingHints(user.id);

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
    if (pushToken) {
      await query('DELETE FROM push_tokens WHERE user_id=$1 AND token=$2', [req.user.userId, pushToken]).catch(() => {});
    }
    try {
      const { revokeSession, revokeAllSessionsForUser } = await import('../services/authSessionService.js');
      if (req.user.sessionId) {
        await revokeSession(req.user.sessionId, req.user.userId);
      } else {
        await revokeAllSessionsForUser(req.user.userId);
      }
    } catch {
      /* session revoke best-effort */
    }
    res.json({ success: true, data: { message: 'Logged out successfully' } });
  } catch {
    res.json({ success: true, data: { message: 'Logged out' } });
  }
});

/** Rotate refresh → new access + refresh */
router.post('/auth/refresh', async (req, res) => {
  try {
    const refreshToken = req.body?.refresh_token || req.body?.refreshToken;
    if (!refreshToken) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'refresh_token required' } });
    }
    const { refreshAuthSession } = await import('../services/authSessionService.js');
    const session = await refreshAuthSession(refreshToken);
    res.json({
      success: true,
      data: {
        access_token: session.accessToken,
        refresh_token: session.refreshToken,
        session_id: session.sessionId,
        expires_in: session.accessExpiresIn,
      },
    });
  } catch (err) {
    res.status(err.httpStatus || 401).json({
      success: false,
      error: { code: err.code || 'SESSION_INVALID', message: err.message || 'Refresh failed' },
    });
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

// POST /api/tally-sync/pair — DISABLED (Phase F). Use POST /workspaces/:id/tally/pair
router.post('/tally-sync/pair', authMiddleware, async (_req, res) => {
  console.warn('[LEGACY] POST /api/tally-sync/pair → 410');
  return res.status(410).json({
    success: false,
    error: {
      code: 'PAIRING_API_DEPRECATED',
      message: 'Use POST /api/workspaces/:workspaceId/tally/pair',
    },
  });
});

/**
 * Headline company for the legacy tally-sync status payload.
 *
 * Demo-ness comes from `companies.is_demo` only. Classifying by a `demo%` name
 * prefix used to hide a real Tally company called e.g. "Demo Traders" from a
 * paired workspace and surface it as the Demo fixture when unpaired.
 */
async function resolveStatusCompany(workspaceId, pairingStatus) {
  const { isDemoEligible, CANONICAL_DEMO_GUID } = await import('../services/demoDataService.js');
  if (isDemoEligible(pairingStatus)) {
    // The canonical Demo lives in the reserved system workspace and is
    // projected into every unpaired workspace.
    const { rows } = await query(
      `SELECT guid, name, gstin FROM companies
       WHERE guid = $1 AND is_demo = TRUE LIMIT 1`,
      [CANONICAL_DEMO_GUID]
    );
    if (!rows[0]) return null;
    return { guid: rows[0].guid, name: rows[0].name, gstin: rows[0].gstin || null };
  }
  // Paired in any state — including Desktop offline — means real books only.
  const { rows } = await query(
    `SELECT guid, name, gstin FROM companies
     WHERE workspace_id = $1 AND is_active = TRUE AND COALESCE(is_demo, FALSE) = FALSE
     ORDER BY synced_at DESC NULLS LAST, name ASC
     LIMIT 1`,
    [workspaceId]
  );
  if (!rows[0]) return null;
  return { guid: rows[0].guid, name: rows[0].name, gstin: rows[0].gstin || null };
}

// GET /api/tally-sync/status
// Workspace-aware: invited members inherit CONNECTED status from the workspace desktop,
// not from their personal device pairing.
router.get('/tally-sync/status', authMiddleware, async (req, res) => {
  try {
    const workspaceId = req.workspaceId
      || req.headers['x-workspace-id']
      || req.headers['X-Workspace-Id']
      || null;

    const ONLINE_THRESHOLD_SECS = 5 * 60;
    const nowSecs = Math.floor(Date.now() / 1000);

    // Prefer workspace binding when X-Workspace-Id is present and caller is an ACTIVE member
    if (workspaceId) {
      const { rows: mem } = await query(
        `SELECT 1 FROM workspace_memberships
         WHERE workspace_id = $1 AND user_id = $2 AND status = 'ACTIVE' LIMIT 1`,
        [workspaceId, req.user.userId]
      );
      if (mem[0]) {
        const { rows: wsRows } = await query(
          `SELECT tally_connection FROM workspaces WHERE id = $1 LIMIT 1`,
          [workspaceId]
        );
        const { rows: binding } = await query(
          `SELECT connection_status, active_device_id FROM workspace_tally_bindings
           WHERE workspace_id = $1 LIMIT 1`,
          [workspaceId]
        );
        const status = binding[0]?.connection_status || wsRows[0]?.tally_connection || 'UNPAIRED';
        const isPaired = status === 'CONNECTED' || status === 'RECONNECTING';
        let device = null;
        let desktopOnline = false;
        const deviceId = binding[0]?.active_device_id;
        if (deviceId) {
          const { rows: devices } = await query(
            `SELECT device_id, name, last_seen FROM devices WHERE device_id = $1 AND paired = TRUE LIMIT 1`,
            [deviceId]
          );
          device = devices[0] || null;
          const lastSeenSecs = Number(device?.last_seen);
          desktopOnline = !!(device && Number.isFinite(lastSeenSecs) && lastSeenSecs > 0
            && (nowSecs - lastSeenSecs) < ONLINE_THRESHOLD_SECS);
        }
        const company = await resolveStatusCompany(workspaceId, status);
        const lastSeenSecs = Number(device?.last_seen);
        return res.json({
          success: true,
          data: {
            is_paired: isPaired,
            desktop_online: !!desktopOnline,
            workspace_status: status,
            device: device ? {
              id: device.device_id,
              name: device.name || 'Desktop',
              last_seen: Number.isFinite(lastSeenSecs) ? lastSeenSecs : null,
            } : null,
            company,
          },
        });
      }
    }

    // No workspace header: resolve Personal Workspace binding (not devices.user_id authority)
    try {
      const { ensurePersonalWorkspace } = await import('../services/workspaceService.js');
      const { getConnectionStatus, buildTallyStatusPayload } = await import('../services/workspacePairingService.js');
      const personal = await ensurePersonalWorkspace(req.user.userId);
      if (personal?.id) {
        const status = await getConnectionStatus(personal.id);
        const payload = await buildTallyStatusPayload(personal.id, req.user.userId);
        const isPaired = status === 'CONNECTED' || status === 'RECONNECTING';
        const company = await resolveStatusCompany(personal.id, status);
        return res.json({
          success: true,
          data: {
            is_paired: isPaired,
            desktop_online: !!payload.desktopOnline,
            workspace_status: status,
            device: payload.activeDeviceId
              ? { id: payload.activeDeviceId, name: 'Desktop', last_seen: payload.lastHeartbeatAt || null }
              : null,
            company,
            canPair: payload.canPair,
            canUnpair: payload.canUnpair,
          },
        });
      }
    } catch (fallbackErr) {
      console.warn('[tally-sync/status] personal workspace fallback failed:', fallbackErr.message);
    }

    return res.json({
      success: true,
      data: {
        is_paired: false,
        desktop_online: false,
        workspace_status: 'UNPAIRED',
        device: null,
        company: null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch sync status' } });
  }
});

// POST /api/tally-sync/unpair — DISABLED (Phase F). Use POST /workspaces/:id/tally/unpair
router.post('/tally-sync/unpair', authMiddleware, async (_req, res) => {
  console.warn('[LEGACY] POST /api/tally-sync/unpair → 410');
  return res.status(410).json({
    success: false,
    error: {
      code: 'PAIRING_API_DEPRECATED',
      message: 'Use POST /api/workspaces/:workspaceId/tally/unpair',
    },
  });
});

// POST /api/cost-centres — company cost centre masters (member scope UI)
router.post('/cost-centres', authMiddleware, async (req, res) => {
  const companyGuid = req.body?.companyGuid || req.query?.companyGuid;
  if (!companyGuid) {
    return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'companyGuid required' } });
  }
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const rows = await listCostCentresForCompany(companyId);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/company/years — financial years for a company
router.get('/company/years', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query('SELECT fin_year, begin_date, end_date FROM company_years WHERE company_id=$1 AND is_active = TRUE ORDER BY begin_date DESC', [companyId]);
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

/** Filter company rows by membership company scope (ALL / SELECTED / NONE). */
async function filterCompaniesByScope(userId, workspaceId, companies) {
  if (!workspaceId || !companies?.length) return companies || [];
  const membership = await loadMembership(userId, workspaceId);
  if (!membership) return [];
  if (membership.membership_type === 'OWNER') return companies;
  const scopes = await getMemberScopes(membership.id);
  const mode = scopes?.policy?.company_mode || 'NONE';
  if (mode === 'NONE') return [];
  if (mode === 'ALL') return companies;
  const allowed = new Set(scopes.companies || []);
  return companies.filter((c) => allowed.has(c.guid));
}

// GET /api/companies — workspace_id + membership + company scope (no companies.user_id)
router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const workspaceId = req.workspaceId
      || req.headers['x-workspace-id']
      || req.headers['X-Workspace-Id']
      || null;
    if (!workspaceId) {
      return res.status(403).json({
        success: false,
        error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'X-Workspace-Id required' },
      });
    }
    const membership = await loadMembership(req.user.userId, workspaceId);
    if (!membership || membership.status !== 'ACTIVE') {
      return res.status(403).json({
        success: false,
        error: { code: 'WORKSPACE_ACCESS_DENIED', message: 'Not a member of this workspace' },
      });
    }
    const { rows: bind } = await query(
      `SELECT connection_status FROM workspace_tally_bindings WHERE workspace_id = $1 LIMIT 1`,
      [workspaceId]
    );
    const { rows: ws } = await query(
      `SELECT tally_connection, owner_user_id FROM workspaces WHERE id = $1 LIMIT 1`,
      [workspaceId]
    );
    const pairingStatus = bind[0]?.connection_status || ws[0]?.tally_connection || 'UNPAIRED';
    if (String(pairingStatus).toUpperCase() !== 'CONNECTED' && ws[0]?.owner_user_id) {
      const { ensureDemoCompany } = await import('../services/demoDataService.js');
      await ensureDemoCompany(ws[0].owner_user_id, workspaceId).catch(() => {});
    }
    const { rows } = await query(
      `SELECT guid, name, gstin FROM companies
       WHERE workspace_id = $1 AND is_active = TRUE
       ORDER BY name ASC`,
      [workspaceId]
    );
    let scoped = await filterCompaniesByScope(req.user.userId, workspaceId, rows);
    const { filterCompaniesByPairingStatus } = await import('../services/demoDataService.js');
    scoped = filterCompaniesByPairingStatus(scoped, pairingStatus);
    res.json({
      success: true,
      data: scoped.map((c) => ({
        id: c.guid,
        guid: c.guid,
        name: c.name,
        gstin: c.gstin || null,
        active: true,
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch companies' } });
  }
});

const PRINT_PROFILE_FIELDS = [
  'gstin', 'pan', 'email', 'phone', 'jurisdiction', 'declaration_text',
  'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch', 'pdf_format', 'pdf_format_overrides',
];
const DEFAULT_PRINT_DECLARATION =
  'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.';

// GET /api/companies/:guid/print-profile
router.get('/companies/:guid/print-profile', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    const ok = await verifyCompanyAccess(req, res, guid, {
      capability: 'workspace.settings.view',
      responseShape: 'api-v1',
    });
    if (!ok) return;
    const { rows: companyRows } = await query(
      'SELECT guid, gstin, pan, email, phone FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1',
      [guid, req.workspaceId]
    );
    if (!companyRows[0]) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company not found' } });
    }
    const { rows } = await query('SELECT * FROM company_print_profile WHERE company_id=$1', [guid]);
    const profile = rows[0] || {};
    res.json({
      success: true,
      data: {
        companyGuid: guid,
        gstin: companyRows[0].gstin || profile.gstin || '',
        pan: companyRows[0].pan || profile.pan || '',
        email: companyRows[0].email || profile.email || '',
        phone: companyRows[0].phone || profile.phone || '',
        jurisdiction: profile.jurisdiction || '',
        declarationText: profile.declaration_text || DEFAULT_PRINT_DECLARATION,
        bankName: profile.bank_name || '',
        bankAccountNo: profile.bank_account_no || '',
        bankIfsc: profile.bank_ifsc || '',
        bankBranch: profile.bank_branch || '',
        pdfFormat: profile.pdf_format || 'tally',
        pdfFormatOverrides: profile.pdf_format_overrides || {},
      },
    });
  } catch (err) {
    console.error('[api print-profile:get]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to fetch print profile' } });
  }
});

// PUT /api/companies/:guid/print-profile
router.put('/companies/:guid/print-profile', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    const ok = await verifyCompanyAccess(req, res, guid, {
      capability: 'workspace.settings.manage',
      responseShape: 'api-v1',
    });
    if (!ok) return;
    const companyId = requireResolvedCompanyId(req);
    const body = req.body || {};
    const incoming = {
      gstin: body.gstin,
      pan: body.pan,
      email: body.email,
      phone: body.phone,
      jurisdiction: body.jurisdiction,
      declaration_text: body.declarationText ?? body.declaration_text,
      bank_name: body.bankName ?? body.bank_name,
      bank_account_no: body.bankAccountNo ?? body.bank_account_no,
      bank_ifsc: body.bankIfsc ?? body.bank_ifsc,
      bank_branch: body.bankBranch ?? body.bank_branch,
      pdf_format: body.pdfFormat ?? body.pdf_format,
      pdf_format_overrides: body.pdfFormatOverrides ?? body.pdf_format_overrides,
    };
    const cols = PRINT_PROFILE_FIELDS.filter((f) => incoming[f] !== undefined);
    if (!cols.length) {
      return res.status(400).json({ status: false, error: { code: 'BAD_REQUEST', message: 'No print profile fields supplied' } });
    }
    const values = cols.map((c) => (
      c === 'pdf_format_overrides' ? JSON.stringify(incoming[c] || {}) : incoming[c]
    ));
    const placeholders = cols.map((_, i) => `$${i + 3}`).join(', ');
    const updates = cols.map((c, i) => `${c} = $${i + 3}`).join(', ');
    await query(
      `INSERT INTO company_print_profile (company_id, company_guid, ${cols.join(', ')})
       VALUES ($1, $2, ${placeholders})
       ON CONFLICT (company_id) DO UPDATE SET ${updates}, updated_at = NOW()`,
      [companyId, guid, ...values]
    );
    res.json({ success: true, message: 'Print profile saved' });
  } catch (err) {
    console.error('[api print-profile:put]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed to save print profile' } });
  }
});

function dashboardSeriesInterval(period, from, to) {
  const p = String(period || '').toUpperCase();
  if (p === '7D') return 'day';
  if (p === '1M') return 'day';
  if (p === '3M') return 'week';
  if (p === '6M') return 'month';
  const a = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  const b = new Date(`${String(to).slice(0, 10)}T12:00:00`);
  const days = Number.isFinite(b - a) ? Math.max(1, Math.round((b - a) / 86400000) + 1) : 30;
  if (days <= 14) return 'day';
  if (days <= 92) return 'week';
  return 'month';
}

function pgDateTrunc(interval) {
  if (interval === 'week') return 'week';
  if (interval === 'month') return 'month';
  return 'day';
}

function isoDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function enumerateSeriesBuckets(from, to, interval) {
  const start = new Date(`${String(from).slice(0, 10)}T12:00:00`);
  const end = new Date(`${String(to).slice(0, 10)}T12:00:00`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) return [];
  const out = [];
  if (interval === 'month') {
    const d = new Date(start.getFullYear(), start.getMonth(), 1);
    const last = new Date(end.getFullYear(), end.getMonth(), 1);
    while (d <= last) {
      out.push(isoDateLocal(d));
      d.setMonth(d.getMonth() + 1);
    }
  } else if (interval === 'week') {
    const d = new Date(start);
    const dow = d.getDay();
    d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
    while (d <= end) {
      out.push(isoDateLocal(d));
      d.setDate(d.getDate() + 7);
    }
  } else {
    const d = new Date(start);
    while (d <= end) {
      out.push(isoDateLocal(d));
      d.setDate(d.getDate() + 1);
    }
  }
  return out;
}

function seriesPointLabel(dateStr, interval) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return dateStr;
  if (interval === 'month') return d.toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

function rowsToBucketMap(rows) {
  const map = {};
  for (const r of rows || []) {
    const key = String(r.bucket || '').slice(0, 10);
    if (key) map[key] = +(r.v || 0);
  }
  return map;
}

async function voucherSeriesMap(companyId, from, to, interval, typeSql) {
  const trunc = pgDateTrunc(interval);
  const { rows } = await query(
    `SELECT date_trunc('${trunc}', date::timestamp)::date::text AS bucket,
            COALESCE(SUM(amount), 0)::float AS v
     FROM vouchers
     WHERE company_id=$1 AND is_cancelled = FALSE AND date BETWEEN $2 AND $3
       AND (${typeSql})
     GROUP BY 1`,
    [companyId, from, to]
  );
  return rowsToBucketMap(rows);
}

async function ledgerEntrySeriesMap(companyId, from, to, interval, drCr, parentSql) {
  const trunc = pgDateTrunc(interval);
  const { rows } = await query(
    `SELECT date_trunc('${trunc}', v.date::timestamp)::date::text AS bucket,
            COALESCE(SUM(ABS(vle.amount)), 0)::float AS v
     FROM voucher_ledger_entries vle
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
     WHERE vle.company_id=$1 AND vle.dr_cr = $2
       AND (${parentSql})
       AND v.is_cancelled = FALSE AND v.date BETWEEN $3 AND $4
     GROUP BY 1`,
    [companyId, drCr, from, to]
  );
  return rowsToBucketMap(rows);
}

function preferLedgerSeries(ledgerMap, voucherMap) {
  const sum = Object.values(ledgerMap || {}).reduce((s, v) => s + v, 0);
  return sum > 0 ? ledgerMap : voucherMap;
}

const METRICS_SALES_SQL =
  `voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%'`;
const METRICS_PURCHASE_SQL =
  `voucher_type ILIKE '%Purchase%' AND voucher_type NOT ILIKE '%Order%'`;
const METRICS_EXPENSE_SQL =
  `voucher_type IN ('Journal', 'Payment', 'Contra') AND amount > 0`;
const METRICS_SALES_PARENT =
  `(l.parent ILIKE '%Sales%' OR l.parent ILIKE '%Direct Income%' OR l.parent ILIKE '%Indirect Income%')`;
const METRICS_PURCHASE_PARENT =
  `(l.parent ILIKE '%Purchase%' OR l.parent ILIKE '%Direct Expense%')`;
const METRICS_EXPENSE_PARENT = `l.parent ~* '^Indirect Expenses?$'`;
const CASHFLOW_RECEIPT_SQL = `voucher_type ILIKE '%Receipt%'`;
const CASHFLOW_PAYMENT_SQL = `voucher_type ILIKE '%Payment%'`;

async function buildDashboardChartSeries(companyId, from, to, period) {
  const interval = dashboardSeriesInterval(period, from, to);
  const buckets = enumerateSeriesBuckets(from, to, interval);
  const [salesLed, purchLed, expLed, salesV, purchV, expV] = await Promise.all([
    ledgerEntrySeriesMap(companyId, from, to, interval, 'Cr', METRICS_SALES_PARENT),
    ledgerEntrySeriesMap(companyId, from, to, interval, 'Dr', METRICS_PURCHASE_PARENT),
    ledgerEntrySeriesMap(companyId, from, to, interval, 'Dr', METRICS_EXPENSE_PARENT),
    voucherSeriesMap(companyId, from, to, interval, METRICS_SALES_SQL),
    voucherSeriesMap(companyId, from, to, interval, METRICS_PURCHASE_SQL),
    voucherSeriesMap(companyId, from, to, interval, METRICS_EXPENSE_SQL),
  ]);
  const salesMap = preferLedgerSeries(salesLed, salesV);
  const purchMap = preferLedgerSeries(purchLed, purchV);
  const expMap = preferLedgerSeries(expLed, expV);
  return {
    interval,
    series: buckets.map(date => ({
      date,
      label: seriesPointLabel(date, interval),
      sales: salesMap[date] || 0,
      purchase: purchMap[date] || 0,
      expenses: expMap[date] || 0,
    })),
  };
}

// ══════════════════════════════════════════════════════════════
// DASHBOARD
// ══════════════════════════════════════════════════════════════

// GET /api/dashboard/kpi-strip?period=7D
// Amounts from ledger/voucher aggregates; trend_pct/trend_positive reused from KPI builders
// (same meaning as each detail screen). Null when no prior — client shows "—".
router.get('/dashboard/kpi-strip', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const companyId = req.company?.id;
    if (!companyId) {
      return res.status(403).json({ success: false, error: { code: 'COMPANY_SCOPE_DENIED', message: 'Company not resolved' } });
    }
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    // Phase 3B: internal ownership filter = company_id
    const pmtParams = from && to ? [companyId, from, to] : [companyId];
    const pmtDateFilter = from && to ? 'AND date BETWEEN $2 AND $3' : '';
    const { rows: cash } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyId]);
    const { rows: bank } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Bank%' OR parent ILIKE '%Bank Account%')`, [companyId]);
    const { rows: rec }  = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors')`, [companyId]);
    const { rows: pay }  = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Sundry Creditor%' OR parent='Sundry Creditors')`, [companyId]);
    const { rows: loans } = await query(
      `SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers
       WHERE company_id=$1 AND (
         parent ILIKE 'Secured Loans' OR parent ILIKE 'Unsecured Loans'
         OR parent ILIKE '%Bank OD%' OR parent ILIKE '%Overdraft%'
         OR parent ILIKE '%Cash Credit%' OR parent ILIKE 'Bank OD A/c' OR parent ILIKE 'Bank OD Accounts'
       )`,
      [companyId]
    );
    const { rows: pmts } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Payment%' AND is_cancelled=FALSE ${pmtDateFilter}`, pmtParams);
    const { rows: rcts } = await query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Receipt%' AND is_cancelled=FALSE ${pmtDateFilter}`, pmtParams);

    // Soft-fail each builder so one KPI trend failure does not blank the strip
    const settled = await Promise.allSettled([
      buildCashInHandPayload(companyId, { from, to }),
      buildBankBalancePayload(companyId, { from, to }),
      buildArApPayload(companyId, 'AR', {}),
      buildArApPayload(companyId, 'AP', {}),
      buildLoansOdsPayload(companyId),
      buildPaymentReceiptPayload(companyId, { from, to, kind: 'Payment' }),
      buildPaymentReceiptPayload(companyId, { from, to, kind: 'Receipt' }),
    ]);
    const pickTrend = (result) => {
      if (result.status !== 'fulfilled' || !result.value) {
        return { trend_pct: null, trend_positive: null };
      }
      const pct = result.value.trend_pct;
      if (pct == null || !Number.isFinite(Number(pct))) {
        return { trend_pct: null, trend_positive: null };
      }
      const n = Number(pct);
      return {
        trend_pct: n,
        trend_positive: result.value.trend_positive != null ? !!result.value.trend_positive : n >= 0,
      };
    };
    const [
      cashTrend, bankTrend, arTrend, apTrend, loansTrend, pmtTrend, rctTrend,
    ] = settled.map(pickTrend);
    for (const r of settled) {
      if (r.status === 'rejected') {
        console.warn('[kpi-strip] trend enrich failed:', r.reason?.message || r.reason);
      }
    }

    // Raw values only — formatting is done client-side using user's currency/format settings
    const g = (rows) => +(rows?.[0]?.v ?? 0);
    const kpi = [
      { id: 'cash',       label: 'Cash In Hand', amount_raw: g(cash),  icon: 'wallet-outline',              route: '/kpi/cash-in-hand', ...cashTrend },
      { id: 'bank',       label: 'Bank Balance', amount_raw: g(bank),  icon: 'card-outline',                route: '/kpi/bank-balance', ...bankTrend },
      { id: 'receivable', label: 'Receivables',  amount_raw: g(rec),   icon: 'arrow-down-circle-outline',   route: '/kpi/receivables', ...arTrend },
      { id: 'payable',    label: 'Payables',     amount_raw: g(pay),   icon: 'arrow-up-circle-outline',     route: '/kpi/payables', ...apTrend },
      { id: 'loans',      label: 'Loans & ODs',  amount_raw: g(loans), icon: 'git-merge-outline',           route: '/kpi/loans-ods', ...loansTrend },
      { id: 'payments',   label: 'Payments',     amount_raw: g(pmts),  icon: 'send-outline',                route: '/kpi/payments', ...pmtTrend },
      { id: 'receipts',   label: 'Receipts',     amount_raw: g(rcts),  icon: 'download-outline',            route: '/kpi/receipts', ...rctTrend },
    ];
    res.json({ success: true, data: kpi });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

function inclusiveMetricDays(from, to) {
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.floor((b - a) / 86400000) + 1);
}

/** Sales / purchase / expense totals for a window — same queries as GET /dashboard/metrics tiles. */
async function dashboardMetricAmounts(companyGuid, from, to) {
  const [sRes, pRes, eRes] = await Promise.all([
    query(`SELECT COALESCE(
      (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
       JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_id=vle.company_id
       WHERE vle.company_id=$1 AND vle.dr_cr='Cr'
         AND (l.parent ILIKE '%Sales%' OR l.parent ILIKE '%Direct Income%' OR l.parent ILIKE '%Indirect Income%')
         AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
      (SELECT SUM(amount) FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3),
      0
    ) as v`, [companyId, from, to]),
    query(`SELECT COALESCE(
      (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
       JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_id=vle.company_id
       WHERE vle.company_id=$1 AND vle.dr_cr='Dr'
         AND (l.parent ILIKE '%Purchase%' OR l.parent ILIKE '%Direct Expense%')
         AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
      (SELECT SUM(amount) FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Purchase%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3),
      0
    ) as v`, [companyId, from, to]),
    query(`SELECT COALESCE(
      (SELECT SUM(ABS(vle.amount)) FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
       JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_id=vle.company_id
       WHERE vle.company_id=$1 AND vle.dr_cr='Dr'
         AND l.parent ~* '^Indirect Expenses?$'
         AND v.is_cancelled=FALSE AND v.date BETWEEN $2 AND $3),
      (SELECT SUM(amount) FROM vouchers WHERE company_id=$1 AND voucher_type IN ('Journal','Payment','Contra') AND is_cancelled=FALSE AND amount > 0 AND date BETWEEN $2 AND $3),
      0
    ) as v`, [companyId, from, to]),
  ]);
  return {
    sales: +(sRes.rows?.[0]?.v ?? 0) || 0,
    purchases: +(pRes.rows?.[0]?.v ?? 0) || 0,
    expenses: +(eRes.rows?.[0]?.v ?? 0) || 0,
  };
}

function metricTrendTile(id, label, amount, icon, route, pct, invert) {
  const up = pct == null ? null : pct >= 0;
  const positive = invert ? (pct == null ? false : pct <= 0) : (pct == null ? true : pct >= 0);
  return {
    id, label, amount_raw: amount, icon, route,
    change: pct == null ? 0 : pct,
    positive,
    trend_pct: pct,
    trend_positive: up,
  };
}

// GET /api/dashboard/metrics?period=7D&companyGuid=xxx
router.get('/dashboard/metrics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const periodDays = inclusiveMetricDays(from, to);
    const priorTo = addDays(from, -1);
    const priorFrom = addDays(priorTo, -(periodDays - 1));
    const [cur, prior] = await Promise.all([
      dashboardMetricAmounts(companyGuid, from, to),
      dashboardMetricAmounts(companyGuid, priorFrom, priorTo),
    ]);
    const sTrend = computeTrendPct(cur.sales, prior.sales);
    const pTrend = computeTrendPct(cur.purchases, prior.purchases);
    const eTrend = computeTrendPct(cur.expenses, prior.expenses);
    // data stays a tile array so mobile `met.data` is unchanged. Chart series is GET /dashboard/chart.
    // change / trend_pct = current window vs prior equal-length window (1M → previous month).
    res.json({ success: true, data: [
      metricTrendTile('sales',     'Sales',     cur.sales,     'stats-chart-outline',  '/sales',     sTrend, false),
      metricTrendTile('purchases', 'Purchases', cur.purchases, 'cart-outline',         '/purchase',  pTrend, false),
      metricTrendTile('expenses',  'Expenses',  cur.expenses,  'trending-up-outline',  '/expenses',  eTrend, true),
    ]});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/chart — turnover series (sales / purchase / expenses) for the selected window
router.get('/dashboard/chart', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const { interval, series } = await buildDashboardChartSeries(companyId, from, to, req.query.period);
    res.json({ success: true, data: { interval, series, fy_from: from, fy_to: to } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/cashflow
// Bars: Income/Expense = Receipts/Payments (money movement).
// Metrics: Gross/Net Profit from Sales, Purchase, Direct/Indirect (Tally-style).
router.get('/dashboard/cashflow', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const { rows: cash } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyId]);
    const { rows: bank } = await query(`SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND (parent ILIKE '%Bank%')`, [companyId]);
    const salesFilter = `voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND is_cancelled=FALSE`;
    const purchFilter = `voucher_type ILIKE '%Purchase%' AND voucher_type NOT ILIKE '%Order%' AND is_cancelled=FALSE`;
    // Parent match must use ^Direct / ^Indirect — '%Direct Expense%' also matches "Indirect Expenses"
    const plLeg = (parentRegex, drCr) =>
      query(
        `SELECT COALESCE(SUM(ABS(vle.amount)),0) as v
         FROM voucher_ledger_entries vle
         JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
         JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_id=vle.company_id
         WHERE vle.company_id=$1 AND vle.dr_cr=$2
           AND l.parent ~* $3
           AND v.is_cancelled=FALSE AND v.date BETWEEN $4 AND $5`,
        [companyId, drCr, parentRegex, from, to]
      );
    const interval = dashboardSeriesInterval(req.query.period, from, to);
    const buckets = enumerateSeriesBuckets(from, to, interval);
    const [rctRes, pmtRes, salesRes, purchRes, dirExpRes, indExpRes, dirIncRes, indIncRes, rctSeries, pmtSeries] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Receipt%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyId, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Payment%' AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyId, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND ${salesFilter} AND date BETWEEN $2 AND $3`, [companyId, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND ${purchFilter} AND date BETWEEN $2 AND $3`, [companyId, from, to]),
      plLeg('^Direct Expenses?$', 'Dr'),
      plLeg('^Indirect Expenses?$', 'Dr'),
      plLeg('^Direct Incomes?$', 'Cr'),
      plLeg('^Indirect Incomes?$', 'Cr'),
      voucherSeriesMap(companyId, from, to, interval, CASHFLOW_RECEIPT_SQL),
      voucherSeriesMap(companyId, from, to, interval, CASHFLOW_PAYMENT_SQL),
    ]);
    const receipts = +(rctRes.rows?.[0]?.v ?? 0);
    const payments = +(pmtRes.rows?.[0]?.v ?? 0);
    const sales = +(salesRes.rows?.[0]?.v ?? 0);
    const purchase = +(purchRes.rows?.[0]?.v ?? 0);
    const directExpenses = +(dirExpRes.rows?.[0]?.v ?? 0);
    const indirectExpenses = +(indExpRes.rows?.[0]?.v ?? 0);
    const directIncome = +(dirIncRes.rows?.[0]?.v ?? 0);
    const indirectIncome = +(indIncRes.rows?.[0]?.v ?? 0);
    const netCash = +(cash?.[0]?.v ?? 0) + +(bank?.[0]?.v ?? 0);
    // Tally trading + P&L (period, without stock adj for cashflow card speed)
    const grossProfit = sales - purchase - directExpenses + directIncome;
    const netProfit = grossProfit - indirectExpenses + indirectIncome;
    const gpVsSalesPct = sales > 0 ? Math.round((grossProfit / sales) * 100) : 0;
    const series = buckets.map(date => {
      const inflow = rctSeries[date] || 0;
      const outflow = pmtSeries[date] || 0;
      return { date, label: seriesPointLabel(date, interval), inflow, outflow, net: inflow - outflow };
    });
    res.json({ success: true, data: {
      net_cash: netCash, gross_cash: netCash, net_realisable_balance: netCash,
      total_income: receipts, total_expense: payments,
      sales, purchase,
      direct_expenses: directExpenses,
      indirect_expenses: indirectExpenses,
      direct_income: directIncome,
      indirect_income: indirectIncome,
      gross_profit: grossProfit,
      net_profit: netProfit,
      gross_profit_vs_sales_pct: gpVsSalesPct,
      income_percentage: gpVsSalesPct,
      fy_from: from, fy_to: to,
      updated_at: 'just now',
      series,
      interval,
    }});
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/search?q= — unified search for home / voice search
router.get('/dashboard/search', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const companyId = requireResolvedCompanyId(req);
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ success: true, data: [] });

  const pattern = `%${q}%`;
  try {
    const { rows: vouchers } = await query(
      `SELECT guid, voucher_number, party_name, voucher_type, amount, date
       FROM vouchers
       WHERE company_id=$1 AND is_cancelled = FALSE
         AND (party_name ILIKE $2 OR voucher_number ILIKE $2 OR voucher_type ILIKE $2)
       ORDER BY date DESC NULLS LAST
       LIMIT 8`,
      [companyId, pattern]
    );

    const { rows: ledgers } = await query(
      `SELECT guid, name, parent, closing_balance, balance_type
       FROM ledgers
       WHERE company_id=$1 AND (name ILIKE $2 OR alias ILIKE $2 OR gstin ILIKE $2)
       ORDER BY ABS(closing_balance) DESC
       LIMIT 6`,
      [companyId, pattern]
    );

    const { rows: stocks } = await query(
      `SELECT name, closing_qty, group_name
       FROM stocks
       WHERE company_id=$1 AND (name ILIKE $2 OR alias ILIKE $2)
       ORDER BY name ASC
       LIMIT 6`,
      [companyId, pattern]
    );

    const results = [
      ...vouchers.map(v => ({
        id: `v_${v.guid}`,
        kind: 'voucher',
        label: `${v.voucher_type || 'Voucher'}${v.voucher_number ? ` #${v.voucher_number}` : ''}`.trim(),
        party: v.party_name || '',
        subtitle: v.date || '',
        guid: v.guid,
        amount_raw: Math.abs(parseFloat(v.amount) || 0),
        is_credit: (v.voucher_type || '').toLowerCase().includes('receipt'),
        route: v.guid ? `/document/${v.guid}` : null,
      })),
      ...ledgers.map(l => ({
        id: `l_${l.guid || l.name}`,
        kind: 'ledger',
        label: l.name,
        party: l.parent || 'Ledger',
        subtitle: `Balance ₹${Math.round(Math.abs(parseFloat(l.closing_balance) || 0)).toLocaleString('en-IN')}`,
        guid: l.guid,
        route: l.guid ? `/ledger/${l.guid}` : null,
      })),
      ...stocks.map(s => ({
        id: `s_${s.name}`,
        kind: 'stock',
        label: s.name,
        party: s.group_name || 'Stock',
        subtitle: `Qty ${s.closing_qty ?? 0}`,
        route: '/stocks/on-hand-stock',
      })),
    ];

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/recent-activity
router.get('/dashboard/recent-activity', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const { rows } = await query(
      `SELECT id, guid, voucher_number, party_name, voucher_type, amount, date FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 ORDER BY date DESC, id DESC LIMIT 10`,
      [companyId, from, to]
    );
    const activity = rows.map(r => ({
      id: r.guid || String(r.id),
      // guid drives navigation to the real document preview (/document/[guid]).
      guid: r.guid || null,
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

// GET /api/dashboard/top-customers — sales by party for the selected window
router.get('/dashboard/top-customers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const limit = Math.min(10, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const { rows } = await query(
      `SELECT party_name AS name,
              COALESCE(SUM(ABS(amount)), 0)::float AS v,
              COUNT(*)::int AS invoices
       FROM vouchers
       WHERE company_id=$1 AND is_cancelled = FALSE
         AND voucher_type ILIKE '%Sales%'
         AND voucher_type NOT ILIKE '%Order%'
         AND voucher_type NOT ILIKE '%Delivery%'
         AND voucher_type NOT ILIKE '%Quotation%'
         AND party_name IS NOT NULL AND TRIM(party_name) <> ''
         AND date BETWEEN $2 AND $3
       GROUP BY party_name
       ORDER BY v DESC
       LIMIT $4`,
      [companyId, from, to, limit]
    );
    const total = rows.reduce((s, r) => s + +(r.v || 0), 0);
    const data = rows.map(r => {
      const amount_raw = +(r.v || 0);
      return {
        name: r.name,
        amount_raw,
        revenue: amount_raw,
        invoices: +(r.invoices || 0),
        pct: total > 0 ? Math.round((amount_raw / total) * 100) : 0,
      };
    });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/dashboard/cost-analysis — Direct + Indirect expense ledger heads for the window
router.get('/dashboard/cost-analysis', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    let { rows } = await query(
      `SELECT l.name, l.parent,
              COALESCE(SUM(ABS(vle.amount)), 0)::float AS v
       FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
       JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
       WHERE vle.company_id=$1 AND vle.dr_cr = 'Dr'
         AND (l.parent ~* '^Direct Expenses?$' OR l.parent ~* '^Indirect Expenses?$')
         AND v.is_cancelled = FALSE AND v.date BETWEEN $2 AND $3
       GROUP BY l.name, l.parent
       HAVING SUM(ABS(vle.amount)) > 0
       ORDER BY v DESC`,
      [companyId, from, to]
    );
    if (!rows.length) {
      const fallback = await query(
        `SELECT voucher_type AS name, '' AS parent,
                COALESCE(SUM(amount), 0)::float AS v
         FROM vouchers
         WHERE company_id=$1 AND is_cancelled = FALSE
           AND voucher_type IN ('Journal', 'Payment', 'Contra') AND amount > 0
           AND date BETWEEN $2 AND $3
         GROUP BY voucher_type
         HAVING SUM(amount) > 0
         ORDER BY v DESC`,
        [companyId, from, to]
      );
      rows = fallback.rows;
    }
    const sorted = rows.map(r => ({
      name: r.name,
      parent: r.parent || '',
      amount_raw: +(r.v || 0),
    })).filter(h => h.amount_raw > 0);
    const total_raw = sorted.reduce((s, h) => s + h.amount_raw, 0);
    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6).reduce((s, h) => s + h.amount_raw, 0);
    if (rest > 0) top.push({ name: 'Other', parent: '', amount_raw: rest });
    const heads = top.map(h => ({
      ...h,
      pct: total_raw > 0 ? Math.max(1, Math.round((h.amount_raw / total_raw) * 100)) : 0,
    }));
    res.json({ success: true, data: { total_raw, heads } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// SALES
// ══════════════════════════════════════════════════════════════

/** Shared voucher SELECT + app_vouchers lateral join (list screens). */
const VOUCHER_LIST_SELECT = `
      SELECT v.*,
             av_info.tdk_reference_no,
             av_info.current_entry_type,
             av_info.original_entry_type,
             (
               SELECT vle.ledger_name
               FROM voucher_ledger_entries vle
               WHERE vle.voucher_guid = v.guid
                 AND vle.company_id = v.company_id
                 AND NULLIF(TRIM(vle.ledger_name), '') IS NOT NULL
               ORDER BY
                 CASE
                   WHEN vle.ledger_name ILIKE '%Profit%Loss%' THEN 9
                   WHEN vle.ledger_name ~* '(CGST|SGST|IGST|UTGST|\\mGST\\M|Cess|Tax)' THEN 6
                   WHEN vle.ledger_name ~* '(Cash|Bank)' THEN 5
                   WHEN vle.ledger_name ~* '(Sales|Purchase)'
                        AND vle.ledger_name !~* '(Order|Return)' THEN 4
                   ELSE 0
                 END,
                 ABS(COALESCE(vle.amount, 0)) DESC
               LIMIT 1
             ) AS primary_ledger
      FROM vouchers v
      LEFT JOIN LATERAL (
        SELECT av.tdk_reference_no, av.current_entry_type, av.original_entry_type
        FROM app_vouchers av
        WHERE av.company_id = v.company_id
          AND av.tally_voucher_no = v.voucher_number
          AND av.voucher_date::text = v.date
          AND (
            (COALESCE(av.tdk_reference_no, '') <> '' AND COALESCE(v.reference, '') = av.tdk_reference_no)
            OR COALESCE(av.tdk_reference_no, '') = ''
          )
        ORDER BY av.id DESC LIMIT 1
      ) av_info ON true`;

/** Attach resolved party_name for list tiles (Journal / SO / Proforma often NULL). */
function mapVoucherListRow(r, extra = {}) {
  return {
    ...r,
    party_name: resolveVoucherListParty(r),
    primary_ledger: r.primary_ledger || null,
    ...extra,
  };
}

// True Sales invoice (metrics-aligned): Sales but not Order/Delivery/Quotation.
const SALES_INVOICE_SQL = `v.voucher_type ILIKE '%Sales%' AND v.voucher_type NOT ILIKE '%Order%' AND v.voucher_type NOT ILIKE '%Delivery%' AND v.voucher_type NOT ILIKE '%Quotation%'`;
// True Purchase invoice: Purchase but not Purchase Order.
const PURCHASE_INVOICE_SQL = `v.voucher_type ILIKE '%Purchase%' AND v.voucher_type NOT ILIKE '%Order%'`;

/** Map mobile docType → SQL predicate (alias `v`). */
function salesDocTypePredicate(docType) {
  switch (String(docType || '').toLowerCase()) {
    case 'invoice':
      return `(${SALES_INVOICE_SQL} AND COALESCE(v.is_optional, FALSE) = FALSE)`;
    case 'order':
      return `(v.voucher_type ILIKE '%Sales Order%')`;
    case 'credit_note':
      return `(v.voucher_type ILIKE '%Credit Note%')`;
    case 'delivery_note':
      return `(v.voucher_type ILIKE '%Delivery Note%')`;
    case 'proforma':
      return `(${SALES_INVOICE_SQL} AND COALESCE(v.is_optional, FALSE) = TRUE)`;
    case 'quotation':
      return `(v.voucher_type ILIKE '%Quotation%')`;
    case 'receipt':
      return `(v.voucher_type ILIKE '%Receipt%' AND v.voucher_type NOT ILIKE '%Receipt Note%')`;
    case 'journal':
      return `(v.voucher_type ILIKE '%Journal%')`;
    default:
      return null;
  }
}

function purchaseDocTypePredicate(docType) {
  switch (String(docType || '').toLowerCase()) {
    case 'invoice':
      return `(${PURCHASE_INVOICE_SQL} AND COALESCE(v.is_optional, FALSE) = FALSE)`;
    case 'order':
      return `(v.voucher_type ILIKE '%Purchase Order%')`;
    case 'debit_note':
      return `(v.voucher_type ILIKE '%Debit Note%')`;
    case 'payment':
      return `(v.voucher_type ILIKE '%Payment%')`;
    case 'contra':
      return `(v.voucher_type ILIKE '%Contra%')`;
    default:
      return null;
  }
}

function classifySalesDocType(row) {
  const vt = String(row.voucher_type || '');
  if (/quotation/i.test(vt)) return 'quotation';
  if (/credit\s*note/i.test(vt)) return 'credit_note';
  if (/delivery\s*note/i.test(vt)) return 'delivery_note';
  if (/sales\s*order/i.test(vt)) return 'order';
  if (/receipt\s*note/i.test(vt)) return 'invoice'; // inventory — not money Receipt
  if (/receipt/i.test(vt)) return 'receipt';
  if (/journal/i.test(vt)) return 'journal';
  if (row.is_optional) return 'proforma';
  return 'invoice';
}

function classifyPurchaseDocType(row) {
  const vt = String(row.voucher_type || '');
  if (/debit\s*note/i.test(vt)) return 'debit_note';
  if (/purchase\s*order/i.test(vt)) return 'order';
  if (/payment/i.test(vt)) return 'payment';
  if (/contra/i.test(vt)) return 'contra';
  return 'invoice';
}

const voucherListHandler = (voucherType) => async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { search = '', page = 1, limit = 30 } = req.query;
  const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // Optional exact (case/whitespace-insensitive) party filter — used by "deliveries for
  // this customer" style screens. Omitted → handler behaves exactly as before.
  const partyName = typeof req.query.partyName === 'string' ? req.query.partyName.trim() : '';
  try {
    let q = `
      ${VOUCHER_LIST_SELECT}
      WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type ILIKE $2
        AND (v.party_name ILIKE $3 OR v.voucher_number ILIKE $3)
        AND v.date BETWEEN $4 AND $5`;
    const params = [companyId, `%${voucherType}%`, `%${search}%`, from, to];
    if (partyName) {
      params.push(partyName);
      q += ` AND LOWER(TRIM(COALESCE(v.party_name,''))) = LOWER(TRIM($${params.length}))`;
    }
    q += ` ORDER BY v.date DESC, v.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const cntParams = [companyId, `%${voucherType}%`, from, to];
    let cntQ = `SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND voucher_type ILIKE $2 AND date BETWEEN $3 AND $4`;
    if (partyName) {
      cntParams.push(partyName);
      cntQ += ` AND LOWER(TRIM(COALESCE(party_name,''))) = LOWER(TRIM($${cntParams.length}))`;
    }
    const { rows: cnt } = await query(cntQ, cntParams);
    res.json({
      success: true,
      data: rows.map((r) => mapVoucherListRow(r)),
      meta: { total: parseInt(cnt[0].c), page: parseInt(page), limit: parseInt(limit), from, to },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};

/**
 * Strict invoice list — aligns with home-metrics (excludes Order/Delivery/Quotation).
 * Query `is_optional`: omit/false → regular invoices only; true → proforma only; all → both.
 */
const strictInvoiceListHandler = (module) => async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { search = '', page = 1, limit = 30 } = req.query;
  const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const partyName = typeof req.query.partyName === 'string' ? req.query.partyName.trim() : '';
  const optRaw = String(req.query.is_optional ?? 'false').toLowerCase();
  const baseSql = module === 'purchase' ? PURCHASE_INVOICE_SQL : SALES_INVOICE_SQL;
  let optionalSql = ' AND COALESCE(v.is_optional, FALSE) = FALSE';
  if (optRaw === 'true' || optRaw === '1') optionalSql = ' AND COALESCE(v.is_optional, FALSE) = TRUE';
  else if (optRaw === 'all') optionalSql = '';
  try {
    let q = `
      ${VOUCHER_LIST_SELECT}
      WHERE v.company_id=$1 AND v.is_cancelled=FALSE
        AND (${baseSql})${optionalSql}
        AND (v.party_name ILIKE $2 OR v.voucher_number ILIKE $2)
        AND v.date BETWEEN $3 AND $4`;
    const params = [companyId, `%${search}%`, from, to];
    if (partyName) {
      params.push(partyName);
      q += ` AND LOWER(TRIM(COALESCE(v.party_name,''))) = LOWER(TRIM($${params.length}))`;
    }
    q += ` ORDER BY v.date DESC, v.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const cntParams = [companyId, from, to];
    let cntQ = `SELECT COUNT(*) as c FROM vouchers v WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND (${baseSql})${optionalSql} AND v.date BETWEEN $2 AND $3`;
    if (partyName) {
      cntParams.push(partyName);
      cntQ += ` AND LOWER(TRIM(COALESCE(v.party_name,''))) = LOWER(TRIM($${cntParams.length}))`;
    }
    const { rows: cnt } = await query(cntQ, cntParams);
    const classify = module === 'purchase' ? classifyPurchaseDocType : classifySalesDocType;
    res.json({
      success: true,
      data: rows.map((r) => mapVoucherListRow(r, { doc_type: classify(r) })),
      meta: { total: parseInt(cnt[0].c), page: parseInt(page), limit: parseInt(limit), from, to },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};

/** Parse comma-separated query list (trim, drop empties). */
function parseCsvParam(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  return raw.split(',').map((t) => t.trim()).filter(Boolean);
}

/**
 * EXISTS: voucher's party ledger (by party_guid or party_name) has parent in $paramIdx::text[].
 * Used for Sales/Purchase "Party Group" filter — real ledgers.parent from DB.
 */
function partyGroupExistsSql(paramIdx) {
  return `EXISTS (
    SELECT 1 FROM ledgers pl
    WHERE pl.company_id = v.company_id
      AND (
        (NULLIF(TRIM(COALESCE(v.party_guid, '')), '') IS NOT NULL AND pl.guid = v.party_guid)
        OR LOWER(TRIM(pl.name)) = LOWER(TRIM(COALESCE(v.party_name, '')))
      )
      AND LOWER(TRIM(COALESCE(pl.parent, ''))) = ANY(
        SELECT LOWER(TRIM(x)) FROM unnest($${paramIdx}::text[]) AS x
      )
  )`;
}

/** Join party ledger once for group aggregation (prefer party_guid, else name). */
const PARTY_LEDGER_JOIN = `
  JOIN LATERAL (
    SELECT TRIM(COALESCE(l.parent, '')) AS parent
    FROM ledgers l
    WHERE l.company_id = v.company_id
      AND (
        (NULLIF(TRIM(COALESCE(v.party_guid, '')), '') IS NOT NULL AND l.guid = v.party_guid)
        OR LOWER(TRIM(l.name)) = LOWER(TRIM(COALESCE(v.party_name, '')))
      )
    ORDER BY CASE
      WHEN NULLIF(TRIM(COALESCE(v.party_guid, '')), '') IS NOT NULL AND l.guid = v.party_guid THEN 0
      ELSE 1
    END
    LIMIT 1
  ) pl ON TRUE`;

/**
 * Combined Recent feed — one paginated list across selected docTypes.
 * GET /sales/vouchers?docTypes=invoice,order,credit_note&partyGroups=Local%20Debtors,Export
 * GET /purchase/vouchers?docTypes=invoice,order,debit_note&partyGroups=...
 */
const combinedVoucherListHandler = (module) => async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { search = '', page = 1, limit = 30 } = req.query;
  const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const partyName = typeof req.query.partyName === 'string' ? req.query.partyName.trim() : '';
  const partyGroups = parseCsvParam(req.query.partyGroups);
  const defaultTypes = module === 'purchase'
    ? ['invoice', 'order', 'debit_note', 'payment', 'contra']
    : ['invoice', 'order', 'credit_note', 'delivery_note', 'proforma', 'quotation', 'receipt', 'journal'];
  const requested = parseCsvParam(req.query.docTypes).map((t) => t.toLowerCase());
  const effectiveTypes = requested.length ? requested : defaultTypes;
  const predFn = module === 'purchase' ? purchaseDocTypePredicate : salesDocTypePredicate;
  const predicates = effectiveTypes.map(predFn).filter(Boolean);
  if (!predicates.length) {
    return res.json({
      success: true,
      data: [],
      meta: { total: 0, page: parseInt(page), limit: parseInt(limit), from, to, docTypes: [], partyGroups: [] },
    });
  }
  const typeOr = `(${predicates.join(' OR ')})`;
  try {
    let q = `
      ${VOUCHER_LIST_SELECT}
      WHERE v.company_id=$1 AND v.is_cancelled=FALSE
        AND ${typeOr}
        AND (v.party_name ILIKE $2 OR v.voucher_number ILIKE $2)
        AND v.date BETWEEN $3 AND $4`;
    const params = [companyId, `%${search}%`, from, to];
    if (partyName) {
      params.push(partyName);
      q += ` AND LOWER(TRIM(COALESCE(v.party_name,''))) = LOWER(TRIM($${params.length}))`;
    }
    if (partyGroups.length) {
      params.push(partyGroups);
      q += ` AND ${partyGroupExistsSql(params.length)}`;
    }
    q += ` ORDER BY v.date DESC, v.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const cntParams = [companyId, from, to];
    let cntQ = `SELECT COUNT(*) as c FROM vouchers v WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND ${typeOr} AND v.date BETWEEN $2 AND $3`;
    if (partyName) {
      cntParams.push(partyName);
      cntQ += ` AND LOWER(TRIM(COALESCE(v.party_name,''))) = LOWER(TRIM($${cntParams.length}))`;
    }
    if (partyGroups.length) {
      cntParams.push(partyGroups);
      cntQ += ` AND ${partyGroupExistsSql(cntParams.length)}`;
    }
    const { rows: cnt } = await query(cntQ, cntParams);
    const classify = module === 'purchase' ? classifyPurchaseDocType : classifySalesDocType;
    res.json({
      success: true,
      data: rows.map((r) => mapVoucherListRow(r, {
        doc_type: classify(r),
        voucher_type: r.voucher_type,
        is_optional: r.is_optional ?? false,
      })),
      meta: {
        total: parseInt(cnt[0].c),
        page: parseInt(page),
        limit: parseInt(limit),
        from,
        to,
        docTypes: effectiveTypes,
        partyGroups,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};

/**
 * Per–doc-type + party-group counts for register filter sheet (current from/to).
 * partyGroups = distinct ledgers.parent of voucher parties in range.
 */
const voucherCountsHandler = (module) => async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to);
  const types = module === 'purchase'
    ? ['invoice', 'order', 'debit_note', 'payment', 'contra']
    : ['invoice', 'order', 'credit_note', 'delivery_note', 'proforma', 'quotation', 'receipt', 'journal'];
  const predFn = module === 'purchase' ? purchaseDocTypePredicate : salesDocTypePredicate;
  const allPreds = types.map(predFn).filter(Boolean);
  const typeOrAll = allPreds.length ? `(${allPreds.join(' OR ')})` : 'FALSE';
  try {
    const pairs = await Promise.all(types.map(async (docType) => {
      const pred = predFn(docType);
      if (!pred) return [docType, 0];
      const { rows } = await query(
        `SELECT COUNT(*)::int AS c FROM vouchers v
          WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND ${pred}
            AND v.date BETWEEN $2 AND $3`,
        [companyId, from, to]
      );
      return [docType, parseInt(rows[0]?.c || 0, 10)];
    }));
    const { rows: groupRows } = await query(
      `SELECT pl.parent AS name, COUNT(DISTINCT v.guid)::int AS c
         FROM vouchers v
         ${PARTY_LEDGER_JOIN}
        WHERE v.company_id=$1 AND v.is_cancelled=FALSE
          AND ${typeOrAll}
          AND v.date BETWEEN $2 AND $3
          AND pl.parent <> ''
        GROUP BY pl.parent
        ORDER BY c DESC, pl.parent ASC
        LIMIT 50`,
      [companyId, from, to]
    );
    const data = Object.fromEntries(pairs);
    data.all = pairs.reduce((sum, [, n]) => sum + n, 0);
    data.partyGroups = (groupRows || []).map((r) => ({
      name: r.name,
      count: parseInt(r.c || 0, 10),
    }));
    res.json({ success: true, data, meta: { from, to } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
};

router.get('/sales/invoices',    authMiddleware, strictInvoiceListHandler('sales'));
router.get('/sales/orders',      authMiddleware, voucherListHandler('Sales Order'));
router.get('/sales/vouchers/counts', authMiddleware, voucherCountsHandler('sales'));
router.get('/sales/vouchers',    authMiddleware, combinedVoucherListHandler('sales'));

const SALES_HOME_FILTER = `voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND COALESCE(is_optional, FALSE)=FALSE AND is_cancelled=FALSE`;
const PURCHASE_HOME_FILTER = `voucher_type ILIKE '%Purchase%' AND voucher_type NOT ILIKE '%Order%'`;

function shiftYearIso(iso, years = -1) {
  const d = new Date(`${iso}T12:00:00`);
  d.setFullYear(d.getFullYear() + years);
  return d.toISOString().slice(0, 10);
}

function priorMtdWindow(asOf) {
  const mtdFrom = `${asOf.slice(0, 8)}01`;
  const prevMonthEnd = addDays(mtdFrom, -1);
  const prevMtdFrom = `${prevMonthEnd.slice(0, 8)}01`;
  const dayNum = parseInt(asOf.slice(8, 10), 10);
  const prevMonthLastDay = parseInt(prevMonthEnd.slice(8, 10), 10);
  const prevDay = Math.min(dayNum, prevMonthLastDay);
  const prevMtdTo = `${prevMtdFrom.slice(0, 8)}${String(prevDay).padStart(2, '0')}`;
  return { from: mtdFrom, to: asOf, priorFrom: prevMtdFrom, priorTo: prevMtdTo };
}

function homeMetricTrend(cur, prior, invert = false) {
  const trend_pct = computeTrendPct(cur, prior);
  const trend_positive = trend_pct == null ? null : (invert ? trend_pct <= 0 : trend_pct >= 0);
  return { trend_pct, trend_positive };
}

async function sumVoucherAmount(companyGuid, filterSql, from, to) {
  if (!from || !to) return 0;
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND ${filterSql} AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`,
    [companyId, from, to]
  );
  return +(rows?.[0]?.v ?? 0);
}

async function countVouchers(companyGuid, filterSql, from, to) {
  if (!from || !to) return 0;
  const { rows } = await query(
    `SELECT COUNT(*)::int as c FROM vouchers WHERE company_id=$1 AND ${filterSql} AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`,
    [companyId, from, to]
  );
  return +(rows?.[0]?.c ?? 0);
}

async function sumNoteAmount(companyGuid, typePattern, from, to) {
  if (!from || !to) return 0;
  const { rows } = await query(
    `SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE $2 AND is_cancelled=FALSE AND date BETWEEN $3 AND $4`,
    [companyId, typePattern, from, to]
  );
  return +(rows?.[0]?.v ?? 0);
}

async function sumLedgerOutstanding(companyGuid, side) {
  const parentFilter = side === 'AR'
    ? `(parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors')`
    : `(parent ILIKE '%Sundry Creditor%' OR parent='Sundry Creditors')`;
  const { rows } = await query(
    `SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_id=$1 AND ${parentFilter}`,
    [companyId]
  );
  return +(rows?.[0]?.v ?? 0);
}

async function buildAvgTicketMetrics(companyId, filterSql, fyFrom, fyTo, ytdVal) {
  const priorFyFrom = shiftYearIso(fyFrom, -1);
  const priorFyTo = shiftYearIso(fyTo, -1);
  const [count, priorYtd, priorCount] = await Promise.all([
    countVouchers(companyId, filterSql, fyFrom, fyTo),
    sumVoucherAmount(companyId, filterSql, priorFyFrom, priorFyTo),
    countVouchers(companyId, filterSql, priorFyFrom, priorFyTo),
  ]);
  const avg = count > 0 ? ytdVal / count : 0;
  const priorAvg = priorCount > 0 ? priorYtd / priorCount : 0;
  const trend = homeMetricTrend(avg, priorAvg, false);
  return {
    avg_ticket: avg,
    avg_ticket_trend_pct: trend.trend_pct,
    avg_ticket_trend_positive: trend.trend_positive,
    invoice_count: count,
  };
}

async function buildNoteMetrics(companyId, typePattern, fyFrom, fyTo) {
  const priorFyFrom = shiftYearIso(fyFrom, -1);
  const priorFyTo = shiftYearIso(fyTo, -1);
  const [cur, prior] = await Promise.all([
    sumNoteAmount(companyId, typePattern, fyFrom, fyTo),
    sumNoteAmount(companyId, typePattern, priorFyFrom, priorFyTo),
  ]);
  const trend = homeMetricTrend(cur, prior, false);
  return { amount: cur, trend_pct: trend.trend_pct, trend_positive: trend.trend_positive };
}

async function buildOutstandingMetrics(companyId, side) {
  const payload = await buildArApPayload(companyId, side, {}).catch((e) => {
    console.warn(`[home-metrics] ${side} trend failed:`, e.message);
    return null;
  });
  const outstanding = await sumLedgerOutstanding(companyId, side);
  return {
    outstanding,
    outstanding_trend_pct: payload?.trend_pct ?? null,
    outstanding_trend_positive: payload?.trend_positive ?? null,
  };
}

async function buildVoucherHomeCoreMetrics(companyId, filterSql, fyFrom, fyTo, today, invertTrend = false) {
  const yesterday = addDays(today, -1);
  const mtdWin = priorMtdWindow(today);
  const priorFyFrom = shiftYearIso(fyFrom, -1);
  const priorFyTo = shiftYearIso(fyTo, -1);
  const [
    todayVal, yesterdayVal,
    mtdVal, priorMtdVal,
    ytdVal, priorYtdVal,
  ] = await Promise.all([
    sumVoucherAmount(companyId, filterSql, today, today),
    sumVoucherAmount(companyId, filterSql, yesterday, yesterday),
    sumVoucherAmount(companyId, filterSql, mtdWin.from, mtdWin.to),
    sumVoucherAmount(companyId, filterSql, mtdWin.priorFrom, mtdWin.priorTo),
    sumVoucherAmount(companyId, filterSql, fyFrom, fyTo),
    sumVoucherAmount(companyId, filterSql, priorFyFrom, priorFyTo),
  ]);
  const todayTrend = homeMetricTrend(todayVal, yesterdayVal, invertTrend);
  const mtdTrend = homeMetricTrend(mtdVal, priorMtdVal, invertTrend);
  const ytdTrend = homeMetricTrend(ytdVal, priorYtdVal, invertTrend);
  return {
    today: todayVal,
    mtd: mtdVal,
    ytd: ytdVal,
    today_trend_pct: todayTrend.trend_pct,
    today_trend_positive: todayTrend.trend_positive,
    mtd_trend_pct: mtdTrend.trend_pct,
    mtd_trend_positive: mtdTrend.trend_positive,
    ytd_trend_pct: ytdTrend.trend_pct,
    ytd_trend_positive: ytdTrend.trend_positive,
  };
}

// GET /api/sales/home-metrics — Today / MTD / YTD / Outstanding / Credit Notes / Avg Ticket
router.get('/sales/home-metrics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const today = new Date().toISOString().slice(0, 10);
    const core = await buildVoucherHomeCoreMetrics(companyId, SALES_HOME_FILTER, fyFrom, fyTo, today, false);
    const [avgMetrics, creditNotes, outstanding] = await Promise.all([
      buildAvgTicketMetrics(companyId, SALES_HOME_FILTER, fyFrom, fyTo, core.ytd),
      buildNoteMetrics(companyId, '%Credit Note%', fyFrom, fyTo),
      buildOutstandingMetrics(companyId, 'AR'),
    ]);
    res.json({
      success: true,
      data: {
        ...core,
        ...outstanding,
        credit_notes: creditNotes.amount,
        credit_notes_trend_pct: creditNotes.trend_pct,
        credit_notes_trend_positive: creditNotes.trend_positive,
        ...avgMetrics,
        from: fyFrom,
        to: fyTo,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/sales/invoices/:id/credit-note-context
// Everything the Credit Note (Sales Return) screen needs for one Sales invoice:
// header + party, the invoice's inventory rows with cumulative returned/remaining
// quantity, the Sales ledger(s) the invoice actually posted to, and the tax rows.
// `:id` is the invoice GUID (preferred) or its voucher number.
// Remaining qty already accounts for Credit Notes synced from Tally AND app-created
// Credit Notes still queued — the same resolver the writer validates against, so the
// number shown here is the number POST /tally/voucher/credit-note will accept.
router.get('/sales/invoices/:id/credit-note-context', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const resolved = await resolveCreditNoteContext(companyId, req.params.id);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, error: { code: resolved.code, message: resolved.message } });
    }
    const { invoice, context } = resolved;
    const returnable = context.items.filter(i => i.remainingQty > 0);
    res.json({
      success: true,
      data: {
        invoice: {
          guid: invoice.guid,
          voucherNumber: invoice.voucher_number || null,
          voucherType: invoice.voucher_type || null,
          voucherTypeParent: invoice.voucher_type_parent || null,
          date: invoice.date || null,
          partyName: invoice.party_name || null,
          partyGuid: invoice.party_guid || null,
          amount: context.totals.invoiceAmount,
          reference: invoice.reference || null,
          narration: invoice.narration || null,
          billRefName: context.linkedInvoice.billRefName,
          tdkRef: context.linkedInvoice.tdkRef,
          financialYear: invoice.financial_year || null,
          isOptional: invoice.is_optional ?? false,
        },
        party: context.party,
        // Echo straight back into POST /tally/voucher/credit-note as `linked_invoice`.
        linkedInvoice: context.linkedInvoice,
        items: context.items,
        salesLedgerCandidates: context.invoiceSalesLedgers,
        companySalesLedgers: context.companySalesLedgers,
        defaultSalesLedger: context.defaultSalesLedger,
        taxes: context.taxes,
        excludedTaxes: context.excludedTaxes || [],
        otherLedgers: context.otherLedgers,
        gst: context.gst,
        returnTaxMode: context.returnTaxMode,
        taxGeometry: context.taxGeometry,
        totals: context.totals,
        priorReturns: context.priorReturns,
        meta: {
          itemCount: context.items.length,
          returnableItemCount: returnable.length,
          fullyReturned: context.items.length > 0 && returnable.length === 0,
          natureOfReturn: '01-Sales Return',
        },
      },
    });
  } catch (err) {
    console.error('[credit-note-context]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/sales/credit-notes',authMiddleware, voucherListHandler('Credit Note'));
router.get('/sales/delivery-notes', authMiddleware, voucherListHandler('Delivery Note'));
router.get('/sales/ewaybills',   authMiddleware, voucherListHandler('Sales'));

// GET /api/company/:guid/compliance-config
router.get('/company/:guid/compliance-config', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    if (!await verifyCompanyOwnership(req, res, guid)) return;
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await query(
      `SELECT * FROM company_compliance_config WHERE company_id=$1`,
      [companyId]
    );
    // Return defaults if not yet configured
    const defaults = {
      company_guid: guid,
      numbering_policy: 'tally_prime_series',
      numbering_overrides: {},
      e_invoice_applicable: 'not_applicable',
      e_invoice_mode: 'manual',
      e_way_bill_applicable: 'not_applicable',
      e_way_bill_mode: 'manual',
    };
    res.json({ status: true, data: rows[0] || defaults });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// POST /api/company/:guid/compliance-config
router.post('/company/:guid/compliance-config', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    if (!await verifyCompanyOwnership(req, res, guid)) return;
    const companyId = requireResolvedCompanyId(req);
    const {
      numbering_policy = 'tally_prime_series',
      numbering_overrides = {},
      e_invoice_applicable = 'not_applicable',
      e_invoice_mode = 'manual',
      e_way_bill_applicable = 'not_applicable',
      e_way_bill_mode = 'manual',
    } = req.body;
    await query(`
      INSERT INTO company_compliance_config
        (company_id, company_guid, numbering_policy, numbering_overrides, e_invoice_applicable, e_invoice_mode, e_way_bill_applicable, e_way_bill_mode, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8, EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT (company_id) DO UPDATE SET
        numbering_policy      = EXCLUDED.numbering_policy,
        numbering_overrides   = EXCLUDED.numbering_overrides,
        e_invoice_applicable  = EXCLUDED.e_invoice_applicable,
        e_invoice_mode        = EXCLUDED.e_invoice_mode,
        e_way_bill_applicable = EXCLUDED.e_way_bill_applicable,
        e_way_bill_mode       = EXCLUDED.e_way_bill_mode,
        updated_at            = EXCLUDED.updated_at
    `, [companyId, guid, numbering_policy, JSON.stringify(numbering_overrides), e_invoice_applicable, e_invoice_mode, e_way_bill_applicable, e_way_bill_mode]);
    res.json({ status: true, message: 'Compliance config saved' });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// GET /api/sales/ledger-accounts — Sales Accounts group ledgers only
router.get('/sales/ledger-accounts', authMiddleware, async (req, res) => {
  try {
    const companyGuid = req.query.companyGuid || req.user?.defaultCompanyGuid;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await query(
      `SELECT name, guid FROM ledgers
       WHERE company_id=$1
         AND (parent = 'Sales Accounts' OR parent ILIKE '%Sales Account%' OR parent ILIKE 'Sales Accounts')
       ORDER BY name ASC`,
      [companyId]
    );
    res.json({ status: true, data: rows });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// GET /api/purchase/ledger-accounts — Purchase Accounts group ledgers only
router.get('/purchase/ledger-accounts', authMiddleware, async (req, res) => {
  try {
    const companyGuid = req.query.companyGuid || req.user?.defaultCompanyGuid;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await query(
      `WITH RECURSIVE purchase_groups AS (
         SELECT name FROM groups
          WHERE company_id=$1 AND name ILIKE 'Purchase Account%'
         UNION ALL
         SELECT g.name FROM groups g
           JOIN purchase_groups pg ON g.parent = pg.name
          WHERE g.company_id=$1
       )
       SELECT DISTINCT l.name, l.guid, l.parent
         FROM ledgers l
        WHERE l.company_id=$1
          AND (l.parent IN (SELECT name FROM purchase_groups) OR l.parent ILIKE '%Purchase Account%')
        ORDER BY l.name ASC`,
      [companyId]
    );
    res.json({ status: true, data: rows });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// GET /api/tax/ledgers — GST/Tax ledgers for item-level tax assignment
router.get('/tax/ledgers', authMiddleware, async (req, res) => {
  try {
    const companyGuid = req.query.companyGuid || req.user?.defaultCompanyGuid;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
    const companyId = requireResolvedCompanyId(req);
    const { rows } = await query(
      `WITH RECURSIVE tax_groups AS (
         SELECT name FROM groups
         WHERE company_id=$1
           AND (name ILIKE '%Duties%' OR name ILIKE '%Tax%' OR name ILIKE '%GST%')
         UNION ALL
         SELECT g.name FROM groups g
         JOIN tax_groups tg ON g.parent = tg.name
         WHERE g.company_id=$1
       )
       SELECT DISTINCT l.name, l.guid, COALESCE(l.tax_rate, 0)::float AS "taxRate" FROM ledgers l
       WHERE l.company_id=$1
         AND (
           l.parent IN (SELECT name FROM tax_groups)
           OR l.parent ILIKE '%GST%' OR l.parent ILIKE '%Tax%' OR l.parent ILIKE '%Duty%' OR l.parent ILIKE '%Duties%'
           OR l.name ILIKE '%CGST%' OR l.name ILIKE '%SGST%' OR l.name ILIKE '%IGST%'
           OR l.name ILIKE '%UTGST%' OR l.name ILIKE '%GST%' OR l.name ILIKE '%Cess%'
           OR l.name ILIKE '%TDS%' OR l.name ILIKE '%TCS%'
         )
       ORDER BY l.name ASC`,
      [companyId]
    );
    res.json({ status: true, data: rows });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});


// GET /api/charge-ledgers — Logistics & additional charge ledgers for invoice form
router.get('/charge-ledgers', authMiddleware, async (req, res) => {
  try {
    const companyGuid = req.query.companyGuid || req.user?.defaultCompanyGuid;
    if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
    if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
    const companyId = requireResolvedCompanyId(req);
    // Recursive CTE: walk ALL descendant groups of the 4 root expense/income categories.
    // Simple parent ILIKE was wrong — it only matched ledgers DIRECTLY under the root
    // groups, missing any ledger under a sub-group (e.g. parent='Freight & Forwarding'
    // which is itself under 'Indirect Expenses').
    const { rows } = await query(
      `WITH RECURSIVE expense_income_groups AS (
         -- Anchor: root group names are carried forward so we know the origin of each ledger
         SELECT name, name AS root_name FROM groups
         WHERE company_id=$1
           AND (
             name ILIKE 'Direct Expenses'
             OR name ILIKE 'Indirect Expenses'
             OR name ILIKE 'Direct Incomes'
             OR name ILIKE 'Indirect Incomes'
             OR name ILIKE '%Duties%'
             OR name ILIKE '%Taxes%'
             OR name ILIKE 'Sales Accounts'
             OR name ILIKE 'Purchase Accounts'
           )
         UNION ALL
         SELECT g.name, eig.root_name FROM groups g
         JOIN expense_income_groups eig ON g.parent = eig.name
         WHERE g.company_id=$1
       )
       SELECT DISTINCT l.name, l.guid, l.parent, eig.root_name
       FROM ledgers l
       JOIN expense_income_groups eig ON l.parent = eig.name
       WHERE l.company_id=$1
       ORDER BY l.name ASC`,
      [companyId]
    );
    const normalize = (s) => String(s || '').trim().toLowerCase();
    const LOGISTICS_KW = ['freight','transport','delivery','courier','loading','unloading','handling','cartage','hamali','logistics','forwarding','shipping','dispatch'];
    const ROUND_OFF_KW = ['round off','rounded off','rounding','roundoff'];
    // Tax/GST ledgers belong ONLY in the tax-ledgers endpoint — exclude from charge buckets
    const TAX_KW = ['cgst','sgst','igst','utgst','gst','cess','tds','tcs','excise','vat','service tax','customs'];
    // Pure revenue/purchase roots — ledgers under these should NOT appear in additionalCharges
    const REVENUE_ROOTS = ['sales accounts', 'purchase accounts', 'duties & taxes', 'duties and taxes'];
    const logistics = [], additional = [], roundOff = [];
    rows.forEach(r => {
      const n = normalize(r.name);
      const rootNorm = normalize(r.root_name || '');
      // Tax ledgers go nowhere in this response — they have their own /tax/ledgers endpoint
      if (TAX_KW.some(k => n.includes(k))) return;
      if (ROUND_OFF_KW.some(k => n.includes(k))) { roundOff.push({ ledgerName: r.name, guid: r.guid, parentGroup: r.parent }); return; }
      if (LOGISTICS_KW.some(k => n.includes(k))) { logistics.push({ ledgerName: r.name, guid: r.guid, parentGroup: r.parent }); return; }
      // Skip ledgers rooted under Sales/Purchase/Tax Accounts from the additional charges bucket
      if (REVENUE_ROOTS.some(root => rootNorm.includes(root))) return;
      additional.push({ ledgerName: r.name, guid: r.guid, parentGroup: r.parent });
    });
    res.json({ status: true, data: { logisticsCharges: logistics, additionalCharges: additional, roundOffLedgers: roundOff, allCharges: [...logistics, ...additional, ...roundOff] } });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// PURCHASE
// ══════════════════════════════════════════════════════════════

// GET /api/purchase/home-metrics — Today / MTD / YTD / Avg Ticket (+ trend pills)
router.get('/purchase/home-metrics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const today = new Date().toISOString().slice(0, 10);
    const core = await buildVoucherHomeCoreMetrics(companyId, PURCHASE_HOME_FILTER, fyFrom, fyTo, today, false);
    const [avgMetrics, debitNotes, outstanding] = await Promise.all([
      buildAvgTicketMetrics(companyId, PURCHASE_HOME_FILTER, fyFrom, fyTo, core.ytd),
      buildNoteMetrics(companyId, '%Debit Note%', fyFrom, fyTo),
      buildOutstandingMetrics(companyId, 'AP'),
    ]);
    res.json({
      success: true,
      data: {
        ...core,
        ...outstanding,
        debit_notes: debitNotes.amount,
        debit_notes_trend_pct: debitNotes.trend_pct,
        debit_notes_trend_positive: debitNotes.trend_positive,
        ...avgMetrics,
        from: fyFrom,
        to: fyTo,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/purchase/invoices', authMiddleware, strictInvoiceListHandler('purchase'));
router.get('/purchase/orders',   authMiddleware, voucherListHandler('Purchase Order'));
router.get('/purchase/vouchers/counts', authMiddleware, voucherCountsHandler('purchase'));
router.get('/purchase/vouchers', authMiddleware, combinedVoucherListHandler('purchase'));

// GET /api/purchase/invoices/:id/debit-note-context
// Purchase Return mirror of credit-note-context — remaining qty accounts for Debit
// Notes synced from Tally AND app-created debit_note rows still queued.
router.get('/purchase/invoices/:id/debit-note-context', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const resolved = await resolveDebitNoteContext(companyId, req.params.id);
    if (!resolved.ok) {
      return res.status(resolved.status).json({ success: false, error: { code: resolved.code, message: resolved.message } });
    }
    const { invoice, context } = resolved;
    const returnable = context.items.filter(i => i.remainingQty > 0);
    res.json({
      success: true,
      data: {
        invoice: {
          guid: invoice.guid,
          voucherNumber: invoice.voucher_number || null,
          voucherType: invoice.voucher_type || null,
          voucherTypeParent: invoice.voucher_type_parent || null,
          date: invoice.date || null,
          partyName: invoice.party_name || null,
          partyGuid: invoice.party_guid || null,
          amount: context.totals.invoiceAmount,
          reference: invoice.reference || null,
          narration: invoice.narration || null,
          billRefName: context.linkedInvoice.billRefName,
          tdkRef: context.linkedInvoice.tdkRef,
          financialYear: invoice.financial_year || null,
          isOptional: invoice.is_optional ?? false,
        },
        party: context.party,
        linkedInvoice: context.linkedInvoice,
        items: context.items,
        purchaseLedgerCandidates: context.invoicePurchaseLedgers,
        companyPurchaseLedgers: context.companyPurchaseLedgers,
        defaultPurchaseLedger: context.defaultPurchaseLedger,
        taxes: context.taxes,
        excludedTaxes: context.excludedTaxes || [],
        otherLedgers: context.otherLedgers,
        gst: context.gst,
        returnTaxMode: context.returnTaxMode,
        taxGeometry: context.taxGeometry,
        totals: context.totals,
        priorReturns: context.priorReturns,
        meta: {
          itemCount: context.items.length,
          returnableItemCount: returnable.length,
          fullyReturned: context.items.length > 0 && returnable.length === 0,
          natureOfReturn: '02-Purchase Return',
        },
      },
    });
  } catch (err) {
    console.error('[debit-note-context]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/purchase/debit-notes', authMiddleware, voucherListHandler('Debit Note'));

// ══════════════════════════════════════════════════════════════
// VOUCHERS
// ══════════════════════════════════════════════════════════════

router.get('/vouchers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { type, search = '', page = 1, limit = 30, from, to } = req.query;
  const typeMap = { payment: 'Payment', receipt: 'Receipt', journal: 'Journal', contra: 'Contra', sales: 'Sales', purchase: 'Purchase' };
  const vType = typeMap[type] || null;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    let q = `SELECT * FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND NOT (voucher_type='Voucher' AND (amount=0 OR amount IS NULL)) AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
    const params = [companyId, `%${search}%`];
    let idx = 3;
    if (vType) { q += ` AND voucher_type ILIKE $${idx++}`; params.push(`%${vType}%`); }
    if (from)  { q += ` AND date >= $${idx++}`; params.push(from); }
    if (to)    { q += ` AND date <= $${idx++}`; params.push(to); }
    q += ` ORDER BY date DESC, id DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE`, [companyId]);
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
  const companyId = requireResolvedCompanyId(req);
  const { from, to, type, page = 1, limit = 50 } = req.query;
  const userId = req.user.userId;
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    // 1. Posted vouchers (synced back from Tally)
    let q = `
      SELECT DISTINCT
        v.*,
        'posted' as _queue_status,
        wq.id as _queue_id,
        av.tdk_reference_no,
        av.original_entry_type,
        av.current_entry_type,
        av.books_impact_status,
        av.conversion_status,
        av.e_invoice_status,
        av.e_way_bill_status,
        av.tally_voucher_no as av_tally_voucher_no,
        av.parent_invoice_uuid,
        av.created_at as av_created_at,
        av.id as av_id,
        av.voucher_type as app_voucher_type,
        parent_av.tdk_reference_no as parent_tdk_reference_no,
        parent_av.tally_voucher_no as parent_tally_voucher_no
      FROM vouchers v
      -- Primary join path: via app_vouchers.tally_voucher_no (Tally's ImportData rarely returns
      -- voucher number in callback, so write_queue.tally_voucher_number is often empty.
      -- app_vouchers.tally_voucher_no is always populated by ingestProcessor reconciliation.)
      --
      -- IMPORTANT (2026-07-01): Tally Receipt voucher_numbers are sequential ('1','2','3'...)
      -- and collide with every other Receipt/Contra/Journal/etc across ALL years. Sales invoice
      -- numbers (e.g. 'TD2731-3-2026') are globally unique so they don't collide. Without the
      -- date+voucher_type disambiguators below, a single Receipt row would fan out to 40+
      -- Tally rows across the years (Cartesian collision). The extra JOIN predicates collapse
      -- the fanout to exactly 1 Tally row per app_voucher.
      JOIN app_vouchers av ON av.tally_voucher_no = v.voucher_number
        AND av.company_id = v.company_id
        AND av.voucher_date::text = v.date
        -- When TDK reference exists, use it as the primary identity guard.
        -- This prevents fan-out when Tally allows duplicate voucher numbers
        -- (e.g. optional + regular or multiple optional Sales sharing number).
        AND (
          (COALESCE(av.tdk_reference_no, '') <> '' AND COALESCE(v.reference, '') = av.tdk_reference_no)
          OR (COALESCE(av.tdk_reference_no, '') = '')
        )
        AND (
          (av.voucher_type = 'receipt'       AND v.voucher_type ILIKE 'Receipt')
          OR (av.voucher_type = 'sales_order' AND v.voucher_type ILIKE '%Sales Order%')
          OR (av.voucher_type = 'sales_invoice' AND v.voucher_type ILIKE 'Sales%' AND v.voucher_type NOT ILIKE '%Order%')
          OR (av.voucher_type = 'proforma_invoice' AND v.voucher_type ILIKE 'Sales%' AND v.voucher_type NOT ILIKE '%Order%')
          OR (av.voucher_type = 'payment'       AND v.voucher_type ILIKE 'Payment')
          OR (av.voucher_type = 'journal'       AND v.voucher_type ILIKE 'Journal')
          OR (av.voucher_type = 'contra'        AND v.voucher_type ILIKE 'Contra')
          OR (av.voucher_type IN ('purchase', 'purchase_invoice') AND v.voucher_type ILIKE 'Purchase%' AND v.voucher_type NOT ILIKE '%Order%')
          -- Credit/Debit Note numbers are sequential ('1','2','3'…) like Receipts, so the
          -- explicit pair keeps the type predicate tight alongside the date match.
          OR (av.voucher_type = 'credit_note'   AND v.voucher_type ILIKE '%Credit Note%')
          OR (av.voucher_type = 'debit_note'    AND v.voucher_type ILIKE '%Debit Note%')
          OR (
            av.voucher_type NOT IN ('receipt','sales_invoice','proforma_invoice','sales_order','payment','journal','contra','purchase','purchase_invoice','credit_note','debit_note')
            AND LOWER(COALESCE(v.voucher_type,'')) LIKE '%' || REPLACE(av.voucher_type, '_', ' ') || '%'
          )
        )
      JOIN write_queue wq ON wq.id = av.write_queue_id
      LEFT JOIN app_vouchers parent_av ON parent_av.invoice_uuid = av.parent_invoice_uuid
      WHERE v.company_id=$1 AND wq.user_id = $2 AND v.is_cancelled = FALSE
    `;
    const params = [companyId, userId];
    let idx = 3;
    if (from) { q += ` AND v.date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND v.date <= $${idx++}`; params.push(to); }
    if (type) { q += ` AND v.voucher_type ILIKE $${idx++}`; params.push(`%${type}%`); }
    // Sort by BUSINESS DATE first (v.date DESC) so current month is always on top,
    // then by entry timestamp (av.created_at DESC) so freshest same-day action lands above
    // older same-day entries. Final tiebreak av.id ASC preserves intra-pair sequence:
    // when a Sales+Receipt pair share the same date + created_at, Sales (lower id, inserted
    // first) appears above its Receipt — matching the real business flow order.
    // 2026-07-01 fix: was `av.created_at DESC, av.id ASC` alone which broke cross-month
    // ordering (June rows re-touched after July creation floated above July entries).
    q += ` ORDER BY v.date DESC, av.created_at DESC, av.id ASC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows: postedRows } = await query(q, params);

    // 1b. Posted masters (party/bank/warehouse/item) — confirmed by ingest via app_masters
    const { rows: postedMasterRows } = await query(`
      SELECT
        wq.id as _queue_id,
        wq.entry_type as voucher_type,
        wq.entry_label as party_name,
        'posted' as _queue_status,
        NULL as _queue_error,
        wq.attempt_count,
        TO_CHAR(TO_TIMESTAMP(wq.created_at), 'YYYY-MM-DD') as date,
        wq.created_at,
        NULL as voucher_number,
        wq.amount as amount,
        COALESCE(am.payload, wq.payload) as _payload,
        am.tally_guid as guid,
        NULL as tdk_reference_no,
        'regular' as original_entry_type,
        'regular' as current_entry_type,
        am.books_impact_status,
        NULL as conversion_status,
        'not_applicable' as e_invoice_status,
        'not_required' as e_way_bill_status,
        NULL as av_tally_voucher_no,
        NULL as parent_invoice_uuid,
        NULL as parent_tdk_reference_no,
        NULL as parent_tally_voucher_no,
        TRUE as _is_master
      FROM app_masters am
      JOIN write_queue wq ON wq.id = am.write_queue_id
      WHERE am.company_id=$1
        AND am.user_id = $2
        AND am.books_impact_status = 'posted'
        AND ($3::text IS NULL OR TO_CHAR(TO_TIMESTAMP(wq.created_at), 'YYYY-MM-DD') >= $3)
        AND ($4::text IS NULL OR TO_CHAR(TO_TIMESTAMP(wq.created_at), 'YYYY-MM-DD') <= $4)
      ORDER BY wq.created_at DESC
      LIMIT 100
    `, [companyId, userId, from || null, to || null]);

    // 2. Pending/failed write_queue entries not yet in vouchers
    // Also include 'success' entries for non-standard voucher types (stock_transfer, stock_adjustment)
    // that may not produce a joinable tally_voucher_number match
    // Masters: exclude rows already posted via app_masters
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
        COALESCE(am.payload, wq.payload) as _payload,
        am.tally_guid as guid,
        av.tdk_reference_no,
        COALESCE(av.original_entry_type, CASE WHEN am.id IS NOT NULL THEN 'regular' ELSE NULL END) as original_entry_type,
        COALESCE(av.current_entry_type,  CASE WHEN am.id IS NOT NULL THEN 'regular' ELSE NULL END) as current_entry_type,
        COALESCE(am.books_impact_status, av.books_impact_status) as books_impact_status,
        av.conversion_status,
        av.e_invoice_status,
        av.e_way_bill_status,
        av.tally_voucher_no as av_tally_voucher_no,
        av.voucher_type as app_voucher_type,
        av.parent_invoice_uuid,
        parent_av.tdk_reference_no as parent_tdk_reference_no,
        parent_av.tally_voucher_no as parent_tally_voucher_no,
        (am.id IS NOT NULL) as _is_master
      FROM write_queue wq
      LEFT JOIN app_vouchers av ON av.write_queue_id = wq.id
      LEFT JOIN app_vouchers parent_av ON parent_av.invoice_uuid = av.parent_invoice_uuid
      LEFT JOIN app_masters am ON am.write_queue_id = wq.id
      WHERE wq.company_id=$1
        AND wq.user_id = $2
        AND wq.entry_type IS DISTINCT FROM 'proforma_convert'
        AND (
          wq.status IN ('pending', 'processing', 'desktop_offline', 'failed')
          OR (
            wq.status = 'success'
            AND wq.created_at > EXTRACT(EPOCH FROM NOW())::BIGINT - 2592000
          )
        )
        -- IMPORTANT: am is LEFT JOIN — when no app_masters row, books_impact_status is NULL.
        -- NOT (NULL = posted) evaluates to NULL and drops the row. Use COALESCE.
        AND COALESCE(am.books_impact_status, 'not_posted') <> 'posted'
      ORDER BY wq.created_at DESC
      LIMIT 50
    `, [companyId, userId]);

    const { lifecycleFilter } = req.query;

    // Apply lifecycle filter to combined results (filter on JS side — simpler than complex SQL)
    let allRows = [...pendingRows, ...postedMasterRows, ...postedRows];
    if (lifecycleFilter && lifecycleFilter !== 'all') {
      allRows = allRows.filter(r => {
        const entryType  = r.current_entry_type || r.original_entry_type;
        const origType   = r.original_entry_type;
        const syncStatus = r._queue_status;
        const eInvoice   = r.e_invoice_status;
        const eWayBill   = r.e_way_bill_status;
        const isMaster   = r._is_master || ['party','bank','warehouse','item','alter_stock_item'].includes(r.voucher_type);

        if (lifecycleFilter === 'pending_sync')
          return ['pending', 'processing', 'desktop_offline'].includes(syncStatus)
            || (isMaster && r.books_impact_status === 'not_posted' && syncStatus === 'success');
        if (lifecycleFilter === 'regular')
          return isMaster
            || entryType === 'regular'
            || (!entryType && syncStatus === 'posted');
        if (lifecycleFilter === 'optional')
          return !isMaster && entryType === 'optional';
        if (lifecycleFilter === 'originally_optional')
          return !isMaster && origType === 'optional' && entryType === 'regular';
        if (lifecycleFilter === 'failed')
          return syncStatus === 'failed';
        if (lifecycleFilter === 'irn_pending')
          return !['not_applicable', 'not_required', 'generated', 'cancelled'].includes(eInvoice || 'not_applicable');
        if (lifecycleFilter === 'ewb_pending')
          return !['not_applicable', 'not_required', 'generated', 'cancelled'].includes(eWayBill || 'not_applicable');
        return true;
      });
    }

    // The caller's own simulated Demo entries, listed alongside real ones and
    // never mixed into them. They carry no Tally status because they were never
    // sent anywhere.
    const demoRows = (await listDemoEntries({ userId: req.user.userId, workspaceId: req.workspaceId }))
      .map(toMyEntriesRow);

    res.json({
      success: true,
      data: allRows.filter(r => r._queue_status === 'posted'),
      pending: allRows.filter(r => r._queue_status !== 'posted'),
      simulated: demoRows,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── Private simulated Demo entries ──────────────────────────────────────────
// Demo is a shared immutable fixture, so practice entries live beside it rather
// than inside it. Ownership is the authenticated user in every statement; there
// is no path that reads or deletes another user's rows.

router.post('/demo/entries', authMiddleware, resolveWorkspaceMiddleware, async (req, res) => {
  try {
    const { entryType, payload } = req.body || {};
    const row = await createDemoEntry({
      userId: req.user.userId,
      workspaceId: req.workspaceId,
      companyId: req.company?.id ?? null,
      entryType,
      payload,
    });
    res.status(201).json({ success: true, data: toMyEntriesRow(row) });
  } catch (err) {
    res.status(err.httpStatus || 500).json({
      success: false,
      error: { code: err.httpStatus === 400 ? 'VALIDATION_ERROR' : 'SERVER_ERROR', message: err.message },
    });
  }
});

router.get('/demo/entries', authMiddleware, resolveWorkspaceMiddleware, async (req, res) => {
  try {
    const rows = await listDemoEntries({ userId: req.user.userId, workspaceId: req.workspaceId });
    res.json({ success: true, data: rows.map(toMyEntriesRow) });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.delete('/demo/entries/:id', authMiddleware, async (req, res) => {
  try {
    const ok = await deleteDemoEntry({ userId: req.user.userId, entryId: Number(req.params.id) });
    if (!ok) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Entry not found' } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.delete('/demo/entries', authMiddleware, resolveWorkspaceMiddleware, async (req, res) => {
  try {
    const removed = await clearDemoEntries({ userId: req.user.userId, workspaceId: req.workspaceId });
    res.json({ success: true, data: { removed } });
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
    // Use retrySingleEntry to safely push one entry without race conditions
    const { retrySingleEntry } = await import('./tally-write.js');
    const result = await retrySingleEntry(id, userId);
    if (result.alreadyProcessing) {
      return res.status(409).json({ success: false, alreadyProcessing: true, message: result.message });
    }
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
  const companyId = requireResolvedCompanyId(req);
  const { id } = req.params;
  try {
    // Prefer GUID match; fall back to voucher_number (most recent when number repeats across FYs)
    const { rows: vRows } = await query(
      'SELECT * FROM vouchers WHERE company_id=$2 AND (guid=$1 OR voucher_number=$1) ORDER BY (guid=$1)::int DESC, date DESC LIMIT 1',
      [id, companyId]
    );
    if (!vRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Voucher not found' } });
    const v = vRows[0];
    // Inventory items (for Sales/Purchase vouchers)
    const { rows: items } = await query('SELECT * FROM voucher_inventory_items WHERE voucher_guid=$1 AND company_id=$2 ORDER BY id', [v.guid, companyId]);
    // GST details
    const { rows: gst } = await query('SELECT * FROM gst_voucher_details WHERE voucher_guid=$1 AND company_id=$2 LIMIT 1', [v.guid, companyId]);
    // Company info — full profile
    const { rows: co } = await query('SELECT name, formal_name, gstin, pan, phone, mobile, email, website, address, state, pincode, country FROM companies WHERE id=$1 LIMIT 1', [companyId]);
    // Party ledger details (GSTIN, address etc) — state_name feeds Place of Supply on the print
    const { rows: partyLedger } = await query('SELECT name, gstin, pan, phone, mobile, email, address, state_name, pincode FROM ledgers WHERE company_id=$1 AND name=$2 LIMIT 1', [companyId, v.party_name || '']);
    // Ledger entries — used to compute the TRUE party amount (not v.amount which may be wrong)
    const { rows: ledgerEntries } = await query(
      'SELECT ledger_name, amount, dr_cr FROM voucher_ledger_entries WHERE voucher_guid=$1 AND company_id=$2 ORDER BY ABS(amount) DESC',
      [v.guid, companyId]
    );
    // Party amount = the Dr entry for the party ledger (what party owes / paid)
    const partyEntry = ledgerEntries.find(e => e.ledger_name === v.party_name);
    const partyAmount = partyEntry ? Math.abs(parseFloat(partyEntry.amount||'0')) : parseFloat(v.amount||'0');
    // App voucher payload — dispatch_details, collect_payment, narration (from app, not Tally)
    const { rows: avRows } = await query(
      `SELECT payload FROM app_vouchers WHERE tally_voucher_no=$1 AND company_id=$2 LIMIT 1`,
      [v.voucher_number, companyId]
    ).catch(() => ({ rows: [] }));
    const avPayload = avRows[0]?.payload || null;
    // Compliance acknowledgements — the IRN band and e-Way Bill line on the print.
    const [{ rows: eInv }, { rows: eWb }] = await Promise.all([
      query('SELECT irn, ack_no, ack_date, qr_code, status FROM e_invoice_details WHERE voucher_guid=$1 AND company_id=$2 LIMIT 1', [v.guid, companyId]).catch(() => ({ rows: [] })),
      query('SELECT ewb_no, ewb_date, valid_till, vehicle_no, transporter_id, status FROM e_way_bill_details WHERE voucher_guid=$1 AND company_id=$2 LIMIT 1', [v.guid, companyId]).catch(() => ({ rows: [] })),
    ]);
    res.json({
      success: true,
      data: {
        voucher: { ...v, party_amount: partyAmount }, // party_amount = authoritative per-party amount
        items,
        gst: gst[0] || null,
        company: co[0] || null,
        party: partyLedger[0] || null,
        ledger_entries: ledgerEntries,
        e_invoice: eInv[0] || null,
        e_way_bill: eWb[0] || null,
        // App-origin data — present only for TallyDekho-created vouchers
        dispatch_details: avPayload?.dispatch_details || null,
        collect_payment: avPayload?.collect_payment || null,
        make_payment: avPayload?.make_payment || null,
        app_narration: avPayload?.narration || null,
        logistics: avPayload?.logistics || null,
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
  const companyId = requireResolvedCompanyId(req);
  const { search = '', nature, group, page = 1, limit = 200 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // If FY params provided, compute FY-specific closing balance (opening + net movement)
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
  const fyPrefix = fyLikePrefix(financialYear);
  try {
    let q = `
      SELECT l.*,
        TRIM(COALESCE(l.parent, '')) as parent,
        -- FY-specific computed closing balance
        COALESCE(lfb.opening_balance, l.opening_balance, 0) as fy_opening_abs,
        COALESCE(lfb.balance_type, l.balance_type, 'Dr') as fy_opening_type,
        COALESCE((
          SELECT SUM(vle.amount)
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
          WHERE vle.company_id = l.company_id AND vle.ledger_name = l.name
            AND v.date >= $4 AND v.date <= $5
            AND (v.is_cancelled IS NULL OR v.is_cancelled = FALSE)
        ), 0) as fy_movement,
        -- Stored nature (often null — inferred below from group hierarchy)
        COALESCE(NULLIF(TRIM(l.nature), ''), NULLIF(TRIM(g.nature), '')) as stored_nature
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_id = l.company_id AND lfb.ledger_name = l.name AND ${sqlLfbJoin('lfb', 3, 6)}
      -- DISTINCT ON: Tally can sync duplicate group rows with the same name; a plain
      -- JOIN fans out every ledger under that parent (same guid twice → React key crash).
      LEFT JOIN (
        SELECT DISTINCT ON (company_guid, name) company_guid, name, nature
        FROM groups
        ORDER BY company_guid, name
      ) g
        ON g.company_id = l.company_id AND g.name = TRIM(l.parent)
      WHERE l.company_id=$1 AND (l.name ILIKE $2 OR l.alias ILIKE $2 OR l.gstin ILIKE $2)
    `;
    const params = [companyId, `%${search}%`, financialYear, fyFrom, fyTo, fyPrefix];
    let idx = 7;
    // Group filter (supports comma-separated multi)
    const groupList = String(group || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (groupList.length === 1) {
      q += ` AND TRIM(l.parent) = $${idx++}`;
      params.push(groupList[0]);
    } else if (groupList.length > 1) {
      q += ` AND TRIM(l.parent) = ANY($${idx++})`;
      params.push(groupList);
    }
    // When nature is requested, load all matching search/group rows then paginate after inference.
    // Otherwise apply SQL pagination as usual.
    const natureList = String(nature || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (natureList.length === 0) {
      q += ` ORDER BY ABS(l.closing_balance) DESC, l.name LIMIT $${idx++} OFFSET $${idx}`;
      params.push(parseInt(limit), offset);
    } else {
      q += ` ORDER BY ABS(l.closing_balance) DESC, l.name`;
    }

    const [{ rows }, { rows: groupRows }, { rows: cnt }] = await Promise.all([
      query(q, params),
      query('SELECT name, parent, nature FROM groups WHERE company_id=$1', [companyId]),
      query('SELECT COUNT(*) as c FROM ledgers WHERE company_id=$1', [companyId]),
    ]);
    const parentByName = buildGroupParentMap(groupRows);

    // Compute FY closing + inferred nature
    let data = rows.map(l => {
      const bt = l.fy_opening_type || 'Dr';
      const openSigned = bt === 'Dr' ? -Math.abs(parseFloat(l.fy_opening_abs||0)) : Math.abs(parseFloat(l.fy_opening_abs||0));
      const closeSigned = openSigned + parseFloat(l.fy_movement||0);
      const parent = String(l.parent || '').trim();
      const natureVal = inferLedgerNature(parent, parentByName, l.stored_nature);
      return {
        ...l,
        parent: parent || null,
        nature: natureVal || null,
        closing_balance: Math.abs(closeSigned),   // FY-computed closing
        balance_type:    closeSigned <= 0 ? 'Dr' : 'Cr',
      };
    });

    if (natureList.length > 0) {
      const wants = natureList.map((s) => s.toLowerCase());
      data = data.filter(l => {
        const n = String(l.nature || '').toLowerCase();
        if (!n) return false;
        return wants.some((want) => n === want || n.startsWith(want) || want.startsWith(n));
      });
      const totalFiltered = data.length;
      data = data.slice(offset, offset + parseInt(limit));
      return res.json({
        success: true,
        data,
        meta: { total: totalFiltered, page: parseInt(page), limit: parseInt(limit) },
      });
    }

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
  const companyId = requireResolvedCompanyId(req);
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
  const fyPrefix = fyLikePrefix(financialYear);
  try {
    // V2: Use financial_year column directly + ledger_fy_balances for opening
    // opening = from ledger_fy_balances (LedgerOpeningBalance.xml per FY)
    // closing = opening + SUM(vle in date window)
    const { rows } = await query(`
      SELECT
        l.guid, l.name, l.parent, l.balance_type,
        COALESCE(lfb.opening_balance, l.opening_balance, 0) as fy_opening_abs,
        COALESCE(lfb.balance_type, l.balance_type, 'Dr')    as fy_balance_type,
        COALESCE((
          SELECT SUM(vle.amount)
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
          WHERE vle.company_id = l.company_id
            AND vle.ledger_name  = l.name
            AND v.date >= $3 AND v.date <= $4
            AND (v.is_cancelled IS NULL OR v.is_cancelled = FALSE)
        ), 0) as fy_movement
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_id = l.company_id
        AND lfb.ledger_name  = l.name
        AND ${sqlLfbJoin('lfb', 2, 5)}
      WHERE l.company_id=$1
    `, [companyId, financialYear, fyFrom, fyTo, fyPrefix]);

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
  const companyId = requireResolvedCompanyId(req);
  const { id } = req.params;
  const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
  try {
    const { rows: lr } = await query('SELECT * FROM ledgers WHERE company_id=$1 AND guid=$2', [companyId, id]);
    if (!lr[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ledger not found' } });
    const ledger = lr[0];
    const ledgerName = ledger.name;

    // Get all vouchers that have a ledger entry for this ledger within the FY
    const { rows: txns } = await query(`
      SELECT v.guid, v.voucher_number, v.voucher_type, v.date, v.narration, v.party_name,
             vle.amount as entry_amount, vle.dr_cr
      FROM voucher_ledger_entries vle
      JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
      WHERE vle.company_id=$1
        AND vle.ledger_name = $2
        AND v.is_cancelled = FALSE
        AND v.date IS NOT NULL AND v.date != ''
        AND v.date BETWEEN $3 AND $4
      ORDER BY v.date ASC, v.id ASC
    `, [companyId, ledgerName, fyFrom, fyTo]);

    // V2: FY-specific opening balance from ledger_fy_balances table
    // Source: LedgerOpeningBalance.xml per FY — Tally's authoritative opening per year
    // Fallback: use ledger.opening_balance from LedgerFull.xml (current FY opening)
    const { rows: fyBalRows } = await query(
      'SELECT opening_balance, balance_type FROM ledger_fy_balances WHERE company_id=$1 AND ledger_name=$2 AND financial_year=$3 LIMIT 1',
      [companyId, ledgerName, financialYear]
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
  const companyId = requireResolvedCompanyId(req);
  const { id } = req.params;
  try {
    const { rows: lr } = await query('SELECT * FROM ledgers WHERE company_id=$1 AND guid=$2', [companyId, id]);
    if (!lr[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Ledger not found' } });
    const { from, to, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    // Join with voucher_ledger_entries to get the per-ledger entry amount (not the full voucher total)
    let tq = `
      SELECT v.*, 
        ABS(vle.amount) as entry_amount, vle.dr_cr as entry_dr_cr
      FROM vouchers v
      LEFT JOIN voucher_ledger_entries vle 
        ON vle.voucher_guid = v.guid AND vle.company_id = v.company_id AND vle.ledger_name = $3
      WHERE v.company_id=$1 AND (v.party_guid=$2 OR v.party_name=$3) AND v.is_cancelled=FALSE
    `;
    const tp = [companyId, id, lr[0].name];
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

/** Comma-separated query param → trimmed string list (Ledger-style multi filter). */
function parseCsvQueryParam(val) {
  return String(val || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Warehouse filter: union of items in any selected WH; one row per item with combined qty/value.
 * Uses stock_transactions net qty per godown (same model as negative-stock breakdown).
 */
async function applyMultiWarehouseStockFilter(companyGuid, rows, warehouseList, { fyTo = null } = {}) {
  if (!warehouseList.length) return rows;

  const normWh = (w) => (w && String(w).trim()) || 'Main Location';
  const whNormList = warehouseList.map(normWh);

  const { rows: whQtyRows } = await query(
    fyTo
      ? `SELECT stock_guid,
                COALESCE(NULLIF(warehouse, ''), 'Main Location') AS warehouse,
                SUM(CASE WHEN type = 'inward' THEN ABS(qty) ELSE -ABS(qty) END) AS net_qty
         FROM stock_transactions
         WHERE company_id=$1
           AND date <= $2
           AND COALESCE(NULLIF(warehouse, ''), 'Main Location') = ANY($3)
           AND voucher_type != 'Physical Stock'
         GROUP BY stock_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')`
      : `SELECT stock_guid,
                COALESCE(NULLIF(warehouse, ''), 'Main Location') AS warehouse,
                SUM(CASE WHEN type = 'inward' THEN ABS(qty) ELSE -ABS(qty) END) AS net_qty
         FROM stock_transactions
         WHERE company_id=$1
           AND COALESCE(NULLIF(warehouse, ''), 'Main Location') = ANY($2)
           AND voucher_type != 'Physical Stock'
         GROUP BY stock_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')`,
    fyTo ? [companyId, fyTo, whNormList] : [companyId, whNormList]
  );

  const qtyByStock = {};
  const activeSet = new Set();
  for (const r of whQtyRows) {
    activeSet.add(r.stock_guid);
    if (!qtyByStock[r.stock_guid]) qtyByStock[r.stock_guid] = 0;
    qtyByStock[r.stock_guid] += parseFloat(r.net_qty || 0);
  }

  return rows
    .filter((r) => activeSet.has(r.name))
    .map((r) => {
      const qty = qtyByStock[r.name] ?? 0;
      const rate = parseFloat(r.closing_rate || 0);
      const value = qty * rate;
      return {
        ...r,
        closing_qty: qty,
        closing_value: value,
        fy_closing_qty: qty,
        fy_closing_value: value,
        primary_warehouse: warehouseList.length === 1 ? whNormList[0] : (r.primary_warehouse || null),
      };
    });
}

// GET /api/stocks/dashboard — canonical replacement for POST /app/stock-dashboard
router.get('/stocks/dashboard', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  }
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const data = await buildStockDashboardInsights(query, companyId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('[stocks/dashboard]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: 'Failed' } });
  }
});

// GET /api/stocks/items
// Per Tally FY guide §3.4: Stock qty is NEVER static. It's always derived from transactions.
// When fy= param is passed: compute FY-specific closing qty from stock_transactions
// When no fy param: serve stored closing_qty (as-of last sync = current stock)
router.get('/stocks/items', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { search = '', category, warehouse, group, page = 1, limit = 500 } = req.query; // Default 500
  const warehouseList = parseCsvQueryParam(warehouse);
  const groupList = parseCsvQueryParam(group);
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const fyRequested = !!(req.query.fy || req.query.from || req.query.to);
    const displayField = await getProductDisplayField(companyId);

    let q, params, idx;
    if (fyRequested) {
      // FY-specific: derive closing qty from stock_transactions up to fyTo (Tally FY guide compliant)
      q = `
        SELECT s.guid, s.name, s.alias, s.sku, s.description, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
               s.reorder_level, s.closing_rate,
               (SELECT st2.warehouse FROM stock_transactions st2
                WHERE st2.company_id = s.company_id AND st2.stock_guid = s.name
                ORDER BY st2.date DESC LIMIT 1) AS primary_warehouse,
               (
                 SELECT ROUND(
                   COALESCE(SUM(ABS(stc.qty)), 0) /
                   GREATEST((NOW()::date - MIN(stc.date::date)), 1)
                 , 4)
                 FROM stock_transactions stc
                 WHERE stc.company_id = s.company_id
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
        LEFT JOIN stock_transactions st ON st.stock_guid = s.name AND st.company_id = s.company_id
          AND st.date <= $3
          AND st.voucher_type != 'Physical Stock'
          AND COALESCE(st.voucher_type, '') != 'Opening Balance'
        WHERE s.company_id=$1
          AND (s.name ILIKE $2 OR s.alias ILIKE $2 OR s.hsn ILIKE $2)
        GROUP BY s.guid, s.company_id, s.name, s.alias, s.sku, s.description, s.category, s.group_name, s.unit, s.hsn, s.tax_rate,
                 s.reorder_level, s.closing_rate, s.opening_qty
        ORDER BY fy_closing_value DESC NULLS LAST, s.name
      `;
      params = [companyId, `%${search}%`, fyTo];
      if (category) { q = q.replace('GROUP BY', `AND s.category = $4 GROUP BY`); params.push(category); }
      if (groupList.length === 1) {
        q = q.replace('GROUP BY', `AND TRIM(s.group_name) = $${params.length + 1} GROUP BY`);
        params.push(groupList[0]);
      } else if (groupList.length > 1) {
        q = q.replace('GROUP BY', `AND TRIM(s.group_name) = ANY($${params.length + 1}) GROUP BY`);
        params.push(groupList);
      }
      const { rows: rawRows } = await query(q, params);
      let allRows = await applyMultiWarehouseStockFilter(companyGuid, rawRows, warehouseList, { fyTo });
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
       WHERE st.company_id = s.company_id AND st.stock_guid = s.name
       ORDER BY st.date DESC LIMIT 1) AS primary_warehouse,
      (
        SELECT ROUND(
          COALESCE(SUM(ABS(stc.qty)), 0) /
          GREATEST((NOW()::date - MIN(stc.date::date)), 1)
        , 4)
        FROM stock_transactions stc
        WHERE stc.company_id = s.company_id
          AND stc.stock_guid = s.name
          AND stc.type = 'outward'
          AND stc.date::date >= (NOW() - INTERVAL '90 days')::date
      ) AS avg_daily_consumption
    FROM stocks s
    WHERE s.company_id=$1 AND (s.name ILIKE $2 OR s.alias ILIKE $2 OR s.hsn ILIKE $2)`;
    params = [companyId, `%${search}%`];
    idx = 3;
    if (category) { q += ` AND category = $${idx++}`; params.push(category); }
    if (groupList.length === 1) {
      q += ` AND TRIM(group_name) = $${idx++}`;
      params.push(groupList[0]);
    } else if (groupList.length > 1) {
      q += ` AND TRIM(group_name) = ANY($${idx++})`;
      params.push(groupList);
    }
    q += ` ORDER BY closing_value DESC NULLS LAST, name`;
    const { rows: rawItems } = await query(q, params);
    let allRows = await applyMultiWarehouseStockFilter(companyGuid, rawItems, warehouseList);
    const totalRows = allRows.length;
    const pageRows = allRows.slice(offset, offset + parseInt(limit));
    const totalValue = allRows.reduce((s, r) => s + parseFloat(r.closing_value || 0), 0);
    const lowStockCnt = allRows.filter(r => parseFloat(r.closing_qty || 0) > 0 && parseFloat(r.closing_qty || 0) <= parseFloat(r.reorder_level || 0)).length;
    const items = pageRows.map(r => ({ ...r, displayName: computeDisplayName(r, displayField) }));
    res.json({
      success: true,
      data: {
        summary: { total_value: `₹${(totalValue/1e5).toFixed(1)}L`, total_skus: totalRows, low_stock_count: lowStockCnt },
        items,
      },
      meta: { total: totalRows, page: parseInt(page) }
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

  const companyId = requireResolvedCompanyId(req);
  const page      = Math.max(1, parseInt(req.query.page     || 1));
  const pageSize  = Math.min(500, Math.max(1, parseInt(req.query.pageSize || 25)));
  const offset    = (page - 1) * pageSize;
  const warehouse = req.query.warehouse || null;

  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const fyRequested = !!(req.query.fy || req.query.from || req.query.to);
    const displayField = await getProductDisplayField(companyId);

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
          ON s.name = sfv.stock_name AND s.company_id = sfv.company_id
        WHERE sfv.company_id=$1
          AND sfv.financial_year = $2
          AND sfv.closing_qty < 0
        ORDER BY sfv.closing_qty ASC
      `, [companyId, financialYear]);

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
          WHERE company_id=$1
            AND qty IS NOT NULL
            AND date <= $2
            AND stock_guid = ANY($3)
            AND voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse movement totals
          GROUP BY stock_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')
        `, [companyId, fyTo, stockNames]);
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
      const params = [companyId];
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
          WHERE company_id=$1 AND qty IS NOT NULL
            AND voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse movement totals
          GROUP BY stock_guid, company_guid, COALESCE(NULLIF(warehouse, ''), 'Main Location')
          ${whFilter}
        ) wh ON wh.stock_guid = s.name AND wh.company_id = s.company_id
        WHERE s.company_id=$1 AND s.closing_qty < 0
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
  const companyId = requireResolvedCompanyId(req);
  const { fy } = req.query;
  try {
    const { financialYear } = await resolveFYDates(companyId, null, null, fy);
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
      LEFT JOIN stocks s ON s.name = ba.stock_item_name AND s.company_id = ba.company_id
      WHERE ba.company_id=$1
        AND ($2::text IS NULL OR ba.financial_year = $2)
      GROUP BY
        ba.stock_item_name, COALESCE(NULLIF(s.sku,''), NULLIF(s.alias,''), ''),
        COALESCE(s.group_name,''), ba.batch_name,
        COALESCE(NULLIF(ba.godown_name,''), 'Main Location'),
        ba.expiry_date, ba.mfg_date
      HAVING SUM(ba.qty) != 0
      ORDER BY ba.expiry_date ASC NULLS LAST, ba.stock_item_name ASC
    `, [companyId, fyParam]);

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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);

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
       AND st.company_id = s.company_id
       AND st.date::date >= $2::date
       AND st.date::date <= $3::date
       AND st.voucher_type != 'Physical Stock'  -- exclude audit counts from velocity calculation
      WHERE s.company_id=$1
      GROUP BY s.guid, s.name, s.group_name, s.unit, s.category, s.closing_rate, s.closing_qty, s.sku, s.alias
      ORDER BY total_outward_qty DESC, s.name ASC
    `, [companyId, fyFrom, fyTo]);

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
       FROM company_inventory_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
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

    const displayField = await getProductDisplayField(companyId);
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
  const companyId = requireResolvedCompanyId(req);
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
          AND st_out.company_id  = s.company_id
          AND st_out.type          = 'outward'
          AND st_out.voucher_type NOT IN ('Stock Journal','Physical Stock')
        LEFT JOIN stock_transactions st_in
          ON  st_in.stock_guid    = s.name
          AND st_in.company_id  = s.company_id
          AND st_in.type          = 'inward'
          AND st_in.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        WHERE s.company_id=$1
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
    `, [companyId, mode, bucketStart, bucketEnd]);

    const displayField  = await getProductDisplayField(companyId);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { fy } = req.query;
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, null, null, fy);

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
          AND st.company_id = s.company_id
          AND st.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        WHERE s.company_id=$1
          AND (
            -- Items currently in stock
            COALESCE(s.closing_qty, 0) > 0
            -- OR items recently sold out but had movement in this FY
            OR EXISTS (
              SELECT 1 FROM stock_transactions st2
              WHERE st2.stock_guid   = s.name
                AND st2.company_id = s.company_id
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
    `, [companyId, fyFrom, fyTo]);

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
  const companyId = requireResolvedCompanyId(req);
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
        WHERE company_id=$1
          AND stock_guid   = $2
          AND type IN ('outward', 'inward')
          AND voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
        GROUP BY date
        ORDER BY date DESC
        LIMIT 30
      ) sub
      ORDER BY date ASC
    `, [companyId, item]);

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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { fy } = req.query;
    let financialYear = fy || null;

    // ── 1. All registered warehouses — always included even if empty ─────────────────────
    const { rows: allWarehouses } = await query(
      'SELECT name FROM warehouses WHERE company_id=$1 ORDER BY name',
      [companyId]
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
      WHERE ba.company_id=$1
      GROUP BY ba.godown_name, ba.stock_item_name
      HAVING GREATEST(SUM(COALESCE(ba.qty, 0)), 0) > 0
    `, [companyId]);

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
      WHERE company_id=$1
    `, [companyId]);

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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { fy, from: qFrom, to: qTo, page = 1, limit = 30 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    let fyFrom = null, fyTo = null;
    if (qFrom && qTo) {
      // Explicit date range overrides FY
      fyFrom = qFrom;
      fyTo   = qTo;
    } else if (fy) {
      const resolved = await resolveFYDates(companyId, null, null, fy);
      fyFrom = resolved.from;
      fyTo   = resolved.to;
    }

    // A "transfer" voucher = same voucher_guid has BOTH outward and inward stock_transaction rows
    // This covers Stock Journal godown transfers synced from Tally
    const { rows: transfers } = await query(`
      WITH transfer_voucher_guids AS (
        SELECT st.voucher_guid
        FROM stock_transactions st
        WHERE st.company_id=$1
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
          AND st_out.company_id = st_in.company_id
          AND st_out.stock_guid   = st_in.stock_guid
          AND st_out.type         = 'outward'
          AND st_in.type          = 'inward'
        JOIN transfer_voucher_guids tvg ON tvg.voucher_guid = st_out.voucher_guid
        WHERE st_out.company_id=$1
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
        LEFT JOIN vouchers v ON v.guid = ti.voucher_guid AND v.company_id=$1
        GROUP BY ti.voucher_guid
      )
      SELECT * FROM grouped
      ORDER BY date DESC
      LIMIT $4 OFFSET $5
    `, [companyId, fyFrom, fyTo, parseInt(limit), offset]);

    const { rows: countRow } = await query(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT st.voucher_guid
        FROM stock_transactions st
        WHERE st.company_id=$1
          AND ($2::date IS NULL OR st.date::date >= $2::date)
          AND ($3::date IS NULL OR st.date::date <= $3::date)
        GROUP BY st.voucher_guid
        HAVING
          COUNT(CASE WHEN st.type = 'outward' THEN 1 END) > 0
          AND COUNT(CASE WHEN st.type = 'inward'  THEN 1 END) > 0
      ) t
    `, [companyId, fyFrom, fyTo]);

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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query('SELECT * FROM stocks WHERE company_id=$1 AND guid=$2', [companyId, req.params.id]);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    // Load saved settings (may be null for new company)
    const { rows: [saved] } = await query(
      `SELECT * FROM company_inventory_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
    );

    // Tally-derived: all distinct UoMs
    const { rows: uomRows } = await query(
      `SELECT DISTINCT TRIM(unit) AS name FROM stocks
       WHERE company_id=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       ORDER BY TRIM(unit) ASC`,
      [companyId]
    );

    // Tally-derived: most common unit (for default)
    const { rows: commonUnitRows } = await query(
      `SELECT TRIM(unit) AS name, COUNT(*) AS cnt FROM stocks
       WHERE company_id=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       GROUP BY TRIM(unit) ORDER BY cnt DESC LIMIT 1`,
      [companyId]
    );

    // Tally-derived: warehouses (godowns)
    const { rows: warehouseRows } = await query(
      `SELECT guid, name, parent, address FROM warehouses
       WHERE company_id=$1 ORDER BY name`,
      [companyId]
    );

    const uoms = uomRows.map(r => r.name).filter(Boolean);
    const tallyDefaultUnit = commonUnitRows[0]?.name || uoms[0] || 'Nos';

    // Tally-derived: company-level batch/expiry flags (aggregate from stocks table)
    const { rows: tallyBatchRows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE batch_enabled  = TRUE) AS batch_count,
         COUNT(*) FILTER (WHERE expiry_enabled = TRUE) AS expiry_count,
         COUNT(*) AS total
       FROM stocks WHERE company_id=$1`,
      [companyId]
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const b = req.body;
    await query(`
      INSERT INTO company_inventory_settings (
        company_id, company_guid, product_display_field, default_unit_for_new_items,
        purchase_buffer_days, reorder_calc_mode, low_stock_threshold_mode,
        archive_old_stock_months, warehouse_code_map, cycle_count_frequency_map,
        archive_stock_layers_map, default_low_stock_level, inventory_aging_rules,
        fast_moving_top_pct, slow_moving_no_movement_days, dead_stock_no_movement_days,
        movement_analysis_period_days, low_stock_alerts, negative_stock_alerts,
        expiry_alerts, fast_slow_moving_alerts,
        batch_tracking_app_enabled, expiry_tracking_app_enabled, allow_negative_stock_app,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,NOW())
      ON CONFLICT (company_id) DO UPDATE SET
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
      companyId,
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query(
      `SELECT DISTINCT unit as name FROM stocks
       WHERE company_id=$1 AND unit IS NOT NULL AND TRIM(unit) != ''
       ORDER BY unit ASC`,
      [companyId]
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query(
      `SELECT DISTINCT TRIM(group_name) as name FROM stocks
       WHERE company_id=$1 AND group_name IS NOT NULL AND TRIM(group_name) != ''
         AND LOWER(TRIM(group_name)) != 'primary'
       ORDER BY TRIM(group_name) ASC`,
      [companyId]
    );
    res.json({ success: true, data: rows.map(r => r.name).filter(Boolean) });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/stocks/warehouses', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query(
      `SELECT w.guid, w.name, w.parent, w.address,
        COALESCE(SUM(CASE WHEN st.type='inward' THEN st.qty ELSE -st.qty END), 0) as net_qty,
        COUNT(DISTINCT st.stock_guid) as skus
       FROM warehouses w
       LEFT JOIN stock_transactions st ON st.warehouse = w.name AND st.company_id = w.company_id
         AND st.voucher_type != 'Physical Stock'  -- exclude audit counts from warehouse net qty
       WHERE w.company_id=$1
       GROUP BY w.guid, w.name, w.parent, w.address
       ORDER BY w.name`,
      [companyId]
    );
    // Merge TallyDekho-only warehouse settings (code, cycle freq, archive months)
    const { rows: settRows } = await query(
      `SELECT warehouse_code_map, cycle_count_frequency_map, archive_stock_layers_map
       FROM company_inventory_settings WHERE company_id=$1 LIMIT 1`,
      [companyId]
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
  const companyId = requireResolvedCompanyId(req);
  const { id } = req.params;
  try {
    // Warehouse info
    const { rows: wh } = await query(
      'SELECT guid, name, parent, address FROM warehouses WHERE company_id=$1 AND guid=$2 LIMIT 1',
      [companyId, id]
    );
    if (!wh[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Warehouse not found' } });
    const whName = wh[0].name;

    // Stock summary for this warehouse
    const { rows: summary } = await query(
      `SELECT
        COALESCE(SUM(CASE WHEN type='inward' THEN qty ELSE -qty END), 0) as total_qty,
        COUNT(DISTINCT stock_guid) as skus
       FROM stock_transactions WHERE company_id=$1 AND warehouse=$2
         AND voucher_type != 'Physical Stock'`,
      [companyId, whName]
    );

    // Recent stock activity (last 500 transactions)
    const { rows: activity } = await query(
      `SELECT st.type, st.qty, st.warehouse, s.name as stock_name, v.guid as voucher_guid, v.voucher_number, v.date, v.voucher_type
       FROM stock_transactions st
       LEFT JOIN stocks s ON s.name = st.stock_guid AND s.company_id = st.company_id
       LEFT JOIN vouchers v ON v.guid = st.voucher_guid AND v.company_id = st.company_id
       WHERE st.company_id=$1 AND st.warehouse=$2
         AND st.voucher_type != 'Physical Stock'
       ORDER BY v.date DESC, st.id DESC LIMIT 500`,
      [companyId, whName]
    );

    res.json({
      success: true,
      data: {
        id: wh[0].guid, name: wh[0].name, parent: wh[0].parent, address: wh[0].address || '',
        total_qty: parseFloat(summary[0]?.total_qty||0),
        skus: parseInt(summary[0]?.skus||0),
        activity: activity.map(a => ({
          type: a.voucher_type || a.type,
          guid: a.voucher_guid || null,
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
  const companyId = requireResolvedCompanyId(req);
  try {
    // Use from/to params sent by the frontend (selected FY dates)
    // Fall back to most recent 12 months if no range provided
    const fromDate = req.query.from || null;
    const toDate   = req.query.to   || null;
    const params   = [companyId];
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
      WHERE company_id=$1 AND is_cancelled=FALSE
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const fyPrefix = fyLikePrefix(financialYear);

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
            JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
            WHERE vle.ledger_name = l.name AND vle.company_id = l.company_id
              AND v.date >= $3 AND v.date <= $4
              AND (v.is_cancelled IS NULL OR v.is_cancelled = FALSE)
              AND v.voucher_type NOT ILIKE '%Order%'  -- exclude Sales Orders / Purchase Orders (non-P&L)
          ), 0) as fy_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_id = l.company_id AND lfb.ledger_name = l.name AND ${sqlLfbJoin('lfb', 2, 5)}
      WHERE l.company_id=$1
    `, [companyId, financialYear, fyFrom, fyTo, fyPrefix]);

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
      WHERE company_id=$1 AND financial_year = $2
    `, [companyId, financialYear]);
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
          WHERE company_id=$1 AND financial_year=$2
        `, [companyId, prevFY]);
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
      `SELECT name, parent FROM groups WHERE company_id=$1`, [companyId]
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
        ON lfb.company_id = l.company_id AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_id=$1
    `, [companyId, financialYear]);
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
       WHERE company_id=$1 AND financial_year=$2`,
      [companyId, financialYear]
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const dateFilter = from && to ? ' AND v.date BETWEEN $2 AND $3' : '';
    const baseParams = from && to ? [companyId, from, to] : [companyId];

    const [salesRes, purchaseRes, monthsRes] = await Promise.all([
      query(`SELECT COALESCE(SUM(ABS(g.cgst_amount + g.sgst_amount + g.igst_amount)),0) as tax,
                    COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v JOIN gst_voucher_details g ON g.voucher_guid=v.guid AND g.company_id=v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type_parent='Sales'${dateFilter}`, baseParams),
      query(`SELECT COALESCE(SUM(ABS(g.cgst_amount + g.sgst_amount + g.igst_amount)),0) as tax,
                    COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v JOIN gst_voucher_details g ON g.voucher_guid=v.guid AND g.company_id=v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type_parent='Purchase'${dateFilter}`, baseParams),
      // Use voucher_type ILIKE '%Sales%' (not strict parent='Sales') — covers Tally types classified as 'Voucher' parent
      query(`SELECT COUNT(DISTINCT TO_CHAR(date::date, 'YYYY-MM')) as filed_months
             FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE
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

async function getReadNotificationIds(userId) {
  const { rows } = await query('SELECT alert_settings FROM users WHERE id=$1', [userId]);
  return parseReadNotificationIds(rows[0]?.alert_settings);
}

async function persistReadNotificationIds(userId, ids) {
  await query(
    `UPDATE users SET alert_settings = COALESCE(alert_settings, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ read_notification_ids: [...ids] }), userId]
  );
}

async function buildDerivedNotifications(companyId) {
  const raw = [];
  if (!companyId) return raw;

  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 7);

  const { rows: lowStock } = await query(
    'SELECT name, closing_qty, reorder_level FROM stocks WHERE company_id=$1 AND closing_qty <= reorder_level AND reorder_level > 0 LIMIT 3',
    [companyId]
  );
  lowStock.forEach((s, i) => {
    const createdAt = new Date(now.getTime() - i * 3600000);
    raw.push(stockNotification(s, createdAt));
  });

  const { rows: overdue } = await query(
    `SELECT name, ABS(closing_balance) as bal FROM ledgers
     WHERE company_id=$1 AND parent ILIKE '%Sundry Debtor%' AND closing_balance > 50000
     ORDER BY closing_balance DESC LIMIT 3`,
    [companyId]
  );
  overdue.forEach((l, i) => {
    const createdAt = new Date(now.getTime() - (i + 1) * 7200000);
    raw.push(receivableNotification(l, createdAt));
  });

  const fyStart = `${now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1}-04-01`;
  const fyEnd = `${now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear()}-03-31`;

  const { rows: pendingEwb } = await query(
    `SELECT COUNT(*)::int AS c FROM vouchers
     WHERE company_id=$1 AND is_cancelled=FALSE
       AND voucher_type ILIKE '%Sales%'
       AND voucher_type NOT ILIKE '%Order%'
       AND amount >= 50000
       AND (ewb_number IS NULL OR ewb_number='')
       AND date BETWEEN $2 AND $3 AND date >= '2018-04-01'`,
    [companyId, fyStart, fyEnd]
  ).catch(() => ({ rows: [{ c: 0 }] }));

  const ewbCount = pendingEwb[0]?.c || 0;
  if (ewbCount > 0) {
    raw.push(complianceNotification({
      id: 'ewb_pending',
      type: 'gst',
      title: 'E-Way Bill Pending',
      body: `${ewbCount} invoice${ewbCount > 1 ? 's' : ''} need E-Way Bill generation`,
      route: '/settings/ewb',
      actionLabel: 'Generate EWB',
      createdAt: weekAgo,
    }));
  }

  const { rows: pendingIrn } = await query(
    `SELECT COUNT(*)::int AS c FROM vouchers
     WHERE company_id=$1 AND is_cancelled=FALSE
       AND voucher_type ILIKE '%Sales%'
       AND amount >= 0
       AND (irn IS NULL OR irn = '')
       AND (irn_cancelled IS NULL OR irn_cancelled = FALSE)
       AND date BETWEEN $2 AND $3 AND date >= '2020-10-01'`,
    [companyId, fyStart, fyEnd]
  ).catch(() => ({ rows: [{ c: 0 }] }));

  const irnCount = pendingIrn[0]?.c || 0;
  if (irnCount > 0) {
    raw.push(invoiceNotification({
      id: 'irn_pending',
      title: 'IRN Generation Due',
      body: `${irnCount} invoice${irnCount > 1 ? 's' : ''} pending IRN generation`,
      route: '/settings/einvoice',
      actionLabel: 'Generate IRN',
      createdAt: weekAgo,
    }));
  }

  const { rows: recentSales } = await query(
    `SELECT voucher_number, party_name, amount, date FROM vouchers
     WHERE company_id=$1 AND is_cancelled=FALSE
       AND voucher_type ILIKE '%Sales%'
       AND voucher_type NOT ILIKE '%Order%'
       AND date >= CURRENT_DATE - INTERVAL '3 days'
     ORDER BY date DESC LIMIT 2`,
    [companyId]
  ).catch(() => ({ rows: [] }));

  recentSales.forEach((v, i) => {
    const amt = Math.round(parseFloat(v.amount) || 0);
    raw.push(invoiceNotification({
      id: `sale_${v.voucher_number || i}`,
      title: 'New Sales Invoice',
      body: `${v.party_name || 'Party'} — ₹${amt.toLocaleString('en-IN')}`,
      route: '/sales',
      actionLabel: 'View invoice',
      createdAt: v.date ? new Date(v.date) : now,
    }));
  });

  return raw;
}

router.get('/notifications', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const readIds = await getReadNotificationIds(req.user.userId);
    const raw = await buildDerivedNotifications(companyId);
    const data = raw.map(n => enrichNotification(n, readIds));
    res.json({ success: true, data });
  } catch (err) {
    console.error('[notifications GET]', err.message);
    res.json({ success: true, data: [] });
  }
});

router.patch('/notifications/:id/read', authMiddleware, async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ success: false, error: { code: 'MISSING_ID', message: 'Notification id required' } });
  try {
    const readIds = await getReadNotificationIds(req.user.userId);
    readIds.add(id);
    await persistReadNotificationIds(req.user.userId, readIds);
    res.json({ success: true, data: { id, read: true } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.patch('/notifications/read-all', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.body?.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const readIds = await getReadNotificationIds(req.user.userId);
    const raw = await buildDerivedNotifications(companyId);
    raw.forEach(n => readIds.add(n.id));
    await persistReadNotificationIds(req.user.userId, readIds);
    res.json({ success: true, data: { read: true, count: readIds.size } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════
// PARTIES (for dropdowns in create forms)
// ══════════════════════════════════════════════════════════════

router.get('/parties', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { search = '', type } = req.query;
  try {
    let q = `SELECT guid, name, gstin, gst_registration_type, parent, address, state_name, pincode FROM ledgers WHERE company_id=$1 AND (name ILIKE $2 OR alias ILIKE $2)`;
    const params = [companyId, `%${search}%`];
    let idx = 3;
    if (type === 'customer') { q += ` AND parent ILIKE $${idx++}`; params.push('%Sundry Debtor%'); }
    if (type === 'vendor')   { q += ` AND parent ILIKE $${idx++}`; params.push('%Sundry Creditor%'); }
    // Payment expense ledgers: Direct / Indirect Expenses (exact group names; avoid '%Direct%' matching Indirect)
    if (type === 'expense') {
      q += ` AND (parent ~* $${idx} OR parent ~* $${idx + 1})`;
      params.push('^Direct Expenses?$', '^Indirect Expenses?$');
      idx += 2;
    }
    // Receipt income ledgers: Direct / Indirect Incomes
    if (type === 'income') {
      q += ` AND (parent ~* $${idx} OR parent ~* $${idx + 1})`;
      params.push('^Direct Incomes?$', '^Indirect Incomes?$');
      idx += 2;
    }
    q += ' ORDER BY name LIMIT 500';
    const { rows } = await query(q, params);
    res.json({ success: true, data: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/party/outstanding-bills?companyGuid=...&ledger=<name>&drOnly=true|crOnly=true
// Returns bill_outstanding rows for a single party ledger.
// Receipt uses drOnly (receivables); Payment uses crOnly (payables).
router.get('/party/outstanding-bills', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  const ledger = req.query.ledger || req.query.partyLedger || '';
  const drOnly = String(req.query.drOnly || '').toLowerCase() === 'true' || req.query.drOnly === '1';
  const crOnly = String(req.query.crOnly || '').toLowerCase() === 'true' || req.query.crOnly === '1';
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!ledger)      return res.status(400).json({ success: false, error: { code: 'MISSING_LEDGER',  message: 'ledger required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const params = [companyId, ledger];
    let sideFilter = '';
    if (drOnly) {
      // Receivables for Receipt: Dr type, or negative pending (legacy rows without bill_type)
      sideFilter = ` AND (UPPER(COALESCE(bill_type,'')) = 'DR' OR COALESCE(pending_amount,0) < 0)`;
    } else if (crOnly) {
      // Payables for Payment: Cr type, or positive pending (legacy rows without bill_type)
      sideFilter = ` AND (UPPER(COALESCE(bill_type,'')) = 'CR' OR COALESCE(pending_amount,0) > 0)`;
    }
    const { rows } = await query(
      `SELECT bill_name, bill_date, due_date, amount, pending_amount, bill_type
         FROM bill_outstanding
        WHERE company_id=$1 AND ledger_name=$2 AND ABS(COALESCE(pending_amount,0)) > 0.005
        ${sideFilter}
        ORDER BY bill_date ASC NULLS LAST, id ASC
        LIMIT 500`,
      params
    );
    const billsRaw = rows.map((r) => ({
      ...r,
      amount: Math.abs(parseFloat(r.amount) || 0),
      pending_amount: Math.abs(parseFloat(r.pending_amount) || 0),
    }));
    // Collapse duplicate bill_name rows (same ledger can have >1 outstanding row per ref).
    const byName = new Map();
    for (const b of billsRaw) {
      const key = String(b.bill_name || '');
      const prev = byName.get(key);
      if (!prev) {
        byName.set(key, { ...b });
      } else {
        prev.pending_amount += b.pending_amount;
        prev.amount += b.amount;
        // Keep earliest bill_date
        if (b.bill_date && (!prev.bill_date || String(b.bill_date) < String(prev.bill_date))) {
          prev.bill_date = b.bill_date;
        }
      }
    }
    const bills = [...byName.values()];
    const total = bills.reduce((s, r) => s + (parseFloat(r.pending_amount) || 0), 0);
    res.json({ success: true, data: { bills, totalPending: total } });
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const data = await buildCashInHandPayload(companyId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[kpi/cash-in-hand]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/bank-ledgers — bank + cash ledgers (for payment selection in voucher forms)
// ?type=bank  → bank only (default)
// ?type=cash  → cash only
// ?type=all   → bank + cash
router.get('/bank-ledgers', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const type = req.query.type || 'all'; // changed default to 'all' so payment forms get both
  try {
    let whereExtra = '';
    if (type === 'cash') {
      whereExtra = `AND (l.parent ILIKE '%Cash In Hand%' OR l.parent ILIKE '%Cash-In-Hand%' OR l.name ILIKE 'Cash')`;
    } else if (type === 'bank') {
      whereExtra = `AND (
           l.parent ILIKE '%Bank Accounts%'
           OR l.parent ILIKE '%Bank Account%'
           OR l.parent ILIKE '%Bank OD%'
           OR l.parent ILIKE '%Overdraft%'
           OR l.parent ILIKE '%Bank A/c%'
           OR (l.parent ILIKE '%Bank%' AND l.parent NOT ILIKE '%Bank Charge%' AND l.parent NOT ILIKE '%Bank Interest%' AND l.parent NOT ILIKE '%Bank Exp%')
         )`;
    } else {
      // all: bank + cash
      whereExtra = `AND (
           l.parent ILIKE '%Bank Accounts%'
           OR l.parent ILIKE '%Bank Account%'
           OR l.parent ILIKE '%Bank OD%'
           OR l.parent ILIKE '%Overdraft%'
           OR l.parent ILIKE '%Bank A/c%'
           OR l.parent ILIKE '%Cash In Hand%'
           OR l.parent ILIKE '%Cash-In-Hand%'
           OR l.name ILIKE 'Cash'
           OR (l.parent ILIKE '%Bank%' AND l.parent NOT ILIKE '%Bank Charge%' AND l.parent NOT ILIKE '%Bank Interest%' AND l.parent NOT ILIKE '%Bank Exp%')
         )`;
    }
    const { rows } = await query(
      `SELECT l.name, l.closing_balance, l.balance_type, l.parent,
              l.bank_account_no, l.bank_ifsc, l.bank_name, l.bank_branch, l.bank_holder,
              l.bank_account_type,
              (
                SELECT UPPER(COALESCE(am.payload->>'accountType', am.payload->>'account_type', ''))
                FROM app_masters am
                WHERE am.company_id = l.company_id
                  AND am.master_type = 'bank'
                  AND LOWER(am.master_name) = LOWER(l.name)
                ORDER BY am.updated_at DESC NULLS LAST
                LIMIT 1
              ) AS app_account_type
       FROM ledgers l
       WHERE l.company_id=$1 ${whereExtra}
       ORDER BY
         CASE WHEN l.parent ILIKE '%Cash%' OR l.name ILIKE 'Cash' THEN 0 ELSE 1 END,
         ABS(l.closing_balance) DESC`,
      [companyId]
    );
    const normalizeType = (v) => {
      const t = String(v || '').trim().toUpperCase();
      return ['SAVING', 'CURRENT', 'OD', 'CC'].includes(t) ? t : '';
    };
    res.json({ success: true, data: rows.map(r => {
      const parent = r.parent || '';
      let accountType = normalizeType(r.bank_account_type) || normalizeType(r.app_account_type);
      if (!accountType) {
        if (/Bank\s*OD|Overdraft/i.test(parent)) accountType = 'OD';
        else if (/Cash\s*Credit/i.test(parent)) accountType = 'CC';
        else accountType = 'CURRENT';
      }
      return {
        name: r.name,
        balance: parseFloat(r.closing_balance||0),
        balance_type: r.balance_type,
        parent,
        account_number: r.bank_account_no || '',
        ifsc: r.bank_ifsc || '',
        bank_name: r.bank_name || '',
        branch: r.bank_branch || '',
        account_holder: r.bank_holder || '',
        account_type: accountType,
        type: (parent.toLowerCase().includes('cash') || r.name?.toLowerCase() === 'cash') ? 'cash' : 'bank'
      };
    }) });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/bank-balance', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const data = await buildBankBalancePayload(companyId, { from, to });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[kpi/bank-balance]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/kpi/receivables', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const data = await buildArApPayload(companyId, 'AR', {
      from: req.query.from,
      to: req.query.to,
      overdue: req.query.overdue,
      asOf: req.query.asOf,
    });
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/payables', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const data = await buildArApPayload(companyId, 'AP', {
      from: req.query.from,
      to: req.query.to,
      overdue: req.query.overdue,
      asOf: req.query.asOf,
    });
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/kpi/payments', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const data = await buildPaymentReceiptPayload(companyId, { from, to, kind: 'Payment' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[kpi/payments]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/kpi/receipts', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const data = await buildPaymentReceiptPayload(companyId, { from, to, kind: 'Receipt' });
    res.json({ success: true, data });
  } catch (err) {
    console.error('[kpi/receipts]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/kpi/loans-ods', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const data = await buildLoansOdsPayload(companyId);
    // Flat compat list (loans + ODs) lives on `all` — enriched arrays stay on loans/overdrafts
    const compatLoans = [
      ...(data.loans || []).map((l) => ({
        name: l.name,
        parent: l.parent,
        balance: l.outstanding?.value ?? l.outstanding ?? 0,
        facilityType: l.facilityType,
        mode: l.mode,
      })),
      ...(data.overdrafts || []).map((l) => ({
        name: l.name,
        parent: l.parent,
        balance: l.outstanding?.value ?? l.outstanding ?? 0,
        facilityType: l.facilityType,
        mode: l.mode,
      })),
    ];
    res.json({
      success: true,
      data: {
        ...data,
        loans: data.loans,
        overdrafts: data.overdrafts,
        all: compatLoans,
      },
    });
  } catch (err) {
    console.error('[kpi/loans-ods]', err);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// E-WAY BILLS — with country-aware logic
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/ewaybills/status — summary: integration status + EWB counts
router.get('/ewaybills/status', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const [integRow, generatedRow, pendingRow, expiringRow, errorRow, transportRow, dailyRow] = await Promise.all([
      // Integration status
      query(`SELECT status FROM integrations WHERE company_id=$1 AND type='ewb' LIMIT 1`, [companyId])
        .catch(() => ({ rows: [] })),
      // Generated: vouchers with ewb_number from Tally
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != '' AND date BETWEEN $2 AND $3`, [companyId, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Pending: Sales >= 50K without EWB
      // EWB applicable from Apr 2018 only
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (ewb_number IS NULL OR ewb_number='') AND date BETWEEN $2 AND $3 AND date >= '2018-04-01'`, [companyId, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Expiring within 24h
      query(`SELECT COUNT(*) as c FROM e_way_bill_details WHERE company_id=$1 AND valid_till BETWEEN NOW() AND NOW() + INTERVAL '24 hours'`, [companyId])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Errors
      query(`SELECT COUNT(*) as c FROM e_way_bill_details WHERE company_id=$1 AND error_message IS NOT NULL AND error_message != ''`, [companyId])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // Transport mode breakdown
      query(`SELECT COALESCE(sub_supply_type, 'Road') as mode, COUNT(*) as cnt FROM e_way_bill_details WHERE company_id=$1 GROUP BY sub_supply_type`, [companyId])
        .catch(() => ({ rows: [] })),
      // Daily counts for bar chart (last 30 days within FY)
      query(`SELECT date as day, COUNT(*) as cnt FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != '' AND date BETWEEN $2 AND $3 GROUP BY date ORDER BY date`, [companyId, from, to])
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const { search = '', page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await query(
      // EWB applicable from Apr 2018 only — earlier invoices never need EWB
    `SELECT * FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE
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
      [companyId, from, to, `%${search}%`, parseInt(limit), offset]
    );
    const { rows: cnt } = await query(
      `SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (ewb_number IS NULL OR ewb_number='') AND date BETWEEN $2 AND $3 AND date >= '2018-04-01'`,
      [companyId, from, to]
    );
    res.json({ success: true, data: rows.map(r => ({ ...r, ewb_status: 'pending' })), meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/ewaybills', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    // Check if company has GSTIN (India-specific)
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country FROM companies WHERE id=$1', [companyId]);
    const isIndia = (userRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.gstin)
      || (coRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.state);
    if (!isIndia) return res.json({ success: true, data: [], meta: { total: 0, country_applicable: false, message: 'E-Way Bill is applicable only for India (GST-registered companies)' } });

    // Only return vouchers that have an EWB number (generated from Tally or portal)
    const { search = '', page = 1, limit = 30, from, to } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    // The e-Way Bill print sheet needs date, validity, vehicle and transporter,
    // which live in e_way_bill_details, not on the voucher row.
    // COALESCE on ewb_date: vouchers already has that column, so an unaliased
    // d.ewb_date would shadow it and blank the date whenever no detail row exists.
    // The cast is required — the detail column is text, the voucher column is timestamptz.
    let q = `SELECT v.*, COALESCE(d.ewb_date, v.ewb_date::text) AS ewb_date,
                    d.valid_till, d.vehicle_no, d.transporter_id,
                    d.distance_km, d.supply_type, d.sub_supply_type
               FROM vouchers v
               LEFT JOIN e_way_bill_details d
                 ON d.voucher_guid = v.guid AND d.company_id = v.company_id
              WHERE v.company_id=$1 AND v.is_cancelled=FALSE
                AND v.ewb_number IS NOT NULL AND v.ewb_number != ''
                AND (v.party_name ILIKE $2 OR v.voucher_number ILIKE $2)`;
    const params = [companyId, `%${search}%`];
    let idx = 3;
    if (from) { q += ` AND v.date >= $${idx++}`; params.push(from); }
    if (to)   { q += ` AND v.date <= $${idx++}`; params.push(to); }
    q += ` ORDER BY v.date DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND ewb_number IS NOT NULL AND ewb_number != ''`, [companyId]);
    res.json({
      success: true, country_applicable: true,
      data: rows.map(r => ({ ...r, ewb_status: 'generated' })),
      meta: { total: parseInt(cnt[0].c), page: parseInt(page) }
    });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// POST /api/ewaybills/generate — Generate E-Way Bill for a voucher
router.post('/ewaybills/generate', authMiddleware, async (req, res) => {
  const companyGuid = req.body.companyGuid || req.user?.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { voucherGuid, dispatchDetails, force = false } = req.body;
  if (!voucherGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_VOUCHER', message: 'voucherGuid required' } });

  try {
    // 1. Load voucher
    const { rows: vRows } = await query(`SELECT * FROM vouchers WHERE guid=$1 AND company_id=$2`, [voucherGuid, companyId]);
    if (!vRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND' } });
    const voucher = vRows[0];

    // 2. Check compliance config
    const { rows: cfgRows } = await query(`SELECT * FROM company_compliance_config WHERE company_id=$1`, [companyId]);
    const cfg = cfgRows[0];
    if (!cfg || cfg.e_way_bill_applicable !== 'applicable_configured') {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NOT_CONFIGURED', message: 'E-Way Bill not configured. Go to Settings → Voucher Config.' } });
    }

    // 3. Must have final Tally voucher/invoice number
    if (!voucher.voucher_number) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_TALLY_NUMBER', message: 'Waiting for final Tally invoice number. Sync with Tally first.' } });
    }

    // 4. Must not be optional
    if (voucher.is_optional) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'OPTIONAL_VOUCHER', message: 'Convert to Regular in TallyPrime before generating EWB.' } });
    }

    // 5. If e-invoice is configured, IRN must exist first
    if (cfg.e_invoice_applicable === 'applicable_configured' && !voucher.irn) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'IRN_REQUIRED', message: 'E-Invoice (IRN) must be generated before E-Way Bill for this company.' } });
    }

    // 6. Check existing EWB
    const { rows: existingEWB } = await query(`SELECT ewb_no FROM e_way_bill_details WHERE voucher_guid=$1 AND company_id=$2`, [voucherGuid, companyId]).catch(() => ({ rows: [] }));
    if (existingEWB[0]?.ewb_no && !force) {
      return res.status(400).json({ success: false, error: { code: 'EWB_EXISTS', message: 'E-Way Bill already generated', ewbNo: existingEWB[0].ewb_no } });
    }

    // 7. Company GSTIN
    const { rows: coRows } = await query(`SELECT gstin, name, address, state, pincode, state_code FROM companies WHERE id=$1`, [companyId]);
    if (!coRows[0]?.gstin) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_GSTIN', message: 'Company GSTIN not set. Add in Settings → Company Profile.' } });
    }

    // 8. Dispatch details (from request or from app_vouchers payload)
    let details = dispatchDetails;
    if (!details) {
      const { rows: avRows } = await query(`SELECT payload FROM app_vouchers WHERE company_id=$1 AND tally_voucher_no=$2`, [companyId, voucher.voucher_number]).catch(() => ({ rows: [] }));
      details = avRows[0]?.payload?.dispatch_details;
    }
    if (!details?.dispatch_from || !details?.ship_to) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_DISPATCH_DETAILS', message: 'Dispatch details required. Fill in Dispatch From and Ship To fields.' } });
    }

    // 9. Credentials
    const { rows: userRows } = await query(`SELECT integration_settings FROM users WHERE id=$1`, [req.user.userId]);
    const ewbCreds = userRows[0]?.integration_settings?.ewaybill || userRows[0]?.integration_settings?.ewb || {};

    // Mark as generating
    await query(`UPDATE app_vouchers SET e_way_bill_status='generating', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$1 AND tally_voucher_no=$2`, [companyId, voucher.voucher_number]).catch(() => {});

    // Call EWB generator
    const ewbResult = await generateEWB(companyId, voucher, coRows[0], ewbCreds, details).catch(e => ({ _error: e.message }));

    if (ewbResult._error) {
      await query(`UPDATE app_vouchers SET e_way_bill_status='failed', sync_error=$1, updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$2 AND tally_voucher_no=$3`, [ewbResult._error, companyId, voucher.voucher_number]).catch(() => {});
      return res.status(500).json({ success: false, error: { code: 'EWB_FAILED', message: ewbResult._error } });
    }

    const { ewbNo, ewbDate, validUpto } = ewbResult;
    // Store in e_way_bill_details (schema cols: ewb_no, ewb_date, valid_till, transporter_id, vehicle_no, sub_supply_type)
    // Not best-effort: an e-Way Bill the government issued and we failed to
    // record is one the user cannot cancel or show at a checkpoint.
    try {
      await query(
        `INSERT INTO e_way_bill_details (voucher_guid, company_id, company_guid, ewb_no, ewb_date, valid_till, transporter_id, vehicle_no, sub_supply_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (company_id, voucher_guid) DO UPDATE SET ewb_no=$4, ewb_date=$5, valid_till=$6`,
        [voucherGuid, companyId, companyGuid, ewbNo, ewbDate, validUpto, details.transporter_id || null, details.vehicle_number || null, 'Road']
      );
    } catch (persistErr) {
      console.error('[ewaybills/generate] EWB issued but not recorded:', persistErr.message);
      return res.status(500).json({
        success: false,
        error: { code: 'EWB_NOT_RECORDED', message: 'E-Way Bill was generated but could not be saved', ewbNo },
      });
    }
    await query(`UPDATE app_vouchers SET e_way_bill_status='generated', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$1 AND tally_voucher_no=$2`, [companyId, voucher.voucher_number]).catch(() => {});

    res.json({ success: true, data: { ewbNo, ewbDate, validUpto } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/ewaybills/cancel
router.post('/ewaybills/cancel', authMiddleware, async (req, res) => {
  const companyGuid = req.body.companyGuid || req.user?.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { voucherGuid, cancelReason = 1 } = req.body;
  if (!voucherGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_VOUCHER' } });
  try {
    // Cancelling nothing is not a success — the caller would show the user a
    // cancelled bill that is still live at the portal.
    const cancelled = await query(
      `UPDATE e_way_bill_details SET status='cancelled' WHERE voucher_guid=$1 AND company_id=$2`,
      [voucherGuid, companyId]
    );
    if (!cancelled.rowCount) {
      return res.status(404).json({
        success: false,
        error: { code: 'EWB_NOT_FOUND', message: 'No E-Way Bill for this voucher in this company' },
      });
    }
    await query(
      `UPDATE app_vouchers SET e_way_bill_status='cancelled', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
       WHERE company_id=$1 AND tally_voucher_no=(SELECT voucher_number FROM vouchers WHERE guid=$2 AND company_id=$1)`,
      [companyId, voucherGuid]
    ).catch(() => {});
    res.json({ success: true, message: 'E-Way Bill cancelled' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// E-INVOICE (IRN) — India GST only
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/einvoice/status — summary counts for e-invoice compliance screen
router.get('/einvoice/status', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const [generatedRow, pendingRow, cancelledRow, errorRow] = await Promise.all([
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyId, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      // IRN applicable from Oct 2020 only
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (irn IS NULL OR irn='') AND irn_cancelled=FALSE AND date BETWEEN $2 AND $3 AND date >= '2020-10-01'`, [companyId, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND is_cancelled=FALSE AND irn_cancelled=TRUE AND date BETWEEN $2 AND $3`, [companyId, from, to])
        .catch(() => ({ rows: [{ c: 0 }] })),
      query(`SELECT COUNT(*) as c FROM e_invoice_details WHERE company_id=$1 AND error_message IS NOT NULL AND error_message != ''`, [companyId])
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country FROM companies WHERE id=$1', [companyId]);
    const isIndia = (userRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.gstin)
      || (coRows[0]?.country || '').toLowerCase().includes('india')
      || !!(coRows[0]?.state);
    if (!isIndia) return res.json({ success: true, data: [], meta: { country_applicable: false, message: 'E-Invoice (IRN) is applicable only for India (GST-registered companies)' } });
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    // IRN applicable from Oct 2020 only — earlier invoices never need IRN
    const { rows } = await query(`SELECT * FROM vouchers WHERE company_id=$1 AND voucher_type ILIKE '%Sales%' AND voucher_type NOT ILIKE '%Order%' AND voucher_type NOT ILIKE '%Delivery%' AND voucher_type NOT ILIKE '%Quotation%' AND amount >= 50000 AND (irn IS NULL OR irn='') AND irn_cancelled=FALSE AND is_cancelled=FALSE AND date BETWEEN $2 AND $3 AND date >= '2020-10-01' ORDER BY date DESC LIMIT 100`, [companyId, from, to]);
    res.json({ success: true, country_applicable: true, data: rows, meta: { total: rows.length, pending_irn: rows.length } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

router.get('/einvoice/generated', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const { page = 1, limit = 50, search = '' } = req.query;
    const offset = (parseInt(page)-1)*parseInt(limit);
    // Ack No / Ack date / QR live in e_invoice_details and are what the IRP
    // extract sheet prints alongside the IRN.
    const { rows } = await query(
      `SELECT v.*, d.ack_no, d.ack_date,
              COALESCE(d.qr_code, v.qr_code) AS qr_code,
              d.status AS einvoice_status
         FROM vouchers v
         LEFT JOIN e_invoice_details d
           ON d.voucher_guid = v.guid AND d.company_id = v.company_id
        WHERE v.company_id=$1 AND v.irn IS NOT NULL AND v.irn != ''
          AND v.irn_cancelled=FALSE AND v.is_cancelled=FALSE
          AND v.date BETWEEN $2 AND $3
          AND (v.party_name ILIKE $4 OR v.voucher_number ILIKE $4)
        ORDER BY v.date DESC LIMIT $5 OFFSET $6`,
      [companyId, from, to, `%${search}%`, parseInt(limit), offset]
    );
    const { rows: cnt } = await query(`SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyId, from, to]);
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// POST /api/einvoice/generate — Generate IRN for a voucher
router.post('/einvoice/generate', authMiddleware, async (req, res) => {
  const companyGuid = req.body.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const companyId = requireResolvedCompanyId(req);
  const { voucherGuid, voucherNumber, force = false } = req.body;
  if (!voucherGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_VOUCHER', message: 'voucherGuid required' } });

  try {
    // -- 1. Prerequisite checks -----------------------------------------------
    const { rows: vRows } = await query(
      `SELECT * FROM vouchers WHERE guid = $1 AND company_id=$2`,
      [voucherGuid, companyId]
    );
    if (!vRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Voucher not found' } });
    const voucher = vRows[0];

    // Check compliance config
    const { rows: cfgRows } = await query(
      `SELECT * FROM company_compliance_config WHERE company_id=$1`, [companyId]
    );
    const cfg = cfgRows[0];
    if (!cfg || cfg.e_invoice_applicable !== 'applicable_configured') {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NOT_CONFIGURED', message: 'E-Invoice integration is not configured. Go to Settings > Voucher Config to set up.' } });
    }

    // Must have final Tally voucher number
    if (!voucher.voucher_number) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_TALLY_NUMBER', message: 'Waiting for final Tally invoice number. IRN cannot be generated until Tally sync completes.' } });
    }

    // Must not be optional
    if (voucher.is_optional) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'OPTIONAL_VOUCHER', message: 'Optional vouchers cannot generate IRN. Convert to Regular in TallyPrime first.' } });
    }

    // Must not already have IRN (unless force=true)
    if (voucher.irn && !force) {
      return res.status(400).json({ success: false, error: { code: 'IRN_EXISTS', message: 'IRN already generated for this voucher', irn: voucher.irn } });
    }

    // Check company GSTIN
    const { rows: coRows } = await query(`SELECT gstin, name FROM companies WHERE id = $1`, [companyId]);
    const company = coRows[0];
    if (!company?.gstin) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_GSTIN', message: 'Company GSTIN not configured. Add GSTIN in Settings > Company Profile.' } });
    }

    // Check integration credentials
    const { rows: userRows } = await query(`SELECT integration_settings FROM users WHERE id = $1`, [req.user.userId]);
    const einvoiceCreds = userRows[0]?.integration_settings?.einvoice;
    if (!einvoiceCreds?.gstin || !einvoiceCreds?.username) {
      return res.status(400).json({ success: false, locked: true, error: { code: 'NO_CREDENTIALS', message: 'IRP credentials not configured. Go to Settings > E-Invoice to set up.' } });
    }

    // -- 2. Mark as generating ------------------------------------------------
    await query(
      `UPDATE app_vouchers SET e_invoice_status = 'generating', updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$1 AND tally_voucher_no = $2`,
      [companyId, voucher.voucher_number]
    ).catch(() => {});

    // -- 3. IRP API call (wire real GSP/NIC API in irnGenerator.js) -----------
    const irnResult = await generateIRN(companyId, voucher, company, einvoiceCreds).catch(e => ({ error: e.message }));

    if (irnResult.error) {
      // Store failure record
      await query(
        `INSERT INTO e_invoice_details (voucher_guid, company_id, company_guid, status, error_message, synced_at)
         VALUES ($1, $2, $3, 'failed', $4, NOW())
         ON CONFLICT (company_id, voucher_guid) DO UPDATE SET status='failed', error_message=$4, synced_at=NOW()`,
        [voucherGuid, companyId, companyGuid, irnResult.error]
      );
      await query(
        `UPDATE app_vouchers SET e_invoice_status = 'failed', sync_error = $1, updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$2 AND tally_voucher_no = $3`,
        [irnResult.error, companyId, voucher.voucher_number]
      ).catch(() => {});
      return res.status(500).json({ success: false, error: { code: 'IRN_FAILED', message: irnResult.error } });
    }

    // -- 4. Store IRN result --------------------------------------------------
    const { irn, ackNo, ackDate, signedInvoice, qrCode } = irnResult;
    await query(
      `INSERT INTO e_invoice_details (voucher_guid, company_id, company_guid, irn, ack_no, ack_date, signed_invoice, qr_code, status, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'generated',NOW())
       ON CONFLICT (company_id, voucher_guid) DO UPDATE SET
         irn=$4, ack_no=$5, ack_date=$6, signed_invoice=$7, qr_code=$8, status='generated', synced_at=NOW()`,
      [voucherGuid, companyId, companyGuid, irn, ackNo, ackDate, signedInvoice, qrCode]
    );
    // Update vouchers table
    await query(
      `UPDATE vouchers SET irn=$1, irn_date=$2 WHERE guid=$3 AND company_id=$4`,
      [irn, ackDate, voucherGuid, companyId]
    );
    // Update app_vouchers
    await query(
      `UPDATE app_vouchers SET e_invoice_status='generated', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT WHERE company_id=$1 AND tally_voucher_no=$2`,
      [companyId, voucher.voucher_number]
    ).catch(() => {});

    res.json({ success: true, data: { irn, ackNo, ackDate, qrCode } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /api/einvoice/cancel — Cancel an IRN
router.post('/einvoice/cancel', authMiddleware, async (req, res) => {
  const companyGuid = req.body.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { voucherGuid, cancelReason = 1, cancelRemarks = '' } = req.body;
  if (!voucherGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_VOUCHER' } });
  try {
    const { rows } = await query(`SELECT irn FROM vouchers WHERE guid=$1 AND company_id=$2`, [voucherGuid, companyId]);
    if (!rows[0]?.irn) return res.status(404).json({ success: false, error: { code: 'NO_IRN', message: 'No IRN found for this voucher' } });
    // Placeholder: call IRP cancel API in production
    await query(`UPDATE vouchers SET irn_cancelled=TRUE WHERE guid=$1 AND company_id=$2`, [voucherGuid, companyId]);
    await query(`UPDATE e_invoice_details SET status='cancelled', synced_at=NOW() WHERE voucher_guid=$1 AND company_id=$2`, [voucherGuid, companyId]);
    await query(
      `UPDATE app_vouchers SET e_invoice_status='cancelled', updated_at=EXTRACT(EPOCH FROM NOW())::BIGINT
        WHERE company_id=$1 AND tally_voucher_no=(SELECT voucher_number FROM vouchers WHERE guid=$2 AND company_id=$1)`,
      [companyId, voucherGuid]
    ).catch(() => {});
    res.json({ success: true, message: 'IRN cancelled successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// GST REPORTS — India only
// ══════════════════════════════════════════════════════════════════════════════

// ─── GET /reports/gst-summary ────────────────────────────────────────────────
router.get('/reports/gst-summary', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user?.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);

    const baseParams = [companyId];
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
             JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled = FALSE
             AND v.voucher_type != ALL(${NON_SALES_LIT})${dateWhere}`, baseParams),
      // ITC = sum of (cgst+sgst+igst) on inward purchases
      query(`SELECT
               COALESCE(SUM(g.cgst_amount),0) as cgst,
               COALESCE(SUM(g.sgst_amount),0) as sgst,
               COALESCE(SUM(g.igst_amount),0) as igst,
               COALESCE(SUM(g.taxable_amount),0) as taxable
             FROM vouchers v
             JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled = FALSE
             AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])${dateWhere}`, baseParams),
      // Unmatched = GSTR-2A eligible purchases (from registered suppliers) without IRN
      query(`SELECT COUNT(*) as cnt
             FROM vouchers v
             INNER JOIN ledgers l ON l.name = v.party_name AND l.company_id = v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled = FALSE
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
  const companyId = requireResolvedCompanyId(req);
  const { from, to, type = 'GSTR-1', fy } = req.query;
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, from, to, fy);
    const { rows: userRows } = await query('SELECT country FROM users WHERE id=$1', [req.user.userId]);
    const { rows: coRows } = await query('SELECT gstin, state, country, gst_taxpayer_type FROM companies WHERE id=$1', [companyId]);
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
               INNER JOIN ledgers l ON l.name = v.party_name AND l.company_id = v.company_id
               LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id
               WHERE v.company_id=$1 AND v.is_cancelled = FALSE
               AND v.voucher_type = ANY($2)
               AND l.gstin IS NOT NULL AND l.gstin != ''`;
      let q2Params = [companyId, PURCHASE];
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
      const baseParams = [companyId];
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
      const outQ = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_id = v.company_id WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type != ALL(${NON_SALES_LITERAL}) ${gstRelevanceFilter}`;
      const inQ  = `SELECT ${voucherCols} FROM vouchers v LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_id = v.company_id WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase']) ${gstRelevanceFilter}`;
      const [outSumR, inSumR, outVouR, inVouR] = await Promise.all([
        query(`SELECT ROUND(COALESCE(SUM(ABS(v.amount)),0)::numeric,2) as total FROM vouchers v WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type != ALL(${NON_SALES_LITERAL})${dateWhere}`, baseParams),
        query(`SELECT ROUND(COALESCE(SUM(ABS(v.amount)),0)::numeric,2) as total FROM vouchers v WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type = ANY(ARRAY['Purchase GST','Purchase'])${dateWhere}`, baseParams),
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
      qParams    = [companyId, NON_SALES];
      typeFilter = 'AND v.voucher_type != ALL($2)';
      qIdx       = 3;
    } else if (cfg.types && cfg.types.length > 0) {
      qParams    = [companyId, cfg.types];
      typeFilter = 'AND v.voucher_type = ANY($2)';
      qIdx       = 3;
    } else if (cfg.types && cfg.types.length === 0) {
      // Empty array = return nothing (ISD/TDS requires special Tally setup)
      return res.json({ success: true, country_applicable: true, data: [], meta: { total: 0, gstr_type: gstrTypeStr, empty: true,
        label: cfg.label, message: `${cfg.label} (${gstrTypeStr}) requires specific Tally TDL setup. No data available.` } });
    } else {
      qParams    = [companyId];
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
             LEFT JOIN gst_voucher_details g ON g.voucher_guid = v.guid AND g.company_id = v.company_id
             LEFT JOIN ledgers l2 ON l2.name = v.party_name AND l2.company_id = v.company_id
             WHERE v.company_id=$1 AND v.is_cancelled=FALSE ${typeFilter}
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
  const companyId = requireResolvedCompanyId(req);
  const { from, to, page = 1, limit = 50 } = req.query;
  const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, from, to);
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
      LEFT JOIN gst_voucher_details gst ON gst.voucher_guid = v.guid AND gst.company_id = v.company_id
      WHERE v.company_id=$1
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
    `, [companyId, fyFrom, fyTo, parseInt(limit), offset]);
    const { rows: cnt } = await query(
      `SELECT COUNT(*) as c FROM vouchers v
       LEFT JOIN gst_voucher_details gst ON gst.voucher_guid = v.guid AND gst.company_id = v.company_id
       WHERE v.company_id=$1 AND v.is_cancelled=FALSE AND v.voucher_type ILIKE ANY(ARRAY['%Sales%','%Purchase%'])
         AND v.date BETWEEN $2 AND $3
         AND (gst.id IS NULL OR COALESCE(gst.cgst_amount,0)+COALESCE(gst.sgst_amount,0)+COALESCE(gst.igst_amount,0)=0)
         AND ABS(v.amount)>0`,
      [companyId, fyFrom, fyTo]
    );
    res.json({ success: true, data: rows, meta: { total: parseInt(cnt[0].c), page: parseInt(page) } });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EXPENSES
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Recursive Direct/Indirect expense group tree.
 * Matches charge-ledgers pattern — ledgers under sub-groups (e.g. parent='Salary'
 * under 'Indirect Expenses') must count, not only direct children of the root.
 * $1 = company_guid in the CTE.
 */
const EXPENSE_GROUPS_CTE = `
WITH RECURSIVE expense_groups AS (
  SELECT g.name,
         CASE WHEN g.name ~* '^Direct Expenses?$' THEN 'Direct' ELSE 'Indirect' END AS root_type
    FROM groups g
   WHERE g.company_id=$1
     AND (g.name ~* '^Direct Expenses?$' OR g.name ~* '^Indirect Expenses?$')
  UNION ALL
  SELECT child.name, eg.root_type
    FROM groups child
    JOIN expense_groups eg
      ON LOWER(TRIM(COALESCE(child.parent, ''))) = LOWER(TRIM(eg.name))
   WHERE child.company_id=$1
)`;

async function sumExpenseAmount(companyGuid, from, to) {
  if (!from || !to) return 0;
  const { rows } = await query(
    `${EXPENSE_GROUPS_CTE}
     SELECT COALESCE(SUM(ABS(vle.amount)), 0) AS v
     FROM voucher_ledger_entries vle
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
     JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
     WHERE v.company_id=$1
       AND v.is_cancelled = FALSE
       AND vle.dr_cr = 'Dr'
       AND v.date IS NOT NULL AND v.date != ''
       AND v.date BETWEEN $2 AND $3`,
    [companyId, from, to]
  );
  return +(rows?.[0]?.v ?? 0);
}

async function buildExpenseHomeCoreMetrics(companyId, fyFrom, fyTo, today) {
  const yesterday = addDays(today, -1);
  const mtdWin = priorMtdWindow(today);
  const priorFyFrom = shiftYearIso(fyFrom, -1);
  const priorFyTo = shiftYearIso(fyTo, -1);
  const [
    todayVal, yesterdayVal,
    mtdVal, priorMtdVal,
    ytdVal, priorYtdVal,
  ] = await Promise.all([
    sumExpenseAmount(companyId, today, today),
    sumExpenseAmount(companyId, yesterday, yesterday),
    sumExpenseAmount(companyId, mtdWin.from, mtdWin.to),
    sumExpenseAmount(companyId, mtdWin.priorFrom, mtdWin.priorTo),
    sumExpenseAmount(companyId, fyFrom, fyTo),
    sumExpenseAmount(companyId, priorFyFrom, priorFyTo),
  ]);
  const todayTrend = homeMetricTrend(todayVal, yesterdayVal, true);
  const mtdTrend = homeMetricTrend(mtdVal, priorMtdVal, true);
  const ytdTrend = homeMetricTrend(ytdVal, priorYtdVal, true);
  return {
    today: todayVal,
    mtd: mtdVal,
    ytd: ytdVal,
    today_trend_pct: todayTrend.trend_pct,
    today_trend_positive: todayTrend.trend_positive,
    mtd_trend_pct: mtdTrend.trend_pct,
    mtd_trend_positive: mtdTrend.trend_positive,
    ytd_trend_pct: ytdTrend.trend_pct,
    ytd_trend_positive: ytdTrend.trend_positive,
  };
}

// GET /api/expenses/home-metrics — Today / MTD / YTD (+ trend pills; lower spend = positive)
router.get('/expenses/home-metrics', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const today = new Date().toISOString().slice(0, 10);
    const core = await buildExpenseHomeCoreMetrics(companyId, fyFrom, fyTo, today);
    res.json({
      success: true,
      data: {
        ...core,
        from: fyFrom,
        to: fyTo,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

/** Expense register filter counts — type (Direct/Indirect) + category parents. */
router.get('/expenses/counts', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to);
  try {
    const baseFrom = `
      ${EXPENSE_GROUPS_CTE}
      SELECT COUNT(DISTINCT v.guid)::int AS c
      FROM vouchers v
      JOIN voucher_ledger_entries vle ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
      JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
      JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
      WHERE v.company_id=$1
        AND v.is_cancelled = FALSE
        AND vle.dr_cr = 'Dr'
        AND v.date IS NOT NULL AND v.date != ''
        AND v.date BETWEEN $2 AND $3`;
    const [allRes, directRes, indirectRes, catRes] = await Promise.all([
      query(baseFrom, [companyId, from, to]),
      query(`${baseFrom} AND eg.root_type = 'Direct'`, [companyId, from, to]),
      query(`${baseFrom} AND eg.root_type = 'Indirect'`, [companyId, from, to]),
      query(
        `${EXPENSE_GROUPS_CTE}
         SELECT l.parent AS name, COUNT(DISTINCT v.guid)::int AS c
         FROM vouchers v
         JOIN voucher_ledger_entries vle ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
         JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
         JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
         WHERE v.company_id=$1
           AND v.is_cancelled = FALSE
           AND vle.dr_cr = 'Dr'
           AND v.date IS NOT NULL AND v.date != ''
           AND v.date BETWEEN $2 AND $3
         GROUP BY l.parent
         ORDER BY c DESC
         LIMIT 50`,
        [companyId, from, to]
      ),
    ]);
    res.json({
      success: true,
      data: {
        all: parseInt(allRes.rows[0]?.c || 0, 10),
        direct: parseInt(directRes.rows[0]?.c || 0, 10),
        indirect: parseInt(indirectRes.rows[0]?.c || 0, 10),
        categories: (catRes.rows || []).map((r) => ({
          name: r.name,
          count: parseInt(r.c || 0, 10),
        })),
      },
      meta: { from, to },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

router.get('/expenses', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { from, to, page = 1, limit = 30, type, category } = req.query;
  const { from: fyFrom, to: fyTo } = await resolveFYDates(companyId, from, to);
  const offset = (parseInt(page) - 1) * parseInt(limit);
  // Multi-select: types=Direct,Indirect (or legacy type=Direct). Empty / All → both.
  const typesRaw = parseCsvParam(req.query.types).length
    ? parseCsvParam(req.query.types)
    : (type ? [String(type).trim()] : []);
  const wantDirect = typesRaw.some((t) => /^direct$/i.test(t));
  const wantIndirect = typesRaw.some((t) => /^indirect$/i.test(t));
  const wantAllTypes = !typesRaw.length
    || typesRaw.some((t) => /^all$/i.test(t))
    || (wantDirect && wantIndirect);
  // Type scopes via recursive root_type (Direct / Indirect), not immediate parent name.
  let rootTypeSql = '';
  if (!wantAllTypes && wantDirect) rootTypeSql = ` AND eg.root_type = 'Direct'`;
  else if (!wantAllTypes && wantIndirect) rootTypeSql = ` AND eg.root_type = 'Indirect'`;
  // Multi-select categories=A,B (or legacy category=A) — immediate ledger.parent under the tree.
  const categoryNames = parseCsvParam(req.query.categories).length
    ? parseCsvParam(req.query.categories)
    : (typeof category === 'string' && category.trim() ? [category.trim()] : []);

  try {
    const buildFilters = () => {
      const params = [companyId, fyFrom, fyTo];
      let idx = 4;
      let catSql = '';
      if (categoryNames.length === 1) {
        params.push(categoryNames[0]);
        catSql = ` AND LOWER(TRIM(COALESCE(l.parent,''))) = LOWER(TRIM($${idx}))`;
        idx += 1;
      } else if (categoryNames.length > 1) {
        params.push(categoryNames);
        catSql = ` AND LOWER(TRIM(COALESCE(l.parent,''))) = ANY(SELECT LOWER(TRIM(x)) FROM unnest($${idx}::text[]) AS x)`;
        idx += 1;
      }
      return { params, catSql };
    };

    const listBuilt = buildFilters();
    const { rows } = await query(
      `${EXPENSE_GROUPS_CTE}
       SELECT DISTINCT ON (v.guid)
              v.*,
              l.name AS expense_ledger,
              l.parent AS expense_group,
              eg.root_type AS expense_type,
              ABS(vle.amount) AS expense_amount
       FROM vouchers v
       JOIN voucher_ledger_entries vle ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
       JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
       WHERE v.company_id=$1
         AND v.is_cancelled = FALSE
         AND vle.dr_cr = 'Dr'
         ${rootTypeSql}
         ${listBuilt.catSql}
         AND v.date IS NOT NULL AND v.date != ''
         AND v.date BETWEEN $2 AND $3
       ORDER BY v.guid, ABS(vle.amount) DESC`,
      listBuilt.params
    );
    const sorted = rows.sort((a, b) => {
      const da = String(a.date || '');
      const db = String(b.date || '');
      return db.localeCompare(da) || (parseFloat(b.expense_amount) || 0) - (parseFloat(a.expense_amount) || 0);
    });
    const paged = sorted.slice(offset, offset + parseInt(limit));

    const totBuilt = buildFilters();
    const { rows: totRow } = await query(
      `${EXPENSE_GROUPS_CTE}
       SELECT COALESCE(SUM(ABS(vle.amount)), 0) AS total
       FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
       JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
       JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
       WHERE v.company_id=$1
         AND v.is_cancelled = FALSE
         AND vle.dr_cr = 'Dr'
         ${rootTypeSql}
         ${totBuilt.catSql}
         AND v.date IS NOT NULL AND v.date != ''
         AND v.date BETWEEN $2 AND $3`,
      totBuilt.params
    );

    // Categories = immediate ledger parents under the Direct/Indirect tree (not narrowed by type),
    // so the Category tab lists real sub-groups (Salary, Rent, …) with amounts in range.
    const { rows: catRows } = await query(
      `${EXPENSE_GROUPS_CTE}
       SELECT l.parent AS name, COALESCE(SUM(ABS(vle.amount)), 0) AS total
       FROM voucher_ledger_entries vle
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
       JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
       JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
       WHERE v.company_id=$1
         AND v.is_cancelled = FALSE
         AND vle.dr_cr = 'Dr'
         AND v.date IS NOT NULL AND v.date != ''
         AND v.date BETWEEN $2 AND $3
       GROUP BY l.parent
       ORDER BY total DESC
       LIMIT 50`,
      [companyId, fyFrom, fyTo]
    );

    // Master fill: all ledger parents that sit under the expense tree (even if 0 in range).
    const { rows: parentRows } = await query(
      `${EXPENSE_GROUPS_CTE}
       SELECT DISTINCT l.parent AS name
         FROM ledgers l
         JOIN expense_groups eg ON LOWER(TRIM(l.parent)) = LOWER(TRIM(eg.name))
        WHERE l.company_id=$1
          AND COALESCE(TRIM(l.parent), '') <> ''
        ORDER BY name
        LIMIT 50`,
      [companyId]
    );
    const amountByParent = new Map(catRows.map((r) => [r.name, parseFloat(r.total) || 0]));
    const categoryList = [];
    const seen = new Set();
    for (const r of catRows) {
      if (!r.name || seen.has(r.name)) continue;
      seen.add(r.name);
      categoryList.push({ id: r.name, name: r.name, amount_raw: amountByParent.get(r.name) || 0 });
    }
    for (const r of parentRows) {
      if (!r.name || seen.has(r.name)) continue;
      seen.add(r.name);
      categoryList.push({ id: r.name, name: r.name, amount_raw: 0 });
    }

    const totalExpenses = parseFloat(totRow[0]?.total || 0);
    const typeMeta = wantAllTypes
      ? 'All'
      : [wantDirect && 'Direct', wantIndirect && 'Indirect'].filter(Boolean).join(',');
    res.json({
      success: true,
      data: paged.map((r) => ({
        ...r,
        voucher_type: r.voucher_type,
        is_optional: r.is_optional ?? false,
        expense_type: r.expense_type || null,
        expense_group: r.expense_group || null,
      })),
      categories: categoryList,
      summary: { total: totalExpenses, display: `₹${Math.round(totalExpenses).toLocaleString('en-IN')}`, count: sorted.length },
      meta: {
        total: sorted.length,
        page: parseInt(page),
        limit: parseInt(limit),
        from: fyFrom,
        to: fyTo,
        type: typeMeta,
        types: wantAllTypes ? [] : [wantDirect && 'Direct', wantIndirect && 'Indirect'].filter(Boolean),
        category: categoryNames.length === 1 ? categoryNames[0] : null,
        categories: categoryNames,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// DAYBOOK
// ══════════════════════════════════════════════════════════════════════════════

router.get('/daybook', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  const { date, page = 1, limit = 50 } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const offset = (parseInt(page)-1)*parseInt(limit);
  try {
    const { rows } = await query(
      `SELECT * FROM vouchers WHERE company_id=$1 AND date=$2 AND is_cancelled=FALSE ORDER BY id DESC LIMIT $3 OFFSET $4`,
      [companyId, targetDate, parseInt(limit), offset]
    );
    const { rows: cnt } = await query('SELECT COUNT(*) as c FROM vouchers WHERE company_id=$1 AND date=$2 AND is_cancelled=FALSE', [companyId, targetDate]);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query('SELECT gstin, name FROM companies WHERE id=$1', [companyId]);
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
       WHERE company_id=$1 AND user_id = $2
       ORDER BY synced_at DESC
       LIMIT $3`,
      [companyId, req.user.userId, parseInt(limit)]
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const isCurrentFY = (financialYear === currentFYLabel());
    const monthKey    = currentMonthKey();

    // ── Step 1: Check cache (current FY only, monthly TTL) ────────────────────
    if (isCurrentFY) {
      const cached = await getCachedInsights(companyId, monthKey);
      if (cached) {
        return res.json({ success: true, data: { ...cached, fromCache: true, isCurrentFY } });
      }
    }

    // ── Step 2: Compute SQL analytics ─────────────────────────────────────────
    const metrics = await computeInsightMetrics(companyId, from, to, financialYear);
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
      await setCachedInsights(companyId, monthKey, llmPayload, responseData);
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
  const companyId = requireResolvedCompanyId(req);
  const financialYear = req.params.fy; // e.g. '2025-2026'
  if (!financialYear || !/^\d{4}-\d{4}$/.test(financialYear)) {
    return res.status(400).json({ success: false, error: { code: 'INVALID_FY', message: 'fy must be like 2025-2026' } });
  }
  // Block current FY — use /ai/insights for that
  if (financialYear === currentFYLabel()) {
    return res.status(400).json({ success: false, error: { code: 'USE_CURRENT_ENDPOINT', message: 'Use /ai/insights for current FY' } });
  }
  try {
    const { from, to } = await resolveFYDates(companyId, null, null, financialYear);
    const summary = await computeHistoricalSummary(companyId, financialYear, from, to);
    return res.json({ success: true, data: summary });
  } catch(err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// ── Company Profile — GET + PUT ────────────────────────────────────────────────
router.get('/company/profile', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query('SELECT * FROM companies WHERE id=$1 LIMIT 1', [companyId]);
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
  const companyId = requireResolvedCompanyId(req);
  const { gstin, address, state, email, formal_name } = req.body || {};
  try {
    // Scoped by internal id, not guid. Two things were wrong here: the guid
    // column was being compared against companyId, an integer, so the statement
    // matched nothing and every profile edit was silently discarded behind a
    // success response; and had it matched, `WHERE guid = ...` would have
    // rewritten the GSTIN and address of every workspace sharing that Tally GUID.
    const { rowCount } = await query(`
      UPDATE companies SET
        gstin = COALESCE($1, gstin),
        address = COALESCE($2, address),
        state = COALESCE($3, state),
        formal_name = COALESCE($4, formal_name),
        email = COALESCE($5, email)
      WHERE id = $6
    `, [gstin || null, address || null, state || null, formal_name || null, email || null, companyId]);
    if (!rowCount) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Company not found' },
      });
    }
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
  const companyId = requireResolvedCompanyId(req);
  const { logo } = req.body || {}; // expects base64 data URI: data:image/jpeg;base64,...
  if (!logo) return res.status(400).json({ success: false, error: { code: 'MISSING_LOGO', message: 'logo field required (base64 data URI)' } });
  // Validate it's a data URI image
  if (!logo.startsWith('data:image/')) return res.status(400).json({ success: false, error: { code: 'INVALID_FORMAT', message: 'logo must be a base64 data URI (data:image/...)' } });
  // Rough size check: base64 of 500KB image is ~680KB
  if (logo.length > 750_000) return res.status(413).json({ success: false, error: { code: 'TOO_LARGE', message: 'Logo too large. Max 500 KB.' } });
  try {
    // Scoped by internal id. `WHERE guid=...` replaced the logo of every company
    // sharing that Tally GUID, in every workspace — the GET directly below was
    // already scoped by workspace_id, so the two disagreed.
    const { rowCount } = await query('UPDATE companies SET logo_url=$1 WHERE id=$2', [logo, companyId]);
    if (!rowCount) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Company not found' },
      });
    }
    res.json({ success: true, data: { logo_url: logo }, message: 'Logo updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// ─── GET /api/company/:guid/logo — fetch company logo ──────────────────────────
router.get('/company/:guid/logo', authMiddleware, async (req, res) => {
  const { guid } = req.params;
  if (!await verifyCompanyOwnership(req, res, guid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows } = await query('SELECT logo_url FROM companies WHERE guid=$1 AND workspace_id=$2 LIMIT 1', [guid, req.workspaceId]);
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
  
  const companyId = requireResolvedCompanyId(req);
  try {
    // Get company name for the message
    const { rows: co } = await query('SELECT name, guid FROM companies WHERE id=$1 LIMIT 1', [companyId]);
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
        'SELECT email FROM ledgers WHERE company_id=$1 AND name=$2 LIMIT 1',
        [companyId, ledgerName]
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
    const { createAuthSession } = await import('../services/authSessionService.js');
    const session = await createAuthSession(user.id, { mobile: user.mobile, clientType: 'app' });
    const token = session.accessToken;
    await query('UPDATE users SET updated_at=$1 WHERE id=$2', [now(), user.id]);
    const { isPaired, company } = await getUserPairingHints(user.id);
    console.log(`[API 2FA] PIN verified for user ${user.id}`);
    res.json({
      success: true,
      data: {
        access_token: token,
        refresh_token: session.refreshToken,
        session_id: session.sessionId,
        expires_in: session.accessExpiresIn,
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
    const { createAuthSession } = await import('../services/authSessionService.js');
    const session = await createAuthSession(req.user.userId, { mobile: u.mobile, clientType: 'app' });
    const token = session.accessToken;
    const { isPaired } = await getUserPairingHints(req.user.userId);
    res.json({
      success: true,
      data: {
        access_token: token,
        refresh_token: session.refreshToken,
        session_id: session.sessionId,
        expires_in: session.accessExpiresIn,
        is_paired: isPaired,
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
      console.log(`[CHANGE-PHONE S1] OTP sent → +91${cleanPhone}${devOtpSuffix(otp4)}`);
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
      console.log(`[CHANGE-PHONE S2] OTP sent → +91${cleanNew}${devOtpSuffix(newOtp)}`);
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
      console.log(`[CHANGE-EMAIL S1] OTP sent → ${currentEmail}${devOtpSuffix(otp4)}`);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const { from, to, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const fyPrefix = fyLikePrefix(financialYear);
    // Lazy backfill for companies synced before tax extraction existed
    try {
      const { rows: tc } = await query('SELECT COUNT(*)::int AS c FROM tax_transactions WHERE company_id=$1', [companyId]);
      if ((tc[0]?.c || 0) === 0) {
        const { backfillTaxTransactions } = await import('../controllers/ingestProcessor.js');
        await backfillTaxTransactions(companyGuid);
      }
    } catch (e) { console.warn('[other-taxes/summary] backfill skipped:', e.message); }
    const taxDateFilter = `(
        (NULLIF(voucher_date,'') IS NOT NULL AND NULLIF(voucher_date,'')::date BETWEEN $2::date AND $3::date)
        OR ((financial_year = $4 OR financial_year LIKE $5) AND (voucher_date IS NULL OR voucher_date = ''))
      )`;
    const { rows } = await query(`
      SELECT tax_type,
             COUNT(DISTINCT voucher_guid) AS voucher_count,
             SUM(tax_amount)              AS total_tax_amount,
             MAX(COALESCE(NULLIF(voucher_date,''), financial_year)) AS last_transaction_date
      FROM tax_transactions
      WHERE company_id=$1 AND ${taxDateFilter}
      GROUP BY tax_type
      ORDER BY total_tax_amount DESC
    `, [companyId, from, to, financialYear, fyPrefix]);
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
  const companyId = requireResolvedCompanyId(req);
  const { taxType, page = 1, limit = 50 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const { from, to, financialYear } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const fyPrefix = fyLikePrefix(financialYear);
    const params = [companyId, from, to];
    // typeFilter is TOP-LEVEL — must apply to ALL rows (including null-date FY fallback)
    let typeFilter = '';
    if (taxType) { typeFilter = ` AND tax_type = $4`; params.push(taxType); }
    const fyParam = params.length + 1;
    const prefixParam = params.length + 2;
    const fyParams = [...params, financialYear, fyPrefix];
    // Date filter: real date range OR null-date fallback by FY — typeFilter applies to BOTH branches
    const dateFilter = `(
      (NULLIF(voucher_date,'') IS NOT NULL AND NULLIF(voucher_date,'')::date BETWEEN $2::date AND $3::date)
      OR ((financial_year = $${fyParam} OR financial_year LIKE $${prefixParam}) AND (voucher_date IS NULL OR voucher_date = ''))
    )`;
    const { rows } = await query(`
      SELECT * FROM tax_transactions
      WHERE company_id=$1${typeFilter} AND ${dateFilter}
      ORDER BY COALESCE(NULLIF(voucher_date,''), financial_year) DESC
      LIMIT ${parseInt(limit)} OFFSET ${offset}
    `, fyParams);
    const { rows: cnt } = await query(`
      SELECT COUNT(*) AS c FROM tax_transactions
      WHERE company_id=$1${typeFilter} AND ${dateFilter}
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
  const companyId = requireResolvedCompanyId(req);
  const { taxType } = req.query;
  try {
    const { from, to } = await resolveFYDates(companyId, req.query.from, req.query.to, req.query.fy);
    const params = [companyId, from, to];
    let typeFilter = '';
    if (taxType) { typeFilter = ` AND tax_type = $4`; params.push(taxType); }
    const { rows } = await query(`
      SELECT tax_type, return_period, challan_no, due_date, paid_date,
             SUM(tax_amount) AS tax_amount,
             (COALESCE(paid_date::date, NOW()::date) - due_date::date) AS late_days
      FROM tax_transactions
      WHERE company_id=$1 AND NULLIF(voucher_date,'')::date BETWEEN $2::date AND $3::date${typeFilter}
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
  const companyId = requireResolvedCompanyId(req);
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

  const companyId = requireResolvedCompanyId(req);
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
    const stCond = [`st.company_id=$1`];
    const params = [companyId];
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
          WHERE vf.guid = st.voucher_guid AND vf.company_id=$1
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
            AND sv.company_id=$1 AND sv.voucher_number ILIKE $${idx}
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
       WHERE company_id=$1 AND warehouse IS NOT NULL AND warehouse <> ''
       ORDER BY warehouse`, [companyId]);
    const warehouses = whRows.map(r => r.warehouse);

    // ── Distinct voucher types for filter (dynamic — Tally companies use custom names like 'Sales GST')
    const { rows: vtRows } = await query(
      `SELECT DISTINCT voucher_type FROM stock_transactions
       WHERE company_id=$1 AND voucher_type IS NOT NULL AND voucher_type <> ''
       ORDER BY voucher_type`, [companyId]);
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
          ON s.name = st.stock_guid AND s.company_id = st.company_id
        LEFT JOIN vouchers v
          ON v.guid = st.voucher_guid AND v.company_id = st.company_id
          AND v.is_cancelled = FALSE
        LEFT JOIN LATERAL (
          SELECT batch_name FROM voucher_inventory_items
          WHERE voucher_guid = st.voucher_guid
            AND company_id = st.company_id
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
          ON s.name = st.stock_guid AND s.company_id = st.company_id
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
            ON v.guid = st.voucher_guid AND v.company_id = st.company_id
            AND v.is_cancelled = FALSE
          WHERE st.company_id=$1 AND st.stock_guid IN (${placeholders})
          ORDER BY st.date DESC, st.id DESC
        `, [companyId, ...itemNames]);

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
        ON v.guid = st.voucher_guid AND v.company_id = st.company_id
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
        ON v.guid = st.voucher_guid AND v.company_id = st.company_id
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
          ON s.name = st.stock_guid AND s.company_id = st.company_id
        LEFT JOIN LATERAL (
          SELECT batch_name FROM voucher_inventory_items
          WHERE voucher_guid = st.voucher_guid
            AND company_id = st.company_id
            AND stock_item_name = st.stock_guid
          LIMIT 1
        ) vi ON true
        WHERE st.company_id=$1 AND st.voucher_guid IN (${phs})
        ORDER BY st.id
      `, [companyId, ...vGuids]);

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
  const companyId = requireResolvedCompanyId(req);
  const { limit = 20 } = req.query;
  try {
    // Get stock name from guid
    const { rows: sRows } = await query('SELECT name, closing_rate FROM stocks WHERE guid=$1 AND company_id=$2', [req.params.id, companyId]);
    if (!sRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    const stockName = sRows[0].name;

    // Movement history — purchases/sales from voucher_inventory_items;
    // Stock Journal godown transfers from stock_transactions (avoids double-counting IN+OUT legs).
    const { rows } = await query(`
      SELECT * FROM (
        (
          SELECT
            v.voucher_number,
            v.voucher_type AS type,
            v.date,
            v.reference,
            SUM(vi.actual_qty) AS qty,
            CASE WHEN SUM(vi.actual_qty) > 0
              THEN SUM(vi.amount) / NULLIF(SUM(vi.actual_qty), 0)
              ELSE AVG(vi.rate) END AS rate,
            SUM(vi.amount) AS amount,
            FALSE AS is_transfer,
            NULL::text AS from_warehouse,
            NULL::text AS to_warehouse
          FROM voucher_inventory_items vi
          JOIN vouchers v ON v.guid = vi.voucher_guid AND v.company_id = vi.company_id
          WHERE vi.stock_item_name = $1 AND vi.company_id=$2
            AND v.is_cancelled = FALSE
            AND COALESCE(v.voucher_type, '') NOT IN ('Physical Stock', 'Stock Journal')
          GROUP BY v.id, v.voucher_number, v.voucher_type, v.date, v.reference
        )
        UNION ALL
        (
          SELECT DISTINCT ON (st_out.voucher_guid, st_out.warehouse, st_in.warehouse)
            v.voucher_number,
            COALESCE(v.voucher_type, 'Stock Journal') AS type,
            v.date,
            v.reference,
            st_out.qty,
            0::numeric AS rate,
            0::numeric AS amount,
            TRUE AS is_transfer,
            COALESCE(NULLIF(st_out.warehouse, ''), 'Main Location') AS from_warehouse,
            COALESCE(NULLIF(st_in.warehouse,  ''), 'Main Location') AS to_warehouse
          FROM stock_transactions st_out
          JOIN stock_transactions st_in
            ON  st_out.voucher_guid = st_in.voucher_guid
            AND st_out.company_id = st_in.company_id
            AND st_out.stock_guid   = st_in.stock_guid
            AND st_out.type         = 'outward'
            AND st_in.type          = 'inward'
          JOIN vouchers v ON v.guid = st_out.voucher_guid AND v.company_id = st_out.company_id
          WHERE st_out.stock_guid = $1
            AND st_out.company_id=$2
            AND v.is_cancelled = FALSE
            AND COALESCE(v.voucher_type, st_out.voucher_type, '') = 'Stock Journal'
          ORDER BY st_out.voucher_guid, st_out.warehouse, st_in.warehouse, v.date DESC
        )
      ) movements
      ORDER BY date DESC, voucher_number DESC
      LIMIT $3
    `, [stockName, companyId, parseInt(limit)]);

    // Avg purchase rate from inward transactions
    const { rows: avgRows } = await query(`
      SELECT AVG(rate) as avg_purchase_rate,
             (SELECT rate FROM stock_transactions WHERE stock_guid=$1 AND company_id=$2 AND type='inward' AND rate>0 ORDER BY date DESC, id DESC LIMIT 1) as last_purchase_rate
      FROM stock_transactions
      WHERE stock_guid=$1 AND company_id=$2 AND type='inward' AND rate>0
    `, [stockName, companyId]);

    // Last selling rate from sales vouchers
    const { rows: sellRows } = await query(`
      SELECT vi.rate as last_sell_rate
      FROM voucher_inventory_items vi
      JOIN vouchers v ON v.guid = vi.voucher_guid
      WHERE vi.stock_item_name=$1 AND vi.company_id=$2
        AND v.voucher_type ILIKE '%sales%' AND vi.rate > 0
        AND v.is_cancelled = FALSE
      ORDER BY v.date DESC LIMIT 1
    `, [stockName, companyId]);

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

// GET /api/stocks/items/:id/godowns — per-godown on-hand qty (OB split + movements, reconciled to closing_qty)
router.get('/stocks/items/:id/godowns', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.user.companyGuid;
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    // Resolve by Tally GUID or stock name (mobile sometimes only has name).
    const { rows: sRows } = await query(
      `SELECT name, closing_qty, unit, guid FROM stocks
        WHERE company_id=$2 AND (guid = $1 OR name = $1)
        ORDER BY (guid = $1)::int DESC
        LIMIT 1`,
      [req.params.id, companyId]
    );
    if (!sRows[0]) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Item not found' } });
    const stockName = sRows[0].name;
    const totalQty  = parseFloat(sRows[0].closing_qty || 0);
    const unit      = sRows[0].unit || 'pcs';

    // stock_transactions.stock_guid stores stock NAME (ingest convention).
    const { rows } = await query(`
      WITH ob AS (
        SELECT COALESCE(NULLIF(warehouse, ''), 'Main Location') AS wh,
               SUM(qty) AS qty
        FROM stock_transactions
        WHERE stock_guid = $1 AND company_id=$2
          AND voucher_type = 'Opening Balance'
        GROUP BY COALESCE(NULLIF(warehouse, ''), 'Main Location')
      ),
      ps AS (
        SELECT COALESCE(NULLIF(warehouse, ''), 'Main Location') AS wh,
               SUM(qty) AS qty
        FROM stock_transactions
        WHERE stock_guid = $1 AND company_id=$2
          AND voucher_type = 'Physical Stock'
        GROUP BY COALESCE(NULLIF(warehouse, ''), 'Main Location')
      ),
      has_ob AS (
        SELECT COUNT(*)::int AS cnt
        FROM stock_transactions
        WHERE stock_guid = $1 AND company_id=$2
          AND voucher_type = 'Opening Balance'
      ),
      mov AS (
        SELECT COALESCE(NULLIF(warehouse, ''), 'Main Location') AS wh,
               SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) AS qty
        FROM stock_transactions
        WHERE stock_guid = $1 AND company_id=$2
          AND COALESCE(voucher_type, '') NOT IN ('Physical Stock', 'Opening Balance')
        GROUP BY COALESCE(NULLIF(warehouse, ''), 'Main Location')
      ),
      names AS (
        SELECT wh FROM ob
        UNION
        SELECT wh FROM ps
        UNION
        SELECT wh FROM mov
      ),
      combined AS (
        SELECT
          names.wh AS name,
          ROUND(
            (
              (CASE WHEN has_ob.cnt > 0 THEN COALESCE(ob.qty, 0) ELSE COALESCE(ps.qty, 0) END)
              + COALESCE(mov.qty, 0)
            )::numeric,
            4
          ) AS qty
        FROM names
        CROSS JOIN has_ob
        LEFT JOIN ob  ON ob.wh  = names.wh
        LEFT JOIN ps  ON ps.wh  = names.wh
        LEFT JOIN mov ON mov.wh = names.wh
      )
      SELECT name, qty
      FROM combined
      WHERE qty > 0.0001
      ORDER BY qty DESC
    `, [stockName, companyId]);

    let warehouses = rows.map(r => ({
      name: r.name,
      qty:  parseFloat(r.qty),
      pct:  0,
    }));

    const godownSum = warehouses.reduce((s, w) => s + w.qty, 0);
    const gap = Math.round((totalQty - godownSum) * 10000) / 10000;
    const reconciled = Math.abs(gap) < 0.01;

    if (!reconciled && gap > 0.01) {
      warehouses.push({ name: 'Unassigned', qty: gap, pct: 0 });
    }

    warehouses = warehouses.map(w => ({
      ...w,
      pct: totalQty > 0 ? Math.round((w.qty / totalQty) * 1000) / 10 : 0,
    }));

    res.json({
      success: true,
      data: {
        warehouses,
        totalQty,
        godownSum: Math.round(godownSum * 10000) / 10000,
        reconciled,
        unassignedQty: reconciled ? 0 : gap,
        unit,
      },
    });
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
function generateBarcodeValue(type, companyId, seq) {
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

/** Shared barcode list filters — mutates params[], returns AND-clauses (empty string if none). */
function applyBarcodeListFilters({ period, group, status, search }, params) {
  const clauses = [];
  const isAllToken = (v) => !v || ['All', 'all'].includes(String(v).trim());

  const groupList = (Array.isArray(group)
    ? group.map(String).map((s) => s.trim()).filter(Boolean)
    : parseCsvQueryParam(group)
  ).filter((g) => !isAllToken(g));

  if (groupList.length === 1) {
    params.push(groupList[0]);
    clauses.push(`TRIM(s.group_name) = $${params.length}`);
  } else if (groupList.length > 1) {
    params.push(groupList);
    clauses.push(`TRIM(s.group_name) = ANY($${params.length}::text[])`);
  }

  if (period && !isAllToken(period)) {
    const d = period === 'Today' ? new Date().setHours(0, 0, 0, 0)
      : period === '7 Days' ? Date.now() - 7 * 864e5
      : period === '30 Days' ? Date.now() - 30 * 864e5 : null;
    if (d) {
      params.push(new Date(d).toISOString());
      clauses.push(`(sb.created_at IS NULL OR sb.created_at >= $${params.length})`);
    }
  }

  const statusList = (Array.isArray(status)
    ? status.map(String).map((s) => s.trim()).filter(Boolean)
    : parseCsvQueryParam(status)
  ).filter((st) => !isAllToken(st));
  if (statusList.length) {
    const statusClauses = [];
    for (const st of statusList) {
      if (st === 'Linked')              statusClauses.push('sb.barcode IS NOT NULL');
      else if (st === 'Unlinked')       statusClauses.push('sb.barcode IS NULL');
      else if (st === 'In Stock')       statusClauses.push('s.closing_qty > 0');
      else if (st === 'Low Stock')      statusClauses.push('s.closing_qty > 0 AND s.reorder_level > 0 AND s.closing_qty <= s.reorder_level');
      else if (st === 'Out of Stock')   statusClauses.push('s.closing_qty <= 0');
      else if (st === 'Duplicate')      statusClauses.push("sb.status = 'duplicate'");
      else if (st === 'Invalid')        statusClauses.push("sb.status = 'invalid'");
      else if (st === 'Pending Tally Sync') statusClauses.push("sb.tally_sync_status IN ('pending_tally','failed')");
    }
    if (statusClauses.length) clauses.push(`(${statusClauses.join(' OR ')})`);
  }

  if (search && String(search).trim()) {
    params.push(`%${String(search).trim()}%`);
    clauses.push(`(s.name ILIKE $${params.length} OR s.sku ILIKE $${params.length} OR s.alias ILIKE $${params.length} OR sb.barcode ILIKE $${params.length})`);
  }

  return clauses.join(' AND ');
}

/** Build WHERE for unlinked barcode generation targets (requires sb LEFT JOIN). */
function buildBarcodeTargetWhere(companyId, { all, stockGuids, period, group, status, search }, params) {
  const whereParts = ['s.company_id=$1'];
  params.push(companyId);
  const filterSql = applyBarcodeListFilters({ period, group, status, search }, params);
  if (filterSql) whereParts.push(filterSql);
  if (!all && Array.isArray(stockGuids) && stockGuids.length) {
    params.push(stockGuids);
    whereParts.push(`s.guid = ANY($${params.length}::text[])`);
  }
  return whereParts.join(' AND ');
}

async function fetchBarcodeGenerateTargets(companyId, opts) {
  const params = [];
  const where = buildBarcodeTargetWhere(companyId, opts, params);
  const { rows } = await query(`
    SELECT s.guid, s.name FROM stocks s
    LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_id=s.company_id AND sb.is_primary=TRUE AND sb.status='active'
    WHERE ${where}
    AND NOT EXISTS (
      SELECT 1 FROM stock_barcodes sb2
      WHERE sb2.stock_guid = s.guid AND sb2.company_id=$1 AND sb2.is_primary = TRUE AND sb2.status = 'active'
    )
    ORDER BY s.name`, params);
  return rows.map(r => ({ guid: r.guid, name: r.name }));
}

async function generateOneBarcodeForStock(companyId, companyGuid, item, barcodeType, syncTarget, seqOffset) {
  const { rows: [{ cnt }] } = await query(
    `SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_id=$1`, [companyId],
  );
  const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
  let barcode;
  let tries = 0;
  do {
    barcode = generateBarcodeValue(barcodeType, companyId, cnt + seqOffset + tries + 1);
    tries++;
    const { rows: [dup] } = await query(
      `SELECT 1 FROM stock_barcodes WHERE company_id=$1 AND barcode=$2`, [companyId, barcode],
    );
    if (!dup) break;
  } while (tries < 10);
  if (!barcode) throw new Error('Could not allocate unique barcode');
  await query(`
    INSERT INTO stock_barcodes (company_id, company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
    VALUES ($1,$2,$3,$4,$5,$6,'app_generated','active',TRUE,$7,$8)
    ON CONFLICT (company_id, barcode) DO NOTHING`,
    [companyId, companyGuid, item.guid, item.name, barcode, barcodeType, syncTarget, tallyStatus],
  );
  return barcode;
}

const ACTIVE_BARCODE_GEN_JOBS = new Set();

async function processBarcodeGenerateJob(jobId) {
  if (ACTIVE_BARCODE_GEN_JOBS.has(jobId)) return;
  ACTIVE_BARCODE_GEN_JOBS.add(jobId);
  try {
    const { rows: [job] } = await query(
      `SELECT * FROM barcode_generate_jobs WHERE id=$1`, [jobId],
    );
    if (!job || !['pending', 'running'].includes(job.status)) return;

    await query(`UPDATE barcode_generate_jobs SET status='running' WHERE id=$1`, [jobId]);

    const targets = Array.isArray(job.target_guids)
      ? job.target_guids
      : (typeof job.target_guids === 'string' ? JSON.parse(job.target_guids) : []);
    const BATCH = 25;
    let processed = job.processed || 0;
    let generated = job.generated || 0;
    let errors = job.errors || 0;

    for (let i = processed; i < targets.length; i += BATCH) {
      const batch = targets.slice(i, i + BATCH);
      for (const item of batch) {
        try {
          await generateOneBarcodeForStock(
            job.company_id, job.company_guid, item, job.barcode_type, job.sync_target, generated,
          );
          generated++;
        } catch {
          errors++;
        }
        processed++;
      }
      await query(
        `UPDATE barcode_generate_jobs SET processed=$2, generated=$3, errors=$4 WHERE id=$1`,
        [jobId, processed, generated, errors],
      );
      await new Promise((r) => setImmediate(r));
    }

    await query(
      `UPDATE barcode_generate_jobs SET status='completed', processed=$2, generated=$3, errors=$4, completed_at=NOW() WHERE id=$1`,
      [jobId, processed, generated, errors],
    );
  } catch (err) {
    console.error('[barcode-generate-job]', jobId, err.message);
    await query(
      `UPDATE barcode_generate_jobs SET status='failed', error_message=$2, completed_at=NOW() WHERE id=$1`,
      [jobId, err.message],
    ).catch(() => {});
  } finally {
    ACTIVE_BARCODE_GEN_JOBS.delete(jobId);
  }
}

function kickBarcodeGenerateJob(jobId) {
  setImmediate(() => {
    processBarcodeGenerateJob(jobId).catch((err) => {
      console.error('[barcode-generate-job kick]', jobId, err.message);
    });
  });
}

// POST /inventory/barcodes/generate-bulk/start — async background job with progress
router.post('/inventory/barcodes/generate-bulk/start', authMiddleware, async (req, res) => {
  const {
    companyGuid, stockGuids, all,
    period, group, status, search,
    barcodeType = 'CODE128', syncTarget = 'app_only',
  } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!all && (!Array.isArray(stockGuids) || !stockGuids.length))
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'stockGuids[] or all=true required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [running] } = await query(
      `SELECT id, total, processed, generated, errors, status FROM barcode_generate_jobs
       WHERE company_id=$1 AND status IN ('pending','running')
       ORDER BY created_at DESC LIMIT 1`, [companyId],
    );
    if (running) {
      return res.json({
        success: true,
        data: {
          jobId: running.id,
          total: running.total,
          processed: running.processed,
          generated: running.generated,
          errors: running.errors,
          status: running.status,
          resumed: true,
        },
      });
    }

    const targets = await fetchBarcodeGenerateTargets(companyId, {
      all, stockGuids, period, group, status, search,
    });
    if (!targets.length) {
      return res.json({ success: true, data: { jobId: null, total: 0, status: 'completed', generated: 0, errors: 0 } });
    }

    const { randomUUID } = await import('crypto');
    const jobId = randomUUID();
    const filtersJson = JSON.stringify({ all: !!all, stockGuids, period, group, status, search });

    await query(`
      INSERT INTO barcode_generate_jobs
        (id, company_id, company_guid, status, total, processed, generated, errors, barcode_type, sync_target, filters_json, target_guids)
      VALUES ($1,$2,$3,'pending',$4,0,0,0,$5,$6,$7,$8)`,
      [jobId, companyId, companyGuid, targets.length, barcodeType, syncTarget, filtersJson, JSON.stringify(targets)],
    );

    kickBarcodeGenerateJob(jobId);

    res.json({
      success: true,
      data: { jobId, total: targets.length, processed: 0, generated: 0, errors: 0, status: 'pending' },
    });
  } catch (err) {
    console.error('[inventory/barcodes GENERATE-BULK START]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /inventory/barcodes/generate-bulk/status/:jobId — poll job progress
router.get('/inventory/barcodes/generate-bulk/status/:jobId', authMiddleware, async (req, res) => {
  const { jobId } = req.params;
  const { companyGuid } = req.query;
  if (!companyGuid || !jobId) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid and jobId required' } });
  }
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [job] } = await query(
      `SELECT id, status, total, processed, generated, errors, error_message, created_at, completed_at
       FROM barcode_generate_jobs WHERE id=$1 AND company_id=$2`, [jobId, companyId],
    );
    if (!job) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Job not found' } });

    const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 100;
    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        total: job.total,
        processed: job.processed,
        generated: job.generated,
        errors: job.errors,
        pct,
        errorMessage: job.error_message || null,
        completedAt: job.completed_at,
      },
    });
  } catch (err) {
    console.error('[inventory/barcodes GENERATE-BULK STATUS]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /inventory/barcodes/generate-bulk/active — resume polling if job still running
router.get('/inventory/barcodes/generate-bulk/active', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) {
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid required' } });
  }
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [job] } = await query(
      `SELECT id, status, total, processed, generated, errors, error_message
       FROM barcode_generate_jobs
       WHERE company_id=$1 AND status IN ('pending','running')
       ORDER BY created_at DESC LIMIT 1`, [companyId],
    );
    if (!job) return res.json({ success: true, data: null });
    const pct = job.total > 0 ? Math.min(100, Math.round((job.processed / job.total) * 100)) : 100;
    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        total: job.total,
        processed: job.processed,
        generated: job.generated,
        errors: job.errors,
        pct,
        errorMessage: job.error_message || null,
      },
    });
  } catch (err) {
    console.error('[inventory/barcodes GENERATE-BULK ACTIVE]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// POST /inventory/barcodes/generate-bulk — sync path for small stockGuids batches (print queue)
router.post('/inventory/barcodes/generate-bulk', authMiddleware, async (req, res) => {
  const {
    companyGuid, stockGuids, all,
    period, group, status, search,
    barcodeType = 'CODE128', syncTarget = 'app_only',
  } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!all && (!Array.isArray(stockGuids) || !stockGuids.length))
    return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'stockGuids[] or all=true required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const companyId = requireResolvedCompanyId(req);
  if (all) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'USE_ASYNC_JOB',
        message: 'Use POST /inventory/barcodes/generate-bulk/start for all=true bulk generation',
      },
    });
  }

  try {
    const targets = await fetchBarcodeGenerateTargets(companyId, {
      all: false, stockGuids, period, group, status, search,
    });

    if (!targets.length)
      return res.json({ success: true, data: { generated: 0, alreadyLinked: stockGuids?.length || 0, errors: 0 } });

    let generated = 0, errors = 0;
    for (const item of targets) {
      try {
        await generateOneBarcodeForStock(companyId, companyGuid, item, barcodeType, syncTarget, generated);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const displayField = await getProductDisplayField(companyId);
    const { rows } = await query(`
      SELECT
        s.guid AS stock_guid, s.name, s.alias, s.sku, s.group_name, s.unit,
        s.closing_qty, s.closing_rate,
        sb.barcode, sb.barcode_type, sb.status AS barcode_status, sb.tally_sync_status
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_id=s.company_id AND sb.is_primary=TRUE AND sb.status='active'
      WHERE s.company_id=$1 AND s.guid = ANY($2::text[])
      ORDER BY s.name ASC`, [companyId, stockGuids]);
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const displayField = await getProductDisplayField(companyId);
    const lim  = Math.min(parseInt(pageSize) || 50, 200);
    const off  = (Math.max(1, parseInt(page)) - 1) * lim;
    const params = [companyId];
    let where = 's.company_id=$1';
    const filterSql = applyBarcodeListFilters({ period, group, status, search }, params);
    if (filterSql) where += ` AND ${filterSql}`;

    const sumRes = await query(`
      SELECT
        COUNT(DISTINCT s.guid)::int AS total_items,
        COUNT(DISTINCT sb.stock_guid) FILTER (WHERE sb.status='active')::int AS linked,
        COUNT(*) FILTER (WHERE sb.status='duplicate')::int AS duplicates,
        COUNT(*) FILTER (WHERE sb.status='invalid')::int AS invalid,
        COUNT(*) FILTER (WHERE sb.tally_sync_status IN ('pending_tally','failed'))::int AS pending_tally_sync
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_id=s.company_id AND sb.is_primary=TRUE
      WHERE s.company_id=$1`, [companyId]);
    const sr = sumRes.rows[0] || {};

    const { rows } = await query(`
      SELECT
        s.guid AS stock_guid, s.name, s.alias, s.sku, s.description, s.group_name, s.unit,
        s.closing_qty, s.reorder_level,
        sb.id AS barcode_id, sb.barcode, sb.barcode_type,
        sb.status AS barcode_status, sb.source, sb.sync_target, sb.tally_sync_status, sb.is_primary,
        COUNT(*) OVER() AS _total
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_id=s.company_id AND sb.is_primary=TRUE AND sb.status='active'
      WHERE ${where}
      ORDER BY s.name ASC
      LIMIT $${params.length+1} OFFSET $${params.length+2}`, [...params, lim, off]);

    const total  = parseInt(rows[0]?._total ?? 0);
    const linked = parseInt(sr.linked || 0);

    const unlinkedFilterRes = await query(`
      SELECT COUNT(DISTINCT s.guid)::int AS unlinked_in_filter
      FROM stocks s
      LEFT JOIN stock_barcodes sb ON sb.stock_guid=s.guid AND sb.company_id=s.company_id AND sb.is_primary=TRUE AND sb.status='active'
      WHERE ${where} AND sb.barcode IS NULL`, params);
    const unlinkedInFilter = parseInt(unlinkedFilterRes.rows[0]?.unlinked_in_filter ?? 0);

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

    const groupsRes = await query(`SELECT DISTINCT TRIM(group_name) AS group_name FROM stocks WHERE company_id=$1 AND group_name IS NOT NULL AND TRIM(group_name) != '' ORDER BY 1`, [companyId]);
    const groups = ['All', ...groupsRes.rows.map(r => r.group_name)];

    res.json({
      success: true,
      data: {
        summary: {
          totalItems: parseInt(sr.total_items||0), linked,
          unlinked: Math.max(0, parseInt(sr.total_items||0) - linked),
          unlinkedInFilter,
          duplicates: parseInt(sr.duplicates||0), invalid: parseInt(sr.invalid||0),
          pendingTallySync: parseInt(sr.pending_tally_sync||0),
        },
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
async function autoSyncBarcodeToTally(userId, companyId, stockGuid, stockName, barcode, syncTarget) {
  if (!syncTarget || syncTarget === 'app_only') return;
  try {
    const { rows: [settings] } = await query(
      'SELECT auto_sync_to_tally FROM inventory_barcode_settings WHERE company_id=$1', [companyId]);
    if (!settings?.auto_sync_to_tally) return; // toggle is OFF — do not push
    const { rows: [co] } = await query('SELECT name, guid FROM companies WHERE id=$1', [companyId]);
    if (!co?.name) return;
    const { pushBarcodeToTally } = await import('./tally-write.js');
    const result = await pushBarcodeToTally({
      companyGuid: co.guid, userId, stockGuid, stockName, barcode, syncTarget, companyName: co.name,
    });
    // Map Tally result → tally_sync_status
    const newStatus =
      !result                               ? 'pending_tally' :
      result.status === 'desktop_offline'   ? 'pending_tally' :
      result.status === 'success'           ? 'synced'        :
      (result.altered > 0 && !result.errors)? 'synced'        : 'failed';
    await query(
      'UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_id=$2 AND stock_guid=$3 AND barcode=$4',
      [newStatus, companyId, stockGuid, barcode]
    );
  } catch (err) {
    console.error('[autoSyncBarcodeToTally]', err.message); // non-fatal — barcode already saved
  }
}

router.post('/inventory/barcodes/generate', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuid, barcodeType = 'CODE128', syncTarget = 'app_only' } = req.body;
  if (!companyGuid || !stockGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_PARAMS', message: 'companyGuid and stockGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [stock] } = await query('SELECT name, guid FROM stocks WHERE guid=$1 AND company_id=$2', [stockGuid, companyId]);
    if (!stock) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Stock item not found' } });
    const { rows: [existing] } = await query(`SELECT barcode, barcode_type FROM stock_barcodes WHERE stock_guid=$1 AND company_id=$2 AND is_primary=TRUE AND status='active' LIMIT 1`, [stockGuid, companyId]);
    if (existing) return res.json({ success: true, data: { barcode: existing.barcode, barcodeType: existing.barcode_type, status: 'active', alreadyExisted: true } });
    const { rows: [{ cnt }] } = await query(`SELECT COUNT(*)::int AS cnt FROM stock_barcodes WHERE company_id=$1`, [companyId]);
    let barcode, tries = 0;
    do {
      barcode = generateBarcodeValue(barcodeType, companyId, cnt + tries + 1);
      tries++;
      const { rows: [dup] } = await query(`SELECT 1 FROM stock_barcodes WHERE company_id=$1 AND barcode=$2`, [companyId, barcode]);
      if (!dup) break;
    } while (tries < 10);
    const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
    const { rows: [ins] } = await query(`
      INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
      VALUES ($1,$2,$3,$4,$5,'app_generated','active',TRUE,$6,$7)
      RETURNING barcode, barcode_type, status, tally_sync_status`,
      [companyId, stockGuid, stock.name, barcode, barcodeType, syncTarget, tallyStatus]);
    // Auto-push to Tally if toggle is ON (fire-and-forget, non-blocking)
    autoSyncBarcodeToTally(req.user.userId, companyId, stockGuid, stock.name, ins.barcode, syncTarget).catch(() => {});
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
  const companyId = requireResolvedCompanyId(req);
  const vErr = validateBarcode(barcode, barcodeType);
  if (vErr) return res.status(400).json({ success: false, error: { code: 'INVALID_BARCODE', message: vErr } });
  try {
    const { rows: [stock] } = await query('SELECT name FROM stocks WHERE guid=$1 AND company_id=$2', [stockGuid, companyId]);
    if (!stock) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Stock item not found' } });
    const { rows: [dup] } = await query(`SELECT stock_name FROM stock_barcodes WHERE company_id=$1 AND barcode=$2`, [companyId, barcode.trim()]);
    if (dup) return res.status(409).json({ success: false, error: { code: 'DUPLICATE_BARCODE', message: `Barcode already linked to "${dup.stock_name}"` } });
    if (isPrimary) await query(`UPDATE stock_barcodes SET is_primary=FALSE WHERE stock_guid=$1 AND company_id=$2 AND is_primary=TRUE`, [stockGuid, companyId]);
    const tallyStatus = syncTarget === 'app_only' ? 'not_required' : 'pending_tally';
    await query(`
      INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
      VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`,
      [companyId, stockGuid, stock.name, barcode.trim(), barcodeType, source, isPrimary, syncTarget, tallyStatus]);
    // Auto-push to Tally if toggle is ON
    autoSyncBarcodeToTally(req.user.userId, companyId, stockGuid, stock.name, barcode.trim(), syncTarget).catch(() => {});
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
  const companyId = requireResolvedCompanyId(req);
  try {
    const displayField = await getProductDisplayField(companyId);
    const { rows: [row] } = await query(`
      SELECT s.guid AS stock_guid, s.name, s.sku, s.alias, s.group_name, s.unit, s.closing_qty,
             sb.barcode, sb.barcode_type
      FROM stock_barcodes sb
      JOIN stocks s ON s.guid=sb.stock_guid AND s.company_id=sb.company_id
      WHERE sb.company_id=$1 AND sb.barcode=$2 AND sb.status='active'
      LIMIT 1`, [companyId, barcode.trim()]);
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
  const companyId = requireResolvedCompanyId(req);
  const rawLines = lines || (text ? String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean) : []);
  if (!rawLines.length) return res.status(400).json({ success: false, error: { code: 'NO_DATA', message: 'No data to import' } });
  try {
    // Read company's current sync settings so imported barcodes respect them
    const { rows: [companySettings] } = await query(
      'SELECT barcode_storage_mode, auto_sync_to_tally FROM inventory_barcode_settings WHERE company_id=$1',
      [companyId]
    ).catch(() => ({ rows: [{}] }));
    const companySyncTarget   = companySettings?.barcode_storage_mode || 'app_only';
    const companyAutoSync     = companySettings?.auto_sync_to_tally   || false;
    const companyTallyStatus  = companySyncTarget === 'app_only' ? 'not_required' : 'pending_tally';

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
        const { rows: [found] } = await query(`SELECT guid,name FROM stocks WHERE company_id=$1 AND (LOWER(name)=LOWER($2) OR LOWER(sku)=LOWER($2) OR LOWER(alias)=LOWER($2)) LIMIT 1`, [companyId, row.rawItemName]);
        if (found) { stockGuid=found.guid; stockName=found.name; }
        else { needsReview++; errors.push({ job_id: jobId, row_number: row.rowNumber, item_identifier: row.rawItemName, barcode: b, error_type: 'needs_review', error_message: `No stock item matched "${row.rawItemName}"`, raw_data: row.raw }); continue; }
      }
      const { rows: [dup] } = await query(`SELECT stock_name FROM stock_barcodes WHERE company_id=$1 AND barcode=$2`, [companyId, b]);
      if (dup) { duplicates++; errors.push({ job_id: jobId, row_number: row.rowNumber, barcode: b, error_type: 'duplicate', error_message: `Barcode already linked to "${dup.stock_name}"`, raw_data: row.raw }); continue; }
      try {
        await query(`INSERT INTO stock_barcodes (company_id,company_guid,stock_guid,stock_name,barcode,barcode_type,source,status,is_primary,sync_target,tally_sync_status) VALUES ($1,$2,$3,$4,$5,'CODE128','import','active',TRUE,$6,$7) ON CONFLICT (company_id,barcode) DO NOTHING`, [companyId, companyGuid, stockGuid, stockName, b, companySyncTarget, companyTallyStatus]);
        imported++;
      } catch(e) { invalid++; errors.push({ job_id: jobId, row_number: row.rowNumber, barcode: b, error_type: 'error', error_message: e.message, raw_data: row.raw }); }
    }
    await query(`INSERT INTO barcode_import_jobs (id,company_guid,file_name,status,total_rows,imported_rows,duplicate_rows,invalid_rows,needs_review_rows,created_at,completed_at) VALUES ($1,$2,$3,'completed',$4,$5,$6,$7,$8,NOW(),NOW())`, [jobId, companyGuid, fileName, parsed.length, imported, duplicates, invalid, needsReview]);
    for (const e of errors) await query(`INSERT INTO barcode_import_errors (job_id,row_number,item_identifier,barcode,error_type,error_message,raw_data) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [e.job_id, e.row_number, e.item_identifier||null, e.barcode, e.error_type, e.error_message, e.raw_data]);

    // Auto-push imported barcodes to Tally if company settings say so
    if (imported > 0 && companyAutoSync && companySyncTarget !== 'app_only') {
      setImmediate(async () => {
        try {
          const { pushBarcodeToTally } = await import('./tally-write.js');
          const { rows: [co] } = await query('SELECT name, guid FROM companies WHERE id=$1', [companyId]);
          if (!co?.name) return;
          const { rows: newBarcodes } = await query(
            `SELECT stock_guid, stock_name, barcode, sync_target FROM stock_barcodes
             WHERE company_id=$1 AND tally_sync_status='pending_tally' AND status='active' LIMIT 100`,
            [companyId]);
          for (const row of newBarcodes) {
            const result = await pushBarcodeToTally({
              companyGuid, userId: req.user.userId,
              stockGuid: row.stock_guid, stockName: row.stock_name,
              barcode: row.barcode, syncTarget: row.sync_target, companyName: co.name,
            }).catch(() => null);
            const s = !result ? 'pending_tally'
              : result.status === 'desktop_offline' ? 'pending_tally'
              : (result.status === 'success' || (result.altered > 0 && !result.errors)) ? 'synced' : 'failed';
            await query('UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_id=$2 AND stock_guid=$3 AND barcode=$4',
              [s, companyId, row.stock_guid, row.barcode]);
            if (s === 'pending_tally') break;
          }
        } catch (e) { console.error('[bulk-import auto-sync]', e.message); }
      });
    }

    res.json({ success: true, data: { jobId, summary: { totalRows: parsed.length, imported, duplicates, invalid, needsReview } } });
  } catch (err) {
    console.error('[inventory/barcodes BULK-IMPORT]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/inventory/barcodes/template — pre-filled CSV with all company stocks
// Columns: item_name,barcode  (simple — user fills barcode column and re-uploads)
router.get('/inventory/barcodes/template', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    // Fetch all stocks + their primary barcode (if already linked)
    const { rows } = await query(`
      SELECT s.name AS item_name, sb.barcode
      FROM stocks s
      LEFT JOIN stock_barcodes sb
        ON sb.stock_guid = s.guid AND sb.company_id = s.company_id
           AND sb.is_primary = TRUE AND sb.status = 'active'
      WHERE s.company_id=$1
      ORDER BY s.name ASC`, [companyId]);

    // Build CSV: header + one row per stock
    const lines = ['item_name,barcode'];
    for (const r of rows) {
      // Escape item_name if it contains commas or quotes
      const name = r.item_name ? `"${String(r.item_name).replace(/"/g, '""')}"` : '';
      const bc   = r.barcode   ? `"${String(r.barcode).replace(/"/g, '""')}"` : '';
      lines.push(`${name},${bc}`);
    }
    const csv = lines.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="barcode_template.csv"');
    res.send(csv);
  } catch (err) {
    console.error('[barcode template]', err.message);
    res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } });
  }
});

// GET /api/inventory/barcodes/settings — get barcode settings
router.get('/inventory/barcodes/settings', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [row] } = await query(`SELECT * FROM inventory_barcode_settings WHERE company_id=$1`, [companyId]);
    res.json({ success: true, data: { barcodeStorageMode: row?.barcode_storage_mode || 'app_only', defaultBarcodeType: row?.default_barcode_type || 'CODE128', autoSyncToTally: row?.auto_sync_to_tally || false } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

// POST /api/inventory/barcodes/push-pending — manually push all pending_tally barcodes to Tally
// Also called automatically when user saves settings with autoSyncToTally=true
router.post('/inventory/barcodes/push-pending', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body;
  if (!companyGuid) return res.status(400).json({ success: false, error: { code: 'MISSING_COMPANY', message: 'companyGuid required' } });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  const companyId = requireResolvedCompanyId(req);
  try {
    const { rows: [co] } = await query('SELECT name, guid FROM companies WHERE id=$1', [companyId]);
    if (!co?.name) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Company not found' } });

    const { rows: pending } = await query(`
      SELECT sb.stock_guid, sb.stock_name, sb.barcode, sb.sync_target
      FROM stock_barcodes sb
      WHERE sb.company_id=$1 AND sb.tally_sync_status='pending_tally' AND sb.status='active'
      ORDER BY sb.created_at ASC LIMIT 100`, [companyId]);

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

        await query('UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_id=$2 AND stock_guid=$3 AND barcode=$4',
          [newStatus, companyId, row.stock_guid, row.barcode]);

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
  const companyId = requireResolvedCompanyId(req);
  const VALID_MODES = ['app_only','tally_alias','tally_part_number','tally_udf'];
  const VALID_TYPES = ['CODE128','EAN13','EAN8','UPC','QR','INTERNAL'];
  if (!VALID_MODES.includes(barcodeStorageMode)) return res.status(400).json({ success: false, error: { code: 'INVALID_MODE', message: 'Invalid storage mode' } });
  if (!VALID_TYPES.includes(defaultBarcodeType))  return res.status(400).json({ success: false, error: { code: 'INVALID_TYPE', message: 'Invalid barcode type' } });
  try {
    await query(`
      INSERT INTO inventory_barcode_settings (company_id, company_guid, barcode_storage_mode, default_barcode_type, auto_sync_to_tally, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (company_id) DO UPDATE SET barcode_storage_mode=EXCLUDED.barcode_storage_mode, default_barcode_type=EXCLUDED.default_barcode_type, auto_sync_to_tally=EXCLUDED.auto_sync_to_tally, updated_at=NOW()`,
      [companyId, companyGuid, barcodeStorageMode, defaultBarcodeType, autoSyncToTally]);

    // When user enables auto-sync AND selects a Tally target, update any existing
    // 'app_only' barcodes for this company to the new sync_target so they get queued,
    // then trigger push-pending (fire-and-forget)
    if (autoSyncToTally && barcodeStorageMode !== 'app_only') {
      await query(`UPDATE stock_barcodes SET sync_target=$1, tally_sync_status='pending_tally'
        WHERE company_id=$2 AND status='active' AND tally_sync_status='not_required'`,
        [barcodeStorageMode, companyId]);
      // Kick off push in background — response does not wait for it
      setImmediate(async () => {
        try {
          const { pushBarcodeToTally } = await import('./tally-write.js');
          const { rows: [co] } = await query('SELECT name, guid FROM companies WHERE id=$1', [companyId]);
          if (!co?.name) return;
          const { rows: pending } = await query(`
            SELECT stock_guid, stock_name, barcode, sync_target FROM stock_barcodes
            WHERE company_id=$1 AND tally_sync_status='pending_tally' AND status='active' LIMIT 100`,
            [companyId]);
          for (const row of pending) {
            const result = await pushBarcodeToTally({
              companyGuid, userId: req.user.userId,
              stockGuid: row.stock_guid, stockName: row.stock_name,
              barcode: row.barcode, syncTarget: row.sync_target, companyName: co.name,
            }).catch(() => null);
            const s = !result ? 'pending_tally'
              : result.status === 'desktop_offline' ? 'pending_tally'
              : (result.status === 'success' || (result.altered > 0 && !result.errors)) ? 'synced' : 'failed';
            await query('UPDATE stock_barcodes SET tally_sync_status=$1 WHERE company_id=$2 AND stock_guid=$3 AND barcode=$4',
              [s, companyId, row.stock_guid, row.barcode]);
            if (s === 'pending_tally') break; // desktop offline — stop
          }
        } catch (e) { console.error('[settings auto-sync]', e.message); }
      });
    }

    res.json({ success: true, data: { barcodeStorageMode, defaultBarcodeType, autoSyncToTally } });
  } catch (err) { res.status(500).json({ success: false, error: { code: 'SERVER_ERROR', message: err.message } }); }
});

export default router;
