// TallyDekho AI Assistant
// Route: POST /app/ai/chat
// Uses OpenAI GPT with a system prompt containing full TallyDekho product knowledge

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { query } from '../db/schema.js';

const router = Router();

const TALLYDEKHO_SYSTEM_PROMPT = `You are the TallyDekho AI Assistant — an expert helper embedded inside the TallyDekho product suite.

TallyDekho is a multi-platform system that syncs Tally Prime accounting data and allows data entry from anywhere:
- Mobile App (React Native): iOS and Android. Real-time sync with Tally Prime.
- Web Portal (React): Browser-based dashboard, reports, and data entry.
- Desktop App (Electron): Runs on the same Windows PC as Tally Prime. Acts as a bridge.
- Backend (Node.js + PostgreSQL): Handles auth, data storage, WebSocket sync.

== HOW IT WORKS ==
1. The Desktop App runs on the same machine as Tally Prime (Windows).
2. It connects to the TallyDekho backend via WebSocket.
3. When a user creates an entry (Sales Invoice, Payment, etc.) from the Mobile App or Web Portal:
   - The entry is sent to the backend
   - Backend emits a WebSocket event to the paired Desktop App
   - Desktop App POSTs the XML to Tally Prime's HTTP port (9000)
   - Tally Prime processes it and returns a response
   - The voucher number is auto-assigned by Tally and returned to the user

== PAIRING ==
- Each user must pair their mobile/web account with the Desktop App.
- Go to Desktop App → Devices → copy the 6-digit pairing code.
- In Mobile App → Settings → Account Pairing → enter the 6-digit code.
- Or in Web Portal → Settings → Tally ERP Sync → enter the 6-digit code.

== DATA ENTRY ==
- Sales Invoice: Mobile → Create → Sales Invoice or Web → Data Entry → Sales Invoice
- Purchase Invoice: Mobile → Create → Purchase Invoice or Web → Data Entry
- Payment Voucher: Mobile → Vouchers → Payment
- Receipt Voucher: Mobile → Vouchers → Receipt
- Journal Voucher: Mobile → Vouchers → Journal
- Contra Voucher: Mobile → Vouchers → Contra
- Credit Note / Debit Note / Delivery Note: Mobile → Notes
- Sales Order / Purchase Order: Mobile → Orders
- Create Party / Ledger / Warehouse / Stock Item: Mobile → Masters

== OPTIONAL ENTRIES ==
- Every data entry form has an "Optional" toggle or "Save as Optional" button.
- Optional entries are saved to Tally as optional vouchers — they do NOT affect books until approved.
- Approve them inside Tally Prime under Optional Vouchers.

== SYNC ==
- Data syncs automatically when the Desktop App is connected and Tally is open.
- Manual sync: Desktop App → Sync Now button.
- Sync includes: Ledgers, Vouchers, Stocks, Bills Outstanding, Balance Sheet, P&L.
- Multi-year support: the app syncs data for all financial years in the company.

== BACKUP & RESTORE ==
- Desktop App → Backup & Restore section.
- Local backup: saved to a folder on the PC (default: C:/ProgramData/TallyDekho/Backups).
- Auto-backup schedule: 1 day / 7 days / 1 month / OFF.
- Restore: click Restore on any backup. If Tally is open, the app will close it first.
- Cloud backups: shown in the backup table (last 2 shown, full list on Web Portal).

== DASHBOARD & REPORTS ==
- Dashboard: shows Sales, Purchases, Outstanding Bills, Cash Balance.
- Sales Register: all sales vouchers with party, amount, date.
- Purchase Register: all purchase vouchers.
- Ledger Book: drill into any ledger to see all vouchers.
- Reports: Profit & Loss, Balance Sheet — pulled from Tally in real-time.
- Inventory: stock summary, godown-wise, item-wise.

== SETTINGS ==
- Profile: name, email, mobile (mobile is read-only, set at registration).
- Company Info: pulled from Tally Prime company data.
- Tally ERP Sync: configure Tally host and port (default port: 9000).
- Language & Region: change display language.

== COMMON ISSUES & FIXES ==
1. "No paired device found" — Desktop App is not running or not connected. Start it and check the connection status.
2. "Tally write timeout" — Tally Prime is not open, or the port is wrong. Open Tally and check Desktop App settings (port 9000).
3. "OTP not received" — Check WhatsApp for the OTP message. OTP expires in 5 minutes.
4. Sync not happening — Check that Desktop App shows "Connected" status. Check Tally is open.
5. Wrong data showing — Do a manual sync from Desktop App.
6. Voucher number not showing — The number is auto-assigned by Tally. If it shows blank, the entry is pending (desktop not connected).
7. Optional entry not affecting books — That's expected behavior. Approve it inside Tally Prime.

== TALLY PRIME REQUIREMENTS ==
- Tally Prime must be running on the same PC as the TallyDekho Desktop App.
- Tally's HTTP port must be enabled: Tally Prime → F12 → Advanced → ODBC/HTTP port = 9000.
- Company must be open in Tally.

== YOUR ROLE ==
- Answer questions about TallyDekho features, troubleshoot issues, guide users step-by-step.
- If asked about accounting concepts (GST, TDS, ledger groups, etc.) — explain them in simple terms.
- Be concise and helpful. Use numbered steps for troubleshooting.
- Never make up features that don't exist in TallyDekho.
- Always refer to the correct platform (Mobile/Web/Desktop) when giving instructions.`;

