# COMPANY_GUID COLUMN RETIREMENT MATRIX

Date: 2026-09-18 (Phase 3E + rehearsal)

```text
Global UNIQUE(companies.guid):  REMOVED locally / rehearsed on clone
                                RETAINED in production (cutover not executed)
UNIQUE(workspace_id, guid):     ACTIVE locally / rehearsed on clone
```

Phase requirement is that `company_guid` no longer determines ownership — **not**
that every `company_guid` column is deleted. No mass drop is scheduled.

| Table | company_guid meaning | runtime reads | runtime writes | company_id authoritative | constraint deps | drop ready | retain reason / category |
| ----- | -------------------- | ------------: | -------------: | -----------------------: | --------------- | ---------: | ------------------------ |
| companies | EXTERNAL Tally identity (`guid`) | high | ingest/remap | id is PK | UNIQUE(workspace_id,guid) local; UNIQUE(guid) still in prod | NO | RETAIN_AS_TALLY_EXTERNAL_ID |
| ingest_uploads | upload lineage | low | `/ingest/chunk` writes company_id **and** guid | YES (fixed 2026-09-18) | none | NO | TRANSITIONAL_BLOCKED |
| vouchers | dual-write lineage | low | ingest dual | YES | UNIQUE(company_id,guid) | NO | TRANSITIONAL_BLOCKED (column) |
| ledgers | dual-write lineage | low | ingest dual | YES | UNIQUE(company_id,guid) | NO | TRANSITIONAL_BLOCKED |
| stocks | dual-write lineage | low | ingest dual | YES | UNIQUE(company_id,guid) | NO | TRANSITIONAL_BLOCKED |
| voucher_* children | dual-write | low | ingest | YES | company_id compounds | NO | TRANSITIONAL_BLOCKED |
| stock_transactions | dual-write | low | ingest | YES | company_id compound | NO | TRANSITIONAL_BLOCKED |
| groups/warehouses/units/voucher_types | dual-write | low | ingest | YES | company_id uniques | NO | TRANSITIONAL_BLOCKED |
| company_years | dual-write | cut over | sync | YES | UNIQUE(company_id,fin_year) | NO | TRANSITIONAL_BLOCKED |
| company_print_profile | snapshot | config | config | YES PK(company_id) | PK company_id | NO | TRANSITIONAL_BLOCKED |
| company_compliance_config | snapshot | config | config | YES PK(company_id) | PK company_id | NO | TRANSITIONAL_BLOCKED |
| company_inventory_settings | snapshot | config | config | YES | UNIQUE(company_id) | NO | TRANSITIONAL_BLOCKED |
| inventory_barcode_settings | snapshot | config | config | YES PK(company_id) | PK company_id | NO | TRANSITIONAL_BLOCKED |
| payment_mode_posting_map | ownership remnant | partial | dual | PARTIAL | UNIQUE still includes guid | NO | TRANSITIONAL_BLOCKED |
| member_company_access | — | 0 | 0 | YES | PK(membership_id,company_id) | **DROPPED LOCALLY** | DROP (local done) |
| write_queue | Desktop emit snapshot | Desktop | dual-write | YES ownership | none on guid | NO | RETAIN diagnostic; not ownership |
| sync_runs / sync_log | metadata | partial | dual | YES | — | NO | TRANSITIONAL_BLOCKED |
| ai_insights_cache | snapshot | company_id | company_id | YES | UNIQUE(company_id,month_key) | NO | TRANSITIONAL_BLOCKED |
| financial_year_summaries | snapshot | company_id | company_id | YES | UNIQUE(company_id,fy) | NO | TRANSITIONAL_BLOCKED |
| kpi_*_snapshots | snapshot | company_id | company_id | YES | UNIQUE(company_id,…) | NO | TRANSITIONAL_BLOCKED |
| tdk_reference_counters | snapshot | low | write | YES PK(company_id,…) | PK company_id | NO | TRANSITIONAL_BLOCKED |
| app_vouchers / app_masters | dual | writeback | write | YES | — | NO | TRANSITIONAL_BLOCKED |
| raw_tally_records | DEBUG | rare | ingest | YES | — | NO | DEBUG_METADATA |
| workspace_tally_lineage_companies | EXTERNAL | lineage | pairing | N/A | PK(workspace_id,tally_company_guid) | NO | RETAIN_AS_TALLY_EXTERNAL_ID |
| cost_centres | CREATE still guid PK | company_id runtime | dual | YES unique | migrate CREATE TABLE | NO | TRANSITIONAL_BLOCKED |
| integrations / currencies / tax_transactions / tally_*_master | GUID PK/UNIQUE remnant | varies | varies | PARTIAL | still guid | NO | TRANSITIONAL_BLOCKED |

## Categories

- **DROP** — local MCA `company_guid` only (prod pending)  
- **RETAIN_AS_TALLY_EXTERNAL_ID** — `companies.guid`, lineage  
- **RENAME_LATER_TO_TALLY_COMPANY_GUID** — companies.guid only (API plan required)  
- **TRANSITIONAL_BLOCKED** — column kept; ownership must not use it

## Drop rules

- Do **not** mass-drop child `company_guid` columns after UNIQUE cutover.  
- Drop only when: runtime reads=0, writes=0, company_id authoritative, constraints migrated, rollback understood.
- Verification of "company_id authoritative" must be workspace-scoped. Resolving a
  row's owner with `companies.guid = t.company_guid` alone is invalid post-3E —
  see `scripts/verify-company-id-backfill.mjs` (`ambiguous_guid_no_owner`).
