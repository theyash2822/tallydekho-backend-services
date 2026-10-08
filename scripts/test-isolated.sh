#!/usr/bin/env bash
# Run isolated backend tests against the disposable cluster only.
#   scripts/test-isolated.sh [test-glob...]
# Rebuilds td_isolated_test from $TD_TEST_SCHEMA_BASELINE (schema-only dump, no rows)
# when that file exists; otherwise from an empty database.
set -euo pipefail
cd "$(dirname "$0")/.."
BASELINE="${TD_TEST_SCHEMA_BASELINE:-/tmp/td-isolated-pg/dev-schema-baseline.sql}"
scripts/isolated-pg.sh start >/dev/null
if [[ -f "$BASELINE" ]]; then
  scripts/isolated-pg.sh reset "$BASELINE" >/dev/null
else
  scripts/isolated-pg.sh reset >/dev/null
fi
eval "$(scripts/isolated-pg.sh env)"
if [[ $# -eq 0 ]]; then
  set -- src/__tests__/isolated/*.test.js
fi
exec env -u DATABASE_URL -u PGHOST -u PGDATABASE -u PGUSER -u PGPASSWORD -u PGPORT \
  node --test --test-concurrency=1 "$@"
