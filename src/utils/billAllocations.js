/**
 * Bill allocations from a synced voucher record.
 *
 * AllVoucher.xml explodes them under each ledger entry as
 *   AllLedgerEntries[].Billallocations{ Billname, Billdate, BillAmount, BILLTYPE }
 * while SingleVoucher / Tally-native XML uses BILLALLOCATIONS{ NAME, BILLTYPE, AMOUNT }.
 * fast-xml-parser gives an object for one child and an array for many.
 */

const asList = (v) => (Array.isArray(v) ? v : (v ? [v] : []));

function parseAmount(raw) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number'
    ? raw
    : parseFloat(String(raw).replace('(-)', '-').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Every allocation line: [{ ledger, name, type, amount, date, isParty }].
 * Tally may export the same ledger lines under both ALLLEDGERENTRIES and LEDGERENTRIES,
 * so each ledger is taken from the first list that has it (as parseLedgerEntries does).
 * Within that list, repeated allocations to the same bill are summed — not dropped.
 */
export function extractBillAllocations(r) {
  if (!r || typeof r !== 'object') return [];
  const groups = [
    [...asList(r.ALLLEDGERENTRIES), ...asList(r.AllLedgerEntries), ...asList(r.AllLedgerentries)],
    [...asList(r.LEDGERENTRIES), ...asList(r.LedgerEntries)],
  ].map((g) => g.filter((e) => e && typeof e === 'object'));
  const out = [];
  const byKey = new Map();
  const coveredLedgers = new Set();
  for (const entries of groups) {
    const ledgersHere = new Set();
    for (const e of entries) {
      const ledger = String(e.LEDGERNAME || e.Ledgername || e.LedgerName || e.ledgername || '').trim();
      if (coveredLedgers.has(ledger)) continue;
      ledgersHere.add(ledger);
      const isParty = e.ISPARTYLEDGER === 'Yes' || e.IsPartyLedger === 'Yes';
      const allocs = asList(e.BILLALLOCATIONS || e.BillAllocations || e.Billallocations || e.billallocations);
      for (const ba of allocs) {
        if (!ba || typeof ba !== 'object') continue;
        const name = String(ba.NAME ?? ba.Name ?? ba.name ?? ba.Billname ?? ba.BillName ?? '').trim();
        if (!name) continue;
        const type = String(ba.BILLTYPE ?? ba.BillType ?? ba.billType ?? ba.Billtype ?? '').trim() || null;
        const amount = parseAmount(ba.AMOUNT ?? ba.Amount ?? ba.amount ?? ba.BillAmount ?? ba.Billamount);
        const key = `${ledger}\u0000${name}`;
        const prev = byKey.get(key);
        if (prev) {
          if (amount != null) prev.amount = (prev.amount ?? 0) + amount;
          continue;
        }
        const row = { ledger, name, type, amount, date: ba.BILLDATE ?? ba.BillDate ?? ba.Billdate ?? null, isParty };
        byKey.set(key, row);
        out.push(row);
      }
    }
    for (const l of ledgersHere) coveredLedgers.add(l);
  }
  return out;
}

/** First allocation, preferring the party ledger line. */
export function firstBillAllocation(r) {
  const all = extractBillAllocations(r).filter((a) => a.type);
  const pick = all.find((a) => a.isParty) || all[0];
  if (!pick) return null;
  return { bill_ref_name: pick.name, bill_type: pick.type, bill_allocated_amount: pick.amount };
}
