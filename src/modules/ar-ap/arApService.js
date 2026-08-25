/**
 * AR / AP KPI helpers (Phase B)
 * Spec: TallyDekho_AR_AP_Cash_Bank_Data_Validation_and_Collection_Spec.md
 */
import { query } from '../../db/schema.js';

function money(n) {
  return Math.round((Math.abs(parseFloat(n) || 0)) * 100) / 100;
}

function isoDay(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null;
}

function daysBetween(asOfIso, dueIso) {
  if (!dueIso) return 0;
  const a = new Date(`${asOfIso}T12:00:00`);
  const b = new Date(`${dueIso}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((a - b) / 86400000);
}

/** Due-date based aging including NOT_DUE. */
export function buildAgingBucketsDueBased(bills, asOfIso) {
  const buckets = {
    'NOT_DUE': { bucket: 'NOT_DUE', label: 'Not Due', amount: 0, count: 0 },
    '0-30d':   { bucket: '0-30d',   label: '0–30d',   amount: 0, count: 0 },
    '31-60d':  { bucket: '31-60d',  label: '31–60d',  amount: 0, count: 0 },
    '61-90d':  { bucket: '61-90d',  label: '61–90d',  amount: 0, count: 0 },
    '90+d':    { bucket: '90+d',    label: '90+d',    amount: 0, count: 0 },
  };
  for (const r of bills) {
    const amt = money(r.pending_amount);
    if (!amt) continue;
    const due = isoDay(r.due_date) || isoDay(r.bill_date);
    const overdueDays = due ? daysBetween(asOfIso, due) : 0;
    let key = '0-30d';
    if (overdueDays < 0) key = 'NOT_DUE';
    else if (overdueDays <= 30) key = '0-30d';
    else if (overdueDays <= 60) key = '31-60d';
    else if (overdueDays <= 90) key = '61-90d';
    else key = '90+d';
    buckets[key].amount += amt;
    buckets[key].count += 1;
  }
  // Trend badges kept in UI; without historical as-of snapshots we cannot invent MoM %.
  return Object.values(buckets).map((b) => ({
    ...b,
    amount: money(b.amount),
    trend: null,
    trendState: 'UNKNOWN',
    trendSource: 'UNKNOWN',
  }));
}

function mapBillRow(b, asOfIso, side) {
  const due = isoDay(b.due_date);
  const billDate = isoDay(b.bill_date);
  const pending = money(b.pending_amount);
  const overdueDays = due ? daysBetween(asOfIso, due) : (billDate ? Math.max(0, daysBetween(asOfIso, billDate)) : 0);
  let status = 'NOT_DUE';
  if (due) {
    if (overdueDays > 0) status = 'OVERDUE';
    else if (overdueDays === 0) status = 'DUE_TODAY';
    else status = 'NOT_DUE';
  } else if (pending > 0) {
    status = 'OPEN';
  }
  return {
    party: b.ledger_name,
    ref: b.bill_name,
    billDate,
    dueDate: due,
    date: due || billDate,
    amount: pending,
    daysOverdue: Math.max(0, overdueDays),
    status,
    billType: b.bill_type || (side === 'AR' ? 'DR' : 'CR'),
  };
}

function aggregateParties(debtors, bills, asOfIso, side = 'AR') {
  const byName = new Map();
  for (const d of debtors) {
    byName.set(d.name, {
      name: d.name,
      accountingBalance: money(d.closing_balance),
      phone: d.mobile || d.phone || '',
      openBillOutstanding: 0,
      overdueOutstanding: 0,
      notDueOutstanding: 0,
      openBillCount: 0,
      overdueBillCount: 0,
      oldestOverdueDays: 0,
    });
  }
  for (const b of bills) {
    const row = mapBillRow(b, asOfIso, side);
    let p = byName.get(b.ledger_name);
    if (!p) {
      p = {
        name: b.ledger_name,
        accountingBalance: 0,
        phone: '',
        openBillOutstanding: 0,
        overdueOutstanding: 0,
        notDueOutstanding: 0,
        openBillCount: 0,
        overdueBillCount: 0,
        oldestOverdueDays: 0,
      };
      byName.set(b.ledger_name, p);
    }
    p.openBillOutstanding += row.amount;
    p.openBillCount += 1;
    if (row.status === 'OVERDUE') {
      p.overdueOutstanding += row.amount;
      p.overdueBillCount += 1;
      p.oldestOverdueDays = Math.max(p.oldestOverdueDays, row.daysOverdue);
    } else {
      p.notDueOutstanding += row.amount;
    }
  }
  return [...byName.values()]
    .map((p) => ({
      ...p,
      openBillOutstanding: money(p.openBillOutstanding),
      overdueOutstanding: money(p.overdueOutstanding),
      notDueOutstanding: money(p.notDueOutstanding),
      amount: money(p.accountingBalance || p.openBillOutstanding),
      days_overdue: p.oldestOverdueDays,
      unallocatedDifference: money((p.accountingBalance || 0) - (p.openBillOutstanding || 0)),
    }))
    .filter((p) => p.amount > 0.005 || p.openBillOutstanding > 0.005)
    .sort((a, b) => b.amount - a.amount);
}

async function loadSettlementActivity(companyGuid, {
  side, from, to, limit = 40,
}) {
  // AR: Receipts touching Sundry Debtors; AP: Payments touching Sundry Creditors
  const partyParent = side === 'AR'
    ? `(l.parent ILIKE '%Sundry Debtor%' OR l.parent = 'Sundry Debtors')`
    : `(l.parent ILIKE '%Sundry Creditor%' OR l.parent = 'Sundry Creditors')`;
  const vtype = side === 'AR' ? `v.voucher_type ILIKE '%Receipt%'` : `v.voucher_type ILIKE '%Payment%'`;
  const params = [companyGuid];
  let dateClause = '';
  if (from) { params.push(from); dateClause += ` AND v.date >= $${params.length}`; }
  if (to) { params.push(to); dateClause += ` AND v.date <= $${params.length}`; }
  params.push(limit);
  // DISTINCT ON must ORDER BY guid first; wrap so LIMIT applies to date-desc rows (not guid order).
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (v.guid)
         v.guid, v.voucher_number, v.party_name, v.voucher_type, v.date, v.amount,
         vle.ledger_name AS party_ledger
       FROM vouchers v
       JOIN voucher_ledger_entries vle ON vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = v.company_guid
       WHERE v.company_guid = $1 AND v.is_cancelled = FALSE
         AND ${vtype}
         AND ${partyParent}
         ${dateClause}
       ORDER BY v.guid, v.date DESC
     ) sub
     ORDER BY date DESC
     LIMIT $${params.length}`,
    params
  );
  return rows.map((r) => ({
    guid: r.guid,
    voucher_number: r.voucher_number,
    party_name: r.party_name || r.party_ledger,
    voucher_type: r.voucher_type,
    date: isoDay(r.date),
    amount: money(r.amount),
  }));
}

