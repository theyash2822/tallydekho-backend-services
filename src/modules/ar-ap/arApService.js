/**
 * AR / AP KPI helpers (Phase B + reconstructed trends)
 * Spec: TallyDekho_AR_AP_Cash_Bank_Data_Validation_and_Collection_Spec.md
 *
 * Trends: Cash-style reconstruction (VLE walkback + bill re-age), not snapshot-only.
 * Snapshots still upserted as optional enrichment / future use.
 */
import { query } from '../../db/schema.js';
import { isSideMismatch, effectiveDueDate } from '../../utils/billOutstanding.js';
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
    const due = effectiveDueDate(isoDay(r.due_date), isoDay(r.bill_date));
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
       (SELECT guid FROM companies WHERE id = $1::bigint),
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

/**
 * Tally's BillOutstanding export currently has no due date or credit period, so a bill
 * without one is treated as due DEFAULT_CREDIT_DAYS after its bill date (same rule as
 * payment reminders). `date` stays on the real due/bill date so FY filters don't shift.
 */
function mapBillRow(b, asOfIso, side) {
  const explicitDue = isoDay(b.due_date);
  const billDate = isoDay(b.bill_date);
  const due = effectiveDueDate(explicitDue, billDate);
  const pending = money(b.pending_amount);
  const overdueDays = due ? daysBetween(asOfIso, due) : 0;
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
    dueDateEstimated: !explicitDue && !!due,
    date: explicitDue || billDate,
    amount: pending,
    daysOverdue: Math.max(0, overdueDays),
    status,
    billType: b.bill_type || (side === 'AR' ? 'DR' : 'CR'),
    voucherGuid: b.voucher_guid || null,
    sideMismatch: isSideMismatch(b.bill_type, b.party_group),
  };
}

const TDK_REF_RE = /^TDK-/i;

/**
 * Tally syncs bills without a voucher GUID, and app-posted vouchers get a Tally
 * number that differs from the TDK bill name. Same link rules as My Entries:
 * voucher number, app_vouchers.tally_voucher_no, or vouchers.reference (TDK ref).
 * Non-TDK bill names ("1", "15") repeat across parties and voucher types, so they
 * link only when the voucher's party matches; TDK refs are unique per company.
 */
export async function linkBillsToVouchers(companyId, bills) {
  const refs = [...new Set(bills.filter((b) => !b.voucherGuid && b.ref).map((b) => String(b.ref)))];
  const tdkRefs = refs.filter((r) => TDK_REF_RE.test(r));
  const refSet = new Set(refs);
  const tdkSet = new Set(tdkRefs);

  const candidates = new Map();
  const addCandidate = (ref, v) => {
    if (!candidates.has(ref)) candidates.set(ref, []);
    candidates.get(ref).push(v);
  };

  if (refs.length) {
    const { rows } = await query(
      `SELECT guid, voucher_number, reference, party_name
       FROM vouchers
       WHERE company_id=$1 AND is_cancelled = FALSE
         AND (voucher_number = ANY($2::text[]) OR reference = ANY($3::text[]))
       ORDER BY date DESC NULLS LAST`,
      [companyId, refs, tdkRefs]
    );
    for (const v of rows) {
      if (refSet.has(v.voucher_number)) addCandidate(v.voucher_number, v);
      if (v.reference && tdkSet.has(v.reference)) addCandidate(v.reference, v);
    }
  }

  if (tdkRefs.length) {
    const { rows } = await query(
      `SELECT av.tdk_reference_no, v.guid, v.party_name
       FROM app_vouchers av
       JOIN vouchers v ON v.company_id = $1 AND v.is_cancelled = FALSE AND v.voucher_number = av.tally_voucher_no
       WHERE (av.company_id = $1 OR av.company_guid = (SELECT guid FROM companies WHERE id = $1::bigint))
         AND av.tdk_reference_no = ANY($2::text[])
         AND COALESCE(av.tally_voucher_no, '') <> ''`,
      [companyId, tdkRefs]
    );
    for (const r of rows) addCandidate(r.tdk_reference_no, r);
  }

  const linked = bills.map((b) => {
    if (b.voucherGuid || !b.ref) return b;
    const list = candidates.get(String(b.ref)) || [];
    const party = String(b.party || '').toLowerCase();
    const hit = list.find((v) => String(v.party_name || '').toLowerCase() === party)
      || (TDK_REF_RE.test(String(b.ref)) ? list[0] : undefined);
    return hit ? { ...b, voucherGuid: hit.guid } : b;
  });

  const stillOpen = [...new Set(linked.filter((b) => !b.voucherGuid && b.ref).map((b) => String(b.ref)))];
  if (stillOpen.length) {
    const { rows } = await query(
      `SELECT a.bill_name, a.ledger_name, v.guid
       FROM voucher_bill_allocations a
       JOIN vouchers v ON v.company_id = a.company_id AND v.guid = a.voucher_guid AND v.is_cancelled = FALSE
       WHERE a.company_id = $1 AND a.bill_name = ANY($2::text[])
       ORDER BY (a.bill_type = 'New Ref') DESC, v.date ASC NULLS LAST`,
      [companyId, stillOpen]
    ).catch((e) => { console.warn('[AR/AP] allocation link lookup failed:', e.message); return { rows: [] }; });
    const byKey = new Map();
    for (const r of rows) {
      const key = `${String(r.ledger_name || '').toLowerCase()}\u0000${r.bill_name}`;
      if (!byKey.has(key)) byKey.set(key, r.guid);
    }
    for (let i = 0; i < linked.length; i++) {
      const b = linked[i];
      if (b.voucherGuid || !b.ref) continue;
      const guid = byKey.get(`${String(b.party || '').toLowerCase()}\u0000${String(b.ref)}`);
      if (guid) linked[i] = { ...b, voucherGuid: guid };
    }
  }

  const guids = [...new Set(linked.map((b) => b.voucherGuid).filter(Boolean))];
  const typeByGuid = new Map();
  if (guids.length) {
    const { rows } = await query(
      `SELECT guid, voucher_type FROM vouchers WHERE company_id=$1 AND guid = ANY($2::text[])`,
      [companyId, guids]
    );
    for (const r of rows) typeByGuid.set(r.guid, r.voucher_type);
  }

  return linked.map((b) => ({
    ...b,
    voucherType: (b.voucherGuid && typeByGuid.get(b.voucherGuid)) || null,
    tdkRef: b.ref && TDK_REF_RE.test(String(b.ref)) ? String(b.ref) : null,
  }));
}

