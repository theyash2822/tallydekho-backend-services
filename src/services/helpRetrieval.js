/**
 * TallyDekho Help Center — Intent Router + KB Retrieval
 *
 * Architecture:
 *   User Question → keyword scoring → top KB sections → focused system prompt
 *
 * Strategy: lightweight keyword routing (no vector DB, no Pinecone)
 * Token target: 500–1200 tokens per query (vs 3000-10000 for full KB stuffing)
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { semanticSearch, isKBIndexed } from './helpEmbeddings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const KB_DIR     = join(__dirname, '../kb');

// ─── KB Module Registry ────────────────────────────────────────────────────────
// Each module maps to a file and a list of trigger keywords
const KB_MODULES = [
  {
    id: 'pairing',
    file: 'pairing.md',
    keywords: [
      'pair', 'pairing', 'connect', 'connection', '6 digit', 'six digit',
      'pairing code', 'desktop agent', 'link tally', 'tally sync', 'unpair',
      'not paired', 'how to pair', 'connect tally', 're-pair', 'new code',
    ],
  },
  {
    id: 'sync_troubleshooting',
    file: 'sync_troubleshooting.md',
    keywords: [
      'sync', 'syncing', 'not syncing', 'sync not working', 'sync issue',
      'data not updating', 'not updating', 'offline', 'last sync', 'sync now',
      'data missing', 'missing data', 'ip address', 'wifi', 'network', 'reconnect',
      'stuck', 'slow sync', 'auto refresh', 'refresh',
    ],
  },
  {
    id: 'desktop_app',
    file: 'desktop_app.md',
    keywords: [
      'desktop', 'desktop agent', 'windows', 'install', 'installation',
      'download', 'tray', 'system tray', 'agent', 'update agent', 'firewall',
      'administrator', 'tally prime open', 'tally not detected',
    ],
  },
  {
    id: 'vouchers',
    file: 'vouchers.md',
    keywords: [
      'voucher', 'invoice', 'sales invoice', 'purchase invoice', 'create invoice',
      'credit note', 'debit note', 'payment voucher', 'receipt voucher', 'journal',
      'contra', 'new entry', 'add entry', 'create sales', 'create purchase',
      'delivery note', 'quotation', 'estimate', 'sales order', 'purchase order',
      'draft', 'optional entry', 'edit voucher', 'delete voucher', 'daybook',
    ],
  },
  {
    id: 'inventory',
    file: 'inventory.md',
    keywords: [
      'stock', 'inventory', 'item', 'product', 'warehouse', 'godown',
      'reorder', 'low stock', 'out of stock', 'negative stock', 'stock detail',
      'closing qty', 'closing quantity', 'stock value', 'barcode', 'sku',
      'stock group', 'stock adjustment', 'stock transfer', 'batch',
    ],
  },
  {
    id: 'gst',
    file: 'gst.md',
    keywords: [
      'gst', 'gstin', 'gstr', 'gstr-1', 'gstr1', 'gstr-3b', 'gstr3b',
      'gstr-2a', 'gstr-2b', 'gstr-9', 'gstr-4', 'gstr-9c', 'tax return',
      'return filing', 'cgst', 'sgst', 'igst', 'input tax', 'itc',
      'gst portal', 'gst report', 'compliance', 'gst data', 'tax',
    ],
  },
  {
    id: 'e_invoice',
    file: 'e_invoice.md',
    keywords: [
      'e-invoice', 'einvoice', 'irn', 'invoice reference', 'e invoice',
      'irn generation', 'irn number', 'irn pending', 'cancel irn',
      'einvoice portal', 'nic portal', 'irn cancelled',
    ],
  },
  {
    id: 'eway_bill',
    file: 'eway_bill.md',
    keywords: [
      'eway bill', 'e-way bill', 'ewb', 'e way bill', 'eway',
      'ewb number', 'transport', 'shipment', 'goods movement',
      'eway portal', 'ewb expiry', 'ewb generation', 'eway status',
    ],
  },
  {
    id: 'reports',
    file: 'reports.md',
    keywords: [
      'report', 'reports', 'p&l', 'profit and loss', 'profit & loss',
      'balance sheet', 'trial balance', 'bill ageing', 'ageing', 'aging',
      'daybook', 'cash register', 'financial report', 'outstanding',
      'receivable', 'payable', 'ledger statement', 'audit trail',
    ],
  },
  {
    id: 'ai_insights',
    file: 'ai_insights.md',
    keywords: [
      'ai insights', 'insights', 'recommendation', 'forecast', 'revenue forecast',
      'expense spike', 'top customer', 'top supplier', 'stockout', 'receivables risk',
      'business highlights', 'ai recommendation', 'analytics', 'historical',
      'current fy', 'cash flow projection',
    ],
  },
  {
    id: 'settings',
    file: 'settings.md',
    keywords: [
      'settings', 'profile', 'pin', '2fa', 'biometric', 'face id', 'fingerprint',
      'language', 'currency', 'date format', 'notification', 'voucher config',
      'invoice format', 'qr code', 'logo', 'company logo', 'license',
      'subscription', 'change pin', 'forgot pin', 'security',
    ],
  },
  {
    id: 'payment_reminders',
    file: 'payment_reminders.md',
    keywords: [
      'payment reminder', 'reminder', 'due date', 'overdue', 'whatsapp reminder',
      'send reminder', 'bill outstanding', 'outstanding bill', 'receivables',
      'customer payment', 'collect payment',
    ],
  },
  {
    id: 'mobile_app',
    file: 'mobile_app.md',
    keywords: [
      'app', 'mobile app', 'navigation', 'bottom tab', 'dashboard', 'home screen',
      'how to find', 'where is', 'how to access', 'pdf share', 'share invoice',
      'company switch', 'fy switch', 'financial year switch', 'search',
    ],
  },
  {
    id: 'web_portal',
    file: 'web_portal.md',
    keywords: [
      'web portal', 'browser', 'website', 'web app', 'desktop browser',
      'web version', 'portal', 'chrome', 'firefox', 'web login',
    ],
  },
  {
    id: 'faq',
    file: 'faq.md',
    keywords: [
      'login', 'otp', 'logout', 'account', 'sign in', 'offline', 'demo data',
      'real data', 'multiple device', 'password', 'forgot', 'how do i',
      'what is', 'support', 'contact', 'help',
    ],
  },
];

// ─── KB Content Cache (loaded once, stays in memory) ───────────────────────────
const kbCache = new Map();

function loadKB(filename) {
  if (kbCache.has(filename)) return kbCache.get(filename);
  try {
    const content = readFileSync(join(KB_DIR, filename), 'utf-8');
    kbCache.set(filename, content);
    return content;
  } catch {
    return null;
  }
}

// ─── Intent Scoring ────────────────────────────────────────────────────────────
// Returns top N KB module IDs sorted by keyword match score
function scoreModules(question, topN = 3) {
  const q = question.toLowerCase();
  const scored = KB_MODULES.map(mod => {
    let score = 0;
    for (const kw of mod.keywords) {
      if (q.includes(kw)) {
        // Longer keyword = more specific = higher score
        score += kw.split(' ').length;
      }
    }
    return { id: mod.id, file: mod.file, score };
  });

  // Sort by score desc, take top N with score > 0
  const top = scored
    .filter(m => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  // Always include faq.md as a fallback if nothing matched
  if (top.length === 0) {
    const faqMod = KB_MODULES.find(m => m.id === 'faq');
    if (faqMod) top.push({ id: 'faq', file: faqMod.file, score: 0 });
  }

  return top;
}

// ─── Main Retrieval Function ───────────────────────────────────────────────────
// Returns: { context: string, modules: string[] }
export function retrieveKBContext(question) {
  const topModules = scoreModules(question, 3);
  const sections   = [];

  for (const mod of topModules) {
    const content = loadKB(mod.file);
    if (content) {
      sections.push(`--- ${mod.id.toUpperCase().replace(/_/g, ' ')} ---\n${content}`);
    }
  }

  return {
    context:     sections.join('\n\n'),
    modules:     topModules.map(m => m.id),
    hasContext:  sections.length > 0,
    method:      'keyword',
  };
}

// ─── Phase 2 Retrieval (semantic search via pgvector) ───────────────────────
// Uses vector similarity search first; falls back to keyword if unavailable
export async function retrieveKBContextSemantic(question) {
  const kbReady = await isKBIndexed();

  if (kbReady) {
    try {
      const results = await semanticSearch(question, 5);
      const seen = new Set();
      const sections = [];
      const modules  = [];

      for (const row of results) {
        // No hard threshold — in a bounded product KB, nearest neighbour is always relevant
        sections.push(`--- ${row.section.toUpperCase().replace(/_/g, ' ')} ---\n${row.content}`);
        if (!seen.has(row.section)) { seen.add(row.section); modules.push(row.section); }
      }

      if (sections.length > 0) {
        return { context: sections.join('\n\n'), modules, hasContext: true, method: 'semantic' };
      }
    } catch (err) {
      console.warn('[KB] Semantic search failed, falling back to keywords:', err.message);
    }
  }

  // Phase 1 fallback
  return { ...retrieveKBContext(question), method: 'keyword-fallback' };
}

// ─── System Prompt Builder ─────────────────────────────────────────────────────
export function buildSystemPrompt(kbContext) {
  return `You are the TallyDekho Support Assistant — an AI built specifically to help users of TallyDekho, a mobile and web app that syncs with Tally Prime accounting software.

STRICT RULES:
1. Use ONLY the KB context provided below to answer questions.
2. NEVER invent features, screens, or navigation paths not mentioned in the KB.
3. If the answer is not in the KB, say: "I don't have specific information on that. Please contact support at support@tallydekho.com or WhatsApp +91 90244 66791."
4. Give step-by-step guidance when explaining how to do something.
5. Keep answers concise — 2-4 sentences or a short numbered list.
6. Do not guess or make assumptions about Tally Prime internals.
7. If asked something unrelated to TallyDekho or accounting, politely redirect.

=== KNOWLEDGE BASE ===
${kbContext}
=== END KNOWLEDGE BASE ===

Answer the user's question using ONLY the above knowledge base.`;
}
