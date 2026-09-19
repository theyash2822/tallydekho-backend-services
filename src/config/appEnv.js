/**
 * Environment identity.
 *
 * NODE_ENV selects *behaviour* (staging must run production behaviour), APP_ENV
 * selects *identity* (which deployment this is). Keeping them separate is what
 * lets staging exercise production code paths while remaining distinguishable.
 *
 *   production   NODE_ENV=production APP_ENV=production
 *   staging      NODE_ENV=production APP_ENV=staging
 *   development  NODE_ENV=development
 *   test         NODE_ENV=test
 */
export const APP_ENVS = Object.freeze(['production', 'staging', 'development', 'test']);

/** Environments where production behaviour (and production-grade safety) applies. */
const PRODUCTION_LIKE = Object.freeze(['production', 'staging']);

export function resolveAppEnv(env = process.env) {
  const explicit = String(env.APP_ENV || '').trim().toLowerCase();
  if (explicit) {
    if (!APP_ENVS.includes(explicit)) {
      throw new Error(
        `Invalid APP_ENV "${env.APP_ENV}". Expected one of: ${APP_ENVS.join(', ')}`
      );
    }
    return explicit;
  }
  const nodeEnv = String(env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  return 'development';
}

export function isStaging(env = process.env) {
  return resolveAppEnv(env) === 'staging';
}

export function isProduction(env = process.env) {
  return resolveAppEnv(env) === 'production';
}

export function isProductionLike(env = process.env) {
  return PRODUCTION_LIKE.includes(resolveAppEnv(env));
}

/**
 * Staging exists to catch problems that only appear under production behaviour.
 * Running it with NODE_ENV=development would silently re-enable dev-only
 * branches (verbose OTP echo, auto-applied destructive migrations, relaxed
 * legacy-JWT handling), which defeats the purpose.
 */
export function assertAppEnvConsistency(env = process.env) {
  const appEnv = resolveAppEnv(env);
  const problems = [];

  if (PRODUCTION_LIKE.includes(appEnv) && env.NODE_ENV !== 'production') {
    problems.push(
      `APP_ENV=${appEnv} requires NODE_ENV=production (got ${env.NODE_ENV || 'unset'})`
    );
  }
  if (appEnv === 'staging' && !env.DATABASE_URL) {
    problems.push('APP_ENV=staging requires an explicit DATABASE_URL (no implicit fallback)');
  }
  // Without a signing secret every login and every token check throws, one
  // request at a time, as a 500. Better to refuse to start.
  if (PRODUCTION_LIKE.includes(appEnv) && !env.JWT_SECRET) {
    problems.push('JWT_SECRET is required — tokens cannot be signed or verified without it');
  }
  if (problems.length) {
    throw new Error(`Environment misconfiguration:\n  - ${problems.join('\n  - ')}`);
  }
  return appEnv;
}

export function describeAppEnv(env = process.env) {
  const appEnv = resolveAppEnv(env);
  return `APP_ENV=${appEnv} NODE_ENV=${env.NODE_ENV || 'unset'}`;
}
