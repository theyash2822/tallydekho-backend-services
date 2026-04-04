// Pairing routes
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

// GET /desktop/pairing-code — Desktop generates pairing code
router.get('/pairing-code', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id header required' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expires = Date.now() + 10 * 60 * 1000;

  try {
    await query(`
      INSERT INTO devices (device_id, pairing_code, code_expires, last_seen)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (device_id) DO UPDATE SET
        pairing_code = EXCLUDED.pairing_code,
        code_expires = EXCLUDED.code_expires,
        last_seen = EXCLUDED.last_seen
    `, [deviceId, code, expires, now()]);

    console.log(`[PAIRING] Device ${deviceId} → code ${code}`);
    res.json({ status: true, data: { code, expiresIn: 600 } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to generate code' });
  }
});

// POST /app/pairing — Mobile enters code to pair
router.post('/pairing', authMiddleware, async (req, res) => {
  const { pairingCode } = req.body;
  if (!pairingCode) return res.status(400).json({ status: false, message: 'Pairing code required' });

  try {
    const { rows } = await query('SELECT * FROM devices WHERE pairing_code = $1', [pairingCode]);
    const device = rows[0];

    if (!device) return res.status(400).json({ status: false, message: 'Invalid pairing code' });
    if (Date.now() > device.code_expires) return res.status(400).json({ status: false, message: 'Pairing code expired. Generate a new one.' });

    await query(
      'UPDATE devices SET user_id = $1, paired = TRUE, pairing_code = NULL, code_expires = NULL WHERE device_id = $2',
      [req.user.userId, device.device_id]
    );

    res.json({ status: true, message: 'Paired successfully', data: { deviceId: device.device_id } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Pairing failed' });
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
    if (!device) return res.json({ status: true, data: null });
    res.json({
      status: true,
      data: { device: { code: device.device_id.slice(0, 8), deviceId: device.device_id, lastSync: device.last_seen ? new Date(device.last_seen * 1000).toISOString() : null, paired: true } },
    });
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
    res.json({ status: true, data: device ? { device: { code: device.device_id.slice(0, 8), lastSync: device.last_seen ? new Date(device.last_seen * 1000).toISOString() : null } } : null });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// PUT /app/pairing — Update device info
router.put('/pairing', authMiddleware, async (req, res) => {
  const { deviceName, os, deviceId } = req.body || {};
  if (!deviceId) return res.json({ status: true, message: 'No device info' });
  try {
    await query(
      'UPDATE devices SET name = COALESCE($1, name), os = COALESCE($2, os), last_seen = $3 WHERE device_id = $4 AND user_id = $5',
      [deviceName || null, os || null, now(), deviceId, req.user.userId]
    );
    res.json({ status: true, message: 'Pairing updated' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Update failed' });
  }
});

// DELETE /desktop/paired-device — Unpair
router.delete('/paired-device', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false });
  try {
    await query('UPDATE devices SET paired = FALSE, user_id = NULL WHERE device_id = $1', [deviceId]);
    res.json({ status: true, message: 'Unpaired' });
  } catch (err) {
    res.status(500).json({ status: false });
  }
});

// POST /desktop/register — Desktop registers on startup
router.post('/register', async (req, res) => {
  const headerDeviceId = req.headers['device-id'];
  const { deviceId, host, desktopVersion } = req.body || {};
  const resolvedId = headerDeviceId || deviceId;
  if (!resolvedId) return res.status(400).json({ status: false, message: 'device-id required' });

  try {
    await query(`
      INSERT INTO devices (device_id, name, last_seen)
      VALUES ($1, $2, $3)
      ON CONFLICT (device_id) DO UPDATE SET
        name = COALESCE($2, devices.name),
        last_seen = EXCLUDED.last_seen
    `, [resolvedId, host || 'TallyDekho Desktop', now()]);

    const { rows } = await query('SELECT * FROM devices WHERE device_id = $1', [resolvedId]);
    const device = rows[0];
    const lastSync = device?.last_seen ? new Date(device.last_seen * 1000).toISOString() : null;

    res.json({ status: true, message: 'Registered', data: { lastSync, forceUpdate: false } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Registration failed' });
  }
});

export default router;
