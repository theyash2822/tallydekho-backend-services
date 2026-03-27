import { Router } from 'express';
import { getDb } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// GET /app/companies — list companies for logged-in user
router.get('/companies', authMiddleware, (req, res) => {
  const db = getDb();
  const companies = db.prepare('SELECT * FROM companies WHERE user_id = ? ORDER BY name').all(req.user.userId);
  res.json({ status: true, data: { companies } });
});

// Internal: upsert company (called from ingest pipeline)
export function upsertCompany(companyData, userId, deviceId) {
  const db = getDb();
  db.prepare(`
    INSERT INTO companies (guid, user_id, device_id, name, formal_name, gstin, address, state, fy_start, fy_end, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(guid) DO UPDATE SET
      name=excluded.name, formal_name=excluded.formal_name, gstin=excluded.gstin,
      address=excluded.address, state=excluded.state, synced_at=unixepoch()
  `).run(companyData.guid, userId, deviceId, companyData.name, companyData.formalName || companyData.name,
    companyData.gstin || null, companyData.address || null, companyData.state || null,
    companyData.fyStart || null, companyData.fyEnd || null);
}

export default router;
