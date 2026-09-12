# DB_CONTRACT.md — td-backend (PostgreSQL)

Schema defined in: `src/db/schema.js` → `initSchema()`
DB: PostgreSQL via pg Pool (max 20 connections)

## Core Tables

### users
Primary user table (mobile/web login)
- id, mobile (UNIQUE), name, email, language, otp, otp_expires, token, created_at, updated_at

### devices
Desktop app registrations
- id, device_id (UNIQUE), user_id→users, name, os, pairing_code, code_expires, paired (bool), last_seen
- workspace_id, device_secret_hash, binding_status (UNBOUND/ACTIVE/RESTORE_PENDING/REVOKED), credential_claimed_at
- Backend stores secret hash only. Legacy paired devices without a hash still auth with device-id until next pair/register issues a secret.

### companies
Companies synced from Tally
- id, guid (UNIQUE), user_id→users, device_id→devices, workspace_id, name, formal_name, + address/GST/contact fields
- logo_url (added for company logo feature)

## Workspace / Backup (2026-09-12)
### workspaces
- id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status, tally_connection, setup_generation, is_base
- reset_requested_at / close_requested_at (lifecycle timestamps; expand-only)

### workspace_memberships
- workspace_id + user_id unique; OWNER membership on personal workspace bootstrap

### workspace_ownership_transfers
- from/target users, outgoing_role_id
- status: PENDING_EMAIL | PENDING_CONFIRM | PENDING_GRACE | COMPLETED | CANCELLED | EXPIRED
- confirm_count, confirm_tokens_json (hashed tokens), email_count, expires_at (confirm window), grace_ends_at, completed_at, cancelled_at

### workspace_lifecycle_requests
- kind RESET | CLOSE; status PENDING_CONFIRM | PENDING_GRACE | COMPLETED | EXPIRED | CANCELLED
- confirm_count, confirm_phrase, grace_ends_at, expires_at

### billing_payment_orders / billing_invoices / usage_events
- Payment orders: PENDING → COMPLETED (MANUAL complete or Razorpay fulfill)
- Invoices linked to order_id
- usage_events: owner/workspace/kind drilldown (also mirrored from wallet_transactions)

### payment_mode_posting_map
- workspace_id + company_guid + payment_mode → ledger_guid/name

### workspace_tally_bindings / workspace_tally_lineage_companies
- One active desktop per workspace; lineage GUIDs for TALLY_DATA_MISMATCH

### workspace_backups
- status UPLOADING/AVAILABLE/FAILED/DELETED; latest 3 AVAILABLE kept

### restore_sessions / hard_sync_requests / workspace_audit_log
- Durable restore codes and Hard Sync approvals

Legacy user_id ownership on companies/devices is kept (expand/contract).

### company_years
Financial years per company
- id, company_guid, fin_year (e.g. "2025-2026"), begin_date, end_date

## Tally Data Tables

### ledgers
- id, guid, company_guid, name, group_name, closing_balance, balance_type (Dr/Cr), financial_year
- opening_balance, opening_balance_type

### ledger_fy_balances
FY anchor balances (opening per FY)
- id, ledger_guid, company_guid, financial_year, opening_balance, opening_type (Dr/Cr)

### vouchers
- id, guid, company_guid, type (Sales/Purchase/Payment/etc), date, party_name
- amount, narration, financial_year, _RECORD_TYPE, _FINANCIAL_YEAR, status
- write_queue_id (if app-created)

### voucher_ledger_entries
Double-entry lines per voucher
- id, voucher_guid, ledger_guid, ledger_name, amount, entry_type (Dr/Cr), financial_year

### voucher_inventory_items
Stock line items per voucher
- id, voucher_guid, stock_guid, stock_name, qty, rate, amount, unit, godown_name

### voucher_items
Simplified items (legacy)
- id, voucher_guid, name, qty, rate, amount, unit

### gst_voucher_details
GST fields per voucher
- id, voucher_guid, gstin, hsn_code, tax_rate, igst/cgst/sgst amounts, gst_classification

### bill_outstanding
Party-wise bill outstanding
- id, voucher_guid, company_guid, party_name, amount, due_date, pending_amount

## Stock Tables

### stocks
Stock master (items)
- id, guid, company_guid, name, group_name, unit, opening_qty, closing_qty, rate, closing_value, financial_year

### stock_transactions
Per-voucher stock movements
- id, stock_guid, voucher_guid, company_guid, date, qty_in, qty_out, rate, godown_name, financial_year

### stock_fy_valuation
FY-level stock valuation cache
- id, company_guid, stock_guid, financial_year, opening_qty, opening_value, closing_qty, closing_value

### warehouses (godowns)
- id, guid, company_guid, name, address, parent

### units
- id, guid, company_guid, name, symbol

### groups
Stock + ledger groups
- id, guid, company_guid, name, parent, nature (Assets/Liabilities/etc)

### stock_categories
- id, guid, company_guid, name, parent

### batch_allocations
Batch/lot tracking per voucher
- id, voucher_guid, stock_guid, batch_name, qty, mfg_date, exp_date

## Write Queue (App-Created Entries)

### write_queue
App-created vouchers pending Tally write-back
- id, user_id, company_guid, voucher_type, payload (JSONB), status (pending/synced/failed)
- retry_count, error_message, created_at, synced_at, tally_guid

## Sync / Audit Tables

### sync_runs
Tally sync run log
- id (UUID), company_guid, device_id, started_at, completed_at, status, records_processed

### sync_log
Device-level sync events
- id, device_id, event, payload, created_at

### ingest_uploads
Chunk upload sessions
- id (TEXT), device_id, company_guid, status, chunk_count, created_at

### raw_tally_records
Raw XML-parsed records before processing (backup)
- id, upload_id, record_type, data (JSONB)

## Notifications / Push

### push_tokens
FCM tokens per user
- id, user_id→users, token, platform (ios/android), created_at

## Compliance

### e_invoice_details
- id, voucher_guid, irn, ack_no, ack_date, qr_code, status

### e_way_bill_details
- id, voucher_guid, ewb_no, ewb_date, valid_until, status, vehicle_no

## Balance Calculation Rule (CRITICAL)
```
ledger_balance = ledger_fy_balances.opening_balance
              + SUM(voucher_ledger_entries.amount WHERE financial_year = X)
```
NEVER use `ledgers.closing_balance` directly — it may be stale.
Use `ledger_fy_balances` as anchor + movements from `voucher_ledger_entries`.
