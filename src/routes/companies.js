import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

// GET /app/companies
router.get('/companies', authMiddleware, async (req, res) => {
  try {
    const { rows: companies } = await query(
      'SELECT * FROM companies WHERE user_id = $1 ORDER BY name',
      [req.user.userId]
    );

    // Fetch all financial years for all companies in one query
    const guids = companies.map(c => c.guid);
    let allYearsRows = [];
    if (guids.length > 0) {
      const ph = guids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await query(`SELECT * FROM company_years WHERE company_guid IN (${ph}) ORDER BY begin_date ASC`, guids);
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
  await query(`
    INSERT INTO companies (guid, user_id, device_id, name, formal_name, gstin, address, state, fy_start, fy_end, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (guid) DO UPDATE SET
      name = EXCLUDED.name, formal_name = EXCLUDED.formal_name,
      gstin = EXCLUDED.gstin, address = EXCLUDED.address,
      state = EXCLUDED.state, synced_at = EXCLUDED.synced_at
  `, [
    companyData.guid, userId, deviceId,
    companyData.name || companyData.NAME || 'Unknown',
    companyData.formalName || companyData.name || '',
    companyData.gstin || null,
    companyData.address || null,
    companyData.state || null,
    companyData.fyStart || null,
    companyData.fyEnd || null,
    now(),
  ]);
}

export default router;
