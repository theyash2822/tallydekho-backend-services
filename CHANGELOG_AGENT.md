# CHANGELOG_AGENT.md

## 2026-07-14 — Journal voucher rewrite + Depreciation on Asset

### Context
Journal create was a stub (wrong API keys, fake JV no). Need single Dr+Cr parity with Payment/Receipt, plus Income-tax WDV depreciation helper.

### Added / Changed
- `POST /tally/voucher/journal`: TDK-JOR / OPT-JOR, `app_vouchers`, numbering policy, narration anchor `TDK Journal:`, omit empty VOUCHERNUMBER, optional `depreciationMeta` in payload.
- `buildVoucherDocument`: journal preview branch (Dr/Cr + depreciation meta).
- Ingest: Journal narration reconciler (per-row + batch).

### Files
- `src/routes/tally-write.js`, `src/controllers/ingestProcessor.js`

---

## 2026-07-14 — Payment leftover Advance NAME + number sync

### Context
Multi-bill Payment (`TDK-PAY-2026-0002`) failed with Tally exception: Advance leftover sent **without** `<NAME>` (reference export uses named Advance; On Account has no NAME). Preview showed "Pending" for Posted `TDK-PAY-2026-0003` because Payment had no narration reconciler (Tally drops `<REFERENCE>`).

### Fix
- Payment + Receipt XML: Advance auto-`TDK-ADV-…` NAME; On Account strips NAME.
- Cash/Bank Payment leg `ISPARTYLEDGER=Yes` (export parity).
- Payment narration reconciler (per-row + batch) mirrors Receipt.
- Preview: `numberPending` / “Posted — Tally series number pending sync”.
- Persist truncated Tally response on write_queue failure.
- Data: `TDK-PAY-2026-0003` → `tally_voucher_no=2`.

### Files
- `src/routes/tally-write.js`, `src/controllers/ingestProcessor.js`

---

## 2026-07-13 — False Posted: empty Tally create (CREATED=0) + Payment bill merge

### Context
`TDK-PAY-2026-0001` showed **Posted** in audit trail but was **not** in Tally. `write_queue.tally_id='0'` / CREATED=0 was treated as success.

### Fix
- `updateWriteQueue`: never mark Posted when `created===0` or `tallyId==='0'`; on failure flip `app_vouchers` to `not_posted`.
- Payment bill XML: merge duplicate Agst Ref names (Tally rejects duplicate bill NAME).
- Outstanding API: collapse duplicate `bill_name` rows per ledger.
- Data repair: `TDK-PAY-2026-0001` → failed / not_posted.

### Files
- `src/routes/tally-write.js`, `src/routes/api-v1.js`

---

## 2026-07-13 — Payment Voucher rewrite (Receipt parity)

### Added / Changed
- `POST /tally/voucher/payment`: multi-bill allocations, instruments, TDK-PAY refs, `app_vouchers`, Settings numbering (`PAY`), cash/bank `ISPARTYLEDGER=No`.
- `createPaymentForInvoice`: pairs Payment with Purchase when Make Payment Now is on.
- `POST /tally/voucher/purchase`: TDK-PUR + `app_vouchers` + `make_payment` pairing.
- `GET /party/outstanding-bills?crOnly=true`: Cr payables for Payment UI.
- `buildVoucherDocument`: payment preview branch (reuses `/invoice/:tdkRef/preview`).

### Files
- `src/routes/tally-write.js`
- `src/routes/api-v1.js`

### Test
- Create Payment with Cr bills + Cash → TDK-PAY row Posted after Tally write.
- Purchase with `make_payment` → paired Payment against PUR TDK ref.

---

## 2026-07-13 — Outstanding polish: date parse + drOnly for Receipt

### Changed
- `ingestProcessor.js` `normalizeDate`: parse `31-Mar-17` / `DD/MM/YYYY` / dashed YYYYMMDD.
- `api-v1.js` `GET /party/outstanding-bills?drOnly=true`: filter Dr receivables for Receipt UI.

### Files
- `src/controllers/ingestProcessor.js`
- `src/routes/api-v1.js`

---

## 2026-07-13 — Receipt preview Not Posted / missing number fix

### Context
`TDK-RCP-2026-0007` posted in Tally as voucher **#10**, but mobile preview showed **Not Posted** / no receipt number.

