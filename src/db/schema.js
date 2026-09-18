// Database — PostgreSQL via pg pool
import pg from 'pg';
import { REPAIR_VOUCHER_TYPE_PARENT_SQL } from '../utils/voucherTypeParent.js';
import { applyWorkspaceSchema } from './workspaceSchema.js';
import { ensureDeploymentIdentity } from './deploymentIdentity.js';
import { assertAppEnvConsistency } from '../config/appEnv.js';
const { Pool } = pg;

const POOL_OPTS = {
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

let pool = new Pool(POOL_OPTS);

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

/** Test harness: pin every new connection to an isolated schema. */
export function configureTestSearchPath(schemaName) {
  if (!schemaName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schemaName)) {
    throw new Error('Invalid test schema name');
  }
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schemaName}`).catch(() => {});
  });
}

export function getPool() {
  return pool;
}

/** After pool.end() in multi-file tests — recreate so the next file can run. */
export async function recreatePool() {
  try {
    if (pool && !pool.ended) await pool.end();
  } catch (_) { /* ignore */ }
  pool = new Pool(POOL_OPTS);
  pool.on('error', (err) => {
    console.error('[DB] Unexpected pool error:', err.message);
  });
  return pool;
}

// Helper: run a query with params
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 500) console.warn(`[DB] Slow query (${duration}ms):`, text.slice(0, 80));
    return res;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '\nQuery:', text.slice(0, 120));
    throw err;
  }
}

// Helper: get a client for transactions
export async function getClient() {
  return pool.connect();
}

// Legacy compat — returns pool (used as db in routes)
export function getDb() {
  return pool;
}

/**
 * Destructive Company Identity constraint migrations must never run as an
 * implicit side effect of a production deploy/restart. Outside production they
 * run on boot so dev/CI schemas track the code.
 */
export function cidDestructiveMigrationsAllowed() {
  return (
    process.env.NODE_ENV !== 'production' ||
    process.env.CID_ALLOW_DESTRUCTIVE_MIGRATION === '1'
  );
}

/**
 * Anchor table whose owner defines who should own every application object.
 * `users` is in the first CREATE batch below, so it exists in any database that
 * has ever been bootstrapped.
 */
const SCHEMA_OWNER_ANCHOR = 'users';

/**
 * Adopt the role that already owns the schema, for the duration of this client.
 *
 * Postgres assigns ownership to whoever executes CREATE, and `initSchema` issues
 * `CREATE TABLE IF NOT EXISTS` on every boot. So a maintenance script run as a
 * superuser (`postgresql://mac@…`) silently created new tables owned by that
 * superuser, while the app connects as `tallydekho` — and the app could then no
 * longer ALTER its own table. That surfaced as RBAC tests failing with
 * "must be owner of table demo_simulated_entries", repaired by hand each time.
 *
 * Adopting the established owner makes it self-correcting: the first bootstrap
 * of an empty database sets the owner, and every later bootstrap — whoever runs
 * it — creates objects as that same role.
 */
async function adoptSchemaOwner(client) {
  const configured = process.env.DB_APP_ROLE?.trim();
  const { rows } = await client.query(
    `SELECT current_user AS me,
            (SELECT tableowner FROM pg_tables
              WHERE schemaname = current_schema() AND tablename = $1) AS owner`,
    [SCHEMA_OWNER_ANCHOR]
  );
  const me = rows[0]?.me;
  // No anchor table yet = fresh database; whoever bootstraps it becomes owner.
  const target = configured || rows[0]?.owner;
  if (!target || target === me) return null;

  const { rows: member } = await client.query(`SELECT pg_has_role($1, 'MEMBER') AS ok`, [target]);
  if (!member[0]?.ok) {
    // Not fatal on its own — DDL against existing objects will fail loudly with
    // a far clearer error than a silently mis-owned new table.
    console.warn(
      `[DB] schema is owned by "${target}" but this connection is "${me}", which is not a member of it. ` +
        'New objects will be mis-owned; run scripts/verify-db-ownership.mjs.'
    );
    return null;
  }
  await client.query(`SET ROLE ${quoteIdent(target)}`);
  if (target !== me) console.log(`[DB] bootstrapping as schema owner "${target}" (connected as "${me}")`);
  return target;
}

