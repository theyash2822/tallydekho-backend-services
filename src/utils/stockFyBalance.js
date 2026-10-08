/**
 * StockFYBalance.xml rows are point-in-time stock values: the closing of a fiscal year (date = FY end)
 * or its opening (date = day before FY start). Current desktops tag every row with FY_BEGIN, FY_END,
 * BALANCE_DATE and BALANCE_ROLE; older desktops only send FROM_DATE plus a calendar-year label and are
 * classified per row with the historical April–March rule.
 */

const ymd = (v) => {
  const s = String(v ?? '').trim().replace(/-/g, '');
  return /^\d{8}$/.test(s) ? s : null;
};

const dayBefore = (yyyymmdd) => {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) - 1));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const plain = (raw) => parseFloat(String(raw || 0).replace(/[^0-9.-]/g, '')) || 0;

// Tally exports stock value as a Dr (negative) amount; stored values are positive.
const stockValue = (raw) => {
  const s = String(raw || 0).replace('(-)', '-');
  return parseFloat(s.replace(/[^0-9.-]/g, '')) * (s.includes('-') ? -1 : 1) || 0;
};

function classifyRow(r) {
  const fyLabel = r._FINANCIAL_YEAR || r.FINANCIAL_YEAR || null;
  const role = String(r.BALANCE_ROLE || '').toLowerCase();
  if (role) {
    const fyBegin = ymd(r.FY_BEGIN);
    const fyEnd = ymd(r.FY_END);
    const date = ymd(r.BALANCE_DATE ?? r.FROM_DATE);
    if (!fyLabel || !fyBegin || !fyEnd || !date) return { error: 'missing_fiscal_metadata' };
    if (role === 'closing' && date === fyEnd) return { financialYear: fyLabel, role };
    if (role === 'opening' && date === dayBefore(fyBegin)) return { financialYear: fyLabel, role };
    return { error: 'role_date_mismatch' };
  }
  // Legacy desktop: label is the calendar year of the query date, boundaries assumed April–March.
  const date = ymd(r.FROM_DATE ?? r.from_date);
  if (!fyLabel || !date) return { error: 'missing_fiscal_metadata' };
  const startYear = parseInt(String(fyLabel).split('-')[0], 10);
  if (!Number.isFinite(startYear)) return { error: 'missing_fiscal_metadata' };
  if (date === `${startYear + 1}0331`) return { financialYear: fyLabel, role: 'closing' };
  return { financialYear: fyLabel, role: 'opening' };
}

/**
 * Groups rows by fiscal year and role. Identical duplicates collapse; the same item with different
 * values in one scope is contradictory and is reported instead of being written in arrival order.
 */
export function classifyStockFyBalanceRows(data) {
  const groups = new Map();
  const rejected = [];
  for (const r of data || []) {
    const name = r?.Name || r?.NAME || '';
    if (!name) continue;
    const c = classifyRow(r);
    if (c.error) { rejected.push({ name, reason: c.error }); continue; }
    const key = `${c.financialYear}|${c.role}`;
    if (!groups.has(key)) groups.set(key, { financialYear: c.financialYear, role: c.role, items: new Map() });
    const item = {
      name,
      guid: r.Guid || r.GUID || null,
      qty: plain(r.ClosingQty || r.CLOSINGQTY),
      rate: plain(r.ClosingRate || r.CLOSINGRATE),
      value: stockValue(r.ClosingValue || r.CLOSINGVALUE),
    };
    const items = groups.get(key).items;
    const prev = items.get(name);
    if (!prev) { items.set(name, item); continue; }
    if (prev.conflict) continue;
    if (prev.qty !== item.qty || prev.rate !== item.rate || prev.value !== item.value) {
      items.set(name, { ...prev, conflict: true });
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const items = [];
    for (const it of g.items.values()) {
      if (it.conflict) rejected.push({ name: it.name, reason: 'contradictory_duplicate', financialYear: g.financialYear, role: g.role });
      else items.push(it);
    }
    out.push({ financialYear: g.financialYear, role: g.role, items });
  }
  return { groups: out, rejected };
}