// POST /app/ai/chat
router.post('/chat', authMiddleware, async (req, res) => {
  const { messages, context } = req.body || {};

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ status: false, message: 'messages array required' });
  }

  // Priority: Groq > OpenAI > rule-based fallback
  const GROQ_KEY    = process.env.GROQ_API_KEY;
  const OPENAI_KEY  = process.env.OPENAI_API_KEY;

  const apiKey  = GROQ_KEY || OPENAI_KEY;
  const apiUrl  = GROQ_KEY
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model   = GROQ_KEY ? 'llama-3.1-8b-instant' : 'gpt-4o-mini';

  if (!apiKey) {
    const lastMsg = messages[messages.length - 1]?.content?.toLowerCase() || '';
    const reply = getRuleBasedReply(lastMsg, context);
    return res.json({ status: true, data: { reply, source: 'local' } });
  }

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: TALLYDEKHO_SYSTEM_PROMPT },
          ...messages.slice(-10),
        ],
        max_tokens: 600,
        temperature: 0.4,
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `API error ${response.status}`);

    const reply = data.choices?.[0]?.message?.content || 'No response from AI.';
    res.json({ status: true, data: { reply, source: GROQ_KEY ? 'groq' : 'openai' } });
  } catch (err) {
    console.error('[AI] LLM error:', err.message);
    const lastMsg = messages[messages.length - 1]?.content?.toLowerCase() || '';
    const reply = getRuleBasedReply(lastMsg);
    res.json({ status: true, data: { reply, source: 'fallback' } });
  }
});

