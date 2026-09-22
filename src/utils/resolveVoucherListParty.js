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
  if (/round\s*(ed)?\s*off|transport|freight|expense|charge/i.test(n)) return 3;
  return 0;
}

/** Tally often puts the bank/cash ledger into PartyName on Receipt / Payment. */
export function isBankOrCashLedger(name = '') {
  return /\b(bank|cash|petty\s*cash|od\s*a\/?c|overdraft)\b/i.test(String(name || ''));
}

function entrySide(e = {}) {
  const side = String(e.dr_cr || e.drCr || '').toLowerCase();
  if (side === 'dr' || side === 'debit' || side === 'd') return 'dr';
  if (side === 'cr' || side === 'credit' || side === 'c') return 'cr';
  const amt = parseFloat(e.amount ?? e.Amount ?? 0);
  if (!Number.isNaN(amt) && amt !== 0) return amt < 0 ? 'dr' : 'cr';
  return '';
}

/**
 * Prefer the real party/customer ledger over bank/sales/tax lines.
 * Receipt: party is usually Cr; Payment: party is usually Dr.
 * Sales: party is Dr; Purchase: party is Cr.
 */
export function resolveSyncedPartyName({
  voucherType = '',
  storedParty = null,
  appParty = null,
  ledgerEntries = [],
} = {}) {
  const app = formatLedgerDisplayName(appParty) || String(appParty || '').trim();
  if (app) return app;

  const vt = String(voucherType || '').toLowerCase();
  const isReceipt = vt.includes('receipt');
  const isPayment = vt.includes('payment');
  const isPurchase = vt.includes('purchase') || vt.includes('debit note');
  const stored = formatLedgerDisplayName(storedParty) || String(storedParty || '').trim();

  // Receipt/Payment: Tally often stamps PartyName with the bank — ignore that.
  if (stored && !(isReceipt || isPayment) || (stored && !isBankOrCashLedger(stored))) {
    return stored;
  }

  const preferredSide = isReceipt ? 'cr' : isPayment || !isPurchase ? 'dr' : 'cr';
  const scored = (ledgerEntries || [])
    .map((e) => {
      const name = formatLedgerDisplayName(
        e.ledger_name || e.ledgerName || e.LEDGERNAME || e.LedgerName || ''
      );
      const amt = Math.abs(parseFloat(e.amount ?? e.Amount ?? 0) || 0);
      return { name, amt, pri: ledgerPriority(name), side: entrySide(e) };
    })
    .filter((e) => e.name && !isBankOrCashLedger(e.name));

  const preferred = scored
    .filter((e) => !e.side || e.side === preferredSide)
    .sort((a, b) => a.pri - b.pri || b.amt - a.amt);
  if (preferred[0]?.name) return preferred[0].name;

  scored.sort((a, b) => a.pri - b.pri || b.amt - a.amt);
  return scored[0]?.name || stored || null;
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
