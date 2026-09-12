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
| GET | /api/workspace/approvals | Owner/Admin: pending Hard Sync, latest 3 backups, restore requests |
| POST | /api/workspace/hard-sync/:id/approve | First approval wins |
| POST | /api/workspace/hard-sync/:id/reject | Reject pending Hard Sync |
| GET | /api/workspace/backups | Latest 3 AVAILABLE backups |
| POST | /api/workspace/restore/approve | Body: {code, backupId} — approve new-PC restore |

## Desktop Workspace (device-id + x-device-secret)
| Method | Path | Notes |
|--------|------|-------|
| GET | /desktop/me | Workspace identity, last cloud backup |
| POST | /desktop/claim-credential | Marks device secret claimed |
| POST | /desktop/hard-sync/request | Creates/returns Hard Sync request; auto-approves single-member workspaces |
| GET | /desktop/hard-sync/status | ?requestId |
| POST | /desktop/backup/sessions | Presign/local upload authorization |
| POST | /desktop/backup/sessions/:id/complete | Finalize; latest-3 retention |
| GET | /desktop/backup/list | Latest 3 |
| POST | /desktop/restore/request | Short restore code |
| GET | /desktop/restore/status | Poll approval + download URL |
| POST | /desktop/restore/complete | Body `{ ok, lineageGuids[], restoredFolders[] }`. Folders must overlap backup company names/folder basenames. Activates new device / revokes old |
| PUT | /desktop/backup/objects/:token | Local object-store PUT when S3 is not configured |

## Workspace RBAS / billing (workspaceApi.js)
Header `X-Workspace-Id` preferred; path `:id` binds workspace via `bindWorkspaceParam`.
| Method | Path | Notes |
|--------|------|-------|
| PATCH | /api/workspaces/:id/members/:userId/role | Body `{ roleId }`. Cap: `members.role_assign`. Cannot change Owner |
| POST | /api/workspaces/:id/invitations | Body `{ mobile, roleId, scopes? }`. Existing users only (`INVITEE_NOT_FOUND` 404). TTL 48h. Reserves seat |
| POST | /api/workspaces/:id/transfer/initiate | Owner. Body `{ targetUserId, outgoingRoleId }`. Creates PENDING_CONFIRM + 3 tokens (24h confirm window). Free/base requires ≥1000 credits on Owner wallet. Returns `confirmTokens`/`confirmUrls` in non-prod or when SES mock |
| POST | /api/workspaces/:id/transfer/:transferId/confirm | Body `{ token }` (or `?token=`). Increments confirms; at 3 → PENDING_GRACE (24h) |
| POST | /api/workspaces/:id/transfer/:transferId/revoke | Owner. Cancels PENDING_* transfer |
| POST | /api/workspaces/:id/transfer/:transferId/complete | Owner (or system). After grace: flips Owner, assigns outgoing role, deducts 1000 if base |
| POST | /api/workspaces/:id/reset/request | Owner, base only. PENDING_CONFIRM; phrase `RESET WORKSPACE` |
| POST | /api/workspaces/:id/reset/confirm | Owner. Body `{ phrase }`. 3 confirms → PENDING_GRACE 24h |
| POST | /api/workspaces/:id/reset/execute | Owner after grace. Unpair devices, delete cloud backups, clear lineage, detach companies → Demo, remove non-owners, UNPAIRED |
| POST | /api/workspaces/:id/close/request | Owner, non-base. PENDING_GRACE 24h |
| POST | /api/workspaces/:id/close/execute | Owner after grace. Purge memberships, lifecycle CLOSED |
| GET | /api/billing/usage | Filters: `workspaceId`, `kind`, `limit`. Merges `usage_events` + `wallet_transactions` |
| GET | /api/billing/transactions | Owner wallet_transactions |
| GET/POST | /api/billing/payment-orders | Create PENDING MANUAL order `{ credits, amountInr }`. List Owner orders |
| POST | /api/billing/payment-orders/:id/complete | Owner manual/dev settle (no Razorpay). Credits wallet + invoice. Prod Razorpay: see `createRechargeOrder` / `fulfillRechargePayment` |
| GET | /api/billing/invoices | Owner billing_invoices |
| GET/PUT | /api/workspaces/:id/companies/:companyGuid/payment-mode-map | Uses `payment_mode_posting_map`. PUT body `{ mappings: [{ paymentMode, ledgerGuid, ledgerName }] }` |
| GET | /api/workspaces/:id/companies/:companyGuid/cost-centres | Company cost centres (`guid, name, parent_name`). Empty masters → try voucher allocation tables if present, else `[]`. Requires workspace membership + company access |
| POST | /api/cost-centres | Body `{ companyGuid }`. Same list as workspace GET; company access via `verifyCompanyAccess` |
| POST | /app/cost-centres | Legacy data-route shape `{ status, data: { costCentres } }` |

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
| GET | /api/dashboard/kpi-strip | ?companyGuid&from&to&fy&period — each card: amount_raw + trend_pct + trend_positive (null if no prior) |
| GET | /api/dashboard/metrics | ?companyGuid&from&to&fy&period — `data` is the tile array (mobile-safe) |
| GET | /api/dashboard/chart | ?companyGuid&from&to&fy&period — turnover series: `{ interval, series: [{ date, label, sales, purchase, expenses }] }` (7D/1M day, 3M week, 6M month) |
| GET | /api/dashboard/cashflow | ?companyGuid&from&to&fy&period — totals unchanged. Additive `data.series` `{ date, label, inflow, outflow, net }` + `data.interval` |
| GET | /api/dashboard/recent-activity | ?companyGuid&from&to&fy |
| GET | /api/dashboard/top-customers | ?companyGuid&from&to&fy&period&limit — sales by party: `{ name, amount_raw, revenue, invoices, pct }` |
| GET | /api/dashboard/cost-analysis | ?companyGuid&from&to&fy&period — Direct+Indirect expense heads: `{ total_raw, heads: [{ name, parent, amount_raw, pct }] }` |

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

