# BACKEND_MAP.md — td-backend File Map

## src/routes/
| File | Purpose |
|------|---------|
| api-v1.js | All /api/* endpoints (~3500 lines). Primary route file for mobile V4 and web portal |
| auth.js | Legacy /app/auth/* routes |
| companies.js | Legacy /app/companies/* routes |
| data.js | Legacy /app/data/* routes |
| ingest.js | /ingest/* — Tally sync ingest (chunk upload, full sync) |
| pairing.js | /app/pairing/* — device pairing handshake |
| tally-write.js | /tally/* — write-back vouchers to Tally via desktop socket |
| ai.js | /ai/* — AI chat/help routes |
| integrations.js | /integrations/* — external integration hooks |

## src/controllers/
| File | Purpose |
|------|---------|
| ingestProcessor.js | Parses Tally XML payloads → upserts to PostgreSQL. Core sync logic |

## src/db/
| File | Purpose |
|------|---------|
| schema.js | pg Pool, query(), getClient(), initSchema() — all CREATE TABLE IF NOT EXISTS |

## src/middleware/
| File | Purpose |
|------|---------|
| auth.js | authMiddleware (JWT verify), generateToken, pre-auth middleware |

## src/socket/
| File | Purpose |
|------|---------|
| socketHandler.js | Socket.io events: sync-start, sync-data, sync-complete, pairing events |

## src/services/
| File | Purpose |
|------|---------|
| aiInsights.js | Groq API (llama-3.1-8b-instant) — AI financial narration |
| aiAnalytics.js | Analytics data prep for AI |
| whatsapp.js | Cronberry WABA OTP + payment reminders |
| notifications.js | Push notifications + WhatsApp reminders dispatcher |
| scheduler.js | node-cron: payment reminder scheduler, alert jobs |
| email.js | OTP email fallback |
| push.js | FCM push token management |
| sms.js | SMS OTP fallback |
| helpRetrieval.js | KB search / RAG |
| helpEmbeddings.js | Help KB embedding index |
| helpDirectAnswer.js | Direct answer from KB |

## src/utils/
| File | Purpose |
|------|---------|
| gstClassifier.js | Assigns GST tabs (GSTR1/2B/3B) per voucher |
| taxClassifier.js | Other tax classification helpers |

## src/kb/
Markdown knowledge base files used for RAG/help answers.
Do not modify unless updating help content.

## Root Files
| File | Purpose |
|------|---------|
| src/server.js | App entry: Express setup, route mounting, Socket.io init |
| ecosystem.config.cjs | PM2 process config |
| data/tallydekho.db | SQLite leftover (ignore — app uses PostgreSQL) |
| logs/ | Runtime logs (ignore in agent tasks) |
