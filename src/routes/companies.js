import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

// GET /app/companies
router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const { rows: companies } = await query(
      'SELECT * FROM companies WHERE user_id = $1 AND (is_active = TRUE OR is_active IS NULL) ORDER BY name',
      [req.user.userId]
    );

    // Fetch all financial years for all companies in one query
    const guids = companies.map(c => c.guid);
    let allYearsRows = [];
    if (guids.length > 0) {
      const ph = guids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await query(`SELECT * FROM company_years WHERE company_guid IN (${ph}) AND is_active = TRUE ORDER BY begin_date ASC`, guids);
      allYearsRows = rows;
    }

    const yearsByCompany = {};
    for (const y of allYearsRows) {
      if (!yearsByCompany[y.company_guid]) yearsByCompany[y.company_guid] = [];
      yearsByCompany[y.company_guid].push({
        uniqueId: `${y.company_guid}_${y.fin_year}`,
        name: y.fin_year,
        startDate: y.begin_date,
        endDate: y.end_date,
      });
    }

    const companiesWithYears = companies.map(c => {
      let years = yearsByCompany[c.guid] || [];

      // Fallback: derive from fy_start/fy_end if no years in DB yet
      if (years.length === 0) {
        const fyStart = c.fy_start;
        const fyEnd   = c.fy_end;
        if (fyStart && fyEnd) {
          const startYear = String(fyStart).replace(/-/g, '').slice(0, 4);
          const endYear   = String(fyEnd).replace(/-/g, '').slice(0, 4);
          years = [{ uniqueId: `${c.guid}_${startYear}`, name: `${startYear}-${String(endYear).slice(2)}`, startDate: fyStart, endDate: fyEnd }];
        } else {
          const now = new Date();
          const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          years = [{ uniqueId: `${c.guid}_${fyYear}`, name: `${fyYear}-${String(fyYear + 1).slice(2)}`, startDate: `${fyYear}-04-01`, endDate: `${fyYear + 1}-03-31` }];
        }
      }

      return { ...c, years };
    });

    res.json({ status: true, data: { companies: companiesWithYears } });
  } catch (err) {
    console.error('[companies] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch companies' });
  }
});

// GET /app/pairing-device
router.get('/pairing-device', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
      [req.user.userId]
    );
    const device = rows[0];
    if (!device) return res.json({ status: true, data: { device: null, isPaired: false } });
    res.json({ status: true, data: { device: { id: device.device_id, name: device.name, os: device.os, lastSeen: device.last_seen }, isPaired: true } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch device' });
  }
});

// GET /app/paired-device — alias
router.get('/paired-device', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
      [req.user.userId]
    );
    const device = rows[0];
    if (!device) return res.json({ status: true, data: { device: null, isPaired: false } });
    res.json({ status: true, data: { device: { id: device.device_id, name: device.name, os: device.os, lastSeen: device.last_seen }, isPaired: true } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch device' });
  }
});

// Internal upsert (called from ingest)
export async function upsertCompany(companyData, userId, deviceId) {
  const address = Array.isArray(companyData.address)
    ? companyData.address.map((l) => String(l || '').trim()).filter(Boolean).join(', ')
    : (companyData.address || null);
  await query(`
    INSERT INTO companies (guid, user_id, device_id, name, formal_name, gstin, address, state, fy_start, fy_end, synced_at,
                           pan, phone, mobile, email, website, pincode, country)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    ON CONFLICT (guid) DO UPDATE SET
      name = EXCLUDED.name, formal_name = EXCLUDED.formal_name,
      gstin = COALESCE(EXCLUDED.gstin, companies.gstin),
      address = COALESCE(EXCLUDED.address, companies.address),
      state = COALESCE(EXCLUDED.state, companies.state), synced_at = EXCLUDED.synced_at,
      pan     = COALESCE(EXCLUDED.pan,     companies.pan),
      phone   = COALESCE(EXCLUDED.phone,   companies.phone),
      mobile  = COALESCE(EXCLUDED.mobile,  companies.mobile),
      email   = COALESCE(EXCLUDED.email,   companies.email),
      website = COALESCE(EXCLUDED.website, companies.website),
      pincode = COALESCE(EXCLUDED.pincode, companies.pincode),
      country = COALESCE(EXCLUDED.country, companies.country)
  `, [
    companyData.guid, userId, deviceId,
    companyData.name || companyData.NAME || 'Unknown',
    companyData.formalName || companyData.name || '',
    companyData.gstin || companyData.gstNumber || null,
    address,
    companyData.state || null,
    companyData.fyStart || null,
    companyData.fyEnd || null,
    now(),
    companyData.incomeTaxNumber || null,
    companyData.phoneNumber || null,
    companyData.mobileNumber || null,
    companyData.email || null,
    companyData.website || null,
    companyData.pincode || null,
    companyData.country || null,
  ]);
}