### Root cause
1. `POST /voucher/receipt` inserted `bill_ref_name` / `bill_type` / `bill_allocated_amount` into `app_vouchers` — columns do not exist → silent insert failure → no lifecycle row.
2. `updateWriteQueue` only marked Posted when Tally ack included `voucherNumber` (often missing for Tally Series; only LASTVCHID).

### Fix
- Removed unused bill_* columns from receipt `app_vouchers` INSERT (bill data stays in `payload` JSON).
- On write success: always set `tally_sync_status=synced` + `books_impact_status=posted`; backfill voucher number from `vouchers` via TDK narration/reference when ack has no number.
- Backfilled `TDK-RCP-2026-0007` → Posted / #10.

### Files
- `src/routes/tally-write.js`

### Test
- Preview `TDK-RCP-2026-0007` → Posted + receipt number 10.
- New receipt create → `app_vouchers` row created; status Posted after Tally write.

---

## 2026-07-13 — BillOutstanding ingest full-refresh + ABS outstanding API

### Context
Receipt bill picker empty because `bill_outstanding` stayed at 0. Desktop Option B ships minimal TDL; backend must accept BILLROW payloads cleanly and expose Dr balances (often negative pending).

### Changed
- `ingestProcessor.js` `processBillOutstanding`: DELETE+INSERT per company; strip commas; skip empty ledger/bill; skip ~0 pending; store Dr/Cr in `bill_type`.
- `api-v1.js` `GET /party/outstanding-bills`: filter `ABS(pending_amount) > 0.005`; return ABS amounts for mobile UI.

### Files
- `src/controllers/ingestProcessor.js`
- `src/routes/api-v1.js`

### QA
`node --check` both files. Device Hard Sync verification pending (DB count + Aai Gee ledger).

---

## 2026-07-06 R3 — Website tags + VAT TIN/CST tag broadening (POST /master/party)

### Context
After R2 mailing win (State + Country now populated in Tally 6.2 History), user did device verification and reported 3 remaining gaps: (a) Website field never saved to Tally (backend received but silently dropped it — per 2026-06-27 decision), (b) VAT Details popup showed Type of Dealer = Regular working but VAT TIN No + CST No were blank, (c) Bank Details not needed on customer ledgers. This changelog covers (a) and (b); item (c) is a mobile-side change (see tallydekho-mobile-V4 changelog).

### Added
- **tally-write.js Website tags (4 variants):** Inside `<LEDGER>` XML right after email tags: `<WEBSITE>` + `<LEDGERWEBSITE>` + `<CONTACTWEBSITE>` + `<HOMEPAGE>`. All conditional on `website` truthy. Belt-and-suspenders — Tally silently drops unknown tags, so extras are safe.
- **tally-write.js VAT TIN/CST broadening:** VAT block stays flat (user confirmed no History popup on VAT Details page — VAT does NOT historise in Tally 6.2). Added 3 TIN variants + 1 new CST variant:
  - TIN goes to `<VATTINNUMBER>` (user research suggests this is real Tally field) + `<STATEVATTINNUMBER>` (kept from before) + `<SALESTAXNUMBER>` (Tally 'Sales Tax No.' field, per user example) — all pointing to `vatDetails.vatTin`
  - CST goes to `<INTERSTATESTNUMBER>` (Inter-State ST No. = CST semantically, likely winner) + `<CSTNUMBER>` (kept from before) — both pointing to `vatDetails.cstNo`
  - `<VATDEALERTYPE>` unchanged (already saving correctly)
  - `<ISAGAINST_FORM_C>` unchanged

### Not changed
- `LEDMAILINGDETAILS.LIST` wrapper (R2 win intact)
- GST / Bank / PAN / Phone / Email blocks
- Mobile payload (website already sent since 2026-06-27; vatDetails structure already correct)
- DB schema, route contract

### QA
🟢 GREEN — LITE subagent (11 checks all passed): backend syntax, Website tag block position + count + escapeXml usage, VAT tag order + duplication check, mobile TypeScript 0 errors, git diff scope (2 repos, only expected files), backend health 200, R2 mailing regression sanity (all 4 country + 5 state variants inside wrapper intact).

