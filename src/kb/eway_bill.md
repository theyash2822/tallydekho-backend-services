# TallyDekho — E-Way Bill (EWB)

## What is E-Way Bill?
E-Way Bill is required for transporting goods worth more than ₹50,000.
A unique EWB number must be generated before goods move.

## E-Way Bill in TallyDekho
- Access via Reports → Compliance → E-Way Bill
- See: Pending EWBs (eligible without EWB number) and Generated EWBs
- Donut chart shows Generated / Pending / Expired breakdown

## Pending EWB List
- Sales and Purchase invoices eligible for EWB but without an EWB number
- Date gated: only from 01-April-2018 (EWB mandate start date)
- Excludes: Sales Orders, Delivery Notes, Quotations (not eligible)

## Generated EWB List
- Invoices with an EWB number assigned
- Tap "View Details" to open https://ewaybillgst.gov.in/ externally
- Filter by date range locked to selected FY

## EWB Expiry
- E-Way Bills expire based on distance and validity period
- Expired EWBs are tracked and shown in the compliance dashboard

## Transport Mode
- Transport mode (Road / Rail / Air / Ship) shown per voucher
- Source: synced from Tally e_way_bill_details

## Common Questions
Q: Why is my EWB count zero?
A: Check if EWB numbers are entered in Tally Prime. Sync again from Settings → Tally Prime Sync.

Q: How do I generate an EWB?
A: Generate on https://ewaybillgst.gov.in/ or through Tally Prime. Then sync to TallyDekho.

Q: Old invoices from 2017 are showing in pending?
A: The date filter should exclude pre-April-2018 invoices. If they appear, trigger a fresh sync.

Q: EWB chart shows wrong numbers?
A: Sync your data first. The chart pulls from the latest synced data.
