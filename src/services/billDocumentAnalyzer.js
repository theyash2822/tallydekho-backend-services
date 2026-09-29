/**
 * Vendor bill document check (no LLM, no paid API).
 *   PDF with a text layer → unpdf text extraction
 *   Photo (JPEG/PNG/WebP)  → tesseract.js OCR on this server
 * Then rule-based scoring ("does this look like a bill?") + candidate extraction
 * (GSTINs, invoice numbers, totals, IRN) the client matches against the form.
 * Extracted text is never persisted or returned in full.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESSERACT_CACHE = path.resolve(__dirname, '../../.cache/tesseract');

const OCR_TIMEOUT_MS = 20_000;
const MAX_PDF_PAGES = 10;
const MIN_TEXT_CHARS = 30;
export const BILL_SCORE_THRESHOLD = 6;

let _workerPromise = null;
async function getOcrWorker() {
  if (!_workerPromise) {
    _workerPromise = (async () => {
      const { createWorker } = await import('tesseract.js');
      return createWorker('eng', 1, { cachePath: TESSERACT_CACHE });
    })().catch((err) => { _workerPromise = null; throw err; });
  }
  return _workerPromise;
}

// OCR calls share one worker; serialize so concurrent uploads don't interleave.
let _ocrQueue = Promise.resolve();
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}

async function ocrImage(buffer) {
  const run = _ocrQueue.then(async () => {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(buffer);
    return data?.text || '';
  });
  _ocrQueue = run.catch(() => {});
  return withTimeout(run, OCR_TIMEOUT_MS, 'OCR');
}

async function pdfText(buffer) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = Array.isArray(text) ? text.slice(0, MAX_PDF_PAGES) : [String(text || '')];
  return { text: pages.join('\n'), totalPages };
}

// ── GSTIN (with official check-digit) ─────────────────────────────────────────
const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function isValidGstin(g) {
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GST_CHARS.indexOf(g[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36] === g[14];
}

// OCR look-alikes by GSTIN position. A repair is accepted only if the result passes
// the format + mod-36 check digit, and fewer substitutions win.
const AS_DIGIT = { O: '09', D: '0', Q: '09', U: '0', G: '60', I: '1', L: '1', T: '17', J: '1', Z: '27', S: '58', B: '83', A: '4', E: '8' };
const AS_LETTER = { 0: 'OD', 1: 'IL', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 8: 'B', R: 'A', A: 'R', H: 'NM', N: 'MH', M: 'NH', O: 'DQ', D: 'O', V: 'Y', Y: 'V' };
const AS_ANY = { 0: 'O', O: '0', 1: 'I', I: '1', 2: 'Z', Z: '2', 5: 'S', S: '5', 8: 'B', B: '8' };
const DIGIT_POS = new Set([0, 1, 7, 8, 9, 10]);
const LETTER_POS = new Set([2, 3, 4, 5, 6, 11]);
const MAX_GSTIN_FIXES = 3;

function gstinAlternatives(raw) {
  return raw.split('').map((ch, i) => {
    if (i === 13) return ch === 'Z' ? '' : 'Z';
    if (DIGIT_POS.has(i)) return /\d/.test(ch) ? '' : (AS_DIGIT[ch] || '');
    if (LETTER_POS.has(i)) return AS_LETTER[ch] || '';
    return AS_ANY[ch] || '';
  });
}

function repairGstin(raw) {
  const alts = gstinAlternatives(raw);
  const slots = alts.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  const chars = raw.split('');
  const search = (start, left) => {
    if (left === 0) {
      const g = chars.join('');
      return isValidGstin(g) ? g : null;
    }
    for (let s = start; s < slots.length; s++) {
      const pos = slots[s];
      const orig = chars[pos];
      for (const alt of alts[pos]) {
        chars[pos] = alt;
        const hit = search(s + 1, left - 1);
        if (hit) { chars[pos] = orig; return hit; }
      }
      chars[pos] = orig;
    }
    return null;
  };
  for (let k = 1; k <= Math.min(MAX_GSTIN_FIXES, slots.length); k++) {
    const hit = search(0, k);
    if (hit) return hit;
  }
  return null;
}

function extractGstins(upper) {
  const out = new Set();
  const compact = upper.replace(/[ \t]+/g, ' ').replace(/@/g, '0').replace(/\|/g, '1');
  for (const m of compact.matchAll(/[0-9A-Z]{15}/g)) {
    const g = m[0];
    if (isValidGstin(g)) { out.add(g); continue; }
    if (!/^[0-9OQDUGILTJZSBAE]{2}/.test(g)) continue;
    const r = repairGstin(g);
    if (r) out.add(r);
  }
  return [...out].slice(0, 10);
}

// ── Other candidates ─────────────────────────────────────────────────────────
const INV_NO_RE = /(?:TAX\s+INVOICE|INVOICE|INV|BILL|VOUCHER|DOCUMENT|DOC)\s*\.?\s*(?:NO|NUMBER|NUM|#)\s*\.?\s*[:\-#]?\s*([A-Z0-9][A-Z0-9/\-_.]{0,24})/g;
function extractInvoiceNos(upper) {
  const out = new Set();
  for (const m of upper.matchAll(INV_NO_RE)) {
    const v = m[1].replace(/[.\-/]+$/, '');
    if (/\d/.test(v) && v.length >= 1 && v.length <= 24) out.add(v);
  }
  return [...out].slice(0, 10);
}

const MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC';
const DATE_RE = new RegExp(`\\b(\\d{1,2}[/\\-.]\\d{1,2}[/\\-.]\\d{2,4}|\\d{1,2}[\\s\\-]?(?:${MONTHS})[A-Z]*[\\s\\-,]*\\d{2,4})\\b`, 'g');
function countDates(upper) {
  return [...upper.matchAll(DATE_RE)].length;
}

const AMOUNT_RE = /(?:₹|RS\.?|INR)?\s*(\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+\.\d{2})(?!\d)/g;
function parseAmounts(line) {
  const out = [];
  for (const m of line.matchAll(AMOUNT_RE)) {
    const n = Number(m[1].replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0 && n < 1e10) out.push(Math.round(n * 100) / 100);
  }
  return out;
}

const TOTAL_LINE_RE = /\b(GRAND\s+TOTAL|TOTAL\s+AMOUNT|INVOICE\s+(?:TOTAL|VALUE|AMOUNT)|NET\s+(?:AMOUNT|PAYABLE|TOTAL)|AMOUNT\s+PAYABLE|TOTAL\s+PAYABLE|TOTAL)\b/;
function extractAmounts(upper) {
  const lines = upper.split(/\r?\n/);
  const totals = new Set();
  const all = new Set();
  for (let i = 0; i < lines.length; i++) {
    const nums = parseAmounts(lines[i]);
    nums.forEach(n => all.add(n));
    if (TOTAL_LINE_RE.test(lines[i])) {
      // Label and value are often split across adjacent lines in OCR/PDF output.
      const near = nums.length ? nums : parseAmounts(lines[i + 1] || '');
      near.forEach(n => totals.add(n));
    }
  }
  const sortDesc = (s) => [...s].sort((a, b) => b - a);
  return { totalCandidates: sortDesc(totals).slice(0, 15), amounts: sortDesc(all).slice(0, 60) };
}

function extractIrns(upper) {
  return [...new Set([...upper.matchAll(/\b[0-9A-F]{64}\b/g)].map(m => m[0].toLowerCase()))].slice(0, 3);
}

/** Alphanumeric tokens containing a digit — lets the client check the invoice no. appears anywhere. */
function extractTokens(upper) {
  const out = new Set();
  for (const m of upper.matchAll(/[A-Z0-9][A-Z0-9/\-_.]{1,30}/g)) {
    const t = m[0].replace(/[.\-/_]+$/, '');
    if (/\d/.test(t) && t.length >= 2) out.add(t.replace(/[^A-Z0-9]/g, ''));
  }
  return [...out].filter(t => t.length >= 2 && t.length <= 30).slice(0, 500);
}