/** Earliest synced voucher date (YYYY-MM-DD) — only the last 2 FYs are synced. */
async function earliestSyncedVoucherDate(companyId) {
  const { rows } = await query(
    `SELECT MIN(date) AS d FROM vouchers
     WHERE company_id=$1 AND date ~ '^\\d{4}-\\d{2}-\\d{2}'`,
    [companyId]
  ).catch((e) => { console.warn('[AR/AP] earliest voucher lookup failed:', e.message); return { rows: [] }; });
  return isoDay(rows[0]?.d) || null;
}

/** Unlinked bills dated before the earliest synced voucher come from an older, unsynced FY. */
export function markOlderYearBills(bills, earliestIso) {
  return bills.map((b) => ({
    ...b,
    olderYear: Boolean(earliestIso && !b.voucherGuid && b.billDate && b.billDate < earliestIso),
  }));
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

function inPeriod(day, from, to) {
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/**
 * Phone + ledger GUID for every listed party, whatever its group: a Cr bill can sit
 * on a Sundry Debtor (advance / credit note) and still belong on Payables.
 */
async function fillPartyPhones(companyId, parties) {
  const names = [...new Set(parties.map((p) => p.name).filter(Boolean))];
  if (!names.length) return;
  const { rows } = await query(
    `SELECT DISTINCT ON (name) name, guid, COALESCE(NULLIF(mobile, ''), NULLIF(phone, '')) AS phone
     FROM ledgers WHERE company_id=$1 AND name = ANY($2::text[])
     ORDER BY name, guid`,
    [companyId, names]
  ).catch((e) => { console.warn('[AR/AP] party phone lookup failed:', e.message); return { rows: [] }; });
  const byName = new Map(rows.map((r) => [r.name, r]));
  for (const p of parties) {
    const r = byName.get(p.name);
    if (!r) continue;
    if (!p.phone && r.phone) p.phone = r.phone;
    p.ledgerGuid = r.guid || null;
  }
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
  // Tally exports pending amounts unsigned, so the sign only decides when there is no Dr/Cr label.
  const billTypeClause = side === 'AR'
    ? `(UPPER(COALESCE(bo.bill_type,'')) = 'DR' OR (COALESCE(bo.bill_type,'') = '' AND COALESCE(bo.pending_amount,0) < 0))`
    : `(UPPER(COALESCE(bo.bill_type,'')) = 'CR' OR (COALESCE(bo.bill_type,'') = '' AND COALESCE(bo.pending_amount,0) > 0))`;

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
    `SELECT bo.ledger_name, bo.bill_name, bo.bill_date, bo.due_date, bo.pending_amount, bo.bill_type, bo.voucher_guid,
            l.parent AS party_group
     FROM bill_outstanding bo
     LEFT JOIN LATERAL (
       SELECT parent FROM ledgers WHERE company_id = bo.company_id AND name = bo.ledger_name LIMIT 1
     ) l ON TRUE
     WHERE bo.company_id=$1 AND ABS(COALESCE(bo.pending_amount,0)) > 0.005
       AND ${billTypeClause}
     ORDER BY COALESCE(NULLIF(bo.due_date,''), NULLIF(bo.bill_date,'')) ASC NULLS LAST
     LIMIT 5000`,
    [companyId]
  );

  let bills = markOlderYearBills(
    await linkBillsToVouchers(companyId, billsRaw.map((b) => mapBillRow(b, asOf, side))),
    await earliestSyncedVoucherDate(companyId),
  );

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

  // Only bills whose voucher (bill) date lies in the selected FY — not the due date,
  // so a March bill due in April stays in its own year.
  if (from || to) {
    bills = bills.filter((b) => inPeriod(b.billDate || b.date, from, to));
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
    if (!from && !to) return true;
    const mapped = mapBillRow(br, asOf, side);
    return inPeriod(mapped.billDate || mapped.date, from, to);
  }), asOf, side);
  await fillPartyPhones(companyId, parties);

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
    bills: [...bills].sort((a, b) => String(b.date || '').localeCompare(String(a.date || ''))).slice(0, 100),
    olderYearBillCount: bills.filter((b) => b.olderYear).length,
    receipts: side === 'AR' ? activity : [],
    payments: side === 'AP' ? activity : [],
    activityLabel: side === 'AR' ? 'Receipts' : 'Payments',
  };
}