/** Identifier quoting for a role name that never reaches SQL as a parameter. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// Initialize schema — create all tables if they don't exist
export async function initSchema() {
  const client = await pool.connect();
  let adoptedRole = null;
  try {
    assertAppEnvConsistency();
    // Before any DDL: ensureDeploymentIdentity creates a table of its own, so
    // it has to run as the schema owner like everything else.
    adoptedRole = await adoptSchemaOwner(client);
    // Fail closed if this app is pointed at another environment's database
    // (e.g. a staging deploy still holding the production DATABASE_URL).
    await ensureDeploymentIdentity(client);

    await client.query(`
      -- Users (mobile/web login)
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        mobile      TEXT UNIQUE NOT NULL,
        name        TEXT,
        email       TEXT,
        language    TEXT DEFAULT 'English',
        otp         TEXT,
        otp_expires BIGINT,
        token       TEXT,
        created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Desktop devices
      CREATE TABLE IF NOT EXISTS devices (
        id            SERIAL PRIMARY KEY,
        device_id     TEXT UNIQUE NOT NULL,
        user_id       INTEGER REFERENCES users(id),
        name          TEXT,
        os            TEXT,
        pairing_code  TEXT,
        code_expires  BIGINT,
        paired        BOOLEAN DEFAULT FALSE,
        last_seen     BIGINT,
        created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Companies (from Tally)
      CREATE TABLE IF NOT EXISTS companies (
        id          SERIAL PRIMARY KEY,
        guid        TEXT UNIQUE NOT NULL,
        user_id     INTEGER REFERENCES users(id),
        device_id   TEXT REFERENCES devices(device_id),
        name        TEXT NOT NULL,
        formal_name TEXT,
        gstin       TEXT,
        address     TEXT,
        state       TEXT,
        country     TEXT DEFAULT 'India',
        currency    TEXT DEFAULT 'INR',
        fy_start    TEXT,
        fy_end      TEXT,
        synced_at   BIGINT,
        created_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Ledgers
      CREATE TABLE IF NOT EXISTS ledgers (
        id                SERIAL PRIMARY KEY,
        guid              TEXT NOT NULL,
        company_guid      TEXT NOT NULL,
        name              TEXT NOT NULL,
        parent            TEXT,
        alias             TEXT,
        gstin             TEXT,
        pan               TEXT,
        phone             TEXT,
        email             TEXT,
        address           TEXT,
        opening_balance   DECIMAL(15,4) DEFAULT 0,
        closing_balance   DECIMAL(15,4) DEFAULT 0,
        balance_type      TEXT DEFAULT 'Dr',
        is_revenue        BOOLEAN DEFAULT FALSE,
        alter_id          INTEGER DEFAULT 0,
        synced_at         BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(guid, company_guid)
      );

      -- Vouchers
      CREATE TABLE IF NOT EXISTS vouchers (
        id              SERIAL PRIMARY KEY,
        guid            TEXT NOT NULL,
        company_guid    TEXT NOT NULL,
        voucher_number  TEXT,
        voucher_type    TEXT,
        date            TEXT,
        party_name      TEXT,
        party_guid      TEXT,
        amount          DECIMAL(15,4) DEFAULT 0,
        narration       TEXT,
        reference       TEXT,
        is_cancelled    BOOLEAN DEFAULT FALSE,
        alter_id        INTEGER DEFAULT 0,
        raw_data        TEXT,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        -- Bill-wise allocation cache (Phase B+C, 2026-06-30) — also added via ALTER block below for existing DBs.
        bill_ref_name          TEXT,
        bill_type              TEXT,  -- 'New Ref' | 'Agst Ref' | 'On Account' | 'Advance'
        bill_allocated_amount  DECIMAL(15,4),
        UNIQUE(guid, company_guid)
      );

      -- Voucher line items
      CREATE TABLE IF NOT EXISTS voucher_items (
        id            SERIAL PRIMARY KEY,
        voucher_guid  TEXT NOT NULL,
        company_guid  TEXT NOT NULL,
        ledger_name   TEXT,
        ledger_guid   TEXT,
        amount        DECIMAL(15,4),
        type          TEXT,
        item_name     TEXT,
        qty           DECIMAL(15,4),
        unit          TEXT,
        rate          DECIMAL(15,4),
        tax_rate      DECIMAL(8,4),
        hsn           TEXT
      );

      -- Stock items
      CREATE TABLE IF NOT EXISTS stocks (
        id              SERIAL PRIMARY KEY,
        guid            TEXT NOT NULL,
        company_guid    TEXT NOT NULL,
        name            TEXT NOT NULL,
        alias           TEXT,
        category        TEXT,
        group_name      TEXT,
        unit            TEXT,
        hsn             TEXT,
        tax_rate        DECIMAL(8,4) DEFAULT 18,
        opening_qty     DECIMAL(15,4) DEFAULT 0,
        opening_rate    DECIMAL(15,4) DEFAULT 0,
        closing_qty     DECIMAL(15,4) DEFAULT 0,
        closing_rate    DECIMAL(15,4) DEFAULT 0,
        closing_value   DECIMAL(15,4) DEFAULT 0,
        reorder_level       DECIMAL(15,4) DEFAULT 0,
        minimum_order_qty   DECIMAL(15,4) DEFAULT 0,
        alter_id            INTEGER DEFAULT 0,
        synced_at           BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(guid, company_guid)
      );

      -- Stock transactions
      CREATE TABLE IF NOT EXISTS stock_transactions (
        id            SERIAL PRIMARY KEY,
        stock_guid    TEXT NOT NULL,
        company_guid  TEXT NOT NULL,
        voucher_guid  TEXT,
        voucher_type  TEXT,
        date          TEXT,
        qty           DECIMAL(15,4),
        rate          DECIMAL(15,4),
        value         DECIMAL(15,4),
        type          TEXT,
        warehouse     TEXT,
        synced_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Sync log
      CREATE TABLE IF NOT EXISTS sync_log (
        id            SERIAL PRIMARY KEY,
        device_id     TEXT NOT NULL,
        user_id       INTEGER REFERENCES users(id),
        company_guid  TEXT NOT NULL,
        synced_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        mode          TEXT DEFAULT 'normal',       -- 'normal' | 'hard'
        voucher_count INTEGER DEFAULT 0,
        ledger_count  INTEGER DEFAULT 0,
        stock_count   INTEGER DEFAULT 0,
        record_count  INTEGER DEFAULT 0,
        status        TEXT DEFAULT 'success',      -- 'success' | 'failed'
        error_message TEXT
      );

      -- Ingest uploads
      CREATE TABLE IF NOT EXISTS ingest_uploads (
        id            TEXT PRIMARY KEY,
        device_id     TEXT,
        company_guid  TEXT,
        stream        TEXT,
        chunks        INTEGER DEFAULT 0,
        status        TEXT DEFAULT 'pending',
        created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        completed_at  BIGINT
      );

      -- Company financial years (multi-year support)
      CREATE TABLE IF NOT EXISTS company_years (
        id            SERIAL PRIMARY KEY,
        company_guid  TEXT NOT NULL,
        fin_year      TEXT NOT NULL,  -- e.g. '2023-2024'
        begin_date    TEXT NOT NULL,  -- e.g. '2023-04-01'
        end_date      TEXT NOT NULL,  -- e.g. '2024-03-31'
        UNIQUE(company_guid, fin_year)
      );

      CREATE INDEX IF NOT EXISTS idx_company_years ON company_years(company_guid);

      -- Warehouses / Godowns
      CREATE TABLE IF NOT EXISTS warehouses (
        id            SERIAL PRIMARY KEY,
        guid          TEXT,
        company_guid  TEXT NOT NULL,
        name          TEXT NOT NULL,
        parent        TEXT,
        parent_guid   TEXT,
        address       TEXT,
        alter_id      INTEGER DEFAULT 0,
        synced_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(name, company_guid)
      );

      -- Currency masters
      CREATE TABLE IF NOT EXISTS currencies (
        id            SERIAL PRIMARY KEY,
        guid          TEXT,
        company_guid  TEXT NOT NULL,
        name          TEXT NOT NULL,
        alter_id      INTEGER DEFAULT 0,
        synced_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(name, company_guid)
      );

      -- Units of measure
      CREATE TABLE IF NOT EXISTS units (
        id              SERIAL PRIMARY KEY,
        guid            TEXT,
        company_guid    TEXT NOT NULL,
        name            TEXT NOT NULL,
        formal_name     TEXT,
        is_simple_unit  BOOLEAN DEFAULT TRUE,
        base_units      TEXT,
        additional_units TEXT,
        conversion      TEXT,
        alter_id        INTEGER DEFAULT 0,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(name, company_guid)
      );

      -- Voucher types
      CREATE TABLE IF NOT EXISTS voucher_types (
        id              SERIAL PRIMARY KEY,
        guid            TEXT,
        company_guid    TEXT NOT NULL,
        name            TEXT NOT NULL,
        parent          TEXT,
        parent_guid     TEXT,
        numbering_method TEXT,
        is_deemed_positive BOOLEAN DEFAULT FALSE,
        affects_stock   BOOLEAN DEFAULT FALSE,
        alter_id        INTEGER DEFAULT 0,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(name, company_guid)
      );

      -- Indexes for new tables
      CREATE INDEX IF NOT EXISTS idx_warehouses_company  ON warehouses(company_guid);
      CREATE INDEX IF NOT EXISTS idx_units_company       ON units(company_guid);
      CREATE INDEX IF NOT EXISTS idx_vtype_company       ON voucher_types(company_guid);

      -- Group masters
      CREATE TABLE IF NOT EXISTS groups (
        id            SERIAL PRIMARY KEY,
        guid          TEXT NOT NULL,
        company_guid  TEXT NOT NULL,
        name          TEXT NOT NULL,
        parent        TEXT,
        nature        TEXT,
        is_revenue    BOOLEAN DEFAULT FALSE,
        is_debit_positive BOOLEAN DEFAULT FALSE,
        is_primary        BOOLEAN DEFAULT FALSE,
        reorder_level     DECIMAL(15,4) DEFAULT 0,
        minimum_order_qty DECIMAL(15,4) DEFAULT 0,
        alter_id          INTEGER DEFAULT 0,
        synced_at         BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(guid, company_guid)
      );

      -- Voucher inventory items (line items with qty, rate, item)
      CREATE TABLE IF NOT EXISTS voucher_inventory_items (
        id              SERIAL PRIMARY KEY,
        voucher_guid    TEXT NOT NULL,
        company_guid    TEXT NOT NULL,
        stock_item_name TEXT,
        stock_item_guid TEXT,
        actual_qty      DECIMAL(15,4) DEFAULT 0,
        billed_qty      DECIMAL(15,4) DEFAULT 0,
        rate            DECIMAL(15,4) DEFAULT 0,
        amount          DECIMAL(15,4) DEFAULT 0,
        discount        DECIMAL(8,4)  DEFAULT 0,
        godown_name     TEXT,
        batch_name      TEXT,
        unit            TEXT,
        hsn             TEXT,
        alter_id        INTEGER DEFAULT 0
      );

      -- Voucher ledger entries (AllLedgerEntries from AllVoucher.xml)
      -- amount: negative = Debit, positive = Credit (Tally sign convention from company perspective)
      CREATE TABLE IF NOT EXISTS voucher_ledger_entries (
        id           SERIAL PRIMARY KEY,
        voucher_guid TEXT NOT NULL,
        company_guid TEXT NOT NULL,
        ledger_name  TEXT,
        ledger_guid  TEXT,
        amount       DECIMAL(15,4) NOT NULL,  -- negative=Dr, positive=Cr
        dr_cr        TEXT,                    -- 'Dr' or 'Cr' (derived from amount sign)
        line_index   INTEGER DEFAULT 0,
        synced_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_vle_voucher ON voucher_ledger_entries(voucher_guid);
      CREATE INDEX IF NOT EXISTS idx_vle_company ON voucher_ledger_entries(company_guid);
      CREATE INDEX IF NOT EXISTS idx_vle_ledger  ON voucher_ledger_entries(ledger_name);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vle_unique') THEN
          ALTER TABLE voucher_ledger_entries ADD CONSTRAINT vle_unique UNIQUE (voucher_guid, company_guid, ledger_name, line_index);
        END IF;
      END $$;

      -- GST voucher details
      CREATE TABLE IF NOT EXISTS gst_voucher_details (
        id              SERIAL PRIMARY KEY,
        voucher_guid    TEXT NOT NULL,
        company_guid    TEXT NOT NULL,
        voucher_number  TEXT,
        voucher_type    TEXT,
        date            TEXT,
        party_name      TEXT,
        gst_reg_type    TEXT,
        place_of_supply TEXT,
        taxable_amount  DECIMAL(15,4) DEFAULT 0,
        cgst_amount     DECIMAL(15,4) DEFAULT 0,
        sgst_amount     DECIMAL(15,4) DEFAULT 0,
        igst_amount     DECIMAL(15,4) DEFAULT 0,
        irn             TEXT,
        alter_id        INTEGER DEFAULT 0,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE(voucher_guid, company_guid)
      );

      -- Bill-wise outstanding
      CREATE TABLE IF NOT EXISTS bill_outstanding (
        id              SERIAL PRIMARY KEY,
        voucher_guid    TEXT,
        company_guid    TEXT NOT NULL,
        ledger_name     TEXT,
        bill_name       TEXT,
        bill_date       TEXT,
        due_date        TEXT,
        amount          DECIMAL(15,4) DEFAULT 0,
        pending_amount  DECIMAL(15,4) DEFAULT 0,
        bill_type       TEXT,
        alter_id        INTEGER DEFAULT 0,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Write queue: every entry from app/web, tracks Tally push status
      CREATE TABLE IF NOT EXISTS write_queue (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id),
        company_guid    TEXT NOT NULL,
        entry_type      TEXT NOT NULL,  -- 'sales', 'purchase', 'payment', 'receipt', 'journal', 'contra', 'party', 'item', 'warehouse', 'sales_order', 'purchase_order', 'credit_note', 'debit_note', 'delivery_note'
        entry_label     TEXT,           -- human-readable: party name, voucher number, item name
        amount          DECIMAL(15,4),
        payload         JSONB,          -- full request payload for retry
        xml             TEXT,           -- generated XML for retry
        status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'sent', 'success', 'failed', 'desktop_offline'
        tally_voucher_number TEXT,
        tally_id        TEXT,
        error_message   TEXT,
        attempt_count   INTEGER DEFAULT 0,
        created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        source          TEXT DEFAULT 'web',  -- 'web', 'mobile'
        -- Phase C: outbox claim/lock (prevents duplicate desktop processing)
        locked_by_device_id TEXT,
        locked_at           BIGINT,
        lock_expires_at     BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_wq_company   ON write_queue(company_guid);
      CREATE INDEX IF NOT EXISTS idx_wq_user      ON write_queue(user_id);
      CREATE INDEX IF NOT EXISTS idx_wq_status    ON write_queue(status);
      CREATE INDEX IF NOT EXISTS idx_wq_created   ON write_queue(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wq_lock      ON write_queue(status, lock_expires_at) WHERE status IN ('desktop_offline','pending');

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_groups_company     ON groups(company_guid);
      CREATE INDEX IF NOT EXISTS idx_vii_voucher        ON voucher_inventory_items(voucher_guid);
      CREATE INDEX IF NOT EXISTS idx_vii_company        ON voucher_inventory_items(company_guid);
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'voucher_inventory_items_unique') THEN
          ALTER TABLE voucher_inventory_items ADD CONSTRAINT voucher_inventory_items_unique UNIQUE (voucher_guid, company_guid, stock_item_name, godown_name, batch_name);
        END IF;
      END $$;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_transactions_unique') THEN
          ALTER TABLE stock_transactions ADD CONSTRAINT stock_transactions_unique UNIQUE (stock_guid, company_guid, voucher_guid, warehouse, type);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_gst_company        ON gst_voucher_details(company_guid);
      CREATE INDEX IF NOT EXISTS idx_bill_company       ON bill_outstanding(company_guid);
      CREATE INDEX IF NOT EXISTS idx_bill_ledger        ON bill_outstanding(ledger_name);

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_ledgers_company   ON ledgers(company_guid);
      CREATE INDEX IF NOT EXISTS idx_vouchers_company  ON vouchers(company_guid);
      CREATE INDEX IF NOT EXISTS idx_vouchers_type     ON vouchers(voucher_type);
      CREATE INDEX IF NOT EXISTS idx_vouchers_date     ON vouchers(date);
      CREATE INDEX IF NOT EXISTS idx_stocks_company    ON stocks(company_guid);
      CREATE INDEX IF NOT EXISTS idx_companies_user    ON companies(user_id);

      -- Migrations for existing installs
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

      -- sync_log migrations (add new columns for existing installs)
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS user_id       INTEGER REFERENCES users(id);
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS synced_at     BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT;
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS mode          TEXT DEFAULT 'normal';
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS voucher_count INTEGER DEFAULT 0;
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS ledger_count  INTEGER DEFAULT 0;
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS stock_count   INTEGER DEFAULT 0;
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS record_count  INTEGER DEFAULT 0;
      ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS error_message TEXT;

      -- company_years migrations
      ALTER TABLE company_years ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT FALSE;

      -- companies migrations
      -- Authoritative Demo marker. Demo used to be inferred from the name
      -- starting with "demo" or a reserved GUID prefix, which meant a customer
      -- who named a real Tally company "Demo Traders" would have had it treated
      -- as sample data — hidden once Tally connected, and exempted from the
      -- guards that key off Demo. Visibility, mutation blocking, Desktop
      -- exclusion and billing bypass all read this column now.
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
      -- One-time backfill of rows created before the column existed. Matches the
      -- legacy generator's reserved GUID prefix only — deliberately NOT the name
      -- heuristic, so a real company called "Demo…" is never swept in.
      UPDATE companies SET is_demo = TRUE
       WHERE is_demo = FALSE AND guid LIKE 'dddddddd-dddd-4ddd-8ddd-%';
      CREATE INDEX IF NOT EXISTS idx_companies_is_demo ON companies (is_demo) WHERE is_demo = TRUE;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS device_id TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS synced_at BIGINT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS pincode TEXT;
      -- Print identity synced from Tally's Company collection (INCOMETAXNUMBER, EMAIL, PHONENUMBER…).
      -- The Tally invoice header prints all of these, so a preview without them cannot match.
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS pan TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS mobile TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS website TEXT;

      -- Print-only company details Tally keeps in its print config and never exports:
      -- jurisdiction line, declaration text, bank block. User-editable from Settings.
      CREATE TABLE IF NOT EXISTS company_print_profile (
        company_guid      TEXT PRIMARY KEY,
        gstin             TEXT,
        pan               TEXT,
        email             TEXT,
        phone             TEXT,
        jurisdiction      TEXT,
        declaration_text  TEXT,
        bank_name         TEXT,
        bank_account_no   TEXT,
        bank_ifsc         TEXT,
        bank_branch       TEXT,
        pdf_format        TEXT DEFAULT 'tally',
        pdf_format_overrides JSONB DEFAULT '{}'::jsonb,
        updated_at        TIMESTAMPTZ DEFAULT NOW()
      );

      -- ledgers migrations (columns referenced in routes but missing from schema)
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS mobile TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS nature TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS warehouse_name TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS alias TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS pan TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS phone TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS email TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS opening_balance NUMERIC(18,4) DEFAULT 0;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS alter_id BIGINT DEFAULT 0;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS pincode TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(8,4) DEFAULT 0;
      -- Written by ingestProcessor and read for Place of Supply / PARTYGSTIN, but
      -- never created here — a fresh database silently lost both.
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS state_name TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS gst_registration_type TEXT;
      -- Bank ledger master fields from Tally (BankAccountDetails / IFS Code, etc.)
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_account_no TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_ifsc TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_name TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_branch TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_holder TEXT;
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(18,2);
      -- App Bank Feeds account type (SAVING|CURRENT|OD|CC) — not a Tally Bank Accounts field
      ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS bank_account_type TEXT;

      -- vouchers migrations (E-Invoice / E-Way Bill columns)
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS irn TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS irn_date TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS irn_cancelled BOOLEAN DEFAULT FALSE;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS ewb_number TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS ewb_date TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS qr_code TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS signed_invoice TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS created_at BIGINT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS party_gstin TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS place_of_supply TEXT;

      -- V2 Migration: financial_year on transactional tables
      ALTER TABLE vouchers              ADD COLUMN IF NOT EXISTS financial_year TEXT;
      ALTER TABLE voucher_ledger_entries ADD COLUMN IF NOT EXISTS financial_year TEXT;
      ALTER TABLE stock_transactions    ADD COLUMN IF NOT EXISTS financial_year TEXT;
      ALTER TABLE stock_transactions    ADD COLUMN IF NOT EXISTS warehouse_guid TEXT;
      ALTER TABLE batch_allocations     ADD COLUMN IF NOT EXISTS godown_guid TEXT;
      ALTER TABLE voucher_inventory_items ADD COLUMN IF NOT EXISTS financial_year TEXT;
      ALTER TABLE gst_voucher_details   ADD COLUMN IF NOT EXISTS financial_year TEXT;

      -- V2: sync_runs table — atomic sync tracking
      CREATE TABLE IF NOT EXISTS sync_runs (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_guid  TEXT NOT NULL,
        sync_type     TEXT NOT NULL DEFAULT 'normal' CHECK (sync_type IN ('normal', 'hard')),
        status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
        record_counts JSONB,
        expected_counts JSONB,
        error_message TEXT,
        started_at    TIMESTAMPTZ DEFAULT NOW(),
        completed_at  TIMESTAMPTZ,
        upload_id     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sync_runs_company ON sync_runs(company_guid);
      CREATE INDEX IF NOT EXISTS idx_sync_runs_status  ON sync_runs(status);

      -- V2: ledger_fy_balances — per-FY opening balance from LedgerOpeningBalance.xml
      CREATE TABLE IF NOT EXISTS ledger_fy_balances (
        id             SERIAL PRIMARY KEY,
        ledger_guid    TEXT,
        ledger_name    TEXT NOT NULL,
        company_guid   TEXT NOT NULL,
        financial_year TEXT NOT NULL,
        opening_balance NUMERIC(18,4) DEFAULT 0,
        balance_type   TEXT DEFAULT 'Dr',
        synced_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_guid, ledger_name, financial_year)
      );
      CREATE INDEX IF NOT EXISTS idx_lfb_company ON ledger_fy_balances(company_guid);
      CREATE INDEX IF NOT EXISTS idx_lfb_ledger  ON ledger_fy_balances(company_guid, ledger_name);

      -- V2: e_invoice_details — dedicated e-invoice table
      CREATE TABLE IF NOT EXISTS e_invoice_details (
        id             SERIAL PRIMARY KEY,
        voucher_guid   TEXT NOT NULL,
        company_guid   TEXT NOT NULL,
        financial_year TEXT,
        irn            TEXT,
        ack_no         TEXT,
        ack_date       TEXT,
        signed_invoice TEXT,
        qr_code        TEXT,
        status         TEXT DEFAULT 'pending',
        error_message  TEXT,
        synced_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(voucher_guid, company_guid)
      );
      CREATE INDEX IF NOT EXISTS idx_einv_company ON e_invoice_details(company_guid);

      -- V2: e_way_bill_details — dedicated e-way bill table
      CREATE TABLE IF NOT EXISTS e_way_bill_details (
        id              SERIAL PRIMARY KEY,
        voucher_guid    TEXT NOT NULL,
        company_guid    TEXT NOT NULL,
        financial_year  TEXT,
        ewb_no          TEXT,
        ewb_date        TEXT,
        valid_till      TEXT,
        vehicle_no      TEXT,
        transporter_id  TEXT,
        status          TEXT DEFAULT 'pending',
        distance_km     INTEGER,
        supply_type     TEXT,
        sub_supply_type TEXT,
        error_message   TEXT,
        synced_at       TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(voucher_guid, company_guid)
      );
      CREATE INDEX IF NOT EXISTS idx_ewb_company ON e_way_bill_details(company_guid);

      -- V2: FY indexes for performance
      CREATE INDEX IF NOT EXISTS idx_vouchers_fy    ON vouchers(company_guid, financial_year);
      CREATE INDEX IF NOT EXISTS idx_vle_fy         ON voucher_ledger_entries(company_guid, financial_year);
      CREATE INDEX IF NOT EXISTS idx_st_fy          ON stock_transactions(company_guid, financial_year);
      CREATE INDEX IF NOT EXISTS idx_st_date         ON stock_transactions(company_guid, date);
      CREATE INDEX IF NOT EXISTS idx_st_stock        ON stock_transactions(company_guid, stock_guid);
      CREATE INDEX IF NOT EXISTS idx_st_voucher      ON stock_transactions(company_guid, voucher_guid);
      CREATE INDEX IF NOT EXISTS idx_st_warehouse    ON stock_transactions(company_guid, warehouse);

      -- CTO Spec: batch_allocations — batch/expiry tracking per voucher line item
      -- Populated from VoucherInventoryDetail.xml batch allocation data
      CREATE TABLE IF NOT EXISTS batch_allocations (
        id             SERIAL PRIMARY KEY,
        voucher_guid   TEXT NOT NULL,
        company_guid   TEXT NOT NULL,
        stock_item_name TEXT,
        stock_item_guid TEXT,
        batch_name     TEXT,
        expiry_date    TEXT,
        mfg_date       TEXT,
        qty            NUMERIC(15,4) DEFAULT 0,
        rate           NUMERIC(15,4) DEFAULT 0,
        godown_name    TEXT,
        financial_year TEXT,
        synced_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(voucher_guid, company_guid, stock_item_name, batch_name, godown_name)
      );
      CREATE INDEX IF NOT EXISTS idx_ba_company ON batch_allocations(company_guid);
      CREATE INDEX IF NOT EXISTS idx_ba_stock   ON batch_allocations(company_guid, stock_item_name);
      CREATE INDEX IF NOT EXISTS idx_ba_batch   ON batch_allocations(batch_name);
      CREATE INDEX IF NOT EXISTS idx_ba_fy      ON batch_allocations(company_guid, financial_year);

      -- CTO Spec: stock_categories — dedicated stock category master
      -- Populated from StockCategory.xml
      CREATE TABLE IF NOT EXISTS stock_categories (
        id           SERIAL PRIMARY KEY,
        guid         TEXT,
        company_guid TEXT NOT NULL,
        name         TEXT NOT NULL,
        parent       TEXT,
        alter_id     BIGINT DEFAULT 0,
        synced_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_guid, name)
      );
      CREATE INDEX IF NOT EXISTS idx_sc_company ON stock_categories(company_guid);

      -- V2: raw_tally_records — optional audit/debug table
      -- Stores raw record before processing. Useful for reprocessing without re-syncing Tally.
      -- Set TALLY_STORE_RAW=true env var to enable; disabled by default to save storage.
      CREATE TABLE IF NOT EXISTS raw_tally_records (
        id             BIGSERIAL PRIMARY KEY,
        upload_id      TEXT,
        sync_run_id    UUID,
        company_guid   TEXT,
        financial_year TEXT,
        record_type    TEXT,
        source_xml     TEXT,
        payload        JSONB,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_rtr_company ON raw_tally_records(company_guid);
      CREATE INDEX IF NOT EXISTS idx_rtr_type    ON raw_tally_records(record_type);
      CREATE INDEX IF NOT EXISTS idx_rtr_fy      ON raw_tally_records(company_guid, financial_year);

      -- Phone/Email OTP change columns
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_change_otp TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_change_otp_expires BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_change_new TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_otp TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_otp_expires BIGINT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS email_change_new TEXT;

      -- Language & Region settings (country, timezone, week_start)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS country      TEXT DEFAULT 'India';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone     TEXT DEFAULT 'UTC+05:30 · Asia/Kolkata';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS week_start   TEXT DEFAULT 'Monday';

      -- User settings columns (ensure they exist on fresh installs)
      ALTER TABLE users ADD COLUMN IF NOT EXISTS currency        TEXT DEFAULT 'INR';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS number_format   TEXT DEFAULT 'Indian';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS date_format     TEXT DEFAULT 'DD/MM/YYYY';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS theme           TEXT DEFAULT 'light';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kpi_autoscroll  BOOLEAN DEFAULT TRUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS decimal_places  INTEGER DEFAULT 2;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS voucher_config  JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_settings JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS alert_settings  JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS integration_settings JSONB;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_enabled  BOOLEAN DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS two_fa_pin_hash TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS biometric_enabled BOOLEAN DEFAULT FALSE;

      -- Reorder queue fields migration
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS minimum_order_qty DECIMAL(15,4) DEFAULT 0;

      -- Inventory master fields (sku = OnlyAlias/barcode, description = item notes)
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS sku              TEXT;
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS description       TEXT;
      -- Gap 4: Batch & expiry tracking flags from StockItem.xml (IsBatchWise / IsExpDtMaint)
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS batch_enabled     BOOLEAN DEFAULT FALSE;
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS expiry_enabled    BOOLEAN DEFAULT FALSE;
      -- GSTTYPEOFSUPPLY from StockItemFull.xml. Drives GSTOVRDNTYPEOFSUPPLY on
      -- invoice lines; without it every line posts to Tally as Goods.
      ALTER TABLE stocks ADD COLUMN IF NOT EXISTS type_of_supply    TEXT;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS reorder_level     DECIMAL(15,4) DEFAULT 0;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS minimum_order_qty DECIMAL(15,4) DEFAULT 0;

      -- Phase A+B+C: app_vouchers new columns (invoice_uuid, numbering_policy, tally_voucher_no)
      ALTER TABLE app_vouchers ADD COLUMN IF NOT EXISTS invoice_uuid     UUID DEFAULT gen_random_uuid() UNIQUE;
      ALTER TABLE app_vouchers ADD COLUMN IF NOT EXISTS numbering_policy TEXT NOT NULL DEFAULT 'tally_prime_series';
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_uuid ON app_vouchers(invoice_uuid);

      -- Invoice+Receipt split (2026-06-30): links a Receipt app_voucher to its parent Sales Invoice
      -- via Sales Invoice's invoice_uuid. NULL for all standalone vouchers (invoices, regular receipts).
      ALTER TABLE app_vouchers ADD COLUMN IF NOT EXISTS parent_invoice_uuid UUID;
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_parent ON app_vouchers(parent_invoice_uuid);

      -- Bill-wise allocation (Phase B+C, 2026-06-30): cached from Tally's BILLALLOCATIONS.LIST so
      -- the reconciler can match Receipts (where Tally drops top-level <REFERENCE>) by Agst Ref linkage.
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_optional           BOOLEAN DEFAULT FALSE;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bill_ref_name         TEXT;
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bill_type             TEXT;  -- 'New Ref' | 'Agst Ref' | 'On Account' | 'Advance'
      ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS bill_allocated_amount DECIMAL(15,4);
      CREATE INDEX IF NOT EXISTS idx_vouchers_bill_ref
        ON vouchers(company_guid, bill_type, bill_ref_name);

      -- Phase C: write_queue claim/lock columns
      ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS locked_by_device_id TEXT;
      ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS locked_at           BIGINT;
      ALTER TABLE write_queue ADD COLUMN IF NOT EXISTS lock_expires_at     BIGINT;

      -- stock_fy_valuation — FY-specific opening/closing stock VALUES direct from Tally
      -- Source: StockValuation.xml (per FY, uses Tally's internal costing: FIFO/avg)
      -- This is the source of truth for P&L Opening Stock and Closing Stock
      CREATE TABLE IF NOT EXISTS stock_fy_valuation (
        id             BIGSERIAL PRIMARY KEY,
        company_guid   TEXT NOT NULL,
        financial_year TEXT NOT NULL,
        stock_name     TEXT NOT NULL,
        stock_guid     TEXT,
        opening_qty    NUMERIC(15,4) DEFAULT 0,
        opening_rate   NUMERIC(15,4) DEFAULT 0,
        opening_value  NUMERIC(15,4) DEFAULT 0,
        closing_qty    NUMERIC(15,4) DEFAULT 0,
        closing_rate   NUMERIC(15,4) DEFAULT 0,
        closing_value  NUMERIC(15,4) DEFAULT 0,
        synced_at      BIGINT,
        UNIQUE(company_guid, financial_year, stock_name)
      );
      CREATE INDEX IF NOT EXISTS idx_sfv_company_fy ON stock_fy_valuation(company_guid, financial_year);

      -- Push tokens — Expo push notification tokens per user device
      CREATE TABLE IF NOT EXISTS push_tokens (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT NOT NULL,
        platform   TEXT,                          -- 'ios' | 'android'
        device_id  TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, token)
      );
      CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON push_tokens(user_id);

      -- Stock Adjustments audit trail (Stock Edit → Adjustment flow)
      CREATE TABLE IF NOT EXISTS stock_adjustments (
        id                   SERIAL PRIMARY KEY,
        company_guid         TEXT NOT NULL,
        user_id              INTEGER REFERENCES users(id),
        stock_guid           TEXT NOT NULL,
        stock_name           TEXT,
        warehouse            TEXT,
        adjustment_reason    TEXT NOT NULL,
        adjustment_direction TEXT,
        qty_before           NUMERIC(15,4),
        adjustment_qty       NUMERIC(15,4) NOT NULL,
        qty_change           NUMERIC(15,4) NOT NULL,
        qty_after            NUMERIC(15,4),
        note                 TEXT,
        status               TEXT NOT NULL DEFAULT 'PENDING',
        write_queue_id       INTEGER REFERENCES write_queue(id),
        tally_voucher_number TEXT,
        created_at           BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at           BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_sa_company ON stock_adjustments(company_guid);
      CREATE INDEX IF NOT EXISTS idx_sa_stock   ON stock_adjustments(stock_guid);
      CREATE INDEX IF NOT EXISTS idx_sa_status  ON stock_adjustments(status);

      -- Company Inventory Settings (TallyDekho-only config per company)
      CREATE TABLE IF NOT EXISTS company_inventory_settings (
        id                              SERIAL PRIMARY KEY,
        company_guid                    TEXT NOT NULL UNIQUE,
        -- General
        product_display_field           TEXT DEFAULT 'auto',
        default_unit_for_new_items      TEXT,
        purchase_buffer_days            INTEGER DEFAULT 7,
        reorder_calc_mode               TEXT DEFAULT 'hybrid',
        low_stock_threshold_mode        TEXT DEFAULT 'reorder_level',
        archive_old_stock_months        INTEGER DEFAULT 24,
        -- Warehouses (per-warehouse maps keyed by warehouse guid)
        warehouse_code_map              JSONB DEFAULT '{}',
        cycle_count_frequency_map       JSONB DEFAULT '{}',
        archive_stock_layers_map        JSONB DEFAULT '{}',
        -- Items
        default_low_stock_level         INTEGER DEFAULT 20,
        inventory_aging_rules           JSONB DEFAULT '{"buckets":["0-30","31-60","61-90","90+"]}',
        fast_moving_top_pct             INTEGER DEFAULT 20,
        slow_moving_no_movement_days    INTEGER DEFAULT 90,
        dead_stock_no_movement_days     INTEGER DEFAULT 180,
        movement_analysis_period_days   INTEGER DEFAULT 90,
        -- Alerts
        low_stock_alerts                JSONB DEFAULT '{"inApp":true,"email":false,"whatsapp":false}',
        negative_stock_alerts           JSONB DEFAULT '{"inApp":true,"email":true,"whatsapp":false}',
        expiry_alerts                   JSONB DEFAULT '{"inApp":true,"email":false,"whatsapp":false,"daysBefore":30}',
        fast_slow_moving_alerts         JSONB DEFAULT '{"inApp":false,"email":false,"whatsapp":false}',
        -- Timestamps
        created_at                      TIMESTAMPTZ DEFAULT NOW(),
        updated_at                      TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_inv_settings_company ON company_inventory_settings(company_guid);

      -- App-level intent for Tally-controlled settings (saved as user preference, not written to Tally automatically)
      ALTER TABLE company_inventory_settings ADD COLUMN IF NOT EXISTS batch_tracking_app_enabled   BOOLEAN DEFAULT FALSE;
      ALTER TABLE company_inventory_settings ADD COLUMN IF NOT EXISTS expiry_tracking_app_enabled  BOOLEAN DEFAULT FALSE;
      ALTER TABLE company_inventory_settings ADD COLUMN IF NOT EXISTS allow_negative_stock_app     BOOLEAN DEFAULT FALSE;

      -- ── Barcode Module ────────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS stock_barcodes (
        id               SERIAL PRIMARY KEY,
        company_guid     TEXT NOT NULL,
        stock_guid       TEXT,
        stock_name       TEXT,
        barcode          TEXT NOT NULL,
        barcode_type     TEXT DEFAULT 'CODE128',
        source           TEXT DEFAULT 'manual',
        status           TEXT DEFAULT 'active',
        is_primary       BOOLEAN DEFAULT TRUE,
        sync_target      TEXT DEFAULT 'app_only',
        tally_sync_status TEXT DEFAULT 'not_required',
        synced_to_tally_at TIMESTAMPTZ,
        duplicate_of     INTEGER,
        validation_error TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_barcodes_company_barcode ON stock_barcodes(company_guid, barcode);
      CREATE INDEX IF NOT EXISTS idx_stock_barcodes_company_stock  ON stock_barcodes(company_guid, stock_guid);
      CREATE INDEX IF NOT EXISTS idx_stock_barcodes_status         ON stock_barcodes(company_guid, status);
      CREATE INDEX IF NOT EXISTS idx_stock_barcodes_sync           ON stock_barcodes(company_guid, tally_sync_status);

      CREATE TABLE IF NOT EXISTS barcode_import_jobs (
        id               TEXT PRIMARY KEY,
        company_guid     TEXT NOT NULL,
        file_name        TEXT,
        status           TEXT DEFAULT 'pending',
        total_rows       INTEGER DEFAULT 0,
        imported_rows    INTEGER DEFAULT 0,
        duplicate_rows   INTEGER DEFAULT 0,
        invalid_rows     INTEGER DEFAULT 0,
        needs_review_rows INTEGER DEFAULT 0,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        completed_at     TIMESTAMPTZ
      );

      CREATE TABLE IF NOT EXISTS barcode_generate_jobs (
        id               TEXT PRIMARY KEY,
        company_guid     TEXT NOT NULL,
        status           TEXT DEFAULT 'pending',
        total            INTEGER DEFAULT 0,
        processed        INTEGER DEFAULT 0,
        generated        INTEGER DEFAULT 0,
        errors           INTEGER DEFAULT 0,
        barcode_type     TEXT DEFAULT 'CODE128',
        sync_target      TEXT DEFAULT 'app_only',
        filters_json     TEXT,
        target_guids     JSONB,
        error_message    TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        completed_at     TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_barcode_gen_jobs_company ON barcode_generate_jobs(company_guid, status);

      CREATE TABLE IF NOT EXISTS barcode_import_errors (
        id               SERIAL PRIMARY KEY,
        job_id           TEXT NOT NULL,
        row_number       INTEGER,
        item_identifier  TEXT,
        barcode          TEXT,
        error_type       TEXT,
        error_message    TEXT,
        raw_data         TEXT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS inventory_barcode_settings (
        company_guid          TEXT PRIMARY KEY,
        barcode_storage_mode  TEXT DEFAULT 'app_only',
        default_barcode_type  TEXT DEFAULT 'CODE128',
        auto_sync_to_tally    BOOLEAN DEFAULT FALSE,
        created_at            TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      );

      -- ── TDK Reference Counters ────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS tdk_reference_counters (
        company_guid    TEXT NOT NULL,
        voucher_prefix  TEXT NOT NULL,   -- 'SAL', 'OPT-SAL', 'SO', 'PUR', etc.
        fiscal_year     INT NOT NULL,    -- e.g. 2026
        last_seq        INT NOT NULL DEFAULT 0,
        PRIMARY KEY (company_guid, voucher_prefix, fiscal_year)
      );

      -- ── App Vouchers (TallyDekho lifecycle tracking) ──────────────────────
      CREATE TABLE IF NOT EXISTS app_vouchers (
        id                      SERIAL PRIMARY KEY,
        company_guid            TEXT NOT NULL,
        user_id                 INTEGER REFERENCES users(id),
        write_queue_id          INTEGER REFERENCES write_queue(id),
        voucher_type            TEXT NOT NULL,            -- 'sales_invoice', 'sales_order', etc.
        tdk_reference_no        TEXT NOT NULL UNIQUE,     -- TDK-SAL-2026-0042
        tally_voucher_no        TEXT,                     -- set after Tally sync
        tally_guid              TEXT,
        original_entry_type     TEXT NOT NULL DEFAULT 'regular',   -- 'regular' | 'optional'
        current_entry_type      TEXT NOT NULL DEFAULT 'regular',   -- 'regular' | 'optional'
        numbering_policy        TEXT NOT NULL DEFAULT 'tally_prime_series', -- 'tally_prime_series' | 'tallydekho_series'
        tally_sync_status       TEXT NOT NULL DEFAULT 'queued',    -- 'queued' | 'pushed' | 'synced' | 'failed'
        books_impact_status     TEXT NOT NULL DEFAULT 'not_posted', -- 'not_posted' | 'posted'
        conversion_status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'converted' | 'cancelled'
        e_invoice_status        TEXT NOT NULL DEFAULT 'not_applicable',
        e_way_bill_status       TEXT NOT NULL DEFAULT 'not_required',
        party_name              TEXT,
        total_amount            DECIMAL(15,4),
        voucher_date            DATE,
        payload                 JSONB,
        sync_error              TEXT,
        invoice_uuid            UUID DEFAULT gen_random_uuid() UNIQUE,
        parent_invoice_uuid     UUID,  -- Receipt → Sales Invoice link (Invoice+Receipt split, 2026-06-30)
        created_at              BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at              BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_company ON app_vouchers(company_guid);
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_tdk     ON app_vouchers(tdk_reference_no);
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_wqid    ON app_vouchers(write_queue_id);
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_uuid    ON app_vouchers(invoice_uuid);
      CREATE INDEX IF NOT EXISTS idx_app_vouchers_parent  ON app_vouchers(parent_invoice_uuid);

      -- ── Invoice PDF Versions (Phase C) ──────────────────────────────────────
      CREATE TABLE IF NOT EXISTS invoice_pdf_versions (
        id                  BIGSERIAL PRIMARY KEY,
        tdk_reference_no    TEXT NOT NULL,
        invoice_uuid        UUID,
        company_guid        TEXT NOT NULL,
        user_id             INTEGER REFERENCES users(id),
        version_no          INTEGER NOT NULL DEFAULT 1,
        pdf_type            TEXT NOT NULL DEFAULT 'provisional', -- draft|provisional|final|einvoice|ewaybill
        posting_tag         TEXT NOT NULL DEFAULT 'Not Posted',
        invoice_number      TEXT,
        invoice_number_label TEXT NOT NULL DEFAULT 'Pending from TallyPrime',
        watermark           TEXT,
        file_name           TEXT,
        generated_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE (tdk_reference_no, version_no)
      );
      CREATE INDEX IF NOT EXISTS idx_pdf_ver_tdk     ON invoice_pdf_versions(tdk_reference_no);
      CREATE INDEX IF NOT EXISTS idx_pdf_ver_company ON invoice_pdf_versions(company_guid);

      -- ── Geo masters (Tally country / state-emirate-province list) ───────────
      -- Seeded from data/geo_tally_states.json (TCSDV3 export). Spellings must
      -- match Tally exactly for LEDSTATENAME / COUNTRYOFRESIDENCE.
      CREATE TABLE IF NOT EXISTS geo_countries (
        name            TEXT PRIMARY KEY,
        referred_as     TEXT,
        division_label  TEXT NOT NULL DEFAULT 'State',
        created_at      BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE TABLE IF NOT EXISTS geo_states (
        country_name    TEXT NOT NULL REFERENCES geo_countries(name) ON DELETE CASCADE,
        state_name      TEXT NOT NULL,
        PRIMARY KEY (country_name, state_name)
      );
      CREATE INDEX IF NOT EXISTS idx_geo_states_country ON geo_states(country_name);

      -- ── Company Compliance Config (E-Invoice, E-Way Bill, Numbering Policy) ──
      CREATE TABLE IF NOT EXISTS company_compliance_config (
        company_guid            TEXT PRIMARY KEY REFERENCES companies(guid) ON DELETE CASCADE,
        numbering_policy        TEXT NOT NULL DEFAULT 'tally_prime_series',
        -- per-voucher-type overrides: JSON like {"sales_invoice":"tallydekho_series","receipt":"tally_prime_series"}
        numbering_overrides     JSONB DEFAULT '{}',
        e_invoice_applicable    TEXT NOT NULL DEFAULT 'not_applicable',
        -- 'not_applicable' | 'applicable_not_configured' | 'applicable_configured'
        e_invoice_mode          TEXT NOT NULL DEFAULT 'manual',
        -- 'manual' | 'auto'
        e_way_bill_applicable   TEXT NOT NULL DEFAULT 'not_applicable',
        e_way_bill_mode         TEXT NOT NULL DEFAULT 'manual',
        -- 'manual' | 'auto' | 'ask_after_irn'
        updated_at              BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );

      -- Per-line tax geometry for Credit Note reversal (common GST ledger / VAT / packing).
      -- Written at Sales create from app payload; read by creditNoteContext.
      CREATE TABLE IF NOT EXISTS voucher_line_taxes (
        id                BIGSERIAL PRIMARY KEY,
        company_guid      TEXT NOT NULL,
        tdk_reference_no  TEXT,
        voucher_guid      TEXT,
        stock_item_name   TEXT,
        line_index        INT NOT NULL DEFAULT 0,
        ledger_name       TEXT NOT NULL,
        tax_rate          DECIMAL(15,4) DEFAULT 0,
        tax_amount        DECIMAL(15,4) DEFAULT 0,
        taxable_value     DECIMAL(15,4) DEFAULT 0,
        source            TEXT NOT NULL DEFAULT 'item',
        created_at        BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_vlt_company_tdk
        ON voucher_line_taxes(company_guid, tdk_reference_no);
      CREATE INDEX IF NOT EXISTS idx_vlt_company_voucher
        ON voucher_line_taxes(company_guid, voucher_guid);
      ALTER TABLE voucher_inventory_items ADD COLUMN IF NOT EXISTS tax_rate DECIMAL(15,4);

      -- ── App Masters (ledger / bank / warehouse / stock lifecycle) ───────────
      -- Posted only after ingest confirms the master in the synced table
      -- (unlike vouchers, which mark posted on successful Tally write).
      CREATE TABLE IF NOT EXISTS app_masters (
        id                      SERIAL PRIMARY KEY,
        company_guid            TEXT NOT NULL,
        user_id                 INTEGER REFERENCES users(id),
        write_queue_id          INTEGER REFERENCES write_queue(id) UNIQUE,
        master_type             TEXT NOT NULL,  -- party | bank | warehouse | item | alter_stock_item
        master_name             TEXT NOT NULL,
        tally_guid              TEXT,
        tally_sync_status       TEXT NOT NULL DEFAULT 'queued',    -- queued | pushed | synced | failed
        books_impact_status     TEXT NOT NULL DEFAULT 'not_posted', -- not_posted | posted
        payload                 JSONB,
        sync_error              TEXT,
        created_at              BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        updated_at              BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
      );
      CREATE INDEX IF NOT EXISTS idx_app_masters_company ON app_masters(company_guid);
      CREATE INDEX IF NOT EXISTS idx_app_masters_wqid    ON app_masters(write_queue_id);
      CREATE INDEX IF NOT EXISTS idx_app_masters_name
        ON app_masters(company_guid, LOWER(master_name));
      CREATE INDEX IF NOT EXISTS idx_app_masters_posted
        ON app_masters(company_guid, books_impact_status);

      -- KPI AR/AP daily snapshots for MoM / prior-window trend pills (Phase 3)
      CREATE TABLE IF NOT EXISTS kpi_ar_ap_snapshots (
        id            SERIAL PRIMARY KEY,
        company_guid  TEXT NOT NULL,
        side          TEXT NOT NULL,
        as_of         DATE NOT NULL,
        total         DECIMAL(18,2) NOT NULL DEFAULT 0,
        aging         JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE (company_guid, side, as_of)
      );
      CREATE INDEX IF NOT EXISTS idx_kpi_ar_ap_snap_lookup
        ON kpi_ar_ap_snapshots(company_guid, side, as_of DESC);

      -- KPI Loans & ODs daily snapshots for trend pills (Phase 4)
      CREATE TABLE IF NOT EXISTS kpi_loans_snapshots (
        id            SERIAL PRIMARY KEY,
        company_guid  TEXT NOT NULL,
        as_of         DATE NOT NULL,
        total         DECIMAL(18,2) NOT NULL DEFAULT 0,
        loan_total    DECIMAL(18,2) NOT NULL DEFAULT 0,
        od_total      DECIMAL(18,2) NOT NULL DEFAULT 0,
        created_at    BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
        UNIQUE (company_guid, as_of)
      );
      CREATE INDEX IF NOT EXISTS idx_kpi_loans_snap_lookup
        ON kpi_loans_snapshots(company_guid, as_of DESC);
    `);

    await applyWorkspaceSchema(client);
    if (process.env.SKIP_WORKSPACE_BACKFILL === '1') {
      console.log('⏭️  workspace bootstrap/backfill skipped (SKIP_WORKSPACE_BACKFILL=1)');
    } else {
      try {
        const { backfillPersonalWorkspaces } = await import('../services/workspaceService.js');
        await backfillPersonalWorkspaces();
        console.log('✅ workspace bootstrap/backfill complete');
      } catch (e) {
        console.warn('[workspace] backfill skipped:', e.message);
      }
    }

    // Backfill historical master writes into app_masters + mark posted when synced.
    try {
      const { backfillAppMasters } = await import('../utils/appMasters.js');
      await backfillAppMasters(client);
      console.log('✅ app_masters backfill complete');
    } catch (e) {
      console.warn('[app_masters] backfill skipped:', e.message);
    }

    // Data repair: thin SimplifiedVoucher syncs used to overwrite every
    // voucher_type_parent with the 'Voucher' placeholder, emptying the GST
    // classification and breaking the Credit Note Sales-invoice guard.
    // Idempotent — a no-op once the table is clean.
    const repaired = await client.query(REPAIR_VOUCHER_TYPE_PARENT_SQL, [null]);
    if (repaired.rowCount) console.log(`🔧 voucher_type_parent repaired for ${repaired.rowCount} rows`);

    // ── Company Identity Phase 2 (additive) ──────────────────────────────
    // Keep UNIQUE(guid). Add nullable company_id on internal child tables.
    // Do NOT add company_id to workspace_tally_lineage_companies (external tally identity).
    await client.query(`CREATE INDEX IF NOT EXISTS idx_companies_workspace ON companies (workspace_id)`);
    const companyIdChildTables = [
      'ai_insights_cache', 'app_masters', 'app_vouchers', 'barcode_generate_jobs', 'barcode_import_jobs',
      'batch_allocations', 'bill_outstanding', 'company_compliance_config', 'company_inventory_settings',
      'company_print_profile', 'company_years', 'cost_centres', 'currencies', 'e_invoice_details',
      'e_way_bill_details', 'financial_year_summaries', 'groups', 'gst_voucher_details', 'ingest_uploads',
      'integrations', 'inventory_barcode_settings', 'invoice_pdf_versions', 'kpi_ar_ap_snapshots',
      'kpi_loans_snapshots', 'ledger_fy_balances', 'ledgers', 'member_company_access',
      'payment_mode_posting_map', 'raw_tally_records', 'stock_adjustments', 'stock_barcodes',
      'stock_categories', 'stock_fy_valuation', 'stock_transactions', 'stocks', 'sync_log', 'sync_runs',
      'tally_country_master', 'tally_state_master', 'tax_transactions', 'tdk_reference_counters',
      'units', 'voucher_inventory_items', 'voucher_items', 'voucher_ledger_entries', 'voucher_line_taxes',
      'voucher_types', 'vouchers', 'warehouses', 'write_queue',
    ];
    for (const table of companyIdChildTables) {
      await client.query(
        `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS company_id BIGINT`
      ).catch((e) => {
        // Table may not exist on partial schemas
        if (e.code !== '42P01') console.warn(`[CID2] company_id on ${table}:`, e.message);
      });
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_${table}_company_id ON ${table} (company_id)`
      ).catch(() => {});
    }
    console.log('✅ Company Identity Phase 2 additive company_id columns ensured');

    // ── Company Identity Phase 3C (local integrity) ──────────────────────
    // workspace_id NOT NULL + FK RESTRICT (no CASCADE destroy of financial data).
    // Only apply NOT NULL when zero nulls remain.
    const nullWs = await client.query(
      `SELECT COUNT(*)::int AS c FROM companies WHERE workspace_id IS NULL`
    );
    if (nullWs.rows[0]?.c === 0) {
      await client.query(
        `ALTER TABLE companies ALTER COLUMN workspace_id SET NOT NULL`
      ).catch((e) => console.warn('[CID3C] workspace_id NOT NULL:', e.message));
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE companies
            ADD CONSTRAINT companies_workspace_id_fkey
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
            ON DELETE RESTRICT;
        EXCEPTION
          WHEN duplicate_object THEN NULL;
          WHEN undefined_table THEN NULL;
        END $$;
      `).catch((e) => console.warn('[CID3C] workspace FK:', e.message));
      console.log('✅ companies.workspace_id NOT NULL + FK RESTRICT');
    } else {
      console.warn(`[CID3C] skip workspace NOT NULL — ${nullWs.rows[0].c} NULL rows remain`);
    }

    // MCA: unique (membership_id, company_id) for company_id-authoritative scopes.
    // Retain legacy PK (membership_id, company_guid) until production drop.
    await client.query(`
      DO $$ BEGIN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_mca_membership_company_id
          ON member_company_access (membership_id, company_id)
          WHERE company_id IS NOT NULL;
      EXCEPTION WHEN undefined_table THEN NULL;
      END $$;
    `).catch((e) => console.warn('[CID3C] MCA unique:', e.message));
    console.log('✅ MCA (membership_id, company_id) unique index ensured (drop-ready for legacy PK)');

    if (cidDestructiveMigrationsAllowed()) {
      await applyCidConstraintCutover(client);
    } else {
      console.warn(
        '[CID] destructive Company Identity constraint cutover SKIPPED on boot ' +
          '(NODE_ENV=production without CID_ALLOW_DESTRUCTIVE_MIGRATION=1). ' +
          'Run it as a supervised step: scripts/cid-guid-unique-cutover.mjs — see ' +
          'COMPANY_IDENTITY_PRODUCTION_CUTOVER.md'
      );
    }

    console.log('✅ PostgreSQL schema initialized');
  } finally {
    // The client goes back to a shared pool, so the role change must not.
    if (adoptedRole) await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}

/**
 * Company Identity constraint cutover (Phase 3D + 3E).
 *
 * DESTRUCTIVE: swaps PKs/UNIQUEs to company_id, sets NOT NULL, adds FKs,
 * drops `member_company_access.company_guid`, deletes rows that never acquired
 * an internal owner, and replaces global UNIQUE(companies.guid) with
 * UNIQUE(workspace_id, guid).
 *
 * Runs automatically outside production so local/CI databases converge with the
 * code. In production it must be an operator-supervised step with a verified
 * backup — never an implicit side effect of a deploy/restart.
 */
