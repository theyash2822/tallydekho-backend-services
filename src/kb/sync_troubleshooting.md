# TallyDekho — Sync Troubleshooting

## Sync Not Working — Checklist
1. Is the TallyDekho Desktop Agent running on the Windows PC?
   - Check system tray (bottom-right of taskbar)
   - If not visible, open it from the Start Menu
2. Is Tally Prime open and running?
   - Desktop Agent requires Tally to be active
3. Are both devices on the same WiFi network?
   - Mobile and PC must be on the same local network (LAN/WiFi)
   - Mobile data (4G/5G) will NOT work — requires same WiFi
4. Is the pairing still active?
   - Check Settings → Tally Prime Sync → should show "Connected"
   - If "Not Paired", re-enter the pairing code

## Desktop Agent Not Connecting
- Try closing and reopening the Desktop Agent
- Check Windows Firewall — allow TallyDekho Desktop Agent through firewall
- Make sure port 3001 is not blocked by antivirus or firewall
- Try running Desktop Agent as Administrator

## Data Not Updating After Sync
- Wait 30-60 seconds for sync to complete — large datasets take time
- Pull to refresh on the dashboard after sync
- Check Settings → Tally Prime Sync → Last Sync timestamp
- If timestamp is old, trigger manual sync: Settings → Tally Prime Sync → Sync Now

## Partial Data / Missing Vouchers
- Some vouchers may be filtered out if they have invalid dates in Tally
- Cancelled vouchers are excluded by design
- Check if the correct Financial Year is selected in TallyDekho

## IP Address Issues
- The Desktop Agent uses the PC's local IP address
- If WiFi reconnects, the IP may change
- Solution: set a static IP on your router for the PC (DHCP reservation)
- Check: if sync was working before and stopped after WiFi change, this is likely the cause

## Mobile Shows "Offline" Badge
- Check WiFi connection on mobile
- Check if Desktop Agent is still running
- The offline badge appears when the last sync was more than a few hours ago

## Auto-Refresh on Mobile
- After each sync, the mobile app automatically refreshes data within a few seconds
- If screens don't refresh: pull down to refresh manually

## Re-Pairing After Issues
1. Go to Settings → Tally Prime Sync → Unpair
2. On Desktop Agent, the new pairing code will appear
3. Enter the new code in the app
4. Wait for re-sync to complete
