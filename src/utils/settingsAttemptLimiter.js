/**
 * Wrong OTP/PIN counter for signed-in settings flows (remove PIN, change phone,
 * change email). A wrong code must not look like an expired session (401), so
 * these flows answer 400 and, after MAX_ATTEMPTS, 429 for LOCK_MS.
 * In-memory: the API runs as a single process; a restart clears the counters.
 */
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const attempts = new Map();

const keyOf = (userId, action) => `${userId}:${action}`;

function current(key) {
  const entry = attempts.get(key);
  if (!entry) return null;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    attempts.delete(key);
    return null;
  }
  return entry;
}

/** Returns minutes left if locked, else 0. */
export function lockedMinutes(userId, action) {
  const entry = current(keyOf(userId, action));
  if (!entry?.lockedUntil) return 0;
  return Math.max(1, Math.ceil((entry.lockedUntil - Date.now()) / 60000));
}

/** Records a wrong code; returns attempts left (0 means now locked). */
export function recordFailure(userId, action) {
  const key = keyOf(userId, action);
  const entry = current(key) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = Date.now() + LOCK_MS;
  attempts.set(key, entry);
  return Math.max(0, MAX_ATTEMPTS - entry.count);
}

export function clearFailures(userId, action) {
  attempts.delete(keyOf(userId, action));
}

export function tooManyAttemptsBody(minutes) {
  return {
    success: false,
    error: { code: 'TOO_MANY_ATTEMPTS', message: `Too many attempts, try again in ${minutes} minutes` },
  };
}

export function wrongCodeBody(code, label, left) {
  const tail = left > 0 ? ` ${left} attempt${left === 1 ? '' : 's'} left.` : ' Try again in 15 minutes.';
  return { success: false, error: { code, message: `Incorrect ${label}.${tail}` } };
}

/** Test hook. */
export function _resetAttemptLimiter() {
  attempts.clear();
}
