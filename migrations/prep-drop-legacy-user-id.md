# Prep only — DO NOT auto-run in production during Phase 4 development.

## Preconditions (Deployment A already live)

1. `scripts/verify-rbac-legacy-column-removal.mjs` exits 0 in production.
2. Application code no longer **reads** `companies.user_id` / `devices.user_id` for authorization.
3. Application code no longer **writes** those columns (Phase 4 stop-write).
4. Observation window after Deployment A with zero incidents.

## Migration SQL (PostgreSQL)

```sql
-- Backup expectation: logical dump or snapshot before apply.

ALTER TABLE companies DROP COLUMN IF EXISTS user_id;
ALTER TABLE devices DROP COLUMN IF EXISTS user_id;
```

If SQLite ever used for fixtures: rebuild tables without the columns (not production path).

## Rollback

Restore from pre-migration snapshot/backup. Re-adding columns without data recovery does not restore ownership history.

## Post-migration verification

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'companies' AND column_name = 'user_id';
-- expect 0 rows

SELECT column_name FROM information_schema.columns
WHERE table_name = 'devices' AND column_name = 'user_id';
-- expect 0 rows
```

## Never

Combine stop-write + DROP in one release.
