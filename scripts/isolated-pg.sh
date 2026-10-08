#!/usr/bin/env bash
# Disposable PostgreSQL cluster for isolated backend tests (synthetic data only).
#
#   scripts/isolated-pg.sh start   -> initdb (if needed) + start on 127.0.0.1:${TD_TEST_PG_PORT:-55432}
#   scripts/isolated-pg.sh reset [schema.sql] -> recreate the disposable DB (optionally from a schema-only dump)
#   scripts/isolated-pg.sh env     -> print exports for the isolated test run
#   scripts/isolated-pg.sh stop    -> stop the cluster
#   scripts/isolated-pg.sh destroy -> stop and remove ONLY the disposable cluster directory
#
# The cluster lives in ${TD_TEST_PG_DIR:-/tmp/td-isolated-pg}. It never touches the
# default local server (port 5432) or any DATABASE_URL from .env.
set -euo pipefail

DIR="${TD_TEST_PG_DIR:-/tmp/td-isolated-pg}"
PORT="${TD_TEST_PG_PORT:-55432}"
DB="td_isolated_test"
ROLE="td_isolated"
MARKER_FILE="$DIR/.td-isolated-marker"

if [[ "$PORT" == "5432" ]]; then
  echo "refusing: isolated cluster must not use the default port 5432" >&2
  exit 2
fi

start() {
  if [[ ! -f "$DIR/data/PG_VERSION" ]]; then
    mkdir -p "$DIR"
    initdb -D "$DIR/data" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
    echo "listen_addresses = '127.0.0.1'" >> "$DIR/data/postgresql.conf"
    echo "port = $PORT" >> "$DIR/data/postgresql.conf"
    echo "unix_socket_directories = '$DIR'" >> "$DIR/data/postgresql.conf"
    echo "fsync = off" >> "$DIR/data/postgresql.conf"
  fi
  if ! pg_ctl -D "$DIR/data" status >/dev/null 2>&1; then
    pg_ctl -D "$DIR/data" -l "$DIR/server.log" -w start >/dev/null
  fi
  local psql=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt)
  if [[ "$("${psql[@]}" -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname='$ROLE'")" != "1" ]]; then
    "${psql[@]}" -d postgres -c "CREATE ROLE $ROLE LOGIN PASSWORD 'td_isolated_pw'"
  fi
  if [[ "$("${psql[@]}" -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$DB'")" != "1" ]]; then
    "${psql[@]}" -d postgres -c "CREATE DATABASE $DB OWNER $ROLE"
  fi
  if [[ ! -f "$MARKER_FILE" ]]; then
    od -An -tx1 -N16 /dev/urandom | tr -d ' \n' > "$MARKER_FILE"
  fi
  local token
  token="$(cat "$MARKER_FILE")"
  "${psql[@]}" -d "$DB" -U "$ROLE" -c "CREATE TABLE IF NOT EXISTS td_isolated_fixture_marker (id INT PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL)"
  "${psql[@]}" -d "$DB" -U "$ROLE" -c "INSERT INTO td_isolated_fixture_marker (id, token) VALUES (1, '$token') ON CONFLICT (id) DO UPDATE SET token = EXCLUDED.token"
  echo "isolated postgres ready on 127.0.0.1:$PORT db=$DB"
}

# reset [baseline.sql]: drop and recreate ONLY the disposable database, optionally
# loading a schema-only baseline (pg_dump --schema-only, contains no rows).
reset() {
  local baseline="${1:-}"
  local psql=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt)
  "${psql[@]}" -d postgres -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)"
  "${psql[@]}" -d postgres -c "CREATE DATABASE $DB OWNER $ROLE"
  if [[ -n "$baseline" ]]; then
    if grep -qiE '^(COPY|INSERT) ' "$baseline"; then
      echo "refusing: baseline contains row data" >&2
      exit 2
    fi
    grep -E '^CREATE EXTENSION' "$baseline" | while read -r stmt; do
      "${psql[@]}" -d "$DB" -c "$stmt"
    done
    psql -h 127.0.0.1 -p "$PORT" -U "$ROLE" -d "$DB" -v ON_ERROR_STOP=1 -q -f "$baseline" >/dev/null
  fi
  start
}

envs() {
  echo "export TD_ISOLATED_TEST=1"
  echo "export TD_TEST_PG_DIR='$DIR'"
  echo "export TD_TEST_PG_PORT=$PORT"
  echo "export TD_TEST_DATABASE_URL='postgresql://$ROLE:td_isolated_pw@127.0.0.1:$PORT/$DB'"
}

stop() {
  if [[ -f "$DIR/data/PG_VERSION" ]]; then
    pg_ctl -D "$DIR/data" -m fast stop >/dev/null 2>&1 || true
  fi
  echo "stopped"
}

destroy() {
  stop
  if [[ -f "$MARKER_FILE" && "$DIR" == /tmp/* ]]; then
    rm -rf "$DIR"
    echo "destroyed $DIR"
  else
    echo "refusing to remove $DIR (no marker or not under /tmp)" >&2
    exit 2
  fi
}

case "${1:-}" in
  start) start ;;
  reset) reset "${2:-}" ;;
  env) envs ;;
  stop) stop ;;
  destroy) destroy ;;
  *) echo "usage: $0 start|env|stop|destroy" >&2; exit 64 ;;
esac
