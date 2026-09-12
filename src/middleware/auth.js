import jwt from 'jsonwebtoken';
import { getDb, query } from '../db/schema.js';
import { verifySecret } from '../services/deviceCredential.js';

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ status: false, message: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ status: false, message: 'Invalid or expired token' });
  }
}

export function desktopAuth(req, res, next) {
  // Desktop uses device-id header + token
  const deviceId = req.headers['device-id'] || req.headers['x-device-id'];
  const token = req.headers.authorization?.slice(7);
  if (!deviceId) return res.status(401).json({ status: false, message: 'Missing device-id header' });
  req.deviceId = deviceId;
  if (token) {
    try {
      req.user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {}
  }
  next();
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
 * requirePaired — enforces that the authenticated user has a paired device.
 * Returns 403 if no paired device found.
 * Use after authMiddleware on any data route that requires an active pairing.
 */
export async function requirePaired(req, res, next) {
  try {
    const { rows } = await query(
      'SELECT device_id FROM devices WHERE user_id = $1 AND paired = TRUE LIMIT 1',
      [req.user.userId]
    );
    if (rows.length === 0) {
      return res.status(403).json({
        status: false,
        code: 'DEVICE_NOT_PAIRED',
        message: 'Device not paired. Please pair your Tally desktop app to access data.',
      });
    }
    req.deviceId = rows[0].device_id;
    next();
  } catch (err) {
    res.status(500).json({ status: false, message: 'Pairing check failed' });
  }
}

/**
 * requireCompanySynced — enforces that the requested companyGuid has been synced.
 * Returns 409 if company has no synced data.
 * Reads companyGuid from req.query, req.body, or req.params.
 */
export async function requireCompanySynced(req, res, next) {
  const companyGuid = req.query.companyGuid || req.body?.companyGuid || req.params?.companyGuid;
  if (!companyGuid) return next(); // no company in request — let route handle it
  try {
    const { rows } = await query(
      'SELECT guid FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
      [companyGuid, req.user.userId]
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
