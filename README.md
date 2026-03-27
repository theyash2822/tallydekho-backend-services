# TallyDekho Backend Server

Self-hosted backend for TallyDekho ecosystem — connects Desktop, Mobile, and Web Portal.

## Architecture

```
Tally Prime (offline)
      ↕ XML (port 9000)
TallyDekho Desktop (Electron) ← on user's Windows PC
      ↕ REST + WebSocket
TallyDekho Backend (this server) ← YOUR SERVER (local or AWS)
      ↕ REST API (/app/*)
Mobile App (iOS/Android) + Web Portal
```

## Quick Start (Local)

```bash
cd td-backend
npm install
cp .env.example .env   # edit JWT_SECRET
npm run dev            # starts on port 3001
```

## Setup on AWS

1. Launch EC2 (t3.small minimum, Ubuntu 22.04)
2. Install Node.js 22
3. Copy this folder to `/var/app/td-backend`
4. Set environment variables in `.env`
5. Run with PM2:
   ```bash
   npm install -g pm2
   pm2 start src/server.js --name td-backend
   pm2 save && pm2 startup
   ```
6. Setup Nginx reverse proxy on port 443
7. Point your domain DNS to EC2 IP
8. Update mobile app & desktop app base URL to your domain

## How It Works

### Step 1 — Desktop connects to Tally
- Install TallyDekho Desktop on Windows PC with Tally Prime running
- Desktop registers with server: `POST /desktop/register`
- Desktop generates 6-digit pairing code: `GET /desktop/pairing-code`

### Step 2 — Mobile/Web pairs with Desktop
- User logs in with WhatsApp number (OTP)
- User enters 6-digit code from Desktop screen
- Server links the mobile account to the desktop device
- `POST /app/pairing` — pairs them together

### Step 3 — Tally data syncs
- Desktop fetches Tally data (Ledgers, Vouchers, Stock) via XML
- Sends to server in chunks: `/ingest/init` → `/ingest/chunk` × N → `/ingest/complete`
- Server stores in SQLite (or PostgreSQL on AWS)
- Server emits `synced` WebSocket event to mobile + web

### Step 4 — Mobile & Web read data
- All data available via `/app/*` endpoints with JWT auth
- Real-time updates via WebSocket

## API Endpoints

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/app/send-otp` | Send OTP to WhatsApp number |
| POST | `/app/verify-otp` | Verify OTP, get JWT token |
| POST | `/app/verify` | Verify existing JWT token |
| POST | `/app/onboarding` | Save name + language |

### Pairing
| Method | Path | Description |
|--------|------|-------------|
| GET | `/desktop/pairing-code` | Desktop generates 6-digit code |
| POST | `/desktop/register` | Desktop registers on startup |
| POST | `/app/pairing` | Mobile/Web enters pairing code |
| GET | `/app/pairing-device` | Check pairing status |
| DELETE | `/desktop/paired-device` | Unpair device |

### Data (requires JWT)
| Method | Path | Description |
|--------|------|-------------|
| GET | `/app/companies` | List synced companies |
| POST | `/app/ledgers` | List ledgers with search/pagination |
| POST | `/app/ledger` | Single ledger detail |
| POST | `/app/stocks` | List stock items |
| POST | `/app/stock-dashboard` | Stock summary KPIs |
| POST | `/app/vouchers` | List sales/purchase/expense vouchers |
| POST | `/app/dashboard` | Dashboard KPI totals |
| POST | `/app/reports/pl` | Profit & Loss |
| POST | `/app/reports/balance-sheet` | Balance Sheet |

### Ingest (Desktop → Server)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/desktop/init-sync` | Start sync session |
| POST | `/ingest/init` | Init chunked upload |
| POST | `/ingest/chunk` | Upload data chunk |
| POST | `/ingest/complete` | Finalize upload |

## Environment Variables

```env
PORT=3001
JWT_SECRET=your_secret_here_change_in_production
JWT_EXPIRES_IN=30d
DB_PATH=./data/tallydekho.db
NODE_ENV=production
ALLOWED_ORIGINS=https://yourapp.com,https://www.yourapp.com
```

## Desktop App Config Change

In `td-desktop/util/helper.js`, change:
```js
const baseURL = "https://test.tallydekho.com";
// to:
const baseURL = "https://your-backend-domain.com";
```

## Mobile App Config Change

In `src/services/api/config.js`, change:
```js
[ENV.PROD]: 'https://your-backend-domain.com/app',
```

## Web Portal Config Change

In `src/services/api.js`, change:
```js
const BASE_URL = 'https://your-backend-domain.com/app';
```

## Database

SQLite by default. For production AWS, migrate to PostgreSQL:
1. Install `pg` package
2. Replace `better-sqlite3` calls with `pg` queries
3. Same schema works with minor SQL syntax changes

## Upgrading to Production

- [ ] Change `JWT_SECRET` to a strong random string
- [ ] Remove OTP from API response (use WhatsApp Business API or SMS gateway)
- [ ] Add HTTPS via Nginx + Let's Encrypt
- [ ] Set `NODE_ENV=production`
- [ ] Use PostgreSQL instead of SQLite
- [ ] Set `ALLOWED_ORIGINS` to your actual domains
- [ ] Add PM2 for process management