AR/AP (`/kpi/receivables`, `/kpi/payables`): `total`, `trend_pct` (Total Due vs 30d VLE walkback; null if prior=0), `aging[]` with per-bucket `trend` / lookbacks (Not Due|0–30→30d, 31–60→60d, 61–90→90d, 90+→90d), `due_today` (1d lookback). Filtered overdue/date views: trends null.

## Sales
| Method | Path |
|--------|------|
| GET | /api/sales/invoices |
| GET | /api/sales/vouchers |
| GET | /api/sales/orders |
| GET | /api/sales/credit-notes |
| GET | /api/sales/delivery-notes |
| GET | /api/sales/ewaybills |
All: ?companyGuid&fy&from&to&page&limit&search&partyName
`partyName` (optional): exact party match, case- and whitespace-insensitive. Omit for the full list.

`GET /sales/invoices` — true Sales invoices only (excludes Order/Delivery/Quotation). Default `is_optional=false`; pass `is_optional=true` (proforma) or `is_optional=all`. Each row includes `doc_type`, `voucher_type`, `is_optional`.

`GET /sales/vouchers?docTypes=invoice,order,credit_note,delivery_note,proforma,quotation` — combined Recent feed (server-side OR + single pagination). Omitting `docTypes` selects all six. Rows include `doc_type`.

### GET /api/sales/invoices/:id/credit-note-context
Return-context for the Credit Note (Sales Return) flow. `:id` = invoice GUID (preferred) or voucher number. Requires `?companyGuid=`.
Errors: `INVOICE_NOT_FOUND` (404), `NOT_A_SALES_INVOICE` (400).

`data`:
| Field | Notes |
|-------|-------|
| `invoice` | guid, voucherNumber, voucherType(+Parent), date, partyName, amount, reference, billRefName, tdkRef, financialYear |
| `party` | party ledger master (gstin, address, …) |
| `linkedInvoice` | echo straight back as `linked_invoice` in the POST — invoiceGuid, voucherNumber, billRefName, billRefCandidates, tdkRef |
| `items[]` | itemName, unit, hsn, godown, batch, rate, `soldQty`, `returnedSyncedQty`, `returnedPendingQty`, `previouslyReturnedQty`, `remainingQty`, `isFullyReturned`, `selected:false`, `lines[]` |
| `salesLedgerCandidates[]` | Sales ledgers the invoice actually posted to (the POST validates against this set) |
| `companySalesLedgers[]` | all Sales Accounts ledgers — fallback when the invoice has no synced ledger legs |
| `defaultSalesLedger` | largest invoice Sales leg |
| `taxes[]` | ledgerName, taxAmount, taxableValue, inferred `taxRate` |
| `gst`, `totals`, `otherLedgers` | invoice GST summary / totals / non-sales non-tax legs |
| `priorReturns` | `{ synced[], pending[], hasAny }` |
| `meta` | itemCount, returnableItemCount, fullyReturned, natureOfReturn |

`remainingQty` is cumulative over Credit Notes already synced from Tally (`bill_type='Agst Ref'` against this invoice) **and** app-created Credit Notes still queued.

## Purchase
| Method | Path |
|--------|------|
| GET | /api/purchase/invoices |
| GET | /api/purchase/vouchers |
| GET | /api/purchase/invoices/:id/debit-note-context |
| GET | /api/purchase/orders |
| GET | /api/purchase/debit-notes |
All list routes: ?companyGuid&fy&from&to&page&limit&search&partyName

`GET /purchase/invoices` — true Purchase invoices only (excludes Purchase Order). Default `is_optional=false`; `is_optional=true|all` supported. Rows include `doc_type`.

`GET /purchase/vouchers?docTypes=invoice,order,debit_note` — combined Recent feed. Omitting `docTypes` selects all three.

### GET /api/purchase/invoices/:id/debit-note-context
Purchase Return mirror of credit-note-context. Errors: `INVOICE_NOT_FOUND` (404), `NOT_A_PURCHASE_INVOICE` (400).

Same shape as credit-note-context with Purchase naming:
`purchaseLedgerCandidates`, `companyPurchaseLedgers`, `defaultPurchaseLedger`,
`meta.natureOfReturn = '02-Purchase Return'`.

`remainingQty` counts synced Debit Notes (Agst Ref) + queued `app_vouchers.voucher_type='debit_note'`.

### POST /tally/voucher/debit-note
Purchase Return only — requires `linked_invoice` (Purchase invoice GUID or number).
Numbering prefix **DBN** (`TDK-DBN-*`; series `DBN` when `tallydekho_series`) — does not use Delivery Note `DN`.
XML: VCHTYPE Debit Note, GSTNATUREOFRETURN `02-Purchase Return`, party Dr / inventory+tax Cr, BILLALLOCATIONS Agst Ref.
Response mirrors credit-note (`tdkReferenceNo`, `voucherNumber`, `invoiceUuid`, `queued`, `totals`).

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
| GET | /api/expenses | Expense vouchers. ?type=All\|Direct\|Indirect (anchored `^Direct Expenses?$` / `^Indirect Expenses?$`) & optional `category` (exact ledger parent) |
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
