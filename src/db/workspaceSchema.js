/**
 * Workspace / device-credential / backup-restore tables.
 * Expand-only: never drops legacy user_id ownership columns.
 */
export async function applyWorkspaceSchema(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id                  TEXT PRIMARY KEY,
      name                TEXT NOT NULL,
      owner_user_id      INTEGER REFERENCES users(id),
      workspace_type      TEXT NOT NULL DEFAULT 'PERSONAL',
      lifecycle_status    TEXT NOT NULL DEFAULT 'ACTIVE',
      commercial_status   TEXT NOT NULL DEFAULT 'ACTIVE',
      tally_connection    TEXT NOT NULL DEFAULT 'UNPAIRED',
      setup_generation    INTEGER NOT NULL DEFAULT 1,
      is_base             BOOLEAN NOT NULL DEFAULT TRUE,
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_workspaces_owner ON workspaces(owner_user_id);

    CREATE TABLE IF NOT EXISTS workspace_memberships (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
      user_id           INTEGER NOT NULL REFERENCES users(id),
      membership_type   TEXT NOT NULL DEFAULT 'OWNER',
      role_id           TEXT,
      status            TEXT NOT NULL DEFAULT 'ACTIVE',
      seat_id           TEXT,
      joined_at         BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      suspended_at      BIGINT,
      removed_at       BIGINT,
      UNIQUE (workspace_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_ws_memberships_user ON workspace_memberships(user_id);

    CREATE TABLE IF NOT EXISTS workspace_tally_bindings (
      id                  TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL UNIQUE REFERENCES workspaces(id),
      active_device_id  TEXT,
      lineage_id         TEXT NOT NULL,
      connection_status TEXT NOT NULL DEFAULT 'UNPAIRED',
      first_bound_at    BIGINT,
      last_verified_at  BIGINT,
      updated_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS workspace_tally_lineage_companies (
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
      tally_company_guid  TEXT NOT NULL,
      company_name        TEXT,
      first_seen_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      last_seen_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      status              TEXT NOT NULL DEFAULT 'ACTIVE',
      PRIMARY KEY (workspace_id, tally_company_guid)
    );

    CREATE TABLE IF NOT EXISTS workspace_backups (
      id                    TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
      setup_generation      INTEGER NOT NULL DEFAULT 1,
      source_device_id    TEXT,
      status                TEXT NOT NULL DEFAULT 'UPLOADING',
      object_key            TEXT,
      size_bytes            BIGINT,
      sha256                TEXT,
      format_version        TEXT DEFAULT '1',
      desktop_version       TEXT,
      tally_version         TEXT,
      company_manifest_json JSONB,
      created_at            BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      completed_at          BIGINT,
      deleted_at           BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_backups_ws ON workspace_backups(workspace_id, status, completed_at DESC);

    CREATE TABLE IF NOT EXISTS restore_sessions (
      id                  TEXT PRIMARY KEY,
      workspace_id      TEXT REFERENCES workspaces(id),
      backup_id          TEXT REFERENCES workspace_backups(id),
      new_device_id     TEXT,
      approved_by_user_id INTEGER REFERENCES users(id),
      status              TEXT NOT NULL DEFAULT 'PENDING',
      request_code_hash  TEXT,
      request_code_hint  TEXT,
      token_hash          TEXT,
      expires_at          BIGINT,
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      completed_at        BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_restore_sessions_device ON restore_sessions(new_device_id, status);

    CREATE TABLE IF NOT EXISTS hard_sync_requests (
      id                  TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
      device_id          TEXT NOT NULL,
      operation           TEXT NOT NULL DEFAULT 'REBUILD',
      status              TEXT NOT NULL DEFAULT 'PENDING',
      old_guid            TEXT,
      new_guid            TEXT,
      company_manifest_json JSONB,
      approved_by_user_id INTEGER REFERENCES users(id),
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      decided_at         BIGINT,
      expires_at          BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_hard_sync_ws ON hard_sync_requests(workspace_id, status);

    CREATE TABLE IF NOT EXISTS workspace_audit_log (
      id            TEXT PRIMARY KEY,
      workspace_id TEXT,
      actor_user_id INTEGER,
      event_type    TEXT NOT NULL,
      payload       JSONB,
      created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_audit_ws ON workspace_audit_log(workspace_id, created_at DESC);

    ALTER TABLE devices ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret_hash TEXT;
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS binding_status TEXT DEFAULT 'UNBOUND';
    ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_claimed_at BIGINT;

    ALTER TABLE companies ADD COLUMN IF NOT EXISTS workspace_id TEXT;

    ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS actor_user_id INTEGER;
  `);
}
