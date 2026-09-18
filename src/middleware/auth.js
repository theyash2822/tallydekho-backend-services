import jwt from 'jsonwebtoken';
import { getDb, query } from '../db/schema.js';
import { verifySecret } from '../services/deviceCredential.js';
import { recordLegacyAuthEvent, LEGACY_EVENTS } from '../services/legacyAuthTelemetry.js';

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ status: false, message: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    (async () => {
      try {
        const { assertSessionActive } = await import('../services/authSessionService.js');
        if (payload.sessionId) {
          const ok = await assertSessionActive(payload.sessionId, payload.userId);
          if (!ok) {
            return res.status(401).json({
              status: false,
              code: 'SESSION_REVOKED',
              message: 'Session revoked or expired. Please sign in again.',
            });
          }
        } else if (process.env.ALLOW_LEGACY_JWT !== '1') {
          // Q023 telemetry — counters only; never tokens/headers
          void recordLegacyAuthEvent(LEGACY_EVENTS.JWT_REJECTED, req);
          return res.status(401).json({
            status: false,
            code: 'SESSION_REQUIRED',
            message: 'Please sign in again to continue.',
          });
        } else {
          void recordLegacyAuthEvent(LEGACY_EVENTS.JWT_ACCEPTED, req);
        }
        next();
      } catch (err) {
        return res.status(401).json({ status: false, message: 'Session validation failed' });
      }
    })();
  } catch (err) {
    return res.status(401).json({ status: false, message: 'Invalid or expired token' });
  }
}

async function attachDevice(req) {
  const deviceId = req.headers['device-id'] || req.headers['x-device-id'];
  if (!deviceId) return { error: { status: 401, body: { status: false, code: 'DEVICE_CREDENTIAL_INVALID', message: 'Missing device-id header' } } };
  const { rows } = await query('SELECT * FROM devices WHERE device_id = $1 LIMIT 1', [deviceId]);
  const device = rows[0];
  if (!device) return { error: { status: 401, body: { status: false, code: 'DEVICE_CREDENTIAL_INVALID', message: 'Device not registered' } } };
  req.deviceId = deviceId;
  req.device = device;
  req.workspaceId = device.workspace_id || null;
  return { device };
}

async function enforceSecret(req, device, { requiredIfHashed }) {
  const presented = req.headers['x-device-secret'];
  if (device.device_secret_hash) {
    if (!presented) {
      if (requiredIfHashed) {
        return { error: { status: 401, body: { status: false, code: 'DEVICE_CREDENTIAL_INVALID', message: 'Device credential required' } } };
      }
      return {};
    }
    const ok = await verifySecret(presented, device.device_secret_hash);
    if (!ok) {
      return { error: { status: 401, body: { status: false, code: 'DEVICE_CREDENTIAL_INVALID', message: 'Device credential invalid' } } };
    }
    req.deviceSecretOk = true;
  }
  return {};
}

export async function optionalDeviceCredential(req, res, next) {
  try {
    const attached = await attachDevice(req);
    if (attached.error) {
      req.deviceId = req.headers['device-id'] || req.headers['x-device-id'];
      return next();
    }
    const secret = await enforceSecret(req, attached.device, { requiredIfHashed: false });
    if (secret.error) return res.status(secret.error.status).json(secret.error.body);
    next();
  } catch (err) {
    res.status(500).json({ status: false, message: 'Device auth failed' });
  }
}