/**
 * @param {'AR'|'AP'} side
 */
export async function buildArApPayload(companyGuid, side, opts = {}) {
  const asOf = isoDay(opts.asOf) || new Date().toISOString().slice(0, 10);
  const from = isoDay(opts.from);
  const to = isoDay(opts.to);
  const overdueOnly = String(opts.overdue || '') === '1' || String(opts.overdue || '').toLowerCase() === 'true';

  const partyClause = side === 'AR'
    ? `(parent ILIKE '%Sundry Debtor%' OR parent = 'Sundry Debtors')`
    : `(parent ILIKE '%Sundry Creditor%' OR parent = 'Sundry Creditors')`;
  const billTypeClause = side === 'AR'
    ? `(UPPER(COALESCE(bill_type,'')) = 'DR' OR COALESCE(pending_amount,0) < 0)`
    : `(UPPER(COALESCE(bill_type,'')) = 'CR' OR COALESCE(pending_amount,0) > 0)`;

  const { rows: partiesRaw } = await query(
    `SELECT name, closing_balance, COALESCE(mobile, phone) AS mobile
     FROM ledgers
     WHERE company_guid = $1 AND ${partyClause}
       AND ABS(closing_balance) > 0.005
     ORDER BY ABS(closing_balance) DESC
     LIMIT 200`,
    [companyGuid]
  );

  const { rows: billsRaw } = await query(
    `SELECT ledger_name, bill_name, bill_date, due_date, pending_amount, bill_type
     FROM bill_outstanding
     WHERE company_guid = $1 AND ABS(COALESCE(pending_amount,0)) > 0.005
       AND ${billTypeClause}
     ORDER BY COALESCE(NULLIF(due_date,''), NULLIF(bill_date,'')) ASC NULLS LAST
     LIMIT 2000`,
    [companyGuid]
  );

  let bills = billsRaw.map((b) => mapBillRow(b, asOf, side));
  // Date range = bill/due date filter on current open bills (decision A)
  if (from || to) {
    bills = bills.filter((b) => {
      const ref = b.dueDate || b.billDate;
      if (!ref) return false;
      if (from && ref < from) return false;
      if (to && ref > to) return false;
      return true;
    });
  }
  if (overdueOnly) {
    bills = bills.filter((b) => b.status === 'OVERDUE');
  }

  // Rebuild raw for aging from filtered set
  const agingSource = bills.map((b) => ({
    pending_amount: b.amount,
    due_date: b.dueDate,
    bill_date: b.billDate,
  }));
  const aging = buildAgingBucketsDueBased(agingSource, asOf);

  let parties = aggregateParties(partiesRaw, billsRaw.filter((br) => {
    const mapped = mapBillRow(br, asOf, side);
    if (from || to) {
      const ref = mapped.dueDate || mapped.billDate;
      if (!ref) return false;
      if (from && ref < from) return false;
      if (to && ref > to) return false;
    }
    return true;
  }), asOf, side);

  if (overdueOnly) {
    parties = parties.filter((p) => p.overdueOutstanding > 0.005);
  }

  const accountingBalance = money(partiesRaw.reduce((s, p) => s + Math.abs(parseFloat(p.closing_balance) || 0), 0));
  const openBillOutstanding = money(bills.reduce((s, b) => s + b.amount, 0));
  // When overdue/date filters apply, Total Due must reflect filtered open bills (not full ledger total).
  const filteredView = !!(overdueOnly || from || to);
  const total = filteredView ? openBillOutstanding : accountingBalance;

  const activity = await loadSettlementActivity(companyGuid, {
    side,
    from: from || undefined,
    to: to || asOf,
    limit: 40,
  });

  return {
    asOf,
    from: from || null,
    to: to || null,
    accountingBalance,
    openBillOutstanding,
    unallocatedDifference: money(accountingBalance - openBillOutstanding),
    filteredView,
    total,
    display: `₹${Math.round(total).toLocaleString('en-IN')}`,
    aging,
    parties: parties.slice(0, 80),
    bills: bills.slice(0, 100),
    // chip lists
    receipts: side === 'AR' ? activity : [],
    payments: side === 'AP' ? activity : [],
    activityLabel: side === 'AR' ? 'Receipts' : 'Payments',
  };
}
