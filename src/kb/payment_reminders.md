# TallyDekho — Payment Reminders

## What are Payment Reminders?
Automated reminders sent to customers when their payment is due or overdue.
Reminders are sent via WhatsApp using your registered number.

## Setting Up Payment Reminders
1. Go to Settings → Payment Reminders
2. Enable the toggle: "Send Payment Reminders"
3. Set reminder timing: e.g. "3 days before due date"
4. Choose channel: WhatsApp (currently supported)
5. Save settings

## How It Works
- TallyDekho checks bill_outstanding data from Tally
- When a bill's due date approaches, a WhatsApp message is auto-sent to the party's number
- The party number must be stored in Tally's ledger master

## Reminder Message Content
- Includes: company name, party name, invoice number, amount due, due date
- Sent from your registered WhatsApp number via Cronberry WABA API

## Viewing Outstanding Bills
- Reports → Bill Ageing: shows all outstanding bills grouped by age
- Dashboard → Outstanding KPI card: total outstanding amount
- Tap any party in Bill Ageing to see their individual bills

## Receivables Screen
- Dashboard → tap Outstanding card → goes to Receivables screen
- Shows: all parties with pending amounts, grouped by age bucket (0-30, 31-60, 60+)

## Common Questions
Q: Reminders are not being sent?
A: Check if WhatsApp Notifications are enabled in Settings. Verify the party has a mobile number in Tally.

Q: How do I stop reminders for a specific party?
A: Currently managed at the account level. Selective party exclusion coming in future update.

Q: Can I send reminders manually?
A: Yes — go to Bill Ageing → tap a party → tap "Send Reminder" (WhatsApp icon)

Q: What if the party number is wrong?
A: Update the ledger contact number in Tally Prime and resync.
