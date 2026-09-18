# COMPANY_GUID REMAINING USAGE AUDIT — Phase 3E

Date: 2026-09-17

## Gate result

```text
Internal paths requiring global Tally GUID uniqueness: 0
GUID UNIQUE CUTOVER ELIGIBLE: YES (local)
UNIQUE(workspace_id, guid): ACTIVE locally
Global UNIQUE(guid): REMOVED locally
```

## Classifications (post-3E)

| Class | Status |
| ----- | ------ |
| EXTERNAL_TALLY_IDENTITY | companies.guid, Desktop, lineage — OK |
| API_BOUNDARY_COMPATIBILITY | companyGuid + workspace → company_id — OK |
| DISPLAY_ONLY | response payloads — OK |
| LINEAGE | workspace_tally_lineage_companies — OK |
| DEBUG_METADATA | raw_tally_records dual-write — OK |
| INTERNAL_OWNERSHIP | company_id only — OK |
| INTERNAL_QUERY | company_id joins/filters — OK |
| AUTHORIZATION | workspace + guid or company_id — OK |
| CACHE_KEY | company_id — OK |
| SYNC_KEY | company_id purge/authority — OK |
| QUEUE_KEY | company_id — OK |
| DEAD | rewriteInsertWithCompanyId, global collision 409, companyOwnershipClause legacy — DELETED |
| UNKNOWN | 0 |

## Master table classifications

| Table | Classification |
| ----- | -------------- |
| tally_country_master | COMPANY_OWNED_DATA (PK company_id,name) — empty/dormant writers |
| tally_state_master | COMPANY_OWNED_DATA (PK company_id,name,country) |
| currencies | COMPANY_OWNED_DATA (UNIQUE company_id,name) — ingest projection |
| tax_transactions | COMPANY_OWNED_DATA (UNIQUE company_id,…) |
| cost_centres | COMPANY_OWNED_DATA (PK company_id,guid) |
| integrations | COMPANY_OWNED_DATA (UNIQUE company_id,type) |
| payment_mode_posting_map | COMPANY_OWNED_DATA (UNIQUE workspace_id,company_id,payment_mode) |

## Local UNIQUE cutover

```sql
-- FKs referencing companies(guid) dropped first
ALTER TABLE companies DROP CONSTRAINT companies_guid_key;
ALTER TABLE companies ADD CONSTRAINT companies_workspace_guid_key UNIQUE (workspace_id, guid);
```

Production: NOT EXECUTED — see COMPANY_IDENTITY_PRODUCTION_CUTOVER.md + RBAC ops tail.
