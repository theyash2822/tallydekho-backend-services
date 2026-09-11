/**
 * Resolve a human-readable party / ledger label for voucher list tiles.
 *
 * Tally often leaves vouchers.party_name NULL on Journal / Sales Order / Proforma
 * (and multi-party vouchers store ledger_name as a JSON array string).
 */

/** `["A","B"]` → `A, B`; plain names pass through. */
export function formatLedgerDisplayName(raw) {
  if (raw == null) return '';
  const t = String(raw).trim();
  if (!t) return '';
  if (t.startsWith('[')) {
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) {
        return parsed.map((x) => String(x ?? '').trim()).filter(Boolean).join(', ');
      }
    } catch {
      // fall through to naive strip
    }
    return t
      .replace(/^\[|\]$/g, '')
      .replace(/"/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
  }
  return t;
}

function ledgerPriority(name = '') {
  const n = String(name);
  if (/profit\s*[& ]\s*loss/i.test(n)) return 9;
  if (/\b(cgst|sgst|igst|utgst|gst|cess|tax)\b/i.test(n)) return 6;
  if (/\b(cash|bank)\b/i.test(n)) return 5;
  if (/\b(sales|purchase)\b/i.test(n) && !/order|return/i.test(n)) return 4;
  return 0;
}

/**
 * Pick the best party-like name from raw Tally AllLedgerEntries (ingest path).
 */
export function pickPartyNameFromLedgerEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return null;
  const scored = entries.map((e) => {
    const name = e.LEDGERNAME || e.LedgerName || e.ledgerName || e.ledger_name || '';
    const amt = Math.abs(parseFloat(e.AMOUNT || e.Amount || e.amount || 0));
    return { name: String(name || '').trim(), amt, pri: ledgerPriority(name) };
  }).filter((e) => e.name);
  if (!scored.length) return null;
  scored.sort((a, b) => a.pri - b.pri || b.amt - a.amt);
  const best = formatLedgerDisplayName(scored[0].name);
  return best || null;
}

/** Final tile label: party_name → primary_ledger → narration. */
export function resolveVoucherListParty(row = {}) {
  const fromParty = formatLedgerDisplayName(row.party_name);
  if (fromParty) return fromParty;
  const fromLedger = formatLedgerDisplayName(row.primary_ledger || row.primary_ledger_name);
  if (fromLedger) return fromLedger;
  return String(row.narration || '').trim();
}
