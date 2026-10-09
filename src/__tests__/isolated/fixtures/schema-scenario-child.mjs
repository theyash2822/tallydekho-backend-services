/**
 * Child process for X10 schema scenarios. Runs initSchema inside one dedicated
 * Postgres schema of the disposable cluster (search_path pinned to it, so a
 * missing table cannot silently resolve to another schema).
 *
 *   node schema-scenario-child.mjs <pg_schema>
 *
 * Prints one JSON line: { ok, error?, cutover }.
 */
import { validateIsolatedEnv, verifyMarker } from '../isolatedDb.js';
import { installNetworkGuard } from '../networkGuard.js';

const target = process.argv[2];
if (!/^x10_[a-z0-9_]+$/.test(target || '')) {
  console.log(JSON.stringify({ ok: false, error: 'bad schema name' }));
  process.exit(2);
}

const { url, token } = validateIsolatedEnv();
const u = new URL(url);
installNetworkGuard({ allow: [[u.hostname, Number(u.port)]] });
await verifyMarker(url, token);

u.searchParams.set('options', `-c search_path=${target}`);
process.env.DATABASE_URL = u.toString();
process.env.APP_ENV = 'test';
process.env.SKIP_DEMO_SEED = '1';
process.env.JWT_SECRET = 'isolated-test-secret';
delete process.env.DB_APP_ROLE;

const logs = [];
for (const k of ['log', 'warn', 'error']) {
  console[k] = (...a) => logs.push(a.map(String).join(' '));
}
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

const schema = await import('../../../db/schema.js');
try {
  await schema.initSchema();
  out({ ok: true, cutover: schema.lastCidCutoverOutcome?.() ?? null, logs });
} catch (e) {
  out({ ok: false, error: `${e.code || ''} ${e.message}`, logs });
} finally {
  await schema.getPool().end().catch(() => {});
}
