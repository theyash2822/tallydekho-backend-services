#!/usr/bin/env bash
# Collect the production facts needed to build a matching staging environment.
#
# Run ON the production host as the deploy user:
#   bash scripts/collect-deployment-facts.sh > prod-facts.txt
#
# Safe to run: read-only, and it prints environment variable NAMES only —
# never values — so the output can be pasted into an issue or chat.

set -uo pipefail

hr() { printf '\n== %s ==\n' "$1"; }
try() { "$@" 2>&1 || echo "(unavailable)"; }

echo "collected: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "host     : $(hostname)"

hr "OS"
try cat /etc/os-release
try uname -srm

hr "CPU / memory / disk"
try nproc
try free -h
try df -h /

hr "Node"
try node -v
try npm -v
echo "which node: $(command -v node || echo '(none)')"
try bash -c 'ls -1 "$HOME/.nvm/versions/node" 2>/dev/null'

hr "PM2"
try pm2 -v
# Deliberately NOT `pm2 jlist` — it dumps full env values into the output.
echo "pm2 process list:"
try pm2 list
echo "-- exec mode / instances (names + mode only) --"
try node -e '
  const { execSync } = require("child_process");
  try {
    const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
    for (const p of list) {
      const e = p.pm2_env || {};
      console.log([p.name, e.exec_mode, `instances=${e.instances ?? 1}`,
        `node_args=${e.node_args || ""}`, `max_memory_restart=${e.max_memory_restart || ""}`,
        `cwd=${e.pm_cwd || ""}`].join("  "));
    }
  } catch (e) { console.log("(unavailable)", e.message); }
'

hr "Nginx"
try nginx -v
# `nginx -T` prints every server block. Skim it before sharing: it can contain
# basic-auth files, upstream hosts, or cert paths you may not want to publish.
try nginx -T

hr "PostgreSQL (server)"
try psql --version
# Server version as reported by the server the app actually talks to.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "querying server via DATABASE_URL (value not printed)"
  try psql "$DATABASE_URL" -tAc "select version()"
  try psql "$DATABASE_URL" -tAc "show server_version"
  try psql "$DATABASE_URL" -tAc \
    "select name, setting, unit from pg_settings where name in
      ('max_connections','shared_buffers','work_mem','maintenance_work_mem',
       'effective_cache_size','statement_timeout','lock_timeout',
       'idle_in_transaction_session_timeout','max_wal_size','wal_level',
       'default_transaction_isolation','timezone') order by name"
  echo "-- installed extensions --"
  try psql "$DATABASE_URL" -tAc \
    "select extname, extversion from pg_extension order by extname"
  echo "-- database size --"
  try psql "$DATABASE_URL" -tAc \
    "select pg_size_pretty(pg_database_size(current_database()))"
else
  echo "DATABASE_URL not set in this shell — re-run with it exported, or run:"
  echo "  psql \"\$DATABASE_URL\" -tAc 'select version()'"
fi

hr "Environment variable NAMES visible to the app (values withheld)"
if command -v pm2 >/dev/null 2>&1; then
  # Read names from the running process env without echoing any value.
  try node -e '
    const { execSync } = require("child_process");
    try {
      const list = JSON.parse(execSync("pm2 jlist", { encoding: "utf8" }));
      for (const p of list) {
        console.log(`-- ${p.name} --`);
        const env = (p.pm2_env && p.pm2_env.env) || {};
        console.log(Object.keys(env).sort().join("\n"));
      }
    } catch (e) { console.log("(unavailable)", e.message); }
  '
fi
echo "-- .env keys (names only) --"
for f in .env .env.production; do
  [ -f "$f" ] && { echo "[$f]"; grep -oE '^[A-Za-z_][A-Za-z0-9_]*' "$f" | sort; }
done

hr "TLS"
try bash -c 'certbot certificates 2>/dev/null'
try bash -c 'ls -1 /etc/letsencrypt/live 2>/dev/null'

hr "Cron / timers / background workers"
try crontab -l
try bash -c 'ls -1 /etc/cron.d 2>/dev/null'
try systemctl list-timers --all --no-pager

hr "Listening sockets"
try bash -c 'ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null'

hr "App release identity"
try git -C . rev-parse HEAD
try git -C . describe --tags --always
try node -e 'const p=require("./package.json");console.log(p.name,p.version)'

echo
echo "== done =="
echo "Paste this into COMPANY_IDENTITY_STAGING_PROVISIONING.md section 2."
