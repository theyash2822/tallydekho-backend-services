// Database schema — SQLite (easily migrated to PostgreSQL on AWS)
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/tallydekho.db');

let db;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    -- Users (mobile/web login)
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mobile      TEXT UNIQUE NOT NULL,
      name        TEXT,
      language    TEXT DEFAULT 'English',
      otp         TEXT,
      otp_expires INTEGER,
      token       TEXT,
      created_at  INTEGER DEFAULT (unixepoch()),
      updated_at  INTEGER DEFAULT (unixepoch())
    );

    -- Desktop devices (paired with Tally)
    CREATE TABLE IF NOT EXISTS devices (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id     TEXT UNIQUE NOT NULL,
      user_id       INTEGER REFERENCES users(id),
      name          TEXT,
      os            TEXT,
      pairing_code  TEXT,
      code_expires  INTEGER,
      paired        INTEGER DEFAULT 0,
      last_seen     INTEGER,
      created_at    INTEGER DEFAULT (unixepoch())
    );

    -- Companies (from Tally)
    CREATE TABLE IF NOT EXISTS companies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
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
      synced_at   INTEGER,
      created_at  INTEGER DEFAULT (unixepoch())
    );

    -- Ledgers (from Tally sync)
    CREATE TABLE IF NOT EXISTS ledgers (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
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
      opening_balance   REAL DEFAULT 0,
      closing_balance   REAL DEFAULT 0,
      balance_type      TEXT DEFAULT 'Dr',
      is_revenue        INTEGER DEFAULT 0,
      alter_id          INTEGER DEFAULT 0,
      synced_at         INTEGER DEFAULT (unixepoch()),
      UNIQUE(guid, company_guid)
    );

    -- Vouchers (Sales, Purchase, Payment, Receipt, Journal, Contra, Expense)
    CREATE TABLE IF NOT EXISTS vouchers (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      guid            TEXT NOT NULL,
      company_guid    TEXT NOT NULL,
      voucher_number  TEXT,
      voucher_type    TEXT NOT NULL,
      date            TEXT NOT NULL,
      party_name      TEXT,
      party_guid      TEXT,
      amount          REAL DEFAULT 0,
      narration       TEXT,
      reference       TEXT,
      is_cancelled    INTEGER DEFAULT 0,
      alter_id        INTEGER DEFAULT 0,
      raw_data        TEXT,
      synced_at       INTEGER DEFAULT (unixepoch()),
      UNIQUE(guid, company_guid)
    );

    -- Voucher items (line items)
    CREATE TABLE IF NOT EXISTS voucher_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      voucher_guid  TEXT NOT NULL,
      company_guid  TEXT NOT NULL,
      ledger_name   TEXT,
      ledger_guid   TEXT,
      amount        REAL,
      type          TEXT,
      item_name     TEXT,
      qty           REAL,
      unit          TEXT,
      rate          REAL,
      tax_rate      REAL,
      hsn           TEXT
    );

    -- Stock items (from Tally sync)
    CREATE TABLE IF NOT EXISTS stocks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      guid            TEXT NOT NULL,
      company_guid    TEXT NOT NULL,
      name            TEXT NOT NULL,
      alias           TEXT,
      category        TEXT,
      group_name      TEXT,
      unit            TEXT,
      hsn             TEXT,
      tax_rate        REAL DEFAULT 18,
      opening_qty     REAL DEFAULT 0,
      opening_rate    REAL DEFAULT 0,
      closing_qty     REAL DEFAULT 0,
      closing_rate    REAL DEFAULT 0,
      closing_value   REAL DEFAULT 0,
      reorder_level   REAL DEFAULT 0,
      alter_id        INTEGER DEFAULT 0,
      synced_at       INTEGER DEFAULT (unixepoch()),
      UNIQUE(guid, company_guid)
    );

    -- Stock transactions
    CREATE TABLE IF NOT EXISTS stock_transactions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      stock_guid    TEXT NOT NULL,
      company_guid  TEXT NOT NULL,
      voucher_guid  TEXT,
      voucher_type  TEXT,
      date          TEXT,
      qty           REAL,
      rate          REAL,
      value         REAL,
      type          TEXT,
      warehouse     TEXT,
      synced_at     INTEGER DEFAULT (unixepoch())
    );

    -- Sync log (tracks what's been synced)
    CREATE TABLE IF NOT EXISTS sync_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      company_guid  TEXT NOT NULL,
      device_id     TEXT,
      stream        TEXT,
      records_count INTEGER DEFAULT 0,
      status        TEXT DEFAULT 'success',
      error         TEXT,
      started_at    INTEGER,
      completed_at  INTEGER DEFAULT (unixepoch())
    );

    -- Ingest uploads (chunked upload tracking)
    CREATE TABLE IF NOT EXISTS ingest_uploads (
      id          TEXT PRIMARY KEY,
      device_id   TEXT,
      company_guid TEXT,
      stream      TEXT,
      chunks      INTEGER DEFAULT 0,
      status      TEXT DEFAULT 'pending',
      created_at  INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_ledgers_company    ON ledgers(company_guid);
    CREATE INDEX IF NOT EXISTS idx_vouchers_company   ON vouchers(company_guid);
    CREATE INDEX IF NOT EXISTS idx_vouchers_type      ON vouchers(voucher_type);
    CREATE INDEX IF NOT EXISTS idx_vouchers_date      ON vouchers(date);
    CREATE INDEX IF NOT EXISTS idx_stocks_company     ON stocks(company_guid);
    CREATE INDEX IF NOT EXISTS idx_companies_user     ON companies(user_id);
  `);

  console.log('✅ Database schema initialized');
}

export default getDb;
