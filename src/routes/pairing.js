// Pairing routes
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware, desktopAuth, generateToken } from '../middleware/auth.js';
import { v4 as uuid } from 'uuid';
import { pairDeviceToWorkspace, unpairDevice, BindingError } from '../services/deviceBinding.js';
import { generateDeviceSecret, hashSecret } from '../services/deviceCredential.js';
import { desktopMeHandler } from './desktopWorkspace.js';

// Socket service injected after startup
let _socket = null;
export function setPairingSocket(s) { _socket = s; }

const router = Router();
const now = () => Math.floor(Date.now() / 1000);

router.get('/me', desktopMeHandler);

// GET /pairing-device — smart handler for BOTH desktop (/desktop) and mobile (/app)
// Desktop sends device-id header (no JWT). Mobile sends Bearer token (no device-id).
// This prevents the auth bypass caused by duplicate route declarations.
router.get('/pairing-device', async (req, res) => {
  const deviceId = req.headers['device-id'];
  const bearerToken = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null;

  try {
    // Desktop path: device-id header present
    if (deviceId) {
      const { rows } = await query(
        'SELECT d.device_id, d.name, d.user_id, d.last_seen, u.mobile, u.name as user_name FROM devices d LEFT JOIN users u ON u.id = d.user_id WHERE d.device_id = $1 AND d.paired = TRUE LIMIT 1',
        [deviceId]
      );
      if (!rows[0]) return res.json({ status: true, data: { pairing: null } });
      const d = rows[0];
      return res.json({
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
    }

    // Mobile/Web path: Bearer token required
    if (!bearerToken) return res.status(401).json({ status: false, message: 'Authorization required' });
    let userId;
    try {
      const jwt = await import('jsonwebtoken');
      const payload = jwt.default.verify(bearerToken, process.env.JWT_SECRET);
      userId = payload.userId;
    } catch { return res.status(401).json({ status: false, message: 'Invalid token' }); }

    const { rows } = await query(
      'SELECT * FROM devices WHERE user_id = $1 AND paired = TRUE ORDER BY last_seen DESC LIMIT 1',
      [userId]
    );
    const device = rows[0];
    if (!device) return res.json({ status: true, data: null });
    return res.json({
      status: true,
      data: { device: { code: device.device_id.slice(0, 8), deviceId: device.device_id, lastSync: device.last_seen ? new Date(device.last_seen * 1000).toISOString() : null, paired: true } },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// GET /desktop/pairing-code — Returns EXISTING permanent pairing code for this device.
// Code is set on /desktop/register and only changes when device is unpaired.
// Never generates a new code here — that would break the permanent code design.
router.get('/pairing-code', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id header required' });

  try {
    const { rows } = await query(
      'SELECT pairing_code FROM devices WHERE device_id = $1',
      [deviceId]
    );
    const device = rows[0];

    if (!device) return res.status(404).json({ status: false, message: 'Device not registered' });

    // If somehow no code exists (old install before this change), generate one now
    let code = device.pairing_code;
    if (!code) {
      code = String(Math.floor(100000 + Math.random() * 900000));
      await query(
        'UPDATE devices SET pairing_code = $1 WHERE device_id = $2',
        [code, deviceId]
      );
    }

    console.log(`[PAIRING] Device ${deviceId} → returning permanent code`);
    // No expiry — code is permanent. generatedAt sent for display purposes only.
    res.json({ status: true, data: { code, generatedAt: Date.now() } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to get code' });
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
    // Permanent codes: code_expires is NULL — skip expiry check.
    // Legacy timed codes: check expiry only if code_expires is set.
    if (device.code_expires && Date.now() > device.code_expires) {
      return res.status(400).json({ status: false, message: 'Pairing code expired. Generate a new one.' });
    }

    const bound = await pairDeviceToWorkspace({ device, userId: req.user.userId });
    if (_socket) {
      _socket.notifyPaired(req.user.userId, device.name || 'Desktop');
      _socket.notifyDesktop?.(device.device_id, 'pairing_confirmed', {
        userId: req.user.userId,
        pairedAt: new Date().toISOString(),
        deviceSecret: bound.deviceSecret,
        workspace: { id: bound.workspace.id, name: bound.workspace.name },
      });
    }
    res.json({
      status: true,
      message: 'Paired successfully',
      data: { deviceId: device.device_id, workspaceId: bound.workspace.id },
    });
  } catch (err) {
    if (err instanceof BindingError) {
      return res.status(err.httpStatus).json({ status: false, code: err.code, message: err.message });
    }
    res.status(500).json({ status: false, message: 'Pairing failed' });
  }
});

// Note: GET /pairing-device is handled above (smart handler for both desktop + mobile)

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
  const result = await unpairDevice(deviceId, userId);
  if (_socket && (userId || result.userId)) _socket.notifyUnpaired(userId || result.userId, result.newCode);
  return result;
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
    // Auto-generate a permanent pairing code if this device doesn’t have one yet
    const genCode = () => String(Math.floor(100000 + Math.random() * 900000));

    await query(`
      INSERT INTO devices (device_id, name, last_seen, pairing_code)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (device_id) DO UPDATE SET
        name       = COALESCE($2, devices.name),
        last_seen  = EXCLUDED.last_seen,
        -- Only set code if none exists yet (permanent code)
        pairing_code = COALESCE(devices.pairing_code, EXCLUDED.pairing_code)
    `, [resolvedId, host || 'TallyDekho Desktop', now(), genCode()]);

    const { rows } = await query('SELECT * FROM devices WHERE device_id = $1', [resolvedId]);
    const device = rows[0];
    const lastSync = device?.last_seen ? new Date(device.last_seen * 1000).toISOString() : null;
    const isPaired = device?.paired === true;

    let issuedSecret = null;
    if (isPaired && !device.credential_claimed_at) {
      const secret = generateDeviceSecret();
      const secretHash = await hashSecret(secret);
      await query(
        `UPDATE devices SET device_secret_hash = $2 WHERE device_id = $1`,
        [resolvedId, secretHash]
      );
      issuedSecret = secret;
    }

    let workspace = null;
    if (device?.workspace_id) {
      const { rows: ws } = await query('SELECT id, name, tally_connection FROM workspaces WHERE id = $1', [device.workspace_id]);
      if (ws[0]) workspace = { id: ws[0].id, name: ws[0].name, tallyConnection: ws[0].tally_connection };
    }

    res.json({
      status: true,
      message: 'Registered',
      data: {
        lastSync,
        forceUpdate: false,
        isPaired,
        pairingCode: device?.pairing_code || null,
        versionLevel,
        versionMessage,
        latestVersion: CURRENT_VERSION,
        workspace,
        deviceSecret: issuedSecret,
        bindingStatus: device?.binding_status || (isPaired ? 'ACTIVE' : 'UNBOUND'),
      }
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Registration failed' });
  }
});

// GET /desktop/company-sync-status — used by desktop for multi-device conflict detection
// Returns when the company was last synced and from which device
// Uses desktopAuth (device-id header only, no JWT needed)
router.get('/company-sync-status', desktopAuth, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const deviceId = req.deviceId;
    // Get the device's owner (user_id)
    const { rows: devices } = await query(
      'SELECT user_id FROM devices WHERE device_id = $1 LIMIT 1',
      [deviceId]
    );
    if (!devices[0]) return res.status(403).json({ status: false, message: 'Device not registered' });

    // Get when this company was last synced and from which device
    const { rows: companies } = await query(
      'SELECT synced_at, device_id FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
      [companyGuid, devices[0].user_id]
    );

    const company = companies[0];
    res.json({
      status: true,
      data: {
        lastSyncedAt: company?.synced_at || null,
        lastSyncDeviceId: company?.device_id || null,
        isMyDevice: company?.device_id === deviceId,
      },
    });
  } catch (err) {
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /desktop/logs — receive log file from desktop and email to support
router.post('/logs', async (req, res) => {
  try {
    // Accept plain text or multipart — just acknowledge receipt
    // Future: parse and email to project@tallydekho.com
    res.json({ status: true, message: 'Logs received' });
  } catch (err) {
    res.status(500).json({ status: false });
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
