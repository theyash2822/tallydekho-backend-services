# TallyDekho — GST Compliance

## GST Overview in TallyDekho
TallyDekho syncs GST data from Tally and provides GSTR report views.
All GST calculations happen in Tally — TallyDekho displays and organises them.

## Available GSTR Reports
- GSTR-1: Outward supply (sales) summary
- GSTR-2A/2B: Inward supply from suppliers (view only)
- GSTR-3B: Summary return (liability vs ITC)
- GSTR-4: Quarterly return for composition dealers
- GSTR-9: Annual return
- GSTR-9C: Reconciliation statement

## Accessing GST Reports
1. Go to Reports tab → Compliance
2. Select the GSTR report you want to view
3. Use the FY selector at the top to switch financial year
4. Use the month filter to narrow results

## GSTR-1 Details
- Shows B2B, B2C, Credit Notes, Debit Notes grouped by month
- Tap a month to expand and see voucher-level details
- Figures are read-only — sourced from Tally sync

## GST Registration (GSTIN)
- Your GSTIN is stored in Settings → Tax Information
- It is used for PDF invoice generation and reports

## GST Gauge on Dashboard
- The compliance dashboard shows a gauge of filed vs unfiled periods
- Based on vouchers with GST data in the selected FY

## Common Questions
Q: Why is GSTR-1 showing pre-GST era vouchers?
A: Switch your FY to post-July 2017 using the FY selector at the top.

Q: How do I file GST from TallyDekho?
A: TallyDekho does not file returns directly. Use the reports to verify figures then file via the GST portal or Tally Prime.

Q: GST figures don't match Tally?
A: Trigger a manual sync from Settings → Tally Prime Sync → Sync Now. Then wait for sync to complete.

## Tax Types Supported
- CGST, SGST, IGST, UTGST, Cess
- TDS, TCS (visible under Reports → Compliance → Other Taxes)
- VAT (historical, for pre-GST FYs)
