# BLUEPRINT.md — td-backend

## Stack
- Runtime: Node.js + Express (ESM)
- DB: PostgreSQL (pg pool, max 20 connections)
- Realtime: Socket.io (WebSocket + polling fallback)
- Auth: JWT (Bearer token) + OTP via Cronberry WABA WhatsApp
- Process manager: PM2 (ecosystem.config.cjs)
- Port: 3001

## Entry Point
`src/server.js` — bootstraps Express, Socket.io, DB schema, scheduler, all routes

## Route Prefix Map
| Prefix | File | Notes |
|--------|------|-------|
| `/app/*` | src/routes/auth.js, companies.js, data.js, pairing.js | Legacy mobile/web routes |
| `/api/*` | src/routes/api-v1.js | Primary route file (V2 spec, all new endpoints) |
| `/ingest/*` | src/routes/ingest.js | Tally sync data ingest (from desktop) |
| `/tally/*` | src/routes/tally-write.js | Write-back to Tally (create vouchers) |
| `/ai/*` | src/routes/ai.js | AI insights (Groq) |
| `/integrations/*` | src/routes/integrations.js | External integrations |
| `/health` | server.js | Health check — no auth |

## Key Modules
- `src/controllers/ingestProcessor.js` — processes Tally sync payloads, writes to DB
- `src/db/schema.js` — PostgreSQL pool + `initSchema()` (creates all tables)
- `src/middleware/auth.js` — JWT authMiddleware + generateToken
- `src/socket/socketHandler.js` — Socket.io event handlers (sync, pairing, status)
- `src/services/scheduler.js` — cron jobs (payment reminders, alerts)
- `src/services/aiInsights.js` — AI narration via Groq (llama-3.1-8b-instant)
- `src/services/whatsapp.js` — OTP via Cronberry WABA (template: otp_international)
- `src/services/notifications.js` — push + WhatsApp payment reminders
- `src/utils/gstClassifier.js` — GST tab classification per voucher type

## Auth Flow
1. POST /api/auth/send-otp → sends OTP via WhatsApp (Cronberry)
2. POST /api/auth/verify-otp → returns `pre_auth_token` (if 2FA) or `access_token`
3. POST /api/auth/verify-pin → (2FA) verifies PIN, returns full `access_token`
4. All subsequent requests: `Authorization: Bearer <access_token>`

## Security Rules
- `verifyCompanyOwnership()` must be called on all company-scoped routes
- Rate limiting on OTP routes (20 req / 15min window)
- Helmet + CORS configured in server.js

## Data Flow
Desktop (Tally XML) → `/ingest/*` → `ingestProcessor.js` → PostgreSQL
Mobile/Web → `/api/*` → PostgreSQL → JSON response

## Details
- API contracts: API_CONTRACT.md
- DB schema: DB_CONTRACT.md
- Sync pipeline: SYNC_PIPELINE.md
- Task routing: TASK_ROUTING.md
