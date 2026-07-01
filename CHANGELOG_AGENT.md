# CHANGELOG_AGENT.md

## 2026-07-01 (R2) — my-entries JOIN fanout fix + sort tiebreak

### Fixed
- **Receipt JOIN Cartesian fanout** — `GET /vouchers/my-entries` was returning 40+ duplicate rows per Receipt because Tally Receipt `voucher_number` uses sequential integers (`'1','2','3'...`) that collide across years/types. Live proof: `TDK-RCP-2026-0003` fanned out to 44 rows, `TDK-RCP-2026-0004` to 42 rows. Sales unaffected (globally-unique `TD2731-3-2026`-style numbers).
  - Added two disambiguators to the primary JOIN:
    - `av.voucher_date::text = v.date`
    - voucher_type-aware clause: `receipt → Receipt`, `sales_invoice → Sales%`, others fall through unchanged.
  - Fanout crushed to exactly 1 row per app_voucher (formal QA subagent verified live).
- **Same-day ordering** — `ORDER BY v.date DESC` left same-day rows tied → Postgres returned them in physical row order, pushing fresh Sales+Receipt pairs BELOW older entries from the same day. Added `v.id DESC` tiebreak (auto-increment PK guarantees newest-first).

### Files Changed
- `src/routes/api-v1.js` — `GET /vouchers/my-entries` JOIN + ORDER BY only.

### QA
🟢 GREEN (formal subagent R2, ~3 min) — static checks pass, live smoke test confirms 44→1 and 42→1 collapse, ordering verified.

### Commits
- `f9a744f` → tallydekho-backend-services

---

## 2026-07-01 — Receipt Batch Reconciler + Phase 2a sync:request payload

