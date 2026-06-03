# API_CONTRACT.md — td-backend

All routes under `/api/*` in `src/routes/api-v1.js`.
Auth header required on all routes (except /auth/send-otp, /auth/verify-otp): `Authorization: Bearer <token>`
Company-scoped routes require `?companyGuid=<guid>` query param.

## Auth
| Method | Path | Notes |
|--------|------|-------|
| POST | /api/auth/send-otp | Body: {mobile}. Sends OTP via WhatsApp/email |
| POST | /api/auth/verify-otp | Body: {mobile, otp}. Returns access_token or pre_auth_token (2FA) |
| POST | /api/auth/verify-pin | Pre-auth token required. Body: {pin} |
| POST | /api/auth/set-pin | Body: {pin} |
| POST | /api/auth/reset-pin | Pre-auth token. Body: {pin} |
| DELETE | /api/auth/remove-pin | Removes PIN |
| PATCH | /api/auth/set-biometric | Body: {enabled: bool} |
| GET | /api/auth/two-fa-status | Returns 2FA config |
| POST | /api/auth/change-phone | Body: {new_mobile, otp} |
| POST | /api/auth/change-email | Body: {email} |
| POST | /api/auth/register | Body: {name} |
| GET | /api/auth/me | Returns user profile |
| PATCH | /api/auth/me | Updates user profile |
| POST | /api/auth/logout | Clears token |

## Tally Sync / Pairing
| Method | Path | Notes |
|--------|------|-------|
| POST | /api/tally-sync/pair | Body: {pairingCode}. Links device to user |
| GET | /api/tally-sync/status | Returns sync/pairing status |
| POST | /api/tally-sync/unpair | Removes device pairing |

## Company
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/companies | List companies for user |
| GET | /api/company/years | ?companyGuid. Financial years |
| GET | /api/company/profile | ?companyGuid |
| PUT/PATCH | /api/company/profile | Update company profile |
| POST | /api/company/:guid/logo | Upload logo |
| GET | /api/company/:guid/logo | Get logo URL |
| GET | /api/company/capabilities | ?companyGuid. Feature flags |

## Dashboard
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/dashboard/kpi-strip | ?companyGuid&fy= |
| GET | /api/dashboard/metrics | ?companyGuid&from&to&fy |
| GET | /api/dashboard/cashflow | ?companyGuid&from&to&fy |
| GET | /api/dashboard/recent-activity | ?companyGuid&fy |

## KPI (individual drill-downs)
| Method | Path |
|--------|------|
| GET | /api/kpi/cash-in-hand |
| GET | /api/kpi/bank-balance |
| GET | /api/kpi/receivables |
| GET | /api/kpi/payables |
| GET | /api/kpi/payments |
| GET | /api/kpi/receipts |
| GET | /api/kpi/loans-ods |
All: ?companyGuid&fy

## Sales
| Method | Path |
|--------|------|
| GET | /api/sales/invoices |
| GET | /api/sales/orders |
| GET | /api/sales/quotations |
| GET | /api/sales/credit-notes |
| GET | /api/sales/delivery-notes |
| GET | /api/sales/ewaybills |
All: ?companyGuid&fy&from&to&page&limit

## Purchase
| Method | Path |
|--------|------|
| GET | /api/purchase/invoices |
| GET | /api/purchase/orders |
| GET | /api/purchase/debit-notes |
All: ?companyGuid&fy&from&to

## Vouchers
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/vouchers | All vouchers. ?companyGuid&fy&type&from&to |
| GET | /api/vouchers/my-entries | App-created entries. ?companyGuid |
| POST | /api/vouchers/my-entries/:id/retry | Retry failed Tally write |
| GET | /api/vouchers/:id | Single voucher detail |

## Ledgers
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/ledgers | ?companyGuid&fy&group&search&page&limit |
| GET | /api/ledgers/fy-balances | FY summary balances |
| GET | /api/ledgers/:id | Single ledger |
| GET | /api/ledgers/:id/statement | Transaction statement |

## Stocks
| Method | Path |
|--------|------|
| GET | /api/stocks/items | ?companyGuid&fy&search&group&warehouse |
| GET | /api/stocks/items/:id | Item detail |
| GET | /api/stocks/items/:id/movements | Movement history |
| GET | /api/stocks/items/:id/godowns | Godown-wise stock |
| GET | /api/stocks/units | All units |
| GET | /api/stocks/groups | All stock groups |
| GET | /api/stocks/warehouses | All warehouses/godowns |
| GET | /api/stocks/warehouses/:id | Warehouse detail |

## Reports
| Method | Path |
|--------|------|
| GET | /api/reports/financial | P&L + Balance Sheet |
| GET | /api/reports/pl-bs | Full P&L / BS breakdown |
| GET | /api/reports/gst | GST register |
| GET | /api/reports/gst-summary | GSTR summary |
| GET | /api/reports/gst-detail | GSTR line items |
| GET | /api/reports/unmatched | Unmatched GST entries |
| GET | /api/reports/other-taxes/summary | |
| GET | /api/reports/other-taxes/transactions | |
| GET | /api/reports/other-taxes/late-challans | |

## Misc
| Method | Path | Notes |
|--------|------|-------|
| GET | /api/daybook | Daily voucher log |
| GET | /api/expenses | Expense vouchers |
| GET | /api/parties | Party ledger list |
| GET | /api/bank-ledgers | Bank account ledgers |
| GET | /api/notifications | User notifications |
| GET | /api/sync-history | Tally sync run log |
| GET | /api/ewaybills | E-Way Bill list |
| GET | /api/ewaybills/status | |
| GET | /api/ewaybills/pending | |
| GET | /api/einvoice/status | |
| GET | /api/einvoice/pending | |
| GET | /api/einvoice/generated | |
| GET | /api/ai/insights | ?companyGuid&fy |
| GET | /api/ai/insights/history/:fy | |
| POST | /api/reminders/send | Send payment reminder |
| POST | /api/push-token | Register FCM token |
| DELETE | /api/push-token | Remove FCM token |

## Settings
| Method | Path |
|--------|------|
| GET/PATCH | /api/user-settings |
| GET/PATCH | /api/notification-settings |
| GET/PATCH | /api/alert-settings |
| GET/PATCH | /api/integration-settings |

## Response Format
```json
{ "success": true, "data": { ... } }
{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." } }
```
