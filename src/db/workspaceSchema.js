/**
 * Workspace / device-credential / backup-restore / RBAS tables.
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

    CREATE TABLE IF NOT EXISTS workspace_roles (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      system_key      TEXT,
      display_name    TEXT NOT NULL,
      entry_mode      TEXT NOT NULL DEFAULT 'BOTH',
      is_builtin      BOOLEAN NOT NULL DEFAULT FALSE,
      is_editable     BOOLEAN NOT NULL DEFAULT TRUE,
      created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_roles_ws ON workspace_roles(workspace_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ws_roles_system
      ON workspace_roles(workspace_id, system_key) WHERE system_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS role_capabilities (
      role_id         TEXT NOT NULL REFERENCES workspace_roles(id) ON DELETE CASCADE,
      capability_key  TEXT NOT NULL,
      granted         BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (role_id, capability_key)
    );

    CREATE TABLE IF NOT EXISTS role_sensitive_policies (
      role_id         TEXT NOT NULL REFERENCES workspace_roles(id) ON DELETE CASCADE,
      policy_key      TEXT NOT NULL,
      granted         BOOLEAN NOT NULL DEFAULT TRUE,
      PRIMARY KEY (role_id, policy_key)
    );

    CREATE TABLE IF NOT EXISTS membership_scope_policy (
      membership_id   TEXT PRIMARY KEY REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      company_mode    TEXT NOT NULL DEFAULT 'ALL',
      fy_mode         TEXT NOT NULL DEFAULT 'ALL',
      ledger_mode     TEXT NOT NULL DEFAULT 'ALL',
      godown_mode     TEXT NOT NULL DEFAULT 'ALL',
      cost_centre_mode TEXT NOT NULL DEFAULT 'ALL'
    );

    CREATE TABLE IF NOT EXISTS member_company_access (
      membership_id   TEXT NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      company_id      BIGINT NOT NULL,
      PRIMARY KEY (membership_id, company_id)
    );
    CREATE TABLE IF NOT EXISTS member_fy_access (
      membership_id   TEXT NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      fy_key          TEXT NOT NULL,
      PRIMARY KEY (membership_id, fy_key)
    );
    CREATE TABLE IF NOT EXISTS member_ledger_access (
      membership_id   TEXT NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      ledger_guid     TEXT NOT NULL,
      ledger_name     TEXT,
      PRIMARY KEY (membership_id, ledger_guid)
    );
    CREATE TABLE IF NOT EXISTS member_godown_access (
      membership_id   TEXT NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      godown_guid     TEXT NOT NULL,
      godown_name     TEXT,
      PRIMARY KEY (membership_id, godown_guid)
    );
    CREATE TABLE IF NOT EXISTS member_cost_centre_access (
      membership_id   TEXT NOT NULL REFERENCES workspace_memberships(id) ON DELETE CASCADE,
      cost_centre_guid TEXT NOT NULL,
      cost_centre_name TEXT,
      PRIMARY KEY (membership_id, cost_centre_guid)
    );

    CREATE TABLE IF NOT EXISTS workspace_seats (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
      seat_kind         TEXT NOT NULL DEFAULT 'PAID',
      status            TEXT NOT NULL DEFAULT 'AVAILABLE',
      period_start      BIGINT,
      period_end        BIGINT,
      assigned_user_id  INTEGER REFERENCES users(id),
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_seats_ws ON workspace_seats(workspace_id, status);

    CREATE TABLE IF NOT EXISTS workspace_invitations (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
      invitee_user_id     INTEGER NOT NULL REFERENCES users(id),
      role_id             TEXT REFERENCES workspace_roles(id),
      reserved_seat_id    TEXT REFERENCES workspace_seats(id),
      status              TEXT NOT NULL DEFAULT 'PENDING',
      expires_at          BIGINT NOT NULL,
      invited_by_user_id  INTEGER REFERENCES users(id),
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      accepted_at         BIGINT,
      declined_at         BIGINT,
      revoked_at          BIGINT,
      scope_snapshot_json JSONB
    );
    CREATE INDEX IF NOT EXISTS idx_ws_invites_invitee ON workspace_invitations(invitee_user_id, status);

    CREATE TABLE IF NOT EXISTS billing_accounts (
      id              TEXT PRIMARY KEY,
      owner_user_id   INTEGER NOT NULL UNIQUE REFERENCES users(id),
      created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS wallets (
      id                  TEXT PRIMARY KEY,
      billing_account_id  TEXT NOT NULL UNIQUE REFERENCES billing_accounts(id),
      balance_credits     NUMERIC(14,2) NOT NULL DEFAULT 0,
      updated_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS credit_lots (
      id                  TEXT PRIMARY KEY,
      wallet_id           TEXT REFERENCES wallets(id),
      workspace_id        TEXT,
      credits_remaining   NUMERIC(14,2) NOT NULL,
      credits_original    NUMERIC(14,2) NOT NULL,
      source              TEXT NOT NULL DEFAULT 'SIGNUP',
      expires_at          BIGINT,
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id                  TEXT PRIMARY KEY,
      wallet_id           TEXT REFERENCES wallets(id),
      workspace_id        TEXT,
      amount              NUMERIC(14,2) NOT NULL,
      kind                TEXT NOT NULL,
      reference           TEXT,
      meta_json           JSONB,
      funding_source      TEXT,
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE TABLE IF NOT EXISTS service_rates (
      key           TEXT PRIMARY KEY,
      credits       NUMERIC(14,2) NOT NULL,
      version       INTEGER NOT NULL DEFAULT 1,
      updated_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );

    CREATE TABLE IF NOT EXISTS payment_mode_posting_map (
      id              TEXT PRIMARY KEY,
      workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
      company_guid    TEXT NOT NULL,
      payment_mode    TEXT NOT NULL,
      ledger_guid     TEXT,
      ledger_name     TEXT,
      UNIQUE (workspace_id, company_guid, payment_mode)
    );

    CREATE TABLE IF NOT EXISTS cost_centres (
      guid            TEXT NOT NULL,
      company_guid    TEXT NOT NULL,
      name            TEXT NOT NULL,
      parent_guid     TEXT,
      parent_name     TEXT,
      is_active       BOOLEAN NOT NULL DEFAULT TRUE,
      workspace_id    TEXT,
      PRIMARY KEY (company_guid, guid)
    );

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

    -- One active Desktop per Workspace (paired rows only)
    CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_one_paired_per_workspace
      ON devices (workspace_id)
      WHERE paired = TRUE AND workspace_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS desktop_pairing_sessions (
      id                  TEXT PRIMARY KEY,
      device_id           TEXT NOT NULL,
      code_lookup_hash    TEXT NOT NULL,
      claim_token_hash    TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'PENDING',
      workspace_id        TEXT,
      approved_by_user_id INTEGER,
      created_at          BIGINT NOT NULL,
      expires_at          BIGINT NOT NULL,
      approved_at         BIGINT,
      claimed_at          BIGINT,
      cancelled_at        BIGINT,
      pending_secret_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_device
      ON desktop_pairing_sessions (device_id, status);
    CREATE INDEX IF NOT EXISTS idx_pairing_sessions_code
      ON desktop_pairing_sessions (code_lookup_hash, status);

    ALTER TABLE companies ADD COLUMN IF NOT EXISTS workspace_id TEXT;

    ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS actor_user_id INTEGER;

    CREATE TABLE IF NOT EXISTS workspace_integrations (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
      domain        TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'NOT_CONFIGURED',
      config_json   JSONB,
      activated_at  BIGINT,
      updated_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      UNIQUE (workspace_id, domain)
    );

    -- Ownership transfer (3 email confirms → 24h grace → execute)
    CREATE TABLE IF NOT EXISTS workspace_ownership_transfers (
      id                  TEXT PRIMARY KEY,
      workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
      from_user_id        INTEGER NOT NULL REFERENCES users(id),
      target_user_id      INTEGER NOT NULL REFERENCES users(id),
      outgoing_role_id    TEXT,
      status              TEXT NOT NULL DEFAULT 'PENDING_CONFIRM',
      confirm_count       INTEGER NOT NULL DEFAULT 0,
      confirm_tokens_json JSONB,
      email_count         INTEGER NOT NULL DEFAULT 0,
      expires_at          BIGINT,
      grace_ends_at       BIGINT,
      completed_at        BIGINT,
      cancelled_at        BIGINT,
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_ownership_transfers_ws
      ON workspace_ownership_transfers(workspace_id, status);

    CREATE TABLE IF NOT EXISTS workspace_lifecycle_requests (
      id                TEXT PRIMARY KEY,
      workspace_id      TEXT NOT NULL REFERENCES workspaces(id),
      kind              TEXT NOT NULL,
      actor_user_id     INTEGER REFERENCES users(id),
      status            TEXT NOT NULL DEFAULT 'PENDING_CONFIRM',
      confirm_count     INTEGER NOT NULL DEFAULT 0,
      confirm_phrase    TEXT,
      grace_ends_at     BIGINT,
      expires_at        BIGINT,
      meta_json         JSONB,
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      completed_at      BIGINT,
      cancelled_at      BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_ws_lifecycle_ws
      ON workspace_lifecycle_requests(workspace_id, kind, status);

    CREATE TABLE IF NOT EXISTS billing_payment_orders (
      id                TEXT PRIMARY KEY,
      billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
      owner_user_id     INTEGER NOT NULL REFERENCES users(id),
      credits           NUMERIC(14,2) NOT NULL,
      amount_inr        NUMERIC(14,2) NOT NULL,
      status            TEXT NOT NULL DEFAULT 'PENDING',
      provider          TEXT DEFAULT 'MANUAL',
      provider_order_id TEXT,
      provider_payment_id TEXT,
      meta_json         JSONB,
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      completed_at      BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_billing_orders_owner
      ON billing_payment_orders(owner_user_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_invoices (
      id                TEXT PRIMARY KEY,
      billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id),
      owner_user_id     INTEGER NOT NULL REFERENCES users(id),
      order_id          TEXT REFERENCES billing_payment_orders(id),
      credits           NUMERIC(14,2) NOT NULL,
      amount_inr        NUMERIC(14,2) NOT NULL,
      currency          TEXT NOT NULL DEFAULT 'INR',
      status            TEXT NOT NULL DEFAULT 'PAID',
      invoice_number    TEXT,
      meta_json         JSONB,
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_billing_invoices_owner
      ON billing_invoices(owner_user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS usage_events (
      id                TEXT PRIMARY KEY,
      owner_user_id     INTEGER NOT NULL REFERENCES users(id),
      workspace_id      TEXT,
      kind              TEXT NOT NULL,
      amount            NUMERIC(14,2) NOT NULL DEFAULT 0,
      reference         TEXT,
      wallet_txn_id     TEXT,
      meta_json         JSONB,
      created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_events_owner
      ON usage_events(owner_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_ws
      ON usage_events(workspace_id, kind, created_at DESC);
  `);

  await client.query(`
    INSERT INTO service_rates (key, credits, version) VALUES
      ('ADDITIONAL_WORKSPACE', 1000, 1),
      ('SEAT_MONTHLY', 100, 1),
      ('TALLY_WRITE', 0.10, 1),
      ('PDF_GENERATE', 0.10, 1),
      ('GST_ACTIVATION', 100, 1),
      ('EINVOICE_ACTIVATION', 100, 1),
      ('EWAY_ACTIVATION', 100, 1)
    ON CONFLICT (key) DO NOTHING
  `);

  // Expand-only column parity for older workspace drafts (CREATE IF NOT EXISTS does not alter).
  await client.query(`
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS system_key TEXT;
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS entry_mode TEXT DEFAULT 'BOTH';
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS is_builtin BOOLEAN DEFAULT FALSE;
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS is_editable BOOLEAN DEFAULT TRUE;
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS created_at BIGINT;
    ALTER TABLE workspace_roles ADD COLUMN IF NOT EXISTS updated_at BIGINT;
    ALTER TABLE role_capabilities ADD COLUMN IF NOT EXISTS granted BOOLEAN DEFAULT FALSE;
    ALTER TABLE role_sensitive_policies ADD COLUMN IF NOT EXISTS granted BOOLEAN DEFAULT TRUE;
    ALTER TABLE member_fy_access ADD COLUMN IF NOT EXISTS fy_key TEXT;
    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS scope_snapshot_json JSONB;
    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS invitee_mobile TEXT;
    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS declined_at BIGINT;
    ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS revoked_at BIGINT;
    ALTER TABLE workspace_seats ADD COLUMN IF NOT EXISTS assigned_user_id INTEGER;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS reset_requested_at BIGINT;
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS close_requested_at BIGINT;

    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS confirm_count INTEGER DEFAULT 0;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS confirm_tokens_json JSONB;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS email_count INTEGER DEFAULT 0;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS expires_at BIGINT;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS grace_ends_at BIGINT;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS completed_at BIGINT;
    ALTER TABLE workspace_ownership_transfers ADD COLUMN IF NOT EXISTS cancelled_at BIGINT;

    ALTER TABLE billing_payment_orders ADD COLUMN IF NOT EXISTS provider_payment_id TEXT;
    ALTER TABLE wallets DROP CONSTRAINT IF EXISTS chk_wallets_balance_nonneg;
    ALTER TABLE wallets ADD CONSTRAINT chk_wallets_balance_nonneg CHECK (balance_credits >= 0);

    ALTER TABLE credit_lots ADD COLUMN IF NOT EXISTS workspace_id TEXT;
    ALTER TABLE credit_lots ALTER COLUMN wallet_id DROP NOT NULL;
    ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS funding_source TEXT;
    ALTER TABLE wallet_transactions ALTER COLUMN wallet_id DROP NOT NULL;
    UPDATE wallet_transactions SET funding_source = 'OWNER_GLOBAL' WHERE funding_source IS NULL;

    ALTER TABLE credit_lots DROP CONSTRAINT IF EXISTS chk_credit_lots_remaining_nonneg;
    ALTER TABLE credit_lots ADD CONSTRAINT chk_credit_lots_remaining_nonneg CHECK (credits_remaining >= 0);
    ALTER TABLE credit_lots DROP CONSTRAINT IF EXISTS chk_credit_lots_remaining_le_original;
    ALTER TABLE credit_lots ADD CONSTRAINT chk_credit_lots_remaining_le_original
      CHECK (credits_remaining <= credits_original);
    ALTER TABLE credit_lots DROP CONSTRAINT IF EXISTS chk_credit_lots_original_positive;
    ALTER TABLE credit_lots ADD CONSTRAINT chk_credit_lots_original_positive CHECK (credits_original > 0);
    ALTER TABLE credit_lots DROP CONSTRAINT IF EXISTS chk_credit_lots_owner_or_workspace;
    ALTER TABLE credit_lots ADD CONSTRAINT chk_credit_lots_owner_or_workspace
      CHECK (
        (wallet_id IS NOT NULL AND workspace_id IS NULL)
        OR (wallet_id IS NULL AND workspace_id IS NOT NULL)
      );

    ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_txn_funding_source;
    ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_txn_funding_source
      CHECK (funding_source IS NULL OR funding_source IN ('OWNER_GLOBAL', 'WORKSPACE'));
    ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_txn_workspace_funding;
    ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_txn_workspace_funding
      CHECK (funding_source IS DISTINCT FROM 'WORKSPACE' OR workspace_id IS NOT NULL);
    ALTER TABLE wallet_transactions DROP CONSTRAINT IF EXISTS chk_wallet_txn_owner_funding;
    ALTER TABLE wallet_transactions ADD CONSTRAINT chk_wallet_txn_owner_funding
      CHECK (funding_source IS DISTINCT FROM 'OWNER_GLOBAL' OR wallet_id IS NOT NULL);
  `);

  // Backfill display_name from legacy `name` if that column exists on older drafts.
  try {
    await client.query(`
      UPDATE workspace_roles
      SET display_name = COALESCE(NULLIF(display_name, ''), name, system_key, 'Role')
      WHERE display_name IS NULL OR display_name = ''
    `);
  } catch {
    await client.query(`
      UPDATE workspace_roles
      SET display_name = COALESCE(NULLIF(display_name, ''), system_key, 'Role')
      WHERE display_name IS NULL OR display_name = ''
    `).catch(() => {});
  }

  // Phase 2 D — server-backed sessions (refresh hash only; never store raw refresh)
  await client.query(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id                  TEXT PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id),
      refresh_token_hash  TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at          BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      expires_at          BIGINT,
      revoked_at          BIGINT,
      rotated_at          BIGINT,
      client_type         TEXT,
      device_label        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh ON auth_sessions(refresh_token_hash);
  `);

  // RBAC Phase 7 — legacy auth usage counters (aggregate only, no PII/secrets).
  // Makes "verified clean day" answerable from the database instead of stdout.
  await client.query(`
    CREATE TABLE IF NOT EXISTS legacy_auth_events (
      day               DATE NOT NULL,
      event_type        TEXT NOT NULL,
      route_class       TEXT NOT NULL,
      platform          TEXT NOT NULL DEFAULT 'unknown',
      app_version       TEXT NOT NULL DEFAULT 'unknown',
      identified_client BOOLEAN NOT NULL DEFAULT FALSE,
      hits              BIGINT NOT NULL DEFAULT 0,
      last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (day, event_type, route_class, platform, app_version)
    );
    CREATE INDEX IF NOT EXISTS idx_legacy_auth_events_day ON legacy_auth_events(day DESC);
  `);

  // Private simulated Demo entries.
  //
  // Demo is a shared, immutable fixture, so a user practising data entry cannot
  // write into it. These rows are that practice: private to their author,
  // surfaced in My Entries, and invisible to the accounting tables.
  //
  // A separate table rather than write_queue. write_queue couples workspace and
  // company — the Desktop claim resolves `companies WHERE guid = ? AND
  // workspace_id = ?` — and the canonical Demo company belongs to the reserved
  // system workspace, not to the user's. Reusing it would mean rows whose
  // workspace and company disagree, and the safety of Demo never reaching a
  // Desktop would rest on a status string rather than on the schema.
  await client.query(`
    CREATE TABLE IF NOT EXISTS demo_simulated_entries (
      id            BIGSERIAL PRIMARY KEY,
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workspace_id  TEXT NOT NULL,
      company_id    BIGINT REFERENCES companies(id) ON DELETE SET NULL,
      entry_type    TEXT NOT NULL,
      title         TEXT,
      amount        NUMERIC(18,2),
      entry_date    DATE,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'DEMO_SIMULATED',
      created_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      updated_at    BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
      CONSTRAINT demo_simulated_entries_status_chk CHECK (status = 'DEMO_SIMULATED')
    );
    CREATE INDEX IF NOT EXISTS idx_demo_sim_user ON demo_simulated_entries (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_demo_sim_user_ws ON demo_simulated_entries (user_id, workspace_id);
  `);
}
