/**
 * Database environment stamp.
 *
 * The dangerous failure mode for a new staging deployment is a copy-paste
 * DATABASE_URL that still points at production: staging QA would then mutate
 * real customer data, and a rehearsed destructive migration would run for real.
 *
 * Hostname denylists cannot catch that (URLs are opaque and change). Instead the
 * database itself carries the environment it belongs to, and a mismatch with the
 * running app is fatal.
 *
 * Restoring a production snapshot into staging carries the production stamp
 * along with it, so that path must re-stamp explicitly:
 *   RESTAMP_DEPLOYMENT_ENV=1
 */
import { resolveAppEnv } from '../config/appEnv.js';

const SENSITIVE = new Set(['production', 'staging']);

export async function ensureDeploymentIdentity(client, env = process.env) {
  const appEnv = resolveAppEnv(env);

  await client.query(`
    CREATE TABLE IF NOT EXISTS deployment_identity (
      id          INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      app_env     TEXT NOT NULL,
      stamped_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_boot   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { rows } = await client.query('SELECT app_env, stamped_at FROM deployment_identity WHERE id = 1');
  const stamped = rows[0]?.app_env || null;

  if (!stamped) {
    await client.query(
      `INSERT INTO deployment_identity (id, app_env) VALUES (1, $1)
       ON CONFLICT (id) DO UPDATE SET app_env = EXCLUDED.app_env, last_boot = NOW()`,
      [appEnv]
    );
    console.log(`[env] database stamped as ${appEnv}`);
    return { appEnv, stamped: appEnv, restamped: false };
  }

  if (stamped === appEnv) {
    await client.query('UPDATE deployment_identity SET last_boot = NOW() WHERE id = 1');
    return { appEnv, stamped, restamped: false };
  }

  // dev↔test churn on a developer machine is normal; production/staging is not.
  const sensitive = SENSITIVE.has(stamped) || SENSITIVE.has(appEnv);
  const allowRestamp = env.RESTAMP_DEPLOYMENT_ENV === '1';

  if (sensitive && !allowRestamp) {
    throw new Error(
      `Refusing to boot: this database is stamped "${stamped}" but the app is running as "${appEnv}".\n` +
        `  If DATABASE_URL is wrong, fix it — a ${appEnv} app must never run against a ${stamped} database.\n` +
        `  If this database is a restored snapshot now owned by ${appEnv}, re-stamp deliberately:\n` +
        `    RESTAMP_DEPLOYMENT_ENV=1 <command>`
    );
  }

  await client.query(
    `UPDATE deployment_identity SET app_env = $1, stamped_at = NOW(), last_boot = NOW() WHERE id = 1`,
    [appEnv]
  );
  console.warn(`[env] database re-stamped ${stamped} → ${appEnv}`);
  return { appEnv, stamped: appEnv, restamped: true, previous: stamped };
}
