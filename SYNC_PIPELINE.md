# SYNC_PIPELINE.md — td-backend

## Overview
Tally Prime (Windows) → Desktop App → Backend → PostgreSQL → Mobile/Web

## Step-by-Step Flow

### 1. Desktop Reads Tally
- Desktop app sends XML requests to Tally on localhost:9000
- XML templates in `desktop/xmls/*.xml`
- Response parsed by `desktop/util/xml.js` + `tallyHelper.js`

### 2. Desktop Sends to Backend
- Desktop connects via Socket.io to backend at `http://<mac-ip>:3001`
- Socket events:
  - `sync:start` — begins sync session
  - `sync:data` — sends parsed batch (companies, ledgers, vouchers, stocks)
  - `sync:complete` — signals end of sync run

### 3. Backend Receives (Socket)
- `src/socket/socketHandler.js` handles events
- Delegates to `src/routes/ingest.js` for chunk-based uploads
- Large payloads use `/ingest/chunk` (50MB body limit, raw binary)

### 4. Processing
- `src/controllers/ingestProcessor.js` — core ingestion logic
  - Validates company ownership
  - Upserts: companies, ledgers, vouchers, stocks, warehouses, units, groups
  - Writes `_FINANCIAL_YEAR` on every record
  - Updates `ledger_fy_balances` anchors
  - Writes `sync_runs` log entry

### 5. Tally Write-Back (Reverse)
- Mobile/Web creates voucher → POST to write_queue
- Backend emits socket event to desktop: `tally:write`
- Desktop sends XML to Tally → gets GUID back
- Desktop emits `tally:write:result` → backend updates write_queue status

## Key Data Parsing Rules
- All Tally keys are UPPERCASE (e.g. `LEDGERNAME`, `AMOUNT`)
- Use `tallyName()` helper for name normalization
- Qty format: `"(-) 20 NOS"` → use `parseTallyQty()` 
- Dr/Cr: stored in `balance_type` column — NEVER infer from sign of amount
- Financial year: always stored as `"2025-2026"` format

## Sync Triggers
- Manual: user taps "Sync" in desktop app
- Scheduled: `scheduler.js` can trigger periodic syncs (Needs verification)

## Socket Events Reference
| Event | Direction | Payload |
|-------|-----------|---------|
| sync:start | Desktop → Backend | {deviceId, companyGuid} |
| sync:data | Desktop → Backend | {type, records[]} |
| sync:complete | Desktop → Backend | {deviceId, summary} |
| tally:write | Backend → Desktop | {voucherId, payload, xmlTemplate} |
| tally:write:result | Desktop → Backend | {voucherId, tallyGuid, success} |
| pairing:request | Desktop → Backend | {pairingCode, deviceInfo} |
| pairing:confirmed | Backend → Desktop | {userId, companyGuid} |