export function scoreBillText(text) {
  const upper = String(text || '').toUpperCase();
  const gstins = extractGstins(upper);
  const invoiceNos = extractInvoiceNos(upper);
  const { totalCandidates, amounts } = extractAmounts(upper);
  const irns = extractIrns(upper);
  const dateCount = countDates(upper);

  let score = 0;
  const found = [];
  const missing = [];
  const add = (cond, pts, label) => { if (cond) { score += pts; found.push(label); } else missing.push(label); };

  add(gstins.length > 0, gstins.length > 1 ? 4 : 3, 'GSTIN');
  const hasTaxInvoice = /TAX\s*INVOICE|BILL\s+OF\s+SUPPLY/.test(upper);
  const hasInvoiceWord = /\bINVOICE\b|\bBILL\b/.test(upper);
  add(hasTaxInvoice || hasInvoiceWord, hasTaxInvoice ? 3 : 2, '"Invoice" / "Bill" heading');
  add(invoiceNos.length > 0, 2, 'Invoice number');
  add(/\b(CGST|SGST|IGST|UTGST)\b/.test(upper), 2, 'GST tax lines');
  add(/\bHSN\b|\bSAC\b/.test(upper), 1, 'HSN/SAC');
  add(dateCount > 0, 1, 'Date');
  add(totalCandidates.length > 0 || amounts.length >= 2, totalCandidates.length > 0 ? 2 : 1, 'Total amount');
  if (irns.length) { score += 2; found.push('IRN'); }

  const isBill = score >= BILL_SCORE_THRESHOLD
    && (gstins.length > 0 || invoiceNos.length > 0 || totalCandidates.length > 0);

  return {
    isBill,
    score,
    found,
    missing,
    extracted: { gstins, invoiceNos, totalCandidates, amounts, irns, tokens: extractTokens(upper) },
  };
}

/**
 * @param {{ buffer: Buffer, mime: string }} input
 * @returns {Promise<{ readable: boolean, source: 'pdf_text'|'ocr', pages?: number, reason?: string } & Partial<ReturnType<typeof scoreBillText>>>}
 */
export async function analyzeBillDocument({ buffer, mime }) {
  if (mime === 'application/pdf') {
    const { text, totalPages } = await pdfText(buffer);
    if (text.replace(/\s+/g, '').length < MIN_TEXT_CHARS) {
      return {
        readable: false,
        source: 'pdf_text',
        pages: totalPages,
        reason: 'This PDF has no readable text (it looks like a scanned image). Please attach a photo of the bill instead.',
      };
    }
    return { readable: true, source: 'pdf_text', pages: totalPages, ...scoreBillText(text) };
  }
  const text = await ocrImage(buffer);
  if (text.replace(/\s+/g, '').length < MIN_TEXT_CHARS) {
    return {
      readable: false,
      source: 'ocr',
      reason: 'No readable text found in this photo. Take a clear, well-lit photo of the full bill.',
    };
  }
  return { readable: true, source: 'ocr', ...scoreBillText(text) };
}
