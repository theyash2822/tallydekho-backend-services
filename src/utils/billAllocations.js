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

function ledgerEntriesOf(r) {
  if (!r || typeof r !== 'object') return [];
  return [
    ...asList(r.ALLLEDGERENTRIES),
    ...asList(r.AllLedgerEntries),
    ...asList(r.AllLedgerentries),
    ...asList(r.LEDGERENTRIES),
    ...asList(r.LedgerEntries),
  ].filter((e) => e && typeof e === 'object');
}

/** Every allocation line: [{ ledger, name, type, amount, date, isParty }]. Duplicates removed. */
export function extractBillAllocations(r) {
  const out = [];
  const seen = new Set();
  for (const e of ledgerEntriesOf(r)) {
    const ledger = String(e.LEDGERNAME || e.Ledgername || e.LedgerName || e.ledgername || '').trim();
    const isParty = e.ISPARTYLEDGER === 'Yes' || e.IsPartyLedger === 'Yes';
    const allocs = asList(e.BILLALLOCATIONS || e.BillAllocations || e.Billallocations || e.billallocations);
    for (const ba of allocs) {
      if (!ba || typeof ba !== 'object') continue;
      const name = String(ba.NAME ?? ba.Name ?? ba.name ?? ba.Billname ?? ba.BillName ?? '').trim();
      if (!name) continue;
      const type = String(ba.BILLTYPE ?? ba.BillType ?? ba.billType ?? ba.Billtype ?? '').trim() || null;
      const key = `${ledger}\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        ledger,
        name,
        type,
        amount: parseAmount(ba.AMOUNT ?? ba.Amount ?? ba.amount ?? ba.BillAmount ?? ba.Billamount),
        date: ba.BILLDATE ?? ba.BillDate ?? ba.Billdate ?? null,
        isParty,
      });
    }
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