// Rule-based fallback when no OpenAI key configured
function getRuleBasedReply(msg, context) {
  if (msg.includes('pair') || msg.includes('connect') || msg.includes('desktop')) {
    return `To pair your device with the Desktop App:\n1. Open the TallyDekho Desktop App on your Windows PC\n2. Go to the Devices section\n3. Copy the 6-digit pairing code\n4. On Mobile: Settings → Account Pairing → enter the code\n5. On Web Portal: Settings → Tally ERP Sync → enter the code\n\nMake sure Tally Prime is open before pairing.`;
  }
  if (msg.includes('backup') || msg.includes('restore')) {
    return `Backup & Restore:\n• Desktop App → Backup & Restore section\n• Click "Run Backup Now" for immediate backup\n• Set auto-backup schedule: 1 day / 7 days / 1 month\n• To restore: click Restore on any backup in the list\n• If Tally is open, the app will close it first before restoring`;
  }
  if (msg.includes('sync') || msg.includes('not showing') || msg.includes('data')) {
    return `If data is not syncing:\n1. Check Desktop App shows "Connected" status\n2. Make sure Tally Prime is open with the company open\n3. Click "Sync Now" in Desktop App\n4. Check Tally HTTP port is 9000 (Tally → F12 → Advanced Config)\n5. Restart Desktop App if issue persists`;
  }
  if (msg.includes('invoice') || msg.includes('voucher') || msg.includes('entry') || msg.includes('create')) {
    return `To create an entry in Tally:\n1. Open Mobile App or Web Portal\n2. Go to Data Entry section\n3. Fill in the form (party, items, amount)\n4. Click Submit — this sends the entry directly to Tally Prime\n5. The auto-assigned voucher number is shown on success\n\nTip: Use "Save as Optional" to save without affecting books. Approve in Tally Prime later.`;
  }
  if (msg.includes('optional')) {
    return `Optional entries:\n• Optional entries are saved in Tally but do NOT affect books (P&L, Balance Sheet)\n• Use them for draft entries or entries pending approval\n• To approve: open Tally Prime → Vouchers → Optional → select and approve\n• All entry forms have a "Save as Optional" button`;
  }
  if (msg.includes('otp') || msg.includes('login') || msg.includes('password')) {
    return `Login to TallyDekho:\n• Enter your mobile number → receive OTP on WhatsApp\n• OTP expires in 5 minutes\n• If OTP not received, check your WhatsApp and try again\n• No password needed — OTP is the only authentication method`;
  }
  if (msg.includes('tally') && (msg.includes('port') || msg.includes('9000') || msg.includes('connect'))) {
    return `Tally Prime setup:\n1. Open Tally Prime\n2. Press F12 → Advanced Configuration\n3. Enable ODBC/HTTP Server\n4. Set port to 9000\n5. Restart Tally if you changed the port\n6. Open your company in Tally\n\nThe TallyDekho Desktop App connects to port 9000 to read/write data.`;
  }
  if (msg.includes('report') || msg.includes('pl') || msg.includes('balance sheet') || msg.includes('profit')) {
    return `Reports in TallyDekho:\n• Web Portal → Reports → P&L or Balance Sheet\n• Data is pulled from Tally in real-time\n• Select the financial year from the dropdown\n• Multi-year support is available\n\nFor detailed reports, open Tally Prime directly.`;
  }
  if (msg.includes('hello') || msg.includes('hi') || msg.includes('help')) {
    return `Hi! I'm the TallyDekho AI Assistant. I can help you with:\n\n• Pairing your devices\n• Creating invoices and vouchers\n• Sync and connection issues\n• Backup and restore\n• Understanding optional entries\n• Tally Prime setup\n• Reports and data questions\n\nWhat do you need help with?`;
  }
  return `I'm here to help with TallyDekho! You can ask me about:\n• Device pairing and connection issues\n• Creating invoices, vouchers, orders\n• Sync problems\n• Backup and restore\n• Tally Prime configuration\n• Understanding any feature\n\nWhat's your question?`;
}

// POST /app/ai/attachment — email attachment to project@tallydekho.com
router.post('/attachment', authMiddleware, async (req, res) => {
  const { fileName, fileData, fileType, userMessage, userName, userMobile } = req.body || {};
  if (!fileName || !fileData) {
    return res.status(400).json({ status: false, message: 'fileName and fileData required' });
  }

  const SMTP_HOST  = process.env.SMTP_HOST;
  const SMTP_PORT  = parseInt(process.env.SMTP_PORT || '587');
  const SMTP_USER  = process.env.SMTP_USER;
  const SMTP_PASS  = process.env.SMTP_PASS;
  const SUPPORT_TO = 'project@tallydekho.com';

  // If no SMTP configured, log and acknowledge
  if (!SMTP_HOST || !SMTP_USER) {
    console.warn('[AI] Attachment received but SMTP not configured:', fileName);
    return res.json({
      status: true,
      message: 'Attachment received. Add SMTP config to .env to enable email forwarding.',
    });
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransporter({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    const base64Data = fileData.replace(/^data:[^;]+;base64,/, '');

    await transporter.sendMail({
      from: `"TallyDekho Support" <${SMTP_USER}>`,
      to: SUPPORT_TO,
      subject: `[TallyDekho Help] Attachment from ${userName || userMobile || 'User'}`,
      text: `User: ${userName || 'Unknown'} (${userMobile || 'no mobile'})\n\nMessage: ${userMessage || '(none)'}\n\nFile: ${fileName}`,
      attachments: [{
        filename: fileName,
        content: base64Data,
        encoding: 'base64',
        contentType: fileType || 'application/octet-stream',
      }],
    });

    res.json({ status: true, message: `Attachment sent to ${SUPPORT_TO}` });
  } catch (err) {
    console.error('[AI] Email error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to send attachment email' });
  }
});

export default router;