### Fixed
- **Receipt tally_voucher_no backfill** — the per-record Receipt reconciler (added 2026-06-30) could miss when:
  - Receipt row was inserted via SimplifiedVoucher.xml (no voucher_number yet) then enriched via AllVoucher.xml, OR
  - the per-record reconciler code was deployed AFTER the row was ingested (retro).
  Result: `TDK-RCP-2026-0003` (Tally voucher #4, party NenA, ₹2,12,500) stuck at NULL/queued while Sales pair was fine.
- Added **two post-loop batch reconcilers** in `processVouchers`:
  - **Strategy A (primary):** narration-anchored regex match on `TDK Receipt: <RCP> | Against Invoice: <SAL>`. Unique per receipt.
  - **Strategy B (fallback):** bill-allocation match on `bill_type='Agst Ref' + bill_ref_name=<parent SAL>` with uniqueness guard `COUNT(*) OVER PARTITION` + party/amount/date verification. Fires only if narration was edited manually in Tally.
  Both idempotent (`tally_voucher_no IS NULL` guard). Both emit `voucher:tallySynced` WebSocket event.

### Added (foundation)
- `tally-write.js` — `sync:request` payload now carries `tallyIds` (MASTERIDs of freshly-written Sales+Receipt pair). Foundation for targeted `SingleVoucher.xml` fetch (Phase 2b). Backward-compatible: desktop falls back to full sync if `tallyIds` is missing.
- Added `companyName` to sync:request payload for downstream targeted fetch.

### Files Changed
- `src/controllers/ingestProcessor.js` — added 2 batch reconcilers after existing Sales bill-ref reconciler (~78 LOC).
- `src/routes/tally-write.js` — sync:request payload extended with tallyIds + companyName.

### Verified
- `TDK-RCP-2026-0003` backfilled from `tally_voucher_no=NULL/queued` → `tally_voucher_no=4/synced/posted` via manual SQL matching the new reconciler logic. Reconciler will run automatically on next real sync.

### Commits
- `16353fe` → tallydekho-backend-services

---

## 2026-06-26 — Ledger Master XML Fix (POST /tally/master/party)

### Fixed
- `escapeXml()` helper added — protects against `&`, `<`, `>`, `"`, `'` in all user-supplied values
- Address now split on `\r?\n` into multiple `<ADDRESS>` tags inside `ADDRESS.LIST` (was single string)
- Bank details restored to `LEDGERBANKALLOCATIONS.LIST` wrapper (was incorrectly regressed to direct LEDGER children)
- Bank tags corrected: `BANKACCNO` + `BANKDETAILS` (both), `BANKNAME`, `IFSCODE`, `BANKBRANCHNAME`, `BANKACCHOLDERSHIPNAME`
- Removed wrong `BANKACCOUNTHOLDER` tag
- Added `pan` to destructuring from `req.body`
- Added `<INCOMETAXNUMBER>` to XML when `pan` is present
- `escapeXml()` applied to all user values: name, mailingName, state, country, pincode, gstType, gstin, parent, pan, companyName, all bank fields
- Removed unused `email`/`phone` conditional XML tags (never populated from mobile)

### Files Changed
- `src/routes/tally-write.js` — `POST /tally/master/party` route only

### Commits
- `8d45359` → tallydekho-backend-services

---

## 2026-06-06 — Stock Settings — Backend API + DB Schema

### Added
- `company_inventory_settings` table — 23 columns covering all General/Warehouse/Items/Alerts settings per company
- `GET /api/inventory/settings` — returns saved settings merged with Tally-derived defaults (UoMs from stocks table, warehouses from warehouses table, most-common unit as default)
- `POST /api/inventory/settings` — upsert on company_guid conflict, covers all 20 setting fields
- Settings properly separate TallyDekho-only (stored in DB only) vs Tally-controlled (read-only badges on mobile)

### Files Changed
- `src/db/schema.js` — company_inventory_settings table + index
- `src/routes/api-v1.js` — GET + POST /api/inventory/settings routes

### Commit
- `2ef4308` → tallydekho-backend-services

---

## 2026-06-05 — Movement History Dedup Fix

### Bug Fixed
- **Root cause**: `voucher_inventory_items` was accumulating duplicate rows on every sync because `godown_name IS NULL` bypasses PostgreSQL's UNIQUE constraint (`NULL ≠ NULL`). Each sync inserted a fresh identical row instead of updating.
- **Dahaad 250 ML**: had 77 identical rows for a single voucher → movement history showed 77x the same entry
- **Godown-split items**: same item to multiple warehouses = multiple rows per voucher → duplicates in history

### Changes
- `src/controllers/ingestProcessor.js`: Store `''` instead of `NULL` for `godown_name`/`batch_name` in INSERT — UNIQUE constraint now works correctly
- `src/routes/api-v1.js` `/stocks/items/:id/movements`: Added `GROUP BY v.id` + `SUM(actual_qty)` to collapse godown-split rows; fixed `voucher_number` alias (was `ref`, mobile reads `voucher_number`)
- **DB**: Deleted 76 duplicate rows; normalized remaining NULLs to `''`

### QA: 🟡 YELLOW (pushed — fixes correct, pre-existing mock data in movement-analytics.tsx flagged for cleanup)


## 2026-06-05 — Low Stock Tile + Reorder Queue Consistency Fix
- **Bug:** Dashboard `/stock-dashboard` low stock tile count was lower than items shown on reorder queue screen
- **Root cause:** Tile query only checked `stocks.reorder_level > 0` — ignored group-level reorder fallback
- **Fix:** Both `/stock-dashboard` (low tile count) and `/stocks?lowStockOnly=true` now use LEFT JOIN on `groups` with same COALESCE logic as the reorder queue API
- **File changed:** `src/routes/data.js` (2 queries)
- **No migration needed** — all columns already existed
- **Commit:** `886cc42` — td-backend

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

---

## 2026-06-04 | Fix: Negative Stock FY Filtering

**Task:** Negative stock screen showing no data when a non-current FY was selected from dashboard.

**Root Cause:** FY path in `/api/stocks/negative-stock` was computing `stocks.opening_qty + transactions up to fyTo`. But `stocks.opening_qty` is the current-FY opening balance, not an all-time initial balance. For past FYs this double-counted transactions → result was positive/zero → no items shown.

**Files Changed:**
- `src/routes/api-v1.js` — FY path now JOINs `stock_fy_valuation` on `(company_guid, financial_year)` and uses `sfv.closing_qty` directly (Tally's authoritative per-FY closing qty)

**Behavior Changed:**
- Negative stock screen now correctly shows FY-specific negative items for ALL financial years
- Tested: 2023-24 (1 item), 2024-25 (3 items), 2025-26 (4 items), 2026-27 (4 items) — all correct

**Tested:** ✅ API tested via curl with 4 FYs
**Risks:** None — warehouse path unchanged; only FY query source changed

---

## 2026-06-03 | Reorder Queue — MINIMUMORDERQTY + Group Reorder + API

**Task:** Add MINIMUMORDERQTY sync, group-level reorder fallback, and full reorder queue API.

**Files Changed:**
- `td-source/desktop/xmls/StockItem.xml` — Added Fld22 `MINIMUMORDERQTY` (`$MinimumOrderQty`)
- `td-source/desktop/xmls/StockItemFull.xml` — Added `MINIMUMORDERQTY` Compute field
- `td-source/desktop/xmls/StockGroupFull.xml` — Added `REORDERLEVEL` + `MINIMUMORDERQTY` Compute fields
- `src/db/schema.js` — Added `minimum_order_qty` to `stocks` table; added `reorder_level` + `minimum_order_qty` to `groups` table; added 3 ALTER TABLE migration statements
- `src/controllers/ingestProcessor.js` — `processStocks()`: added `minimum_order_qty` parse+store; `processGroupMasters()`: added `reorder_level` + `minimum_order_qty` parse+store
- `src/routes/data.js` — Added `POST /reorder-queue` endpoint

**Behavior Changed:**
- StockItem sync now stores `minimum_order_qty` (was ignored before)
- StockGroup sync now stores `reorder_level` + `minimum_order_qty` (was not exported/stored)
- `/reorder-queue` returns full item+group level reorder data with effective COALESCE logic
- Priority: CRITICAL (qty≤0), HIGH (qty≤25% of reorder level), MEDIUM (otherwise)
- Suggested qty: max(effectiveMinOrderQty, (effectiveReorderLevel×2) − currentQty)

**DB Migration Impact:**
- `stocks` table: new column `minimum_order_qty DECIMAL(15,4) DEFAULT 0` (safe, ALTER IF NOT EXISTS)
- `groups` table: new columns `reorder_level DECIMAL(15,4) DEFAULT 0`, `minimum_order_qty DECIMAL(15,4) DEFAULT 0` (safe)
- Requires re-sync of StockItem + StockGroupFull after desktop XML deploy

**XML Investigation Results:**
- `REORDERLEVEL`: Present in `StockItem.xml` + `StockItemFull.xml` ✅
- `MINIMUMORDERQTY`: NOT in any XML before this change ❌ → Added to both stock XMLs
- `StockGroup.xml` + `StockGroupFull.xml`: No reorder fields before this change → Added to `StockGroupFull.xml`
- `Master.xml`: Only exports Guid+AlterId, not relevant

**Tested:** ✅ FULLY VERIFIED — API returns correct data, Acephate 500gms correctly appears in reorder queue

**Root Cause Bug Fixed:** `findNestedArray` was matching `STOCKITEM: 71` (numeric count in Tally's CMPINFO metadata) before finding the real `BODY.DATA.TALLYMESSAGE.STOCKITEM[]` array. Stocks had not been syncing since May 28 as a result.

**Additional Fix:** Added `findNestedArrayOfObjects()` helper that skips primitive values and only collects actual record objects. Replaces `findNestedArray` usage in `processStocks`.

**Risks:** None — fix is additive and backward compatible.

---

## 2026-06-02 | tally-write — GODOWN Parent Fix (no Primary)
Files changed: src/routes/tally-write.js
Behavior changed:
- POST /tally/master/warehouse: skip <PARENT> tag when parent is empty or 'Primary'
- Root cause: 'Primary' is not a valid godown name in all Tally setups. Empty parent = Tally assigns to root automatically.
- effectiveParent = skip if empty or 'Primary', include only if user typed an actual existing godown name
Tested: Waiting for user confirmation
Risks: None

---

## 2026-06-02 | tally-write — GODOWN XML Fix (NAME attribute)
Files changed: src/routes/tally-write.js
Behavior changed:
- POST /tally/master/warehouse: added NAME attribute to <GODOWN> element
- Before: <GODOWN ACTION="Create"> → Tally error: "APPOID does not exist"
- After: <GODOWN NAME="${name}" ACTION="Create"> → Tally can identify the object
- Root cause: Tally requires NAME attribute on master elements to identify the object being created
Tested: Waiting for user confirmation
Risks: None

---

## 2026-06-02 | warehouse-detail — stock_name Fixed in Activity Feed
Files changed: src/routes/api-v1.js
Behavior changed:
- /stocks/warehouses/:id activity query: LEFT JOIN stocks s ON s.name = st.stock_guid (was s.guid)
- Same root cause: stock_transactions.stock_guid stores NAME not UUID
- After fix: stock_name in activity rows is correctly populated
Tested: Waiting for user confirmation
Risks: None

---

## 2026-06-02 | stocks/items — Warehouse Filter Fixed (name match, not guid)
Files changed: src/routes/api-v1.js
Behavior changed:
- Root cause: stock_transactions.stock_guid stores STOCK NAME (not UUID). stocks.guid = UUID.
- Non-FY path: changed 'guid IN (...)' to 'name IN (...)'
- FY path: changed 'whSet.has(r.guid)' to 'whSet.has(r.name)'
- Verified: Sitapura returns 5 correct stocks from DB
- NOTE: This is a data schema inconsistency in stock_transactions. stock_guid column misnamed - actually stores stock name. Future cleanup needed.
Tested: DB verified, waiting for app confirmation
Risks: If stock names have case differences, filter may miss some items

---

## 2026-06-02 | stocks/items — Add ?warehouse= filter param
Files changed: src/routes/api-v1.js
Behavior changed:
- GET /api/stocks/items now accepts optional ?warehouse=<name> query param
- Non-FY path: adds subquery filter on stock_transactions.warehouse
- FY path: runs separate query for warehouse stock_guids, filters rawRows in JS
- No change when warehouse param is absent — fully backward compatible
Tested: Needs manual test with Tally data having multiple godowns
Risks: FY path makes extra DB query when warehouse param present

---

## 2026-06-02 | Blueprint System Created
Files changed: AGENTS.md, BLUEPRINT.md, BACKEND_MAP.md, API_CONTRACT.md, DB_CONTRACT.md, SYNC_PIPELINE.md, TASK_ROUTING.md, KNOWN_ISSUES.md, CHANGELOG_AGENT.md, .agentignore
Behavior changed: None (docs only)
Tested: N/A
Risks: None

---

## 2026-05-29 | Write Queue / P&L / Stock KPI Fixes (QA GREEN)
Files changed: src/routes/api-v1.js (multiple sections)
Behavior changed: 
- KPI total stock value now computed from real closing_value (was hardcoded ₹83,150)
- P&L card shows empty state when pl=null
- Audit trail, daybook, my-entries wired to live API
Tested: QA agent — 30/30 PASS
Risks: None

---

## 2026-05-27 | IP Update to 192.168.29.243
Files changed: td-backend/.env, desktop/.env, desktop/util/helper.js, mobile .env, AuthContext.tsx, api.ts, web portal (was .241)
Behavior changed: Backend IP updated across all clients
Tested: Manual
Risks: IP changes on WiFi reconnect — static DHCP not set

---

## 2026-05-06 | Company Logo Routes Added
Files changed: src/routes/api-v1.js (logo routes), src/db/schema.js (logo_url column)
Behavior changed: POST/GET /api/company/:guid/logo routes added
Tested: Route exists, full feature not complete
Risks: Cross-device sync and web portal UI not built

---

## 2026-04-29 | verifyCompanyOwnership() Added to All Routes
Files changed: src/routes/api-v1.js (all company-scoped routes)
Behavior changed: All 45 routes now check company ownership — prevents cross-user data leak
Tested: Manual API test
Risks: None — safe guard added

---

_Add new entries at top._

## 2026-06-03 — Negative Stock Full Fix

### Investigation Findings
1. **XML source**: `StockItem.xml` has NO closing qty field. Closing qty is derived entirely from `StockTransaction.xml` movements.
2. **XML field**: `ActualQty` in StockTransaction.xml — positive = inward, negative = outward. `DestinationGodownName` identifies transfer source.
3. **Root cause 1**: `ingestProcessor.js` used `GREATEST(net_qty, 0)` clamping negative qty → 0 on every sync. Fixed.
4. **Root cause 2**: `AND sub.net_qty > 0` and `AND closing_qty > 0` guards were also zeroing out negatives. Fixed.
5. **Root cause 3**: `SimplifiedVoucher.xml` omits `DestinationGodownName` → both transfer entries stored as inward (+2 phantom stock). Fixed via zero-cost multi-godown detection.
6. **Transfer direction bug**: MIN(id) was wrong guess for source. Fixed to MAX(id) = source (outward), MIN(id) = destination (inward). Backfilled 7 affected items.

### Files Changed
- `src/controllers/ingestProcessor.js`: Remove GREATEST clamp, fix net_qty > 0 guard, fix FY closing_qty > 0 guard, add Stock Journal transfer detection
- `src/routes/api-v1.js`: New `GET /api/stocks/negative-stock` endpoint with priority, pagination, warehouse breakdown, summary stats

### DB Changes
- Backfilled 7 Stock Journal transfer items with correct inward/outward directions
- 60 negative stock items now correctly stored (were all showing 0)
- Balvan Super 1lit: Main Location = -18, Delhi = +1 (matches Tally)

### API Response Shape
```json
{
  "summary": { "negativeItems": N, "criticalItems": N, "highItems": N, "totalNegativeQty": N },
  "items": [{ "stockGuid", "itemName", "groupName", "closingQty", "negativeQty", "isNegativeStock": true, "priority": "CRITICAL|HIGH", "warehouses": [...] }],
  "pagination": { "page", "pageSize", "total" }
}
```

### Priority Logic
- CRITICAL: closingQty <= -10
- HIGH: closingQty < 0 and > -10

## 2026-06-04 — Stock Ledger Endpoint

### Changes
- `src/routes/api-v1.js` — added `GET /api/stocks/ledger`
  - Paginated, FY-aware (fy= param), date range (from/to), item search, warehouse, type filter
  - Returns: entries[], warehouses[], summary (total, totalInQty, totalOutQty, totalValue), pagination
  - Sources: voucher_inventory_items JOIN vouchers
  - Company-scoped, auth-protected (verifyCompanyOwnership)

## 2026-06-04 — Stock Ledger endpoint fixes

### Bug Fixes
- by_document GROUP BY error: ORDER BY v.id → MIN(v.id) (v.id not in GROUP BY)
- by_item 0 movements: transactions sub-query was reusing stCond parameter indices which referenced item names instead of dates → removed stCond.slice(1) from sub-query

## 2026-06-04

### fix(stocks): exclude Physical Stock vouchers from FY qty calculations
- **Root cause:** Physical Stock vouchers (Tally stock audit/count entries) were treated as inward movements, causing cumulative qty inflation in all FY-derived calculations
- **Files changed:** `src/routes/api-v1.js`
- **Routes affected:**
  - `GET /api/stocks/items` (FY path) — JOIN excludes `voucher_type = 'Physical Stock'`
  - `GET /api/stocks/fast-slow` — velocity JOIN excludes Physical Stock
  - `GET /api/stocks/negative-stock` — FY + non-FY warehouse breakdown excludes Physical Stock
  - `GET /api/stocks/warehouses` — net_qty JOIN excludes Physical Stock
- **Data preserved:** Physical Stock rows kept in `stock_transactions` for future audit features
- **TODO:** Future — model Physical Stock as absolute stock count event (last count wins, movements apply on top)

### fix(stocks): add s.company_guid to GROUP BY in FY stocks/items query
- SQL error: `subquery uses ungrouped column s.company_guid`

### fix(stocks): FY query JOIN on st.stock_guid = s.name (not s.guid)
- `stock_transactions.stock_guid` stores stock NAME, not UUID


## 2026-06-05 — Expiry Batch Pipeline Fix (All 4 Gaps)

### Files Changed
- `src/controllers/ingestProcessor.js`
- `src/db/schema.js`

### Changes
**Gap 1 (critical):** `processVouchers()` now collects nested `Batchallocations` from `AllVoucher.xml` inventory entries and calls `processBatchAllocations()` post-commit. Was silently dropping data before.

**Gap 2:** `processStocks()` updated to include `batch_enabled`/`expiry_enabled` in INSERT. `stocks` table gets two new columns via `ALTER TABLE IF NOT EXISTS`.

**Gap 3:** `parseExpiryPeriod()` helper added. `processBatchAllocations()` resolves ExpiryDate first → ExpiryPeriod text fallback.

**Field casing fixes:** Added `Batchname`/`Godownname` (AllVoucher.xml uses lowercase 'n') to lookup chains. Added `BilledQty` as fallback qty. Removed all TEMP DEBUG logs.

### DB Result After Sync
- 9,486 rows in `batch_allocations` ✅ (pipeline working)
- expiry_date = 0 populated — expected: this company has no batch-tracked items in Tally
- `batch_enabled = false` for all stocks — confirmed via StockItem.xml flags

### Commit
`e146f39` — pushed to `tallydekho-backend-services`

## 2026-06-06

### fix(stocks): movement-analytics — include sold-out items + last 30 entry dates
- **Bug 1:** `closing_qty > 0` filter excluded sold-out items from list. Fixed with OR EXISTS subquery that includes items with FY outward movement regardless of current closing_qty. Backend now returns `sold_out: true` flag.
- **Bug 2:** Chart was `CURRENT_DATE - 30` window + `type='outward'` only. Replaced with last 30 unique transaction DATES (inward + outward, no date window). Returns `outward_value`, `outward_qty`, `inward_value`, `inward_qty` per date.
- Commit: `cde944b` — tallydekho-backend-services

## 2026-06-08 — Barcode Module (Backend)

### New DB Tables (schema.js)
- `stock_barcodes` — barcode↔stock mapping (company_guid, stock_guid, barcode, type, source, status, sync_target, tally_sync_status)
- `barcode_import_jobs` — bulk import job tracking
- `barcode_import_errors` — per-row import error log
- `inventory_barcode_settings` — per-company barcode config (storage mode, type, auto-sync)

### New APIs (api-v1.js) — all JWT + verifyCompanyOwnership
- `POST /api/inventory/barcodes` — list with pagination, period/group/status/search filters, summary
- `POST /api/inventory/barcodes/generate` — generate barcode (CODE128: TDKxxxx0000001, EAN13: valid checksum)
- `POST /api/inventory/barcodes/link` — link manual/scanned barcode to stock item (duplicate check + validation)
- `POST /api/inventory/barcodes/lookup` — scan lookup by barcode value
- `POST /api/inventory/barcodes/bulk-import` — CSV/paste import with job tracking
- `GET  /api/inventory/barcodes/template` — CSV template download
- `GET  /api/inventory/barcodes/settings` — get barcode settings
- `POST /api/inventory/barcodes/settings` — save barcode settings

### ingestProcessor.js
- `_tallyAliasMayBeBarcode()` helper: detects barcode-like aliases (>=70% numeric, 8-32 chars, no spaces)
- processStocks(): auto-seeds `stock_barcodes` with `source='tally'` when alias looks like barcode

### Commit: `df00776` → tallydekho-backend-services

## 2026-06-24 — Invoice PDF Before Tally Sync Flow (Phase A+B)

### Backend Changes
- `src/db/schema.js`: Added `invoice_uuid UUID DEFAULT gen_random_uuid() UNIQUE` to app_vouchers CREATE TABLE
- `src/socket/socketHandler.js`: `emitVoucherSynced()` now also emits `invoice_posting_updated` with `{referenceNumber, postingTag, invoiceNumberLabel, tallyVoucherNo}`
- `src/routes/tally-write.js`:
  - `POST /voucher/sales`: INSERT now RETURNs `invoice_uuid`, returned in response as `invoiceUuid`
  - `buildVoucherDocument()` helper: builds VoucherDocument from app_vouchers + company/ledger joins
  - `waitForTallyNumber()` helper: polls every 600ms up to maxWaitMs for tally_voucher_no
  - NEW `GET /tally/invoice/:tdkRef/preview`: returns VoucherDocument snapshot
  - NEW `POST /tally/invoice/:tdkRef/share-pdf`: waits up to 10s, returns provisional/final data
- DB migration already applied: `ALTER TABLE app_vouchers ADD COLUMN IF NOT EXISTS invoice_uuid UUID DEFAULT gen_random_uuid() UNIQUE`

### Architecture Decision
- No new tables created — spec's `invoices` → `app_vouchers`, `tally_sync_outbox` → `write_queue`
- PDF generation on-device (expo-print) not backend (no puppeteer/PDF library installed)
- Backend handles the 10s wait logic + provisional/final decision
