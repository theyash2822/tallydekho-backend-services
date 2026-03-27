import jwt from 'jsonwebtoken';
import { getDb } from '../db/schema.js';

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