export async function requireDeviceCredential(req, res, next) {
  try {
    const attached = await attachDevice(req);
    if (attached.error) return res.status(attached.error.status).json(attached.error.body);
    if (!attached.device.paired || attached.device.binding_status === 'REVOKED') {
      if (attached.device.workspace_id) {
        const { rows: ws } = await query(
          `SELECT lifecycle_status FROM workspaces WHERE id = $1 LIMIT 1`,
          [attached.device.workspace_id]
        );
        const life = ws[0]?.lifecycle_status;
        if (life === 'CLOSED' || life === 'CLOSE_PENDING') {
          return res.status(403).json({ status: false, code: 'WORKSPACE_CLOSED', message: 'Workspace connection is no longer active.' });
        }
        if (life === 'RESET_PENDING' || life === 'RESET') {
          return res.status(403).json({ status: false, code: 'WORKSPACE_RESET', message: 'Workspace was reset. Pair again after restore or new Tally setup.' });
        }
      }
      return res.status(403).json({
        status: false,
        code: attached.device.binding_status === 'REVOKED' ? 'DEVICE_CREDENTIAL_INVALID' : 'DEVICE_NOT_PAIRED',
        message: 'Device is not paired to a workspace.',
      });
    }
    // Product 5.3: fail closed — paired devices must have a claimed secret
    if (!attached.device.device_secret_hash) {
      return res.status(401).json({
        status: false,
        code: 'DEVICE_CREDENTIAL_INVALID',
        message: 'Device credential required. Re-pair or claim credential.',
      });
    }
    const secret = await enforceSecret(req, attached.device, { requiredIfHashed: true });
    if (secret.error) return res.status(secret.error.status).json(secret.error.body);
    next();
  } catch (err) {
    res.status(500).json({ status: false, message: 'Device auth failed' });
  }
}

export function generateToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '30d' });
}

/**
 * requirePaired — Workspace-binding gate for /app data routes.
 * Ownership is Workspace ↔ Desktop binding, NEVER devices.user_id.
 *
 * UNPAIRED / RECONNECTING → allow (Demo path; verifyCompanyAccess still
 * blocks real company GUID reads).
 * CONNECTED → require an active paired Device for this Workspace.
 */
export async function requirePaired(req, res, next) {
  try {
    const { ensureReqWorkspace } = await import('./companyAccess.js');
    const { getConnectionStatus } = await import('../services/workspacePairingService.js');
    const workspaceId = await ensureReqWorkspace(req);
    if (!workspaceId) {
      return res.status(403).json({
        status: false,
        code: 'WORKSPACE_REQUIRED',
        message: 'Workspace context required.',
      });
    }
    const status = await getConnectionStatus(workspaceId);
    if (status === 'UNPAIRED' || status === 'RECONNECTING') {
      return next();
    }
    const { rows } = await query(
      `SELECT device_id FROM devices
       WHERE workspace_id = $1 AND paired = TRUE
       ORDER BY last_seen DESC NULLS LAST
       LIMIT 1`,
      [workspaceId]
    );
    if (rows.length === 0) {
      return res.status(403).json({
        status: false,
        code: 'DEVICE_NOT_PAIRED',
        message: 'No active Tally Desktop for this Workspace. Pair Desktop to access live data.',
      });
    }
    req.deviceId = rows[0].device_id;
    next();
  } catch (err) {
    res.status(500).json({ status: false, message: 'Pairing check failed' });
  }
}

/**
 * requireCompanySynced — company must exist in the caller's Workspace.
 * Ownership is Workspace lineage, never devices.user_id / companies.user_id alone.
 */
export async function requireCompanySynced(req, res, next) {
  const companyGuid = req.query.companyGuid || req.body?.companyGuid || req.params?.companyGuid;
  if (!companyGuid) return next(); // no company in request — let route handle it
  try {
    const { ensureReqWorkspace } = await import('./companyAccess.js');
    const workspaceId = await ensureReqWorkspace(req);
    if (!workspaceId) {
      return res.status(403).json({
        status: false,
        code: 'WORKSPACE_REQUIRED',
        message: 'Workspace context required.',
      });
    }
    const { rows } = await query(
      `SELECT guid FROM companies
       WHERE guid = $1 AND workspace_id = $2
       LIMIT 1`,
      [companyGuid, workspaceId]
    );
    if (rows.length === 0) {
      return res.status(409).json({
        status: false,
        code: 'COMPANY_NOT_SYNCED',
        message: 'Company data not synced yet. Please sync from the desktop app first.',
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ status: false, message: 'Company check failed' });
  }
}