const PRINT_PROFILE_FIELDS = [
  'gstin', 'pan', 'email', 'phone', 'jurisdiction', 'declaration_text',
  'bank_name', 'bank_account_no', 'bank_ifsc', 'bank_branch',
  'pdf_format', 'pdf_format_overrides',
];

const DEFAULT_DECLARATION =
  'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.';

// GET /app/companies/:guid/print-profile — print-only header/footer details
router.get('/companies/:guid/print-profile', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    const { rows: owned } = await query(
      'SELECT guid, gstin, pan, email, phone FROM companies WHERE guid = $1 AND user_id = $2',
      [guid, req.user.userId]
    );
    if (!owned[0]) return res.status(404).json({ status: false, message: 'Company not found' });

    const { rows } = await query('SELECT * FROM company_print_profile WHERE company_guid = $1', [guid]);
    const profile = rows[0] || {};
    res.json({
      status: true,
      data: {
        companyGuid: guid,
        // Synced value wins; the profile only fills what Tally never sent.
        gstin: owned[0].gstin || profile.gstin || '',
        pan: owned[0].pan || profile.pan || '',
        email: owned[0].email || profile.email || '',
        phone: owned[0].phone || profile.phone || '',
        jurisdiction: profile.jurisdiction || '',
        declarationText: profile.declaration_text || DEFAULT_DECLARATION,
        bankName: profile.bank_name || '',
        bankAccountNo: profile.bank_account_no || '',
        bankIfsc: profile.bank_ifsc || '',
        bankBranch: profile.bank_branch || '',
        pdfFormat: profile.pdf_format || 'tally',
        pdfFormatOverrides: profile.pdf_format_overrides || {},
      },
    });
  } catch (err) {
    console.error('[print-profile:get]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch print profile' });
  }
});

// PUT /app/companies/:guid/print-profile
router.put('/companies/:guid/print-profile', authMiddleware, async (req, res) => {
  try {
    const { guid } = req.params;
    const { rows: owned } = await query(
      'SELECT guid FROM companies WHERE guid = $1 AND user_id = $2',
      [guid, req.user.userId]
    );
    if (!owned[0]) return res.status(404).json({ status: false, message: 'Company not found' });

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
    if (!cols.length) return res.status(400).json({ status: false, message: 'No print profile fields supplied' });

    const values = cols.map((c) => (
      c === 'pdf_format_overrides' ? JSON.stringify(incoming[c] || {}) : incoming[c]
    ));
    const placeholders = cols.map((_, i) => `$${i + 2}`).join(', ');
    const updates = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');

    await query(
      `INSERT INTO company_print_profile (company_guid, ${cols.join(', ')})
       VALUES ($1, ${placeholders})
       ON CONFLICT (company_guid) DO UPDATE SET ${updates}, updated_at = NOW()`,
      [guid, ...values]
    );
    res.json({ status: true, message: 'Print profile saved' });
  } catch (err) {
    console.error('[print-profile:put]', err.message);
    res.status(500).json({ status: false, message: 'Failed to save print profile' });
  }
});

export default router;
