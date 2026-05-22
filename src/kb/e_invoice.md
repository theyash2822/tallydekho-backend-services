# TallyDekho — E-Invoice (IRN)

## What is E-Invoice?
E-Invoice is mandatory for businesses above the GST turnover threshold.
It involves generating an Invoice Reference Number (IRN) from the GST portal.

## E-Invoice in TallyDekho
- View E-Invoice status under Reports → Compliance → E-Invoice
- See list of: Pending IRN (eligible invoices without IRN) and Generated IRN list
- TallyDekho does NOT generate IRN directly — it tracks status from Tally

## Pending IRN List
- Shows sales invoices eligible for E-Invoice but without an IRN yet
- Eligibility: Sales invoices (not Sales Orders, Delivery Notes, or Quotations)
- Date gated: only shows invoices from 01-Oct-2020 onwards (government mandate start date)

## Generated IRN List
- Shows invoices that already have an IRN
- Tap "View on Portal" to open https://einvoice1.gst.gov.in/ externally
- Filter by date range (locked to selected FY)

## IRN Cancellation
- Cancelled IRNs are tracked separately (irn_cancelled flag)
- Cancelled IRNs do not count in the generated list

## Common Questions
Q: Why are old invoices (before Oct 2020) not showing in pending?
A: Correct — E-Invoice mandate started 01-Oct-2020. Pre-mandate invoices are excluded.

Q: How do I generate IRN?
A: Generate IRN in Tally Prime using the E-Invoice feature, then sync to TallyDekho.

Q: Pending count seems wrong?
A: Do a fresh sync from Settings → Tally Prime Sync. IRN status updates after each sync.

Q: What if the portal link doesn't open?
A: Check your internet connection. The link opens https://einvoice1.gst.gov.in/ in your browser.
