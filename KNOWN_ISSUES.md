# KNOWN_ISSUES.md — td-backend

## Fixed Issues (for reference)

### Ledger Balance NULL financial_year (Fixed May 2)
- Root cause: `financial_year = NULL` in 26,806 voucher_ledger_entries
- Fix: backfilled financial_year from voucher date
- balType bug: was always storing 'Dr' due to typo — fixed

### Security: Cross-user data leak (Fixed Apr 29)
- Root cause: company-scoped routes missing ownership check
- Fix: `verifyCompanyOwnership()` added to all 45 backend routes

### Socket event mismatch (Fixed Apr 29)
- Desktop emitting "Data Synced", backend listening for "Sync Complete"
- Fix: standardized to consistent event names

### Tally XML UPPERCASE keys (Fixed Apr 30)
- Root cause: parser expected lowercase, Tally sends UPPERCASE
- Fix: `tallyName()` helper normalizes all keys

### Stock qty format (Fixed Apr 30)
- Root cause: `"(-)20 NOS"` format not handled
- Fix: `parseTallyQty()` helper

### Duplicate voucher rows (Fixed Apr 30)
- 3,124 duplicate transaction rows deleted
- 6,871 junk "Voucher" type rows deleted

## Active / Open Issues

### Static DHCP not set (Open)
- Mac IP changes on WiFi reconnect (currently 192.168.29.243)
- Fix: set static DHCP reservation on router — NOT YET DONE
- Workaround: run `ifconfig | grep "inet "` to confirm current IP

### Company Logo Feature (Partial — May 2026)
- Routes exist: POST/GET `/api/company/:guid/logo`
- Backend storage: logo_url column in companies table
- Full feature NOT complete: cross-device sync, web portal upload UI not built

### Mock data still in some web portal pages (Needs verification)
- src/data/*.js files contain mock data (expensesMock, inventoryMock, etc.)
- Some may still be used instead of live API

## Architecture Notes / Gotchas
- `data/tallydekho.db` — SQLite leftover, app uses PostgreSQL, ignore this file
- `ipcRegistry.js` is NOT required from main.js (double-require bug) — all IPC in main.js
- `src/__tests__/critical.test.js` — run before pushing to catch critical regressions
- AI insights uses Groq (llama-3.1-8b-instant) — key in TOOLS.md, never log/expose
