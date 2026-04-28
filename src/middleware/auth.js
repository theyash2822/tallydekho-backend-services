import jwt from 'jsonwebtoken';
import { getDb, query } from '../db/schema.js';

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
