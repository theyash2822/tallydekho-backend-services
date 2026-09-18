# BACKEND_MAP.md — td-backend File Map

## src/routes/
| File | Purpose |
|------|---------|
| api-v1.js | Canonical `/api/*` (mobile V4 + web). Includes workspaceApi mount |
| auth.js | Legacy `/app` auth only (OTP/me/PIN) — LEGACY-BLOCK-APP-AUTH |
| ingest.js | `/ingest/*` — Tally sync ingest (chunk upload, full sync) |
| pairing.js | Mounted at `/desktop` — device pairing handshake |
| tally-write.js | `/tally/*` — write-back vouchers to Tally via desktop socket |
| ai.js | Mounted at `/api/ai` — AI insights / help |
| desktopWorkspace.js | Desktop backup/restore/workspace routes |
| workspaceApi.js | `/api/workspaces/*` team, roles, pairing, billing |

**Deleted (Phase 4–5):** `data.js`, `companies.js`, `integrations.js`, `/app` pairing+ai mounts.

## Membership model (Phase 6)

```text
OWNER | MEMBER
MEMBER → role_id → capabilities / scopes
Admin-equivalent = MEMBER + builtin role system_key=ADMIN
```

## Authorization

| File | Purpose |
|------|---------|
| services/authorizationService.js | Single resolver (`authorize`, `getEffectiveAccess`, `isAdminRole`) |
| middleware/companyAccess.js | Company/FY/scope gate |
| services/capabilityRegistry.js | Capability catalogue (`OWNER` / `OWNER_OR_ADMIN_ROLE`) |
| services/roleService.js | Builtin + custom roles |
| services/workspaceService.js | Invites, members, context |

## Controllers / sync

| File | Purpose |
|------|---------|
| controllers/ingestProcessor.js | Tally XML → PostgreSQL |
| socket/socketHandler.js | WS register / workspace / company rooms |