### Strongest bets on winning tag names
- **Website:** `<WEBSITE>` or `<LEDGERWEBSITE>` — no strong prior evidence
- **VAT TIN:** `<VATTINNUMBER>` (matches user research)
- **CST:** `<INTERSTATESTNUMBER>` (semantically aligned with Tally's 'Inter-State ST No.' label)

### Files
- `src/routes/tally-write.js`

### Commit
`5343e8c` on `main`

### 🔴 Pending user device verification
Create fresh test ledger via mobile with Website filled + VAT Details toggle ON + VAT TIN + CST filled. Then in Tally:
1. Alter the ledger → flat view: **Website** field should now show a value.
2. Alter → Set/Alter VAT Details → Yes → VAT Details popup: **VAT TIN No.** + **CST No.** should now show values (not blank).
3. Type of Dealer stays 'Regular' (already working).

**Possible outcomes:**
- 🟢 All 3 fields populated → R4 cleanup: trim to just the winning tag names.
- 🟡 Some populated, some blank → tells us which tag won → trim losers.
- 🔴 None populated → different approach needed (maybe country pre-existing master issue since VAT unlocks only when country/state present).

---

## 2026-07-06 R2 — State + Country tag broadening inside LEDMAILINGDETAILS.LIST (POST /master/party)

### Context
R1 (commit `934a75e`) got Address + Pincode saving correctly inside TallyPrime 6.2's Mailing Details History collection. But State + Country still showed "Not Applicable" in the History row — because `<STATENAME>` and `<COUNTRYNAME>` are likely wrong tag names INSIDE the historised wrapper. Our working GST block (`LEDGSTREGDETAILS.LIST`) uses `<STATE>`, not `<STATENAME>` — that's the Tally convention inside `.LIST` wrappers. Belt-and-suspenders: throw multiple tag variants for both fields, country-first ordering (Tally UI dependency: pick country → unlocks state list).

### Changed
- **tally-write.js** — Broadened tag coverage inside the existing `LEDMAILINGDETAILS.LIST` wrapper block. Country variants: `<COUNTRYNAME>` + `<COUNTRYOFRESIDENCE>` + `<COUNTRY>` + `<LEDCOUNTRYNAME>` (4 total, emitted BEFORE address block). State variants: `<LEDSTATENAME>` + `<STATENAME>` + `<STATE>` + `<PLACEOFSUPPLY>` + `<PRIORSTATENAME>` (5 total, emitted AFTER address block). All conditional on truthy value — no empty tags emitted. Tally silently drops unknown tags, so extras are safe.

### Not changed
- Address / Pincode inside wrapper (both working from R1)
- `APPLICABLEFROM`, `LEDGERMAILINGNAME`, `ISUPDATINGADDRESS=Yes` (all working from R1)
- Flat top-level tags (kept as fallback for pre-6.2)
- GST / Bank / PAN / Phone / Email blocks
- Mobile payload, DB schema, route contract

### QA
🟢 GREEN — LITE subagent (all 6 checks passed): syntax OK, wrapper structure intact, tag order correct, no regressions to R1 wins, `git diff --stat` scoped to single file (+17/-3), backend health 200.

### Bet on which tag wins
- **State:** strongest bet is `<STATE>` (matches GST historised pattern).
- **Country:** strongest bet is `<COUNTRYOFRESIDENCE>` (Tally's traditional ledger master field name).

### Files
- `src/routes/tally-write.js`

### Commit
`f4e7018` on `main`

### 🔴 Pending user verification (device test)
Create one fresh test ledger via mobile with full address + state (Rajasthan / MP / whatever) + country=India + pincode. Then in Tally: Alter → More Details → Mailing Details (History) popup. Expected: new row shows `UpdateAddress=Yes` + State + Country populated (not "Not Applicable"). Also verify flat Alter view shows State + Country.

**If both light up:** 🟢 done. R3 (cleanup): trim to just the winning tag names.
**If only one lights up:** 🟡 tells us which set won → trim the loser → focus on the failing field.
**If neither lights up:** 🔴 hypothesis C confirmed (Tally requires country/state master preload) → different approach: add `<COUNTRY>` + `<STATE>` master creation XML before ledger XML.

---

## 2026-07-06 — Tally 6.2 mailing details historisation fix (POST /master/party)

### Context
User reported (with screenshots) that new ledgers created via mobile app (`ledger/create.tsx` + `create-invoice.tsx > AddCustomerDrawer`) had NAME + GSTIN saving to Tally correctly, but Address / State / Country / Pincode were being silently dropped. Alter view showed the new **Mailing Details (History)** popup with a single row: `UpdateAddress=No, State=Not Applicable, Country=Not Applicable, Pincode=blank`. TallyPrime 6.2 changed Mailing Details from a flat block to a dated history collection (same pattern as GST since 6.0). Old flat top-level tags are silently ignored by 6.2 unless a history entry with `UpdateAddress=Yes` exists.

### Added
- **tally-write.js** — New `LEDMAILINGDETAILS.LIST` dated wrapper block emitted inside `<LEDGER>` XML, right after `${bankXml}`. Contains `<APPLICABLEFROM>` (today YYYYMMDD, same helper as GST `_gstDate`), `<LEDGERMAILINGNAME>`, `<ISUPDATINGADDRESS>Yes</ISUPDATINGADDRESS>` (flips the 'Update Address' flag in the History popup from No -> Yes), `<ADDRESS.LIST TYPE="String">` with per-line `<ADDRESS>` children, `<STATENAME>`, `<COUNTRYNAME>`, `<PINCODE>`. Emitted only when `hasMailingData` (addressLines.length || state || country || pincode) is truthy so no empty block is sent when payload is bare.

### Consolidated (2026-07-02 unstaged fixes committed today)
- **tally-write.js** — `LEDMULTIADDRESSLIST.LIST` block removed entirely. It requires the 'Maintain multiple mailing details for company and ledgers = Yes' feature enabled in the Tally company; when off, the block poisoned the whole mailing import.
- **tally-write.js** — `<PARENT>` tag moved to immediately after `<NAME>` so Tally resolves the group hierarchy before applying field bindings.

### Kept (fallback, harmless if 6.2 ignores)
All flat top-level tags: `<LEDSTATENAME>`, `<STATENAME>`, `<PRIORSTATENAME>`, `<PLACEOFSUPPLY>`, `<COUNTRYNAME>`, `<COUNTRYOFRESIDENCE>`, `<PINCODE>`, `<ADDRESS.LIST TYPE="String">`. Still needed for pre-6.2 Tally versions and for the flat Alter-view display of the current history row.

### Not changed
- Mobile payload (already carries address, state, country, pincode)
- DB schema
- Route contract (`POST /master/party`)
- 3 well-known gotchas the user flagged — all already handled: (a) LEDSTATENAME is primary, (b) ADDRESS.LIST has TYPE="String", (c) LEDMULTIADDRESSLIST.LIST removed.

### QA
🟢 GREEN — LITE subagent (29s): `node --check` OK, `mailingDetailsXml` const uses `_gstDate` correctly, `${mailingDetailsXml}` interpolated exactly once right after `${bankXml}`, all flat fallback tags intact, `hasMailingData` defensive guard present, backend health 200, git diff scoped to single file.

### Highest-risk guesses (may need one iteration)
- Wrapper tag name: `LEDMAILINGDETAILS.LIST` (best guess from Tally `LED*` naming convention)
- Flag tag name: `ISUPDATINGADDRESS` (to flip Update Address No -> Yes)
- Mailing name inside wrapper: `LEDGERMAILINGNAME`

If wrong, State/Country will still show 'Not Applicable' in Alter -> History. Fallbacks to try in order: `MAILINGDETAILS.LIST` -> `LEDMULTIADDRESSLIST.LIST` (re-enable behind company flag) -> `ADDRESSDETAILS.LIST`. Trivial one-tag tweak per iteration.

### Files
- `src/routes/tally-write.js`

### Commit
`934a75e` on `main`

### 🔴 Pending user verification (device test)
Create one test ledger via mobile with full address (line 1 + line 2 + state + country=India + pincode). Then in Tally: Alter the ledger -> More Details -> Mailing Details (History) -> the new row should show `UpdateAddress=Yes` with State/Country/Pincode populated. Flat Alter view should also show Address/State/Country/Pincode.

---

## 2026-07-01 (R5) — Dispatch/EWB address lines + pincode (Sales Invoice)

### Context
User asked to extend Dispatch/E-Way Bill Details in Sales Create Invoice — currently only State + City were sent. NIC EWB requires address line 1/2 + 6-digit pincode for both `from` and `to`. Existing 342 ledgers had no pincode column; company profile did not surface pincode. Went with option (b): add pincode to schema, backfill via ingestProcessor on next sync.

### Added
- **schema.js** — `ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS pincode TEXT;` and `ALTER TABLE companies ADD COLUMN IF NOT EXISTS pincode TEXT;` (both idempotent, safe re-run)
- **ingestProcessor.js** — `extractNativePincode(r)` helper (checks 5 flat variants + nested LEDMULTIADDRESSLIST); wired into both INSERT paths (processMasters + processFullLedger); ON CONFLICT uses `COALESCE(EXCLUDED.pincode, ledgers.pincode)` to preserve existing pincode when Tally doesn't emit one
- **api-v1.js** — `/parties` SELECT now returns `address, state_name, pincode` alongside gstin/gst_reg_type
- **tally-write.js** — party immediate-insert now saves `state_name`, `pincode`, `gst_registration_type` (was previously dropped, blocking prefill until next Tally sync); sales voucher EWAYBILLDETAILS.LIST XML now emits multi-line `<CONSIGNORADDRESS>`/`<CONSIGNEEADDRESS>` (one tag per line) + `<CONSIGNORPINCODE>` + `<CONSIGNEEPINCODE>` with backward-compatible fallback to single-line city when addr1/addr2 both empty
- **ewbGenerator.js** — NIC EWB payload now uses `dispatchDetails.dispatch_from_address1 || dispatch_from` for `fromAddr1`, adds `fromAddr2`, uses `parseInt(dispatchDetails.dispatch_from_pincode) || parseInt(company.pincode) || 0` for `fromPincode`. Symmetric changes for `toAddr1/toAddr2/toPincode`.

### QA
GREEN — QA agent ran static checks (`node -c` × 5 files + `npx tsc --noEmit`), API contract diff, party data-flow trace, prefill guard analysis, theme/color leak scan, schema idempotency check. One safe fix applied by QA (companies.pincode migration was a pre-existing latent gap — added).

### Follow-up (non-blocking)
1. `PUT/PATCH /company/profile` accepts only `gstin, address, state, email, formal_name` — should also accept `pincode` so users can set it once. Existing companies will have NULL pincode until this or a Tally re-sync populates it.
2. `companies.state_code` is referenced by `api-v1.js:3611` but missing from `schema.js` — pre-existing gap, out of scope for this change.

### Files
- `src/db/schema.js`
- `src/controllers/ingestProcessor.js`
- `src/routes/api-v1.js`
- `src/routes/tally-write.js`
- `src/utils/ewbGenerator.js`

### Commit
`1292538` on `main`

---

## 2026-07-01 (R4) — Cross-month sort fix + Invoice/Receipt pair timestamp alignment

### Context
User reported after R3 shipped: June entries above July in Audit Trail. R3 sort ordered only by `av.created_at` — no business-date primary key. If any June row's `created_at` got bumped after July rows existed, it floated above July. **Forensic audit also uncovered a deeper bug in the mobile merge layer + 28 stale `failed` write_queue rows from May 27—June 24 that were pushing themselves to the top via naive `[...pending, ...posted]` concat.** Backend fix here is one of four fixes in R4.

### Fixed
- **R4a** `src/routes/api-v1.js` — `/vouchers/my-entries` ORDER BY now `v.date DESC, av.created_at DESC, av.id ASC`:
  - Primary: business date (v.date is TEXT `YYYY-MM-DD` — lexicographic DESC works)
  - Secondary: entry timestamp (freshest same-day on top)
  - Tertiary: av.id ASC (Invoice→Receipt intra-pair sequence preserved)
- **R4b** `src/routes/tally-write.js` — Invoice+Receipt pair now shares `created_at`:
  - `createReceiptForInvoice()` accepts optional `parentCreatedAt` param
  - Sales invoice INSERT now `RETURNING created_at`; captured into `invoiceCreatedAt`
  - `invoiceCreatedAt` passed as `parentCreatedAt` when chaining Receipt → both share timestamp → av.id ASC tiebreak fires cleanly
  - Fallback (`parentCreatedAt=null`) fires `EXTRACT(EPOCH FROM NOW())::bigint` — legacy callers unchanged
  - Closes R3 YELLOW-flag edge case (1-sec boundary breaking pair order)

### Data operation (not a code commit)
- Soft-archived 28 stale `failed` write_queue rows from user=11 / company=`2272cb4f-...` older than 2026-06-25:
  ```sql
  UPDATE write_queue SET status='archived', updated_at=EXTRACT(epoch FROM now())::bigint
  WHERE user_id=11 AND company_guid='2272cb4f-...' AND status='failed'
    AND created_at < EXTRACT(epoch FROM '2026-06-25'::date)::bigint;
  ```
- Reversible: `status='archived'` doesn't match mobile filters or backend retry logic — hidden but recoverable.

### QA
- **R4a:** Sonnet subagent 🟡 YELLOW — correctly flagged uncommitted `tally-write.js` drift; I unbundled before push.
- **R4b:** Sonnet LITE-mode subagent (3-min time-box) 🟢 GREEN — SQL placeholders match, `node -c` clean, column-type bigint-consistent.

### Live-verified
```
GET /api/vouchers/my-entries?userId=11&limit=10
→ total: 10, pending: 22 (down from 50)
→ top rows: SAL-0030 (07-01), RCP-0004 (07-01), SAL-0029 (07-01), RCP-0003 (07-01), SAL-0028 (06-30), …
```

### Commits
- `008c78a` — fix(my-entries): sort by business date first
- `2dbf825` — fix(tally-write): share created_at between Invoice+Receipt pair

### Lessons
- When user reports sort/order bug, inspect the ACTUAL rendered layer (mobile), not just the query feeding it.
- Naive `[...arrayA, ...arrayB]` merges are landmines when either side can hold stale entries.
- Stale `failed` write_queue rows are UX debt. Follow-up: nightly auto-archive job for `failed > 30d`.

---

## 2026-07-01 (R3) — my-entries sort corrected: Invoice → Receipt within pair

### Fixed
- **R2 sorted intra-pair backwards.** `ORDER BY v.date DESC, v.id DESC` put Receipt above its Sales because `v.id` is Tally-side auto-increment on the `vouchers` table — Receipt is always written to Tally AFTER Sales, so it got higher v.id.
- **R3:** `ORDER BY av.created_at DESC, av.id ASC` — app-side entry timestamp (Sales + chained Receipt share the second) + app-side auto-increment ASC (Sales inserted first → lower id → sorts first) = correct business entry sequence.
- Added `av.created_at`, `av.id` to SELECT projection (Postgres requires DISTINCT sort columns in SELECT).

### Files
- `src/routes/api-v1.js` — GET /vouchers/my-entries only.

### QA
🟡 YELLOW (formal subagent R3) — static + live smoke pass, correct top-4 sequence verified. YELLOW note: old test-data pairs whose two inserts cross a 1-second boundary sort Receipt above Sales (av.created_at differs → av.id tiebreak doesn't fire). Cosmetic; all new pairs correct.

### Follow-up (deferred)
Align `created_at` explicitly when inserting Sales + chained Receipt in `tally-write.js` — pass shared timestamp to both `app_vouchers` INSERTs to guarantee intra-pair sort direction forever.

### Commits
- `b797d7f` → tallydekho-backend-services

---

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

## 2026-07-09 — Receipt Voucher rewrite (multi-bill, instrument, preview, numbering)

**`src/routes/tally-write.js`:**
- Extended `buildVoucherDocument` with `isReceipt` branch — returns receipt-shaped doc (`documentType: 'receipt'`, `receipt.billAllocations`, `receipt.instrument`) before falling through to sales invoice logic. Existing `/tally/invoice/:tdkRef/preview` endpoint now serves receipts too.
- **Full rewrite of `POST /voucher/receipt`**: accepts multi-block `billAllocations[]` (Agst Ref + On Account/Advance leftover), `instrumentDetails`, `paymentMethod`, `ledgerAccount`, `entryType`, `numbering_policy`. Emits multi-block `<BILLALLOCATIONS.LIST>` matching Tally's native receipt XML pattern (verified against user-supplied Voucher #9 reference). Emits `<BANKALLOCATIONS.LIST>` for Cheque/NEFT/RTGS with instrument no + date + bank name + transaction type. Numbering via `generateTDKReference(guid, opt, 'RCP')` + `generateTDSeriesNumber(guid, 'RCP')`. Inserts into `app_vouchers` so preview/share work identically to Sales Invoice. Fixed pre-existing bug: bank leg had `<ISPARTYLEDGER>Yes</ISPARTYLEDGER>` — now `No`. Full XML escaping on all user inputs.
- Response: `{ status, queued, tdkRef, receiptUuid, voucherNumber, numberingPolicy, ... }`.
- `createReceiptForInvoice` (2026-06-30 Collect Payment Now flow) **unchanged**.

**`src/routes/api-v1.js`:**
- Added `GET /party/outstanding-bills?companyGuid=&ledger=` reading `bill_outstanding` (existing table) filtered by ledger + `pending_amount > 0`. Returns `{ bills, totalPending }`.

**QA:** 🟢 GREEN (LITE, 18/18 checks). Backend PID 17279 on :3001.
