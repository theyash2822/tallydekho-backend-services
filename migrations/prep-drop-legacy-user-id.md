# Drop legacy `companies.user_id` / `devices.user_id`

Deployment B. Deployment A (stop-write + workspace authority) is already live.

## Why

The single-user model owned a company through `companies.user_id` and a Desktop
through `devices.user_id`. Ownership is now the workspace: `companies.workspace_id`
and the `workspace_tally_bindings` row for the Desktop. The columns held no data
and no authorization decision, but every one of them was an invitation for a new
query to resolve a tenant the old way.

Three readers were removed with this migration:

* `desktopWorkspace.desktopMeHandler` and `GET /pairing-device` joined `users`
  through `devices.user_id`, so Desktop had been receiving a null identity ever
  since the stop-write. Both now resolve through `workspaces.owner_user_id`.
* The desktop socket `register` handler read `devices.user_id` to scope the
  pending-writeback count, which silently widened to a user-level queue search.
  It is workspace-scoped now.
* `backfillPersonalWorkspaces` updated `companies`/`devices` by `user_id`, which
  had matched zero rows since the stop-write.

## Preconditions

1. `scripts/verify-rbac-legacy-column-removal.mjs` exits 0.
2. No application code reads or writes either column
   (`src/__tests__/rbac-phase4-static.test.js` asserts this).
3. Both columns are 100% NULL — the script refuses otherwise.

## Apply

```bash
DATABASE_URL=... node scripts/drop-legacy-user-id-columns.mjs            # report
DATABASE_URL=... CONFIRM=1 node scripts/drop-legacy-user-id-columns.mjs  # apply
```

One transaction. Also drops `idx_companies_user`, which indexed the dead column.

Equivalent SQL, for a reviewer:

```sql
DROP INDEX IF EXISTS idx_companies_user;
ALTER TABLE companies DROP COLUMN IF EXISTS user_id;
ALTER TABLE devices   DROP COLUMN IF EXISTS user_id;
```

## Rollback

Restore from the pre-migration snapshot. Re-adding the columns gives them back
empty, which does not restore ownership history — but nothing reads them, so an
empty column and a missing column behave identically.

## Post-migration verification

```sql
SELECT table_name, column_name FROM information_schema.columns
 WHERE table_schema = 'public' AND column_name = 'user_id'
   AND table_name IN ('companies', 'devices');
-- expect 0 rows
```

```bash
npm run test:unit   # rbac-phase4-static asserts the columns are gone
```

## Never

Combine stop-write and DROP in one release.
