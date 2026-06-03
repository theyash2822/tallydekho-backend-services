# CHANGELOG_AGENT.md — td-backend

Format: Date | Task | Files Changed | Behavior Changed | Tested | Risks

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
