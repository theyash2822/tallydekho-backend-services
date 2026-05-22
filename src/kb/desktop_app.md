# TallyDekho — Desktop Agent

## What is the Desktop Agent?
The TallyDekho Desktop Agent is a Windows application that:
- Reads data from Tally Prime
- Syncs it to the TallyDekho backend
- Acts as the bridge between Tally and your mobile/web app

## Installation
- Download the installer from the TallyDekho website or admin panel
- Run on the same Windows PC where Tally Prime is installed
- No special configuration needed — just install and run

## First Launch
- On first launch, the Desktop Agent shows a 6-digit pairing code
- Use this code in the TallyDekho mobile app to pair
- After pairing, the Agent starts syncing automatically

## System Tray Icon
- The Desktop Agent runs in the Windows system tray (bottom-right taskbar)
- Right-click the icon for options: Sync Now, Settings, View Logs, Exit
- Green icon = connected and syncing
- Red/Orange icon = not connected or error

## Sync Frequency
- Auto-sync runs every 10-15 minutes when Tally Prime is open
- Manual sync: right-click tray icon → "Sync Now"
- Or from mobile: Settings → Tally Prime Sync → Sync Now

## What Gets Synced
- All vouchers (Sales, Purchase, Payment, Receipt, Journal, Contra)
- All ledgers with balances
- Stock items with quantities and values
- Stock categories, groups, units
- E-Way Bill details
- E-Invoice (IRN) details
- Company information and financial years

## Pairing Code
- The pairing code is permanent (does not expire)
- It changes only when you unpair and re-pair
- Multiple devices can be paired to the same account (one at a time)

## Common Desktop Issues
- **Agent won't start**: Try running as Administrator
- **Tally not detected**: Make sure Tally Prime is open before starting the Agent
- **Sync stuck**: Close and reopen the Desktop Agent
- **Firewall blocking**: Add exception for TallyDekho Desktop Agent in Windows Firewall

## Updating the Desktop Agent
- When an update is available, the Agent will notify you
- Download the latest version from the same download link
- Install over the existing version — settings and pairing are preserved
