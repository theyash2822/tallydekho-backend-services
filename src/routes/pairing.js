// Pairing routes
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware, requireDeviceCredential } from '../middleware/auth.js';
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

    // Mobile/Web path: Bearer + Workspace binding (not devices.user_id)
    if (!bearerToken) return res.status(401).json({ status: false, message: 'Authorization required' });
    let userId;
    try {
      const jwt = await import('jsonwebtoken');
      const payload = jwt.default.verify(bearerToken, process.env.JWT_SECRET);
      userId = payload.userId;
    } catch { return res.status(401).json({ status: false, message: 'Invalid token' }); }

    const workspaceHeader = req.headers['x-workspace-id'] || req.headers['X-Workspace-Id'] || null;
    let workspaceId = Array.isArray(workspaceHeader) ? workspaceHeader[0] : workspaceHeader;
    if (!workspaceId) {
      const { ensurePersonalWorkspace } = await import('../services/workspaceService.js');
      const personal = await ensurePersonalWorkspace(userId);
      workspaceId = personal?.id || null;
    }
    if (!workspaceId) return res.json({ status: true, data: null });

    const { rows } = await query(
      `SELECT * FROM devices
       WHERE workspace_id = $1 AND paired = TRUE
       ORDER BY last_seen DESC NULLS LAST
       LIMIT 1`,
      [workspaceId]
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

// GET /desktop/pairing-code — short-lived pairing session (10 min default).
// Bridges to devices.pairing_code so current Web/Mobile approve still works until Phase C claim.
router.get('/pairing-code', async (req, res) => {
  const deviceId = req.headers['device-id'];
  if (!deviceId) return res.status(400).json({ status: false, message: 'device-id header required' });

  try {
    const { createPairingSession } = await import('../services/workspacePairingService.js');
    const session = await createPairingSession(deviceId);
    console.log(`[PAIRING] Device ${deviceId} → session ${session.sessionId} code (TTL)`);
    res.json({
      status: true,
      data: {
        code: session.pairingCode,
        pairingCode: session.pairingCode,
        sessionId: session.sessionId,
        claimToken: session.claimToken,
        expiresAt: session.expiresAt,
        generatedAt: Date.now(),
      },
    });
  } catch (err) {
    if (err?.code) {
      return res.status(err.httpStatus || 409).json({ status: false, message: err.message, code: err.code });
    }
    console.error('[PAIRING] pairing-code failed:', err.message);
    res.status(500).json({ status: false, message: 'Failed to get code' });
  }
});

// POST /desktop/pairing-sessions/:sessionId/claim — HTTP credential claim (Phase C)
router.post('/pairing-sessions/:sessionId/claim', async (req, res) => {
  try {
    const claimToken = req.body?.claimToken || req.headers['x-claim-token'];
    const { claimPairingCredential } = await import('../services/workspacePairingService.js');
    const result = await claimPairingCredential({
      sessionId: req.params.sessionId,
      claimToken,
    });
    if (_socket) {
      _socket.notifyWorkspaceRoom?.(result.workspace.id, 'tally_connection', {
        status: 'RECONNECTING',
        workspaceId: result.workspace.id,
      });
    }
    res.json({
      status: true,
      data: {
        deviceSecret: result.deviceSecret,
        workspace: result.workspace,
        deviceId: result.deviceId,
        connectionStatus: result.connectionStatus,
      },
    });
  } catch (err) {
    if (err?.code) {
      return res.status(err.httpStatus || 409).json({ status: false, code: err.code, message: err.message });
    }
    console.error('[PAIRING] claim failed:', err.message);
    res.status(500).json({ status: false, message: 'Claim failed' });
  }
});

// POST /desktop/pairing-sessions/:sessionId/ack — Desktop confirms secret stored
router.post('/pairing-sessions/:sessionId/ack', async (req, res) => {
  try {
    const deviceId = req.headers['device-id'] || req.body?.deviceId;
    const deviceSecret = req.body?.deviceSecret || req.headers['device-secret'];
    const { acknowledgePairingCredential } = await import('../services/workspacePairingService.js');
    const result = await acknowledgePairingCredential({
      sessionId: req.params.sessionId,
      deviceId,
      deviceSecret,
    });
    res.json({ status: true, data: result });
  } catch (err) {
    if (err?.code) {
      return res.status(err.httpStatus || 409).json({ status: false, code: err.code, message: err.message });
    }
    console.error('[PAIRING] ack failed:', err.message);
    res.status(500).json({ status: false, message: 'Ack failed' });
  }
});

// POST /app/pairing — DISABLED (Phase F). Use POST /workspaces/:id/tally/pair
router.post('/pairing', authMiddleware, async (_req, res) => {
  console.warn('[LEGACY] POST /app/pairing → 410');
  return res.status(410).json({
    status: false,
    code: 'PAIRING_API_DEPRECATED',
    message: 'Use POST /api/workspaces/:workspaceId/tally/pair',
  });
});

// Note: GET /pairing-device is handled above (smart handler for both desktop + mobile)

// GET /app/paired-device — Workspace binding (not devices.user_id)
router.get('/paired-device', authMiddleware, async (req, res) => {
  try {
    const { ensureReqWorkspace } = await import('../middleware/companyAccess.js');
    const workspaceId = await ensureReqWorkspace(req);
    if (!workspaceId) {
      return res.json({ status: true, data: null });
    }
    const { rows } = await query(
      `SELECT * FROM devices
       WHERE workspace_id = $1 AND paired = TRUE
       ORDER BY last_seen DESC NULLS LAST
       LIMIT 1`,
      [workspaceId]
    );
    const device = rows[0];
    res.json({
      status: true,
      data: device
        ? {
            device: {
              code: device.device_id.slice(0, 8),
              lastSync: device.last_seen ? new Date(device.last_seen * 1000).toISOString() : null,
            },
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// PUT /app/pairing — DISABLED. Legacy user-owned device metadata update.
// No Web / Mobile V4 / Desktop callers remain (only obsolete mobile refs).
router.put('/pairing', authMiddleware, async (_req, res) => {
  console.warn('[LEGACY] PUT /app/pairing → 410');
  return res.status(410).json({
    status: false,
    code: 'PAIRING_API_DEPRECATED',
    message: 'Use Workspace pairing APIs. Device metadata is updated via Desktop register/heartbeat.',
  });
});

// Shared unpair logic - notifies all platforms via WebSocket
async function performUnpair(deviceId, userId) {
  const result = await unpairDevice(deviceId, userId);
  if (_socket && (userId || result.userId || result.workspaceId)) {
    _socket.notifyUnpaired(
      userId || result.userId,
      result.newCode,
      deviceId,
      result.workspaceId || null,
    );
  }
  return result;
}

// DELETE /desktop/paired-device — Desktop self-disconnect adapter.
// Requires device credential. Uses canonical unpairDevice (Workspace binding), not user_id lookup.
router.delete('/paired-device', requireDeviceCredential, async (req, res) => {
  try {
    const deviceId = req.deviceId || req.headers['device-id'];
    if (!deviceId) return res.status(400).json({ status: false, message: 'device-id required' });
    console.log(`[PAIRING] Desktop self-unpair device=${deviceId} workspace=${req.workspaceId || 'none'}`);
    await performUnpair(deviceId, null);
    res.json({ status: true, message: 'Unpaired from all platforms' });
  } catch (err) {
    console.error('[PAIRING] Desktop self-unpair failed:', err.message);
    res.status(500).json({ status: false, message: 'Unpair failed' });
  }
});

// DELETE /app/pairing — DISABLED (legacy user_id → Device). Use Workspace Unpair.
router.delete('/pairing', authMiddleware, async (_req, res) => {
  console.warn('[LEGACY] DELETE /app/pairing → 410');
  return res.status(410).json({
    status: false,
    code: 'PAIRING_API_DEPRECATED',
    message: 'Use POST /api/workspaces/:workspaceId/tally/unpair',
  });
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
    // Issue secret when missing. Also re-issue when hash exists but never claimed
    // (Desktop missed pairing_confirmed — e.g. Mobile workspace-pair path bug).
    // Once credential_claimed_at is set, never rotate (spec §7/§8).
    const needsSecret =
      isPaired && (!device.device_secret_hash || !device.credential_claimed_at);
    if (needsSecret) {
      const secret = generateDeviceSecret();
      const secretHash = await hashSecret(secret);
      await query(
        `UPDATE devices SET device_secret_hash = $2, credential_claimed_at = NULL WHERE device_id = $1`,
        [resolvedId, secretHash]
      );
      issuedSecret = secret;
      console.log(
        `[REGISTER] Re-issued device secret for ${resolvedId.slice(0, 12)}… ` +
          `(hadHash=${!!device.device_secret_hash}, claimed=${!!device.credential_claimed_at})`
      );
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

// GET /desktop/company-sync-status — device secret + company in device workspace
router.get('/company-sync-status', requireDeviceCredential, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  try {
    const deviceId = req.deviceId;
    const workspaceId = req.device?.workspace_id || req.workspaceId;
    if (!workspaceId) {
      return res.status(403).json({ status: false, code: 'DEVICE_NOT_BOUND', message: 'Device has no workspace binding' });
    }

    const { rows: companies } = await query(
      `SELECT synced_at, device_id FROM companies
       WHERE guid = $1 AND workspace_id = $2 LIMIT 1`,
      [companyGuid, workspaceId]
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
