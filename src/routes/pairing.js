// Pairing routes — Desktop generates code, Mobile enters it
import { Router } from 'express';
import { getDb } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';

const router = Router();

// Generate 6-digit pairing code (called by Desktop)
// GET /desktop/pairing-code
router.get('/pairing-code', (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id header required' });

  const db = getDb();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 10 * 60 * 1000; // 10 min

  // Upsert device
  db.prepare(`
    INSERT INTO devices (device_id, pairing_code, code_expires, last_seen)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(device_id) DO UPDATE SET
      pairing_code=excluded.pairing_code,
      code_expires=excluded.code_expires,
      last_seen=unixepoch()
  `).run(deviceId, code, expires);

  console.log(`[PAIRING] Device ${deviceId} → code ${code}`);
  res.json({ status: true, data: { code, generatedAt: new Date().toISOString(), expiresIn: 600 } });
});

// POST /app/pairing — Mobile enters 6-digit code to pair
router.post('/pairing', authMiddleware, (req, res) => {
  const { pairingCode } = req.body;
  const userId = req.user.userId;
  if (!pairingCode) return res.status(400).json({ status: false, message: 'Pairing code required' });

  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE pairing_code = ?').get(pairingCode);

  if (!device) return res.status(400).json({ status: false, message: 'Invalid pairing code' });
  if (Date.now() > device.code_expires) return res.status(400).json({ status: false, message: 'Pairing code expired. Generate a new one.' });

  // Link device to user
  db.prepare('UPDATE devices SET user_id=?, paired=1, pairing_code=NULL, code_expires=NULL WHERE device_id=?').run(userId, device.device_id);

  res.json({ status: true, message: 'Paired successfully', data: { deviceId: device.device_id } });
});

// GET /app/pairing-device — Check pairing status
router.get('/pairing-device', authMiddleware, (req, res) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE user_id = ? AND paired = 1 ORDER BY last_seen DESC LIMIT 1').get(req.user.userId);
  if (!device) return res.json({ status: true, data: null });
  res.json({
    status: true,
    data: {
      device: {
        code: device.device_id.slice(0, 8),
        deviceId: device.device_id,
        lastSync: device.last_seen ? new Date(device.last_seen * 1000).toISOString() : null,
        paired: true,
      },
    },
  });
});

// GET /app/paired-device — alias
router.get('/paired-device', authMiddleware, (req, res) => {
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE user_id = ? AND paired = 1 ORDER BY last_seen DESC LIMIT 1').get(req.user.userId);
  res.json({ status: true, data: device ? { device: { code: device.device_id.slice(0,8), lastSync: device.last_seen ? new Date(device.last_seen*1000).toISOString() : null } } : null });
});

// PUT /app/pairing — Update pairing (mobile calls this after OTP with device info)
router.put('/pairing', authMiddleware, (req, res) => {
  res.json({ status: true, message: 'Pairing updated' });
});

// DELETE /desktop/paired-device — Unpair
router.delete('/paired-device', (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false });
  const db = getDb();
  db.prepare('UPDATE devices SET paired=0, user_id=NULL WHERE device_id=?').run(deviceId);
  res.json({ status: true, message: 'Unpaired' });
});

// POST /desktop/register — Desktop registers itself on startup
router.post('/register', (req, res) => {
  const deviceId = req.headers['device-id'];
  const { name, os, version } = req.body || {};
  if (!deviceId) return res.status(400).json({ status: false });
  const db = getDb();
  db.prepare(`
    INSERT INTO devices (device_id, name, os, last_seen) VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(device_id) DO UPDATE SET name=excluded.name, os=excluded.os, last_seen=unixepoch()
  `).run(deviceId, name || 'TallyDekho Desktop', os || 'Windows');
  res.json({ status: true, message: 'Registered' });
});

// GET /desktop/pairing-device — Desktop checks its paired user
router.get('/pairing-device-desktop', (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false });
  const db = getDb();
  const device = db.prepare('SELECT * FROM devices WHERE device_id=?').get(deviceId);
  res.json({ status: true, data: device || null });
});

// POST /desktop/logs
router.post('/logs', (req, res) => {
  console.log('[DESKTOP LOG]', req.body);
  res.json({ status: true });
});

export default router;
