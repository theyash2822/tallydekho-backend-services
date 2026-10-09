/**
 * Tables and columns the application reads and writes that exist in long-lived
 * databases (added by migrations no longer in the repository) but that nothing
 * in initSchema created, so a clean install failed. Shapes match the upgraded
 * development schema exactly. Additive only: every statement is IF NOT EXISTS,
 * so an already-upgraded database is untouched.
 */
export async function applyLegacyShapeSchema(client) {
  await client.query(`
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS ob_diff_amount    NUMERIC DEFAULT 0;
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS ob_diff_type      VARCHAR(3) DEFAULT 'Dr';
    ALTER TABLE companies ADD COLUMN IF NOT EXISTS gst_taxpayer_type VARCHAR(50) DEFAULT 'Regular';

    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS financial_year         TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS voucher_type_parent    VARCHAR(100);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS gst_section            VARCHAR(50);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_export              BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_sez                 BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_reverse_charge      BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS gstr3b_section         VARCHAR(20);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_import              BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS itc_eligibility        VARCHAR(50);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_non_gst             BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS is_gst_relevant        BOOLEAN DEFAULT FALSE;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS gst_transaction_nature VARCHAR(50);
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS gst_tabs_json          JSONB;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS gst_sections_json      JSONB;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS cess_amount            NUMERIC(15,4) DEFAULT 0;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS dispatch_details       JSONB;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS ewb_valid_upto         TIMESTAMPTZ;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS irn_cancel_date        TIMESTAMPTZ;

    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS financial_year            TEXT;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_interstate             BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_rcm                    BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS export_type               VARCHAR(50);
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_sez                    BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_nil_rated              BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_exempt                 BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS party_gstin               VARCHAR(20);
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS itc_eligibility           VARCHAR(50);
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS cess_amount               NUMERIC(15,4) DEFAULT 0;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS is_non_gst                BOOLEAN DEFAULT FALSE;
    ALTER TABLE gst_voucher_details ADD COLUMN IF NOT EXISTS gst_return_effective_date DATE;

    ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS stream        TEXT;
    ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS records_count INTEGER DEFAULT 0;
    ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS error         TEXT;
    ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS started_at    BIGINT;
    ALTER TABLE sync_log ADD COLUMN IF NOT EXISTS completed_at  BIGINT DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT;

    CREATE TABLE IF NOT EXISTS integrations (
      id                SERIAL PRIMARY KEY,
      company_guid      TEXT NOT NULL,
      type              TEXT NOT NULL,
      gstin             TEXT,
      username          TEXT,
      password_enc      TEXT,
      client_id_enc     TEXT,
      client_secret_enc TEXT,
      irp_provider      TEXT DEFAULT 'NIC',
      access_token      TEXT,
      token_expiry      TIMESTAMPTZ,
      status            TEXT DEFAULT 'disconnected',
      last_connected    TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW(),
      company_id        BIGINT,
      CONSTRAINT uq_integrations_company_id_type UNIQUE (company_id, type)
    );

    CREATE TABLE IF NOT EXISTS tax_transactions (
      id                 SERIAL PRIMARY KEY,
      company_guid       TEXT NOT NULL,
      voucher_guid       TEXT NOT NULL,
      voucher_alter_id   INTEGER DEFAULT 0,
      voucher_number     TEXT,
      voucher_type       TEXT,
      voucher_date       TEXT,
      party_ledger_name  TEXT,
      tax_type           TEXT NOT NULL,
      tax_sub_type       TEXT,
      tax_ledger_name    TEXT NOT NULL,
      tax_ledger_parent  TEXT,
      tax_ledger_group   TEXT,
      taxable_amount     NUMERIC(15,4) DEFAULT 0,
      tax_rate           NUMERIC(5,2),
      tax_amount         NUMERIC(15,4) DEFAULT 0,
      transaction_nature TEXT,
      country_code       TEXT,
      financial_year     TEXT,
      reference_no       TEXT,
      narration          TEXT,
      due_date           TEXT,
      paid_date          TEXT,
      challan_no         TEXT,
      return_period      TEXT,
      synced_at          TIMESTAMPTZ DEFAULT NOW(),
      company_id         BIGINT,
      CONSTRAINT uq_tax_tx_company_id UNIQUE (company_id, voucher_guid, tax_type, tax_ledger_name, voucher_alter_id)
    );

    CREATE TABLE IF NOT EXISTS tally_country_master (
      company_guid TEXT NOT NULL,
      name         TEXT NOT NULL,
      fetched_at   BIGINT NOT NULL,
      company_id   BIGINT NOT NULL,
      CONSTRAINT tally_country_master_pkey PRIMARY KEY (company_id, name)
    );

    CREATE TABLE IF NOT EXISTS tally_state_master (
      company_guid   TEXT NOT NULL,
      name           TEXT NOT NULL,
      country        TEXT NOT NULL DEFAULT '',
      gst_state_code TEXT,
      fetched_at     BIGINT NOT NULL,
      company_id     BIGINT NOT NULL,
      CONSTRAINT tally_state_master_pkey PRIMARY KEY (company_id, name, country)
    );
    CREATE INDEX IF NOT EXISTS idx_tally_state_country ON tally_state_master (company_guid, country);
  `);
}
