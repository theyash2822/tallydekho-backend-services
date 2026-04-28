// Pairing routes
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware, generateToken } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';

// Socket service injected after startup
let _socket = null;
export function setPairingSocket(s) { _socket = s; }

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

// GET /me (mounted at /desktop/me) — Desktop fetches user profile via device-id
router.get('/me', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id required' });
  try {
    const { rows } = await query(
      'SELECT u.id, u.mobile, u.name, u.email, u.language FROM devices d JOIN users u ON u.id = d.user_id WHERE d.device_id = $1 AND d.paired = TRUE LIMIT 1',
      [deviceId]
    );
    if (!rows[0]) return res.json({ status: false, message: 'Device not paired' });
    const u = rows[0];
    res.json({ status: true, data: { id: u.id, mobile: u.mobile, name: u.name || '', email: u.email || '', language: u.language || 'English' } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch profile' });
  }
});

// GET /pairing-device (mounted at /desktop/pairing-device)
router.get('/pairing-device', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false });
  try {
    // Check if THIS desktop device is paired to a user
    const { rows } = await query(
      'SELECT d.device_id, d.name, d.user_id, d.last_seen, u.mobile, u.name as user_name FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.device_id = $1 AND d.paired = TRUE LIMIT 1',
      [deviceId]
    );
    if (!rows[0]) return res.json({ status: true, data: { pairing: null } });
    const d = rows[0];
    res.json({
      status: true,
      data: {
        pairing: {
          NAME: d.name || d.device_id.slice(0,8),
          MOBILE: d.mobile || '',
          USER_NAME: d.user_name || '',
          LAST_SYNC_AT: d.last_seen,
          IS_PAIRED: true,
        }
      }
    });
  } catch (err) {
    res.status(500).json({ status: false });
  }
});

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

    // Transfer company data: only move companies that belong to this specific device
    // This prevents taking companies from other users who happened to use the same device
    await query(
      'UPDATE companies SET user_id = $1, is_active = TRUE WHERE device_id = $2',
      [req.user.userId, device.device_id]
    ).catch(() => {});

    // Notify all connected clients to refresh (web, mobile, desktop)
    if (_socket) _socket.notifyPaired(req.user.userId, device.name || 'Desktop');

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

// Shared unpair logic - notifies all platforms via WebSocket
async function performUnpair(deviceId, userId) {
  await query('UPDATE devices SET paired = FALSE, user_id = NULL WHERE device_id = $1', [deviceId]);
  // Notify mobile/web clients this user is now unpaired
  if (_socket && userId) _socket.notifyUnpaired(userId);
}

// DELETE /desktop/paired-device — Unpair from Desktop
router.delete('/paired-device', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false });
  try {
    const { rows } = await query('SELECT user_id FROM devices WHERE device_id = $1', [deviceId]);
    await performUnpair(deviceId, rows[0]?.user_id);
    res.json({ status: true, message: 'Unpaired from all platforms' });
  } catch (err) {
    res.status(500).json({ status: false });
  }
});

// DELETE /app/pairing — Unpair from Mobile/Web
router.delete('/pairing', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      'SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
      [req.user.userId]
    );
    if (!rows[0]) return res.json({ status: true, message: 'No paired device found' });
    await performUnpair(rows[0].device_id, req.user.userId);
    res.json({ status: true, message: 'Unpaired from all platforms' });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Unpair failed' });
  }
});

// POST /desktop/register — Desktop registers on startup
router.post('/register', async (req, res) => {
  const headerDeviceId = req.headers['device-id'];
  const { deviceId, host, desktopVersion } = req.body || {};
  const resolvedId = headerDeviceId || deviceId;
  if (!resolvedId) return res.status(400).json({ status: false, message: 'device-id required' });

  // Version compatibility check
  const CURRENT_VERSION = process.env.DESKTOP_VERSION || '1.0.0';
  const MINIMUM_VERSION = process.env.DESKTOP_MIN_VERSION || '1.0.0';

  function parseVer(v) {
    const [ma = 0, mi = 0, pa = 0] = (v || '0.0.0').split('.').map(Number);
    return { major: ma, minor: mi, patch: pa };
  }

  // Level: 0=ok, 1=update available (minor/patch), 2=sync blocked (major mismatch), 3=force update
  let versionLevel = 0;
  let versionMessage = null;

  if (desktopVersion) {
    const curr   = parseVer(desktopVersion);
    const min    = parseVer(MINIMUM_VERSION);
    const latest = parseVer(CURRENT_VERSION);

    if (curr.major < min.major) {
      versionLevel = 3; // force update
      versionMessage = `Desktop v${desktopVersion} is too old. Please update to v${CURRENT_VERSION} to continue.`;
    } else if (curr.major < latest.major) {
      versionLevel = 2; // sync blocked
      versionMessage = `Sync requires desktop v${CURRENT_VERSION}. Please update.`;
    } else if (curr.minor < latest.minor || curr.patch < latest.patch) {
      versionLevel = 1; // update available, non-blocking
      versionMessage = `Update available: v${CURRENT_VERSION}`;
    }
  }

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
    const isPaired = device?.paired === true;

    res.json({
      status: true,
      message: 'Registered',
      data: {
        lastSync,
        forceUpdate: false,
        isPaired,
        versionLevel,      // 0=ok, 1=update available, 2=sync blocked, 3=force
        versionMessage,
        latestVersion: CURRENT_VERSION,
      }
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Registration failed' });
  }
});

// POST /desktop/heartbeat — lightweight ping to keep last_seen fresh
// Desktop calls this every 2 minutes so mobile can detect desktop online status
router.post('/heartbeat', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id required' });
  try {
    await query(
      'UPDATE devices SET last_seen = $1 WHERE device_id = $2',
      [now(), deviceId]
    );
    res.json({ status: true });
  } catch (err) {
    res.status(500).json({ status: false });
  }
});

export default router;
