/**
 * TallyDekho Help Center — Direct Answer Gate
 *
 * Architecture (per strategy doc):
 *   User Question → Intent Router → KB Retrieval → Direct Answer Check → LLM (last resort)
 *
 * This module tries to answer WITHOUT calling Groq:
 *   1. FAQ exact/semantic match (similarity > 0.82) → return FAQ answer directly
 *   2. High-confidence KB chunk (similarity > 0.78) → extract and return
 *   3. If both fail → caller invokes Groq as last resort
 */

import { embedText } from './helpEmbeddings.js';

// ─── Static FAQ Knowledge Base ─────────────────────────────────────────────────
// Real, accurate TallyDekho product answers (no hallucination risk)
const FAQ_KB = [
  {
    q: 'How do I pair TallyDekho with Tally Prime?',
    a: `Here's the exact pairing process:

1. Install the TallyDekho mobile app on your phone
2. Download the TallyDekho Desktop App and install it on the Windows PC where Tally Prime is installed
3. Open Tally Prime and select your company
4. Open the Desktop App → select your company → enable Auto Sync → tap Start Sync
5. A 6-digit pairing code appears on the Desktop App
6. In the mobile app: Settings → Tally Prime Sync → Enter Pairing Code → enter the 6-digit code
7. Your Tally data will appear in the app within 1–5 minutes

Both the PC and phone must be on the same WiFi network.`,
    keywords: ['pair', 'pairing', 'connect', 'connect tally', 'pair with tally', 'how to pair', 'setup tally', 'link tally'],
  },
  {
    q: 'Pairing code not showing in the Desktop App',
    a: `The pairing code only appears after you start the sync process. Make sure you:

1. Open Tally Prime first (it must be running)
2. Open the TallyDekho Desktop App
3. Select your company from the dropdown
4. Click "Start Sync" — the 6-digit code will appear after sync starts

If Tally Prime is not open, the Desktop App won't detect it and won't show the pairing code.`,
    keywords: ['pairing code', 'code not showing', 'no code', 'code not visible', 'where is code', 'code not appearing'],
  },
  {
    q: 'My Tally data is not showing after pairing',
    a: `After pairing, the first sync takes 1–5 minutes. Try these steps:

1. Wait 2–5 minutes — first sync can be slow for large Tally data
2. Check that Tally Prime is open and running on the PC
3. Check that the TallyDekho Desktop App is running (look in system tray)
4. Verify both devices are on the same WiFi
5. Go to Settings → Tally Prime Sync → tap "Sync Now" to force a refresh
6. Pull down to refresh on the Dashboard after sync

If data still doesn't appear, try unpairing and re-pairing.`,
    keywords: ['data not showing', 'no data', 'not syncing', 'tally data missing', 'sync not working', 'data not loading', 'empty dashboard'],
  },
  {
    q: 'Desktop App not detecting Tally Prime',
    a: `For the Desktop App to detect Tally Prime:

1. Make sure Tally Prime is already open before launching the Desktop App
2. Both must be on the same Windows PC
3. Try running the Desktop App as Administrator (right-click → Run as Administrator)
4. Check Windows Firewall — allow the TallyDekho Desktop App through

If Tally is open and still not detected, close both, restart Tally first, then open the Desktop App.`,
    keywords: ['not detecting', 'tally not detected', 'desktop app', 'not found', 'cannot detect tally'],
  },
  {
    q: 'How do I generate a PDF invoice?',
    a: `To share an invoice as PDF:

1. Open the Sales or Purchase tab
2. Tap on any voucher to open it
3. Tap the Share icon (top right)
4. The PDF is generated instantly with your company logo and GST details

To customise the invoice format, go to: Settings → Voucher Config → choose Format 1, 2, or 3. You can also add QR code and Terms & Conditions there.`,
    keywords: ['pdf', 'pdf invoice', 'share invoice', 'generate pdf', 'invoice pdf', 'print invoice', 'share voucher'],
  },
  {
    q: 'How do I set up payment reminders?',
    a: `To set up payment reminders:

1. Go to Settings → Payment Reminders
2. Enable the toggle "Send Payment Reminders"
3. Set the number of days before due date (e.g. 3 days)
4. Choose WhatsApp as the notification channel
5. Save settings

Reminders are sent automatically via WhatsApp when a customer's bill is approaching its due date. The party must have a mobile number stored in Tally's ledger master.`,
    keywords: ['payment reminder', 'reminder', 'due date reminder', 'whatsapp reminder', 'send reminder'],
  },
  {
    q: 'What is an Optional or Draft entry?',
    a: `Optional entries (shown with a purple "Draft" badge) are vouchers saved in TallyDekho but NOT yet posted to Tally Prime.

They are useful for:
- Entries that need approval before going live in Tally
- Pre-booking entries before finalising

To post a draft to Tally: open the voucher → tap "Post to Tally".
To view all drafts: go to Daybook → filter by "My Entries".`,
    keywords: ['optional', 'draft', 'optional entry', 'draft entry', 'not posted', 'post to tally'],
  },
  {
    q: 'Support contact',
    a: `You can reach TallyDekho support at:

📧 Email: support@tallydekho.com
💬 WhatsApp: +91 90244 66791

Tap the email or WhatsApp icon at the top of this screen to contact us directly.`,
    keywords: ['support', 'contact', 'help', 'reach support', 'contact support', 'email support', 'whatsapp support', 'phone number'],
  },
];

// ─── Pre-computed FAQ embeddings (lazy loaded) ────────────────────────────────
let faqEmbeddings = null;

async function getFAQEmbeddings() {
  if (faqEmbeddings) return faqEmbeddings;
  // Embed both the question and key keywords for better matching
  faqEmbeddings = await Promise.all(
    FAQ_KB.map(async (faq) => ({
      ...faq,
      embedding: await embedText(faq.q + ' ' + faq.keywords.join(' ')),
    }))
  );
  return faqEmbeddings;
}

// ─── Cosine similarity helper ─────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ─── FAQ Direct Answer Check ──────────────────────────────────────────────────
// Returns answer string if FAQ match found, null otherwise
export async function tryFAQAnswer(question) {
  try {
    const faqs     = await getFAQEmbeddings();
    const qVec     = await embedText(question);
    let bestScore  = 0;
    let bestAnswer = null;

    for (const faq of faqs) {
      const sim = cosineSim(qVec, faq.embedding);
      if (sim > bestScore) {
        bestScore  = sim;
        bestAnswer = faq.a;
      }
    }

    // High-confidence FAQ match — skip Groq entirely
    const FAQ_THRESHOLD = 0.80;
    if (bestScore >= FAQ_THRESHOLD) {
      console.log(`[Direct Answer] FAQ match (score: ${bestScore.toFixed(3)}) — skipping Groq`);
      return bestAnswer;
    }

    return null; // no confident match
  } catch (err) {
    console.warn('[Direct Answer] FAQ check failed:', err.message);
    return null;
  }
}

// ─── High-Confidence KB Answer Check ─────────────────────────────────────────
// If a KB chunk has very high similarity AND contains a direct step-by-step answer
// we can return it directly without LLM rephrasing
// (conservative threshold to avoid returning partial/wrong chunks)
export function tryDirectKBAnswer(semanticResults) {
  if (!semanticResults || semanticResults.length === 0) return null;
  const top = semanticResults[0];
  // Only return directly if: very high similarity AND chunk is long enough to be a full answer
  if (top.similarity >= 0.78 && top.content.length > 400) {
    console.log(`[Direct Answer] High-conf KB chunk (score: ${top.similarity.toFixed(3)}) — skipping Groq`);
    return top.content;
  }
  return null;
}
