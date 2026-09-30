/**
 * Outstanding-bill helpers for BillOutstanding.xml ingest and AR/AP reads.
 */

const toNum = (v) => {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/,/g, '').replace('(-)', '-').trim());
  return Number.isFinite(n) ? n : null;
};

/** 'Dr' | 'Cr' | null — signed pending (Tally: negative = Dr), then DrCr label, then ledger group. */
export function billSide(r) {
  const signed = toNum(r.SignedPending ?? r.SIGNEDPENDING);
  if (signed != null && Math.abs(signed) >= 0.005) return signed < 0 ? 'Dr' : 'Cr';
  const label = String(r.DrCr ?? r.DRCR ?? r.BillType ?? r.BILLTYPE ?? '').trim().toLowerCase();
  if (label === 'dr') return 'Dr';
  if (label === 'cr') return 'Cr';
  return groupSide(r.LedgerGroup ?? r.LEDGERGROUP);
}

/** Natural side of a party group: debtors Dr, creditors Cr. */
export function groupSide(group) {
  const g = String(group || '').toLowerCase();
  if (g.includes('debtor')) return 'Dr';
  if (g.includes('creditor')) return 'Cr';
  return null;
}

/** Assumed credit period when Tally sends neither a due date nor a credit period. */
export const DEFAULT_CREDIT_DAYS = 30;

/** Credit period in days from Tally text like "30 Days", "30", or "45 days". Dates are not handled. */
export function creditDays(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(\d{1,4})(\s*days?)?$/i);
  return m ? Number(m[1]) : null;
}

/** YYYY-MM-DD due date: explicit due date wins, else bill date + credit period. */
export function dueDateOf(billDateIso, dueDateIso, creditPeriod) {
  if (dueDateIso) return dueDateIso;
  const days = creditDays(creditPeriod);
  if (!billDateIso || days == null || !/^\d{4}-\d{2}-\d{2}$/.test(billDateIso)) return null;
  const d = new Date(`${billDateIso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Due date for ageing/overdue: explicit due date, else bill date + DEFAULT_CREDIT_DAYS. */
export function effectiveDueDate(dueDateIso, billDateIso) {
  return dueDateOf(billDateIso || null, dueDateIso || null, DEFAULT_CREDIT_DAYS);
}

/** True when the bill's side disagrees with its party group (e.g. a Cr bill on a Sundry Debtor). */
export function isSideMismatch(billType, partyGroup) {
  const natural = groupSide(partyGroup);
  const side = String(billType || '').trim().toLowerCase();
  if (!natural || (side !== 'dr' && side !== 'cr')) return false;
  return side !== natural.toLowerCase();
}
