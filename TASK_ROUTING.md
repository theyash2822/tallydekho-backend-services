# TASK_ROUTING.md — td-backend

For each task type, read ONLY the listed files. Nothing else unless explicitly needed.

---

## Auth Bug / OTP Issue
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~109–330)
- src/middleware/auth.js
- src/services/whatsapp.js

Do NOT read: ingest, tally-write, reports, stocks

---

## Voucher Bug (Sales/Purchase/Payment/Receipt/Journal/Contra)
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~731–910)
- src/controllers/ingestProcessor.js
- src/db/schema.js (vouchers, voucher_ledger_entries tables)

Do NOT read: auth routes, stocks, reports, services

---

## Ledger Balance Bug
Read:
- AGENTS.md, BLUEPRINT.md, DB_CONTRACT.md
- src/routes/api-v1.js (lines ~910–1160)
- src/db/schema.js (ledgers, ledger_fy_balances, voucher_ledger_entries)

Do NOT read: auth, stocks, tally-write, services

---

## Stock / Warehouse Bug
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~1156–1370)
- src/db/schema.js (stocks, stock_transactions, warehouses, units, groups)
- src/controllers/ingestProcessor.js (stock section)

Do NOT read: auth, ledger, reports, services

---

## Financial Report / P&L / Balance Sheet Bug
Read:
- AGENTS.md, BLUEPRINT.md, DB_CONTRACT.md
- src/routes/api-v1.js (lines ~1368–1820)
- src/db/schema.js (ledger_fy_balances, voucher_ledger_entries)

Do NOT read: auth, stocks, tally-write, services

---

## GST / E-Way Bill / E-Invoice Bug
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~1819–2230)
- src/db/schema.js (gst_voucher_details, e_way_bill_details, e_invoice_details)
- src/utils/gstClassifier.js

Do NOT read: auth, stocks, financial reports

---

## Tally Sync Bug (ingest side)
Read:
- AGENTS.md, BLUEPRINT.md, SYNC_PIPELINE.md
- src/routes/ingest.js
- src/controllers/ingestProcessor.js
- src/socket/socketHandler.js

Do NOT read: api-v1.js (most of it), auth, services

---

## Tally Write-Back Bug (app creates voucher → Tally)
Read:
- AGENTS.md, BLUEPRINT.md, SYNC_PIPELINE.md
- src/routes/tally-write.js
- src/socket/socketHandler.js
- src/db/schema.js (write_queue table)

Do NOT read: ingest, reports, auth

---

## Payment Reminders / Notifications
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~2979–3050)
- src/services/notifications.js
- src/services/scheduler.js
- src/services/whatsapp.js

Do NOT read: ingest, stocks, reports

---

## AI Insights Bug
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~2752–2870)
- src/services/aiInsights.js
- src/services/aiAnalytics.js

Do NOT read: ingest, stocks, auth, tally-write

---

## Company Profile / Logo
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~2866–2935)
- src/db/schema.js (companies table)

Do NOT read: vouchers, stocks, reports

---

## Dashboard / KPI Bug
Read:
- AGENTS.md, BLUEPRINT.md
- src/routes/api-v1.js (lines ~552–735)
- src/db/schema.js (ledger_fy_balances, vouchers)

Do NOT read: auth, stocks, tally-write, services

---

## New API Endpoint
Read:
- AGENTS.md, BLUEPRINT.md, API_CONTRACT.md
- src/routes/api-v1.js (relevant section)
- src/db/schema.js (relevant tables)
- src/middleware/auth.js

Pattern to follow:
1. Add `verifyCompanyOwnership()` check
2. Use `resolveFYDates()` for FY-aware queries
3. Return `{ success: true, data: { ... } }`

## Files to ALWAYS Ignore
- node_modules/
- logs/
- data/*.db
- .env
- dist/
- src/__tests__/ (unless test task)
- src/kb/ (unless help content task)
- Sibling repos (td-web-portal, tallydekho-mobile-V4, td-source, td-website)
