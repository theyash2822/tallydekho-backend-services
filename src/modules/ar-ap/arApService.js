/**
 * AR / AP KPI helpers (Phase B + reconstructed trends)
 * Spec: TallyDekho_AR_AP_Cash_Bank_Data_Validation_and_Collection_Spec.md
 *
 * Trends: Cash-style reconstruction (VLE walkback + bill re-age), not snapshot-only.
 * Snapshots still upserted as optional enrichment / future use.
 */
import { query } from '../../db/schema.js';
import {
  money, isoDay, addDays, computeTrendPct, pickPriorSnapshot,
} from '../kpi/trendUtil.js';
import {
  lookbackDaysForKey,
  dueTodayAmount,
  computeArApTrends,
} from './arApHistory.js';

const TREND_LOOKBACK_DAYS = lookbackDaysForKey('TOTAL');

function daysBetween(asOfIso, dueIso) {
  if (!dueIso) return 0;
  const a = new Date(`${asOfIso}T12:00:00`);
  const b = new Date(`${dueIso}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((a - b) / 86400000);
}

/** Due-date based aging including NOT_DUE. Trends applied later from snapshots. */
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
  return Object.values(buckets).map((b) => ({
    ...b,
    amount: money(b.amount),
    trend: null,
    trendState: 'UNKNOWN',
    trendSource: 'UNKNOWN',
  }));
}

function agingToMap(aging) {
  const map = {};
  for (const b of aging) {
    map[b.bucket] = money(b.amount);
  }
  return map;
}

async function upsertArApSnapshot(companyId, side, asOf, total, agingMap) {
  await query(
    `INSERT INTO kpi_ar_ap_snapshots (company_id, company_guid, side, as_of, total, aging, created_at)
     VALUES (
       $1,
       (SELECT guid FROM companies WHERE id = $1),
       $2, $3::date, $4, $5::jsonb, EXTRACT(EPOCH FROM NOW())::BIGINT
     )
     ON CONFLICT (company_id, side, as_of)
     DO UPDATE SET company_id = EXCLUDED.company_id, total = EXCLUDED.total, aging = EXCLUDED.aging,
                   created_at = EXTRACT(EPOCH FROM NOW())::BIGINT`,
    [companyId, side, asOf, total, JSON.stringify(agingMap)]
  );
}

async function loadPriorArApSnapshot(companyId, side, asOf) {
  const target = addDays(asOf, -TREND_LOOKBACK_DAYS);
  const from = addDays(target, -3);
  const to = addDays(target, 3);
  const { rows } = await query(
    `SELECT as_of::text AS as_of, total, aging
     FROM kpi_ar_ap_snapshots
     WHERE company_id=$1 AND side = $2
       AND as_of BETWEEN $3::date AND $4::date
       AND as_of <> $5::date
     ORDER BY as_of DESC`,
    [companyId, side, from, to, asOf]
  );
  return pickPriorSnapshot(rows, target, 3);
}

function blankAgingTrends(aging) {
  return aging.map((b) => ({
    ...b,
    trend: null,
    trend_pct: null,
    trend_positive: null,
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
    voucherGuid: b.voucher_guid || null,
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

async function loadSettlementActivity(companyId, {
  side, from, to, limit = 40,
}) {
  const partyParent = side === 'AR'
    ? `(l.parent ILIKE '%Sundry Debtor%' OR l.parent = 'Sundry Debtors')`
    : `(l.parent ILIKE '%Sundry Creditor%' OR l.parent = 'Sundry Creditors')`;
  const vtype = side === 'AR' ? `v.voucher_type ILIKE '%Receipt%'` : `v.voucher_type ILIKE '%Payment%'`;
  const params = [companyId];
  let dateClause = '';
  if (from) { params.push(from); dateClause += ` AND v.date >= $${params.length}`; }
  if (to) { params.push(to); dateClause += ` AND v.date <= $${params.length}`; }
  params.push(limit);
  const { rows } = await query(
    `SELECT * FROM (
       SELECT DISTINCT ON (v.guid)
         v.guid, v.voucher_number, v.party_name, v.voucher_type, v.date, v.amount,
         vle.ledger_name AS party_ledger
       FROM vouchers v
       JOIN voucher_ledger_entries vle ON vle.voucher_guid = v.guid AND vle.company_id = v.company_id
       JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = v.company_id
       WHERE v.company_id=$1 AND v.is_cancelled = FALSE
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
export async function buildArApPayload(companyId, side, opts = {}) {
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
     WHERE company_id=$1 AND ${partyClause}
       AND ABS(closing_balance) > 0.005
     ORDER BY ABS(closing_balance) DESC
     LIMIT 200`,
    [companyId]
  );

  const { rows: billsRaw } = await query(
    `SELECT ledger_name, bill_name, bill_date, due_date, pending_amount, bill_type, voucher_guid
     FROM bill_outstanding
     WHERE company_id=$1 AND ABS(COALESCE(pending_amount,0)) > 0.005
       AND ${billTypeClause}
     ORDER BY COALESCE(NULLIF(due_date,''), NULLIF(bill_date,'')) ASC NULLS LAST
     LIMIT 5000`,
    [companyId]
  );

  let bills = billsRaw.map((b) => mapBillRow(b, asOf, side));

  const missing = bills.filter((b) => !b.voucherGuid && b.ref);
  const missingRefs = [...new Set(missing.map((b) => b.ref))];
  if (missingRefs.length) {
    const { rows: vrows } = await query(
      `SELECT guid, voucher_number, party_name, voucher_type, date
       FROM vouchers
       WHERE company_id=$1
         AND is_cancelled = FALSE
         AND voucher_number = ANY($2::text[])
       ORDER BY date DESC NULLS LAST`,
      [companyId, missingRefs]
    );
    const byRefParty = new Map();
    const byRef = new Map();
    for (const v of vrows) {
      const ref = String(v.voucher_number);
      const pk = `${ref}||${String(v.party_name || '').toLowerCase()}`;
      if (!byRefParty.has(pk)) byRefParty.set(pk, v.guid);
      if (!byRef.has(ref)) byRef.set(ref, v.guid);
    }
    bills = bills.map((b) => {
      if (b.voucherGuid || !b.ref) return b;
      const partyKey = `${b.ref}||${String(b.party || '').toLowerCase()}`;
      const guid = byRefParty.get(partyKey) || byRef.get(String(b.ref)) || null;
      return guid ? { ...b, voucherGuid: guid } : b;
    });
  }

  // Unfiltered aging + total for snapshot / trends (real MoM baseline)
  const unfilteredAgingSource = bills.map((b) => ({
    pending_amount: b.amount,
    due_date: b.dueDate,
    bill_date: b.billDate,
  }));
  const unfilteredAging = buildAgingBucketsDueBased(unfilteredAgingSource, asOf);
  const accountingBalance = money(partiesRaw.reduce((s, p) => s + Math.abs(parseFloat(p.closing_balance) || 0), 0));
  const unfilteredOpen = money(bills.reduce((s, b) => s + b.amount, 0));
  const snapshotTotal = accountingBalance || unfilteredOpen;
  const agingMap = agingToMap(unfilteredAging);

  try {
    await upsertArApSnapshot(companyId, side, asOf, snapshotTotal, agingMap);
  } catch (e) {
    console.warn('[arAp] snapshot upsert skipped:', e.message);
  }

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

  const filteredView = !!(overdueOnly || from || to);
  const agingSource = bills.map((b) => ({
    pending_amount: b.amount,
    due_date: b.dueDate,
    bill_date: b.billDate,
  }));
  let aging = buildAgingBucketsDueBased(agingSource, asOf);

  const dueTodayCur = dueTodayAmount(
    unfilteredAgingSource.map((b) => ({
      pending_amount: b.pending_amount,
      due_date: b.due_date,
      bill_date: b.bill_date,
    })),
    asOf
  );

  let trend_pct = null;
  let trend_positive = null;
  let prior_as_of = null;
  let prior_total = null;
  let trend_source = null;
  let due_today = {
    bucket: 'DUE_TODAY',
    label: 'Due Today',
    amount: dueTodayCur.amount,
    count: dueTodayCur.count,
    trend: null,
    trend_pct: null,
    trend_positive: null,
    trendState: 'UNKNOWN',
    trendSource: 'UNKNOWN',
    trend_lookback_days: lookbackDaysForKey('DUE_TODAY'),
  };

  if (!filteredView) {
    try {
      const trends = await computeArApTrends({
        companyId,
        side,
        asOf,
        currentTotal: snapshotTotal,
        currentAging: aging,
        currentBillsRaw: billsRaw.map((b) => ({
          pending_amount: money(b.pending_amount),
          due_date: b.due_date,
          bill_date: b.bill_date,
          bill_name: b.bill_name,
          ledger_name: b.ledger_name,
          amount: b.amount,
        })),
        currentDueToday: dueTodayCur.amount,
      });
      aging = trends.aging;
      trend_pct = trends.trend_pct;
      trend_positive = trends.trend_positive;
      prior_as_of = trends.prior_as_of;
      prior_total = trends.prior_total;
      trend_source = trends.trend_source;
      due_today = {
        ...due_today,
        ...trends.due_today,
        count: dueTodayCur.count,
      };
    } catch (e) {
      console.warn('[arAp] reconstructed trends failed:', e.message);
      aging = blankAgingTrends(aging);
      // Snapshot fallback only if reconstruction threw
      try {
        const prior = await loadPriorArApSnapshot(companyId, side, asOf);
        if (prior) {
          trend_pct = computeTrendPct(snapshotTotal, prior.total);
          trend_positive = trend_pct == null ? null : trend_pct >= 0;
          prior_as_of = isoDay(prior.as_of);
          prior_total = money(prior.total);
          trend_source = 'SNAPSHOT_FALLBACK';
        }
      } catch (e2) {
        console.warn('[arAp] snapshot fallback skipped:', e2.message);
      }
    }
  } else {
    aging = blankAgingTrends(aging);
  }

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

  const openBillOutstanding = money(bills.reduce((s, b) => s + b.amount, 0));
  const total = filteredView ? openBillOutstanding : accountingBalance;

  const activity = await loadSettlementActivity(companyId, {
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
    unallocatedDifference: money(accountingBalance - unfilteredOpen),
    filteredView,
    total,
    display: `₹${Math.round(total).toLocaleString('en-IN')}`,
    aging,
    due_today,
    trend_pct,
    trend_positive,
    trend_lookback_days: TREND_LOOKBACK_DAYS,
    prior_as_of,
    prior_total,
    trend_source,
    parties: parties.slice(0, 80),
    bills: bills.slice(0, 100),
    receipts: side === 'AR' ? activity : [],
    payments: side === 'AP' ? activity : [],
    activityLabel: side === 'AR' ? 'Receipts' : 'Payments',
  };
}
