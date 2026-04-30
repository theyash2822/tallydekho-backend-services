// Database — PostgreSQL via pg pool
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error:', err.message);
});

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

// Initialize schema — create all tables if they don't exist
export async function initSchema() {
  const client = await pool.connect();
  try {
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
        reorder_level   DECIMAL(15,4) DEFAULT 0,
        alter_id        INTEGER DEFAULT 0,
        synced_at       BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
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
        is_primary    BOOLEAN DEFAULT FALSE,
        alter_id      INTEGER DEFAULT 0,
        synced_at     BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
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
        source          TEXT DEFAULT 'web'  -- 'web', 'mobile'
      );
      CREATE INDEX IF NOT EXISTS idx_wq_company   ON write_queue(company_guid);
      CREATE INDEX IF NOT EXISTS idx_wq_user      ON write_queue(user_id);
      CREATE INDEX IF NOT EXISTS idx_wq_status    ON write_queue(status);
      CREATE INDEX IF NOT EXISTS idx_wq_created   ON write_queue(created_at DESC);

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
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS device_id TEXT;
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS synced_at BIGINT;

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
    `);
    console.log('✅ PostgreSQL schema initialized');
  } finally {
    client.release();
  }
}

export default pool;
