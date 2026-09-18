# Schema ownership convergence

Controlled ops step. Safe to run repeatedly; report-only unless `CONFIRM=1`.

## Problem

Postgres assigns ownership to whoever executes `CREATE`, and `initSchema()`
issues `CREATE TABLE IF NOT EXISTS` on every boot. Any maintenance script or
test run pointed at a different role therefore created new tables owned by that
role while the application connects as another.

Locally that meant `demo_simulated_entries` ended up owned by the OS superuser
`mac` while `DATABASE_URL` connects as `tallydekho`. The application could no
longer `ALTER` its own table and `npm run test:rbac` failed with:

```
must be owner of table demo_simulated_entries
```

It was repaired by hand with `ALTER TABLE … OWNER TO tallydekho`, which does not
survive the next time someone runs a script as a different role.

Reproduce the drift:

```sql
-- connected as a superuser that is not the application role
CREATE TABLE _ownership_probe(id int);
SELECT tableowner FROM pg_tables WHERE tablename = '_ownership_probe';  -- superuser
DROP TABLE _ownership_probe;
```

## Code change (already applied)

`adoptSchemaOwner()` in `src/db/schema.js` runs before any DDL in `initSchema()`.
It reads the owner of the `users` anchor table and, when the connecting role is
a member of it, issues `SET ROLE` for the bootstrap client — so every object
created is owned by the established owner regardless of who ran the bootstrap.
The role is reset in `finally` because the client returns to a shared pool.

* Empty database: no anchor table, so the bootstrapping role becomes the owner.
  That is the intended behaviour for a fresh environment.
* `DB_APP_ROLE` overrides the anchor when an environment wants to state the
  owner explicitly.
* Connecting role not a member of the owner: logs a warning and continues, so
  the subsequent DDL failure is the error the operator sees.

## Repairing an environment that already drifted

```bash
DATABASE_URL=... node scripts/verify-db-ownership.mjs            # report, exit 1 if drift
DATABASE_URL=... CONFIRM=1 node scripts/verify-db-ownership.mjs  # reassign, exit 0 when clean
```

Also available as `npm run verify:db-ownership`.

The script reassigns application tables, views and materialized views only.
Objects installed by an extension (`pg_depend.deptype = 'e'` — pgvector alone
contributes ~118 functions) are owned by whoever ran `CREATE EXTENSION` and are
excluded; so are objects owned by a system role. Indexes and sequences follow
their table.

## Verification

```bash
npm run verify:db-ownership   # exit 0, "no ownership drift"
npm run test:rbac             # passes with no manual ALTER OWNER
```

`src/__tests__/rbac/schema-ownership.test.js` asserts the invariant so a
regression fails the suite rather than surfacing as a confusing privilege error.

## Rollback

None required — the script only changes ownership, and the code change only
affects which role executes bootstrap DDL. To disable adoption in an
environment, unset `DB_APP_ROLE` and ensure the bootstrap connects as the role
that already owns the schema.
