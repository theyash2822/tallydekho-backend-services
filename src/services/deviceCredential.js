import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export function generateDeviceSecret() {
  return crypto.randomBytes(32).toString('hex');
}

export async function hashSecret(secret) {
  return bcrypt.hash(secret, ROUNDS);
}

export async function verifySecret(secret, hash) {
  if (!secret || !hash) return false;
  try {
    return await bcrypt.compare(secret, hash);
  } catch {
    return false;
  }
}

export function generateShortCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function hashToken(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}
