/**
 * The schema must converge without a human running ALTER OWNER.
 *
 * Postgres gives ownership to whoever executes CREATE, and `initSchema()` runs
 * `CREATE TABLE IF NOT EXISTS` on every boot. A maintenance script pointed at
 * `postgresql://mac@…` therefore created tables owned by that superuser while
 * the app connects as `tallydekho`, and the app could no longer ALTER its own
 * table — this suite used to die on "must be owner of table
 * demo_simulated_entries" until someone reassigned it by hand.
 *
 * `adoptSchemaOwner()` in src/db/schema.js closes that hole. These assertions
 * fail if it is removed or stops working.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { query } from '../../db/schema.js';
import { setupRbacHarness } from './harness.js';

let ctx;

/** Application objects only — extension members belong to their extension. */
const DRIFT_SQL = `
  WITH extension_member AS (
    SELECT objid, classid FROM pg_depend WHERE deptype = 'e'
  )
  SELECT c.relname AS name, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r','p','v','m')
     AND NOT EXISTS (
       SELECT 1 FROM extension_member e
        WHERE e.objid = c.oid AND e.classid = 'pg_class'::regclass
     )
     AND pg_get_userbyid(c.relowner) <> $1
   ORDER BY 1
`;

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') {
      ctx = null;
      return;
    }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Schema ownership converges on its own', () => {
  it('every application table is owned by one role', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows: anchor } = await query(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'users'`
    );
    const expected = anchor[0]?.tableowner;
    assert.ok(expected, 'users table must exist after initSchema');

    const { rows: drifted } = await query(DRIFT_SQL, [expected]);
    assert.deepEqual(
      drifted.map((r) => `${r.name} (owner=${r.owner})`),
      [],
      `objects not owned by "${expected}" — run scripts/verify-db-ownership.mjs`
    );
  });

  it('the connected role can alter the tables it owns', async () => {
    if (!ctx) throw new Error('harness required');
    // The exact privilege that was missing: ALTER on a table the app created.
    // A no-op comment needs ownership and leaves no schema change behind.
    await query(`COMMENT ON TABLE demo_simulated_entries IS 'ownership probe'`);
    await query(`COMMENT ON TABLE demo_simulated_entries IS NULL`);
  });

  it('bootstrap adopts the established owner instead of the connecting role', async () => {
    if (!ctx) throw new Error('harness required');
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../db/schema.js', import.meta.url), 'utf8')
    );
    assert.match(src, /async function adoptSchemaOwner/);
    assert.match(src, /SET ROLE \$\{quoteIdent\(target\)\}/);
    assert.match(src, /RESET ROLE/, 'a pooled client must not keep the adopted role');
  });
});
