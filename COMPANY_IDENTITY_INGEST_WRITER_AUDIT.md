# COMPANY IDENTITY — INGEST WRITER AUDIT (Phase 3C)

Date: 2026-09-17

## Summary

| Item | Status |
|------|--------|
| `wrapIngestClient` | RETAINED — thin pg client wrapper for ingest transactions |
| `rewriteInsertWithCompanyId` | SAFETY NET ONLY — fires warn if INSERT has `company_guid` without `company_id` |
| Explicit `company_id` on ingest INSERTs | DONE for classified streams in `ingestProcessor.js` |
| Magic SQL rewrite as primary path | REMOVED (no longer required when writers are explicit) |

## Preferred architecture (target)

```text
resolveCompanyForDevice / resolveCompanyInWorkspace
  → ingestCompanyCtx.run({ companyId, companyGuid })
  → INSERT … (…, company_guid, company_id) VALUES (…, $guid, currentCompanyId())
```

Not:

```text
opaque client.query rewrite mutating SQL strings
```

## Streams with explicit company_id

| Stream / table | Explicit company_id | Notes |
|----------------|--------------------:|-------|
| raw_tally_records | YES | |
| ledgers (masters + full) | YES | |
| stocks + stock_barcodes | YES | |
| vouchers (+ children items) | YES | |
| voucher_ledger_entries | YES | |
| voucher_inventory_items | YES | |
| voucher_items | YES | |
| groups | YES | |
| stock_transactions | YES | incl. opening balance |
| stock_fy_valuation | YES | |
| gst_voucher_details | YES | |
| bill_outstanding | YES | |
| tax_transactions | YES | |
| warehouses / units / voucher_types | YES | |
| stock_categories | YES | |
| batch_allocations | YES | |
| currencies | YES | |
| ledger_fy_balances | YES | |

## `rewriteInsertWithCompanyId` risk analysis

| Risk | Assessment |
|------|------------|
| Parses SQL safely? | Heuristic only — first `INSERT INTO t (cols)` + first `VALUES (...)` close paren |
| Formatting / aliases / RETURNING / CTEs | Can miss multi-statement, CTE wrappers, or non-standard layouts |
| ON CONFLICT | Appends `company_id = COALESCE(EXCLUDED…)` when DO UPDATE present |
| Silent permanent infra? | **No** — Phase 3C makes explicit writers primary; rewrite only warns + patches gaps |
| company_id vs company_guid mismatch? | Prevented when both come from same `ingestCompanyCtx` store |

## Remaining rewrite role

Keep until a CI assertion proves zero safety-net firings across ingest fixtures, then delete `rewriteInsertWithCompanyId` and simplify `wrapIngestClient` to identity (or remove if unused).

## wrapIngestClient legitimate behavior

- Binds `client.query` for transaction-scoped ingest
- Still runs safety-net rewrite (no-op when `company_id` already in INSERT head)
- Do not delete solely because rewrite lived here