async function applyCidConstraintCutover(client) {
    // ── Company Identity Phase 3D (local constraint cutover) ─────────────
    // Order: NOT NULL → full UNIQUE(company_id,…) → drop GUID ownership uniques.
    // Partial unique indexes cannot back ON CONFLICT — use full constraints.
    const notNullTables = [
      'ledgers', 'vouchers', 'stocks', 'groups', 'warehouses', 'units', 'voucher_types',
      'voucher_ledger_entries', 'voucher_inventory_items', 'stock_transactions',
      'bill_outstanding', 'gst_voucher_details', 'ledger_fy_balances',
      'stock_barcodes', 'stock_categories', 'stock_fy_valuation', 'cost_centres',
    ];
    for (const table of notNullTables) {
      try {
        const { rows } = await client.query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE company_id IS NULL`
        );
        if (rows[0]?.c === 0) {
          await client.query(`ALTER TABLE ${table} ALTER COLUMN company_id SET NOT NULL`);
          await client.query(`
            DO $$ BEGIN
              ALTER TABLE ${table}
                ADD CONSTRAINT ${table}_company_id_fkey
                FOREIGN KEY (company_id) REFERENCES companies(id)
                ON DELETE RESTRICT;
            EXCEPTION WHEN duplicate_object THEN NULL;
                       WHEN undefined_table THEN NULL;
            END $$;
          `);
        } else {
          console.warn(`[CID3D] skip NOT NULL ${table}: ${rows[0].c} null company_id`);
        }
      } catch (e) {
        if (e.code !== '42P01') console.warn(`[CID3D] NOT NULL ${table}:`, e.message);
      }
    }

    // Drop prior partial unique indexes from earlier 3D attempts (cannot use ON CONFLICT)
    for (const idx of [
      'uq_ledgers_company_id_guid', 'uq_vouchers_company_id_guid', 'uq_stocks_company_id_guid',
      'uq_groups_company_id_guid', 'uq_warehouses_company_id_name', 'uq_units_company_id_name',
      'uq_voucher_types_company_id_name', 'uq_stock_categories_company_id_name',
      'uq_stock_barcodes_company_id_barcode', 'uq_lfb_company_id_name_fy',
      'uq_sfv_company_id_fy_name', 'uq_gvd_company_id_voucher', 'uq_cost_centres_company_id_guid',
      'uq_stock_tx_company_id_compound', 'uq_vii_company_id_compound',
      'uq_print_profile_company_id', 'uq_inventory_settings_company_id',
      'uq_compliance_config_company_id', 'uq_barcode_settings_company_id',
      'uq_ai_insights_company_id_month', 'uq_fy_summaries_company_id_fy',
      'uq_kpi_ar_ap_company_id', 'uq_kpi_loans_company_id',
    ]) {
      await client.query(`DROP INDEX IF EXISTS ${idx}`).catch(() => {});
    }

    const cidUniqueConstraints = [
      ['ledgers', 'uq_ledgers_company_id_guid', '(company_id, guid)'],
      ['vouchers', 'uq_vouchers_company_id_guid', '(company_id, guid)'],
      ['stocks', 'uq_stocks_company_id_guid', '(company_id, guid)'],
      ['groups', 'uq_groups_company_id_guid', '(company_id, guid)'],
      ['warehouses', 'uq_warehouses_company_id_name', '(company_id, name)'],
      ['units', 'uq_units_company_id_name', '(company_id, name)'],
      ['voucher_types', 'uq_voucher_types_company_id_name', '(company_id, name)'],
      ['stock_categories', 'uq_stock_categories_company_id_name', '(company_id, name)'],
      ['stock_barcodes', 'uq_stock_barcodes_company_id_barcode', '(company_id, barcode)'],
      ['ledger_fy_balances', 'uq_lfb_company_id_name_fy', '(company_id, ledger_name, financial_year)'],
      ['stock_fy_valuation', 'uq_sfv_company_id_fy_name', '(company_id, financial_year, stock_name)'],
      ['gst_voucher_details', 'uq_gvd_company_id_voucher', '(company_id, voucher_guid)'],
      ['cost_centres', 'uq_cost_centres_company_id_guid', '(company_id, guid)'],
      ['stock_transactions', 'uq_stock_tx_company_id_compound', '(company_id, stock_guid, voucher_guid, warehouse, type)'],
      ['voucher_inventory_items', 'uq_vii_company_id_compound', '(company_id, voucher_guid, stock_item_name, godown_name, batch_name)'],
      ['batch_allocations', 'uq_ba_company_id_compound', '(company_id, voucher_guid, stock_item_name, batch_name, godown_name)'],
    ];
    for (const [table, cname, cols] of cidUniqueConstraints) {
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE ${table} ADD CONSTRAINT ${cname} UNIQUE ${cols};
        EXCEPTION WHEN duplicate_object THEN NULL;
                   WHEN undefined_table THEN NULL;
                   WHEN unique_violation THEN NULL;
        END $$;
      `).catch((e) => console.warn(`[CID3D] unique ${cname}:`, e.message));
    }

    await client.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT c.conname, n.nspname, t.relname
          FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE c.contype IN ('u','p')
            AND n.nspname = current_schema()
            AND t.relname IN (
              'ledgers','vouchers','stocks','groups','warehouses','units','voucher_types',
              'stock_categories','stock_barcodes','ledger_fy_balances','stock_fy_valuation',
              'gst_voucher_details','cost_centres','stock_transactions','voucher_inventory_items',
              'voucher_ledger_entries','batch_allocations','e_invoice_details','e_way_bill_details'
            )
            AND pg_get_constraintdef(c.oid) ILIKE '%company_guid%'
            AND pg_get_constraintdef(c.oid) NOT ILIKE '%company_id%'
        LOOP
          EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT IF EXISTS %I', r.nspname, r.relname, r.conname);
        END LOOP;
      END $$;
    `).catch((e) => console.warn('[CID3D] drop legacy guid uniques:', e.message));

    for (const [table, cname, cols] of [
      ['company_print_profile', 'uq_print_profile_company_id', '(company_id)'],
      ['company_inventory_settings', 'uq_inventory_settings_company_id', '(company_id)'],
      ['company_compliance_config', 'uq_compliance_config_company_id', '(company_id)'],
      ['inventory_barcode_settings', 'uq_barcode_settings_company_id', '(company_id)'],
      ['ai_insights_cache', 'uq_ai_insights_company_id_month', '(company_id, month_key)'],
      ['financial_year_summaries', 'uq_fy_summaries_company_id_fy', '(company_id, financial_year)'],
      ['kpi_ar_ap_snapshots', 'uq_kpi_ar_ap_company_id', '(company_id, side, as_of)'],
      ['kpi_loans_snapshots', 'uq_kpi_loans_company_id', '(company_id, as_of)'],
      ['company_years', 'uq_company_years_company_id_fy', '(company_id, fin_year)'],
    ]) {
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE ${table} ADD CONSTRAINT ${cname} UNIQUE ${cols};
        EXCEPTION WHEN duplicate_object THEN NULL;
                   WHEN undefined_table THEN NULL;
                   WHEN unique_violation THEN NULL;
                   WHEN not_null_violation THEN NULL;
        END $$;
      `).catch(() => {});
    }

    // Config / counter PKs → company_id (local). GUID column retained as Tally external snapshot.
    await client.query(`
      DO $$
      BEGIN
        -- print profile
        BEGIN
          ALTER TABLE company_print_profile DROP CONSTRAINT IF EXISTS company_print_profile_pkey;
          ALTER TABLE company_print_profile ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE company_print_profile ADD CONSTRAINT company_print_profile_pkey PRIMARY KEY (company_id);
        EXCEPTION WHEN others THEN NULL;
        END;
        -- compliance
        BEGIN
          ALTER TABLE company_compliance_config DROP CONSTRAINT IF EXISTS company_compliance_config_pkey;
          ALTER TABLE company_compliance_config ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE company_compliance_config ADD CONSTRAINT company_compliance_config_pkey PRIMARY KEY (company_id);
        EXCEPTION WHEN others THEN NULL;
        END;
        -- barcode settings
        BEGIN
          ALTER TABLE inventory_barcode_settings DROP CONSTRAINT IF EXISTS inventory_barcode_settings_pkey;
          ALTER TABLE inventory_barcode_settings ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE inventory_barcode_settings ADD CONSTRAINT inventory_barcode_settings_pkey PRIMARY KEY (company_id);
        EXCEPTION WHEN others THEN NULL;
        END;
        -- TDK counters
        BEGIN
          UPDATE tdk_reference_counters t SET company_id = c.id
            FROM companies c WHERE t.company_id IS NULL AND c.guid = t.company_guid;
          DELETE FROM tdk_reference_counters WHERE company_id IS NULL;
          ALTER TABLE tdk_reference_counters ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE tdk_reference_counters DROP CONSTRAINT IF EXISTS tdk_reference_counters_pkey;
          ALTER TABLE tdk_reference_counters ADD CONSTRAINT tdk_reference_counters_pkey
            PRIMARY KEY (company_id, voucher_prefix, fiscal_year);
        EXCEPTION WHEN others THEN NULL;
        END;
        -- drop legacy GUID uniques superseded by company_id
        ALTER TABLE company_years DROP CONSTRAINT IF EXISTS company_years_company_guid_fin_year_key;
        ALTER TABLE ai_insights_cache DROP CONSTRAINT IF EXISTS ai_insights_cache_company_guid_month_key_key;
        ALTER TABLE financial_year_summaries DROP CONSTRAINT IF EXISTS financial_year_summaries_company_guid_financial_year_key;
        ALTER TABLE kpi_ar_ap_snapshots DROP CONSTRAINT IF EXISTS kpi_ar_ap_snapshots_company_guid_side_as_of_key;
        ALTER TABLE kpi_loans_snapshots DROP CONSTRAINT IF EXISTS kpi_loans_snapshots_company_guid_as_of_key;
        ALTER TABLE company_inventory_settings DROP CONSTRAINT IF EXISTS company_inventory_settings_company_guid_key;
      END $$;
    `).catch((e) => console.warn('[CID3D] config PK cutover:', e.message));

    // MCA: switch PK to (membership_id, company_id); drop company_guid column locally
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = 'member_company_access'
        ) THEN
          DELETE FROM member_company_access WHERE company_id IS NULL;
          BEGIN
            ALTER TABLE member_company_access DROP CONSTRAINT IF EXISTS member_company_access_pkey;
          EXCEPTION WHEN undefined_object THEN NULL;
          END;
          BEGIN
            ALTER TABLE member_company_access
              ADD CONSTRAINT member_company_access_pkey PRIMARY KEY (membership_id, company_id);
          EXCEPTION WHEN duplicate_object THEN NULL;
                    WHEN unique_violation THEN NULL;
          END;
          BEGIN
            ALTER TABLE member_company_access DROP COLUMN IF EXISTS company_guid;
          EXCEPTION WHEN undefined_column THEN NULL;
          END;
        END IF;
      END $$;
    `).catch((e) => console.warn('[CID3D] MCA PK cutover:', e.message));
    console.log('✅ Company Identity Phase 3D local constraint cutover applied');

    // ── Company Identity Phase 3E — UNIQUE(workspace_id, guid) ────────────
    await client.query(`
      DO $$
      DECLARE r RECORD;
      BEGIN
        -- Drop FKs that reference companies(guid) before dropping global unique
        FOR r IN
          SELECT c.conrelid::regclass AS tbl, c.conname
          FROM pg_constraint c
          WHERE c.confrelid = 'companies'::regclass
            AND c.contype = 'f'
            AND pg_get_constraintdef(c.oid) ILIKE '%REFERENCES companies(guid)%'
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
        END LOOP;

        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'companies' AND column_name = 'workspace_id'
        ) THEN
          BEGIN
            ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_guid_key;
          EXCEPTION WHEN undefined_object THEN NULL;
          END;
          BEGIN
            ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_guid_unique;
          EXCEPTION WHEN undefined_object THEN NULL;
          END;
          BEGIN
            ALTER TABLE companies ADD CONSTRAINT companies_workspace_guid_key UNIQUE (workspace_id, guid);
          EXCEPTION WHEN duplicate_object THEN NULL;
                    WHEN unique_violation THEN NULL;
          END;
        END IF;

        -- cost_centres: PK (company_id, guid)
        BEGIN
          ALTER TABLE cost_centres DROP CONSTRAINT IF EXISTS cost_centres_pkey;
          ALTER TABLE cost_centres ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE cost_centres ADD CONSTRAINT cost_centres_pkey PRIMARY KEY (company_id, guid);
        EXCEPTION WHEN others THEN NULL;
        END;

        -- tally country/state masters are COMPANY_OWNED projections
        BEGIN
          ALTER TABLE tally_country_master DROP CONSTRAINT IF EXISTS tally_country_master_pkey;
          ALTER TABLE tally_country_master ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE tally_country_master ADD CONSTRAINT tally_country_master_pkey PRIMARY KEY (company_id, name);
        EXCEPTION WHEN others THEN NULL;
        END;
        BEGIN
          ALTER TABLE tally_state_master DROP CONSTRAINT IF EXISTS tally_state_master_pkey;
          ALTER TABLE tally_state_master ALTER COLUMN company_id SET NOT NULL;
          ALTER TABLE tally_state_master ADD CONSTRAINT tally_state_master_pkey PRIMARY KEY (company_id, name, country);
        EXCEPTION WHEN others THEN NULL;
        END;
      END $$;
    `).catch((e) => console.warn('[CID3E] workspace+guid unique:', e.message));
    console.log('✅ Company Identity Phase 3E UNIQUE(workspace_id, guid) applied');
}

export default pool;
