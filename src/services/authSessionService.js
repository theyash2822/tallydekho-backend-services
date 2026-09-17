/**
 * Server-backed auth sessions (Phase 2 D).
 * Access JWT carries userId + sessionId only (no roles/caps).
 * Logout / revoke marks session REVOKED — middleware rejects.
 */
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../db/schema.js';

const ACCESS_TTL = process.env.JWT_ACCESS_EXPIRES_IN || '15m';
const REFRESH_TTL_MS = Number(process.env.JWT_REFRESH_TTL_MS || 30 * 24 * 60 * 60 * 1000);

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function newId() {
  return crypto.randomUUID();
}

export async function createAuthSession(userId, meta = {}) {
  const sessionId = newId();
  const refreshRaw = crypto.randomBytes(48).toString('hex');
  const refreshHash = hashToken(refreshRaw);
  const now = Date.now();
  const expiresAt = now + REFRESH_TTL_MS;
  await query(
    `INSERT INTO auth_sessions
       (id, user_id, refresh_token_hash, status, created_at, expires_at, client_type, device_label)
     VALUES ($1,$2,$3,'ACTIVE',$4,$5,$6,$7)`,
    [
      sessionId,
      userId,
      refreshHash,
      Math.floor(now / 1000),
      Math.floor(expiresAt / 1000),
      meta.clientType || null,
      meta.deviceLabel || null,
    ]
  );
  const accessToken = jwt.sign(
    { userId, sessionId, mobile: meta.mobile || undefined },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
  return {
    accessToken,
    refreshToken: refreshRaw,
    sessionId,
    accessExpiresIn: ACCESS_TTL,
  };
}

export async function assertSessionActive(sessionId, userId) {
  if (!sessionId) {
    // Legacy JWTs without sessionId: reject in production; allow only with explicit bypass
    const allowLegacy =
      process.env.ALLOW_LEGACY_JWT === '1' && process.env.NODE_ENV !== 'production';
    if (allowLegacy) return true;
    return false;
  }
  const { rows } = await query(
    `SELECT id, status, expires_at FROM auth_sessions
     WHERE id = $1 AND user_id = $2 LIMIT 1`,
    [sessionId, userId]
  );
  const s = rows[0];
  if (!s) return false;
  if (s.status !== 'ACTIVE') return false;
  if (s.expires_at && Number(s.expires_at) * 1000 < Date.now()) return false;
  return true;
}

export async function revokeSession(sessionId, userId = null) {
  if (!sessionId) return;
  if (userId) {
    await query(
      `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = $3
       WHERE id = $1 AND user_id = $2 AND status = 'ACTIVE'`,
      [sessionId, userId, Math.floor(Date.now() / 1000)]
    );
  } else {
    await query(
      `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = $2
       WHERE id = $1 AND status = 'ACTIVE'`,
      [sessionId, Math.floor(Date.now() / 1000)]
    );
  }
}

export async function revokeAllSessionsForUser(userId) {
  await query(
    `UPDATE auth_sessions SET status = 'REVOKED', revoked_at = $2
     WHERE user_id = $1 AND status = 'ACTIVE'`,
    [userId, Math.floor(Date.now() / 1000)]
  );
}

export async function refreshAuthSession(refreshToken) {
  const refreshHash = hashToken(refreshToken);
  const { rows } = await query(
    `SELECT * FROM auth_sessions WHERE refresh_token_hash = $1 LIMIT 1`,
    [refreshHash]
  );
  const s = rows[0];
  if (!s || s.status !== 'ACTIVE') {
    const err = new Error('Invalid refresh token');
    err.code = 'SESSION_INVALID';
    err.httpStatus = 401;
    throw err;
  }
  if (s.expires_at && Number(s.expires_at) * 1000 < Date.now()) {
    await revokeSession(s.id, s.user_id);
    const err = new Error('Refresh token expired');
    err.code = 'SESSION_EXPIRED';
    err.httpStatus = 401;
    throw err;
  }
  // Rotate refresh token
  const newRefreshRaw = crypto.randomBytes(48).toString('hex');
  const newHash = hashToken(newRefreshRaw);
  const now = Date.now();
  const expiresAt = now + REFRESH_TTL_MS;
  await query(
    `UPDATE auth_sessions
     SET refresh_token_hash = $2, expires_at = $3, rotated_at = $4
     WHERE id = $1`,
    [s.id, newHash, Math.floor(expiresAt / 1000), Math.floor(now / 1000)]
  );
  const { rows: users } = await query(`SELECT mobile FROM users WHERE id = $1`, [s.user_id]);
  const accessToken = jwt.sign(
    { userId: s.user_id, sessionId: s.id, mobile: users[0]?.mobile },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
  return {
    accessToken,
    refreshToken: newRefreshRaw,
    sessionId: s.id,
    accessExpiresIn: ACCESS_TTL,
  };
}
