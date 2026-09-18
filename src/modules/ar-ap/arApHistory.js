/**
 * AR/AP historical reconstruction for Cash-style trend pills.
 *
 * Totals: walk back party-ledger VLE from current accounting balance
 *   (same pattern as cashBankService daily series).
 * Aging / Due Today: re-open bills as-of a past date from bill_outstanding
 *   + settlement add-backs (Agst Ref / reference match when present), then
 *   re-age with that as-of date.
 *
 * Lookback windows (product lock):
 *   Total Due / Not Due / 0–30d → 30d
 *   Due Today → 1d (vs yesterday)
 *   31–60d → 60d
 *   61–90d → 90d
 *   90+d → 90d (open-ended bucket; no upper bound defined)
 *
 * Snapshots remain optional enrichment; trends must work on day 1 via reconstruction.
 */
import { query } from '../../db/schema.js';
import { money, isoDay, addDays, computeTrendPct } from '../kpi/trendUtil.js';

const PARTY_SQL = {
  AR: `(l.parent ILIKE '%Sundry Debtor%' OR l.parent = 'Sundry Debtors')`,
  AP: `(l.parent ILIKE '%Sundry Creditor%' OR l.parent = 'Sundry Creditors')`,
};

/** @param {string} key bucket id or 'TOTAL' / 'DUE_TODAY' */
export function lookbackDaysForKey(key) {
  const k = String(key || '');
  if (k === 'DUE_TODAY' || k === 'due_today') return 1;
  if (k === '31-60d') return 60;
  if (k === '61-90d' || k === '90+d') return 90;
  // TOTAL, NOT_DUE, 0-30d, and unknown short labels → 30d
  return 30;
}

function daysBetween(asOfIso, dueIso) {
  if (!dueIso) return 0;
  const a = new Date(`${asOfIso}T12:00:00`);
  const b = new Date(`${dueIso}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
  return Math.floor((a - b) / 86400000);
}

/**
 * Net party-ledger moves after asOf (exclusive of asOf day end = moves with date > asOf).
 * AR/AP outstanding ABS: Dr increases, Cr decreases (same sign convention as cash inflow/outflow).
 * @returns {Promise<{dr:number, cr:number, net:number, rowCount:number}>}
 */
export async function partyLedgerMovesAfter(companyId, side, asOfIso) {
  const partySql = PARTY_SQL[side] || PARTY_SQL.AR;
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(CASE WHEN vle.dr_cr = 'Dr' THEN ABS(vle.amount) ELSE 0 END), 0) AS dr,
       COALESCE(SUM(CASE WHEN vle.dr_cr = 'Cr' THEN ABS(vle.amount) ELSE 0 END), 0) AS cr,
       COUNT(*)::int AS n
     FROM voucher_ledger_entries vle
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
     WHERE vle.company_id=$1
       AND v.is_cancelled = FALSE
       AND v.date > $2
       AND ${partySql}`,
    [companyId, asOfIso]
  );
  const dr = money(rows[0]?.dr);
  const cr = money(rows[0]?.cr);
  return { dr, cr, net: money(dr - cr), rowCount: Number(rows[0]?.n) || 0 };
}

/**
 * Reconstruct total outstanding as-of prior date from current balance + VLE walkback.
 * prior ≈ current - Dr_after + Cr_after
 */
export async function reconstructTotalAsOf(companyId, side, asOfIso, currentTotal) {
  const cur = money(currentTotal);
  const moves = await partyLedgerMovesAfter(companyId, side, asOfIso);
  const prior = money(cur - moves.dr + moves.cr);
  return {
    total: Math.max(0, prior),
    source: moves.rowCount > 0 ? 'VLE_WALKBACK' : 'VLE_WALKBACK_NO_MOVES',
    moves,
  };
}

/**
 * Load settlement add-backs after asOf keyed by bill ref (+ party).
 * Prefers bill_ref_name (Agst Ref); also matches vouchers.reference to bill names when set.
 */
async function loadSettlementAddBacks(companyId, side, asOfIso) {
  const vtype = side === 'AR'
    ? `(v.voucher_type ILIKE '%Receipt%')`
    : `(v.voucher_type ILIKE '%Payment%')`;
  const { rows } = await query(
    `SELECT
       COALESCE(NULLIF(v.bill_ref_name, ''), NULLIF(v.reference, '')) AS ref_key,
       LOWER(COALESCE(v.party_name, '')) AS party_key,
       SUM(ABS(COALESCE(v.bill_allocated_amount, v.amount, 0))) AS settled
     FROM vouchers v
     WHERE v.company_id=$1
       AND v.is_cancelled = FALSE
       AND v.date > $2
       AND ${vtype}
       AND (
         (v.bill_type ILIKE '%Agst%' AND NULLIF(v.bill_ref_name, '') IS NOT NULL)
         OR NULLIF(v.reference, '') IS NOT NULL
       )
     GROUP BY 1, 2`,
    [companyId, asOfIso]
  );
  const byRefParty = new Map();
  const byRef = new Map();
  for (const r of rows) {
    const ref = String(r.ref_key || '').trim();
    if (!ref) continue;
    // Skip TDK receipt/payment self-refs (not bill refs)
    if (/^TDK-(RCP|PMT)-/i.test(ref)) continue;
    const amt = money(r.settled);
    const pk = `${ref}||${r.party_key}`;
    byRefParty.set(pk, money((byRefParty.get(pk) || 0) + amt));
    byRef.set(ref, money((byRef.get(ref) || 0) + amt));
  }
  return { byRefParty, byRef };
}

/**
 * Invoices dated on/before asOf that are no longer open, with a bill-wise Agst Ref
 * settlement after asOf. Party-only matches are NOT used (would invent allocation).
 */
async function loadClearedInvoicesAsOf(companyId, side, asOfIso, openRefs) {
  const invType = side === 'AR'
    ? `(v.voucher_type ILIKE '%Sales%' AND v.voucher_type NOT ILIKE '%Order%' AND v.voucher_type NOT ILIKE '%Note%')`
    : `(v.voucher_type ILIKE '%Purchase%' AND v.voucher_type NOT ILIKE '%Order%' AND v.voucher_type NOT ILIKE '%Note%')`;
  const settleType = side === 'AR'
    ? `(s.voucher_type ILIKE '%Receipt%')`
    : `(s.voucher_type ILIKE '%Payment%')`;
  const windowFrom = addDays(asOfIso, -400);
  const { rows } = await query(
    `SELECT v.voucher_number, v.party_name, v.date::text AS bill_date, v.amount,
            v.reference, v.bill_ref_name
     FROM vouchers v
     WHERE v.company_id=$1
       AND v.is_cancelled = FALSE
       AND v.date BETWEEN $2 AND $3
       AND ${invType}
       AND ABS(COALESCE(v.amount,0)) > 0.005
       AND EXISTS (
         SELECT 1 FROM vouchers s
         WHERE s.company_id = v.company_id
           AND s.is_cancelled = FALSE
           AND s.date > $3
           AND ${settleType}
           AND s.bill_type ILIKE '%Agst%'
           AND (
             s.bill_ref_name = v.voucher_number
             OR s.bill_ref_name = v.reference
             OR (v.bill_ref_name IS NOT NULL AND s.bill_ref_name = v.bill_ref_name)
           )
       )
     LIMIT 3000`,
    [companyId, windowFrom, asOfIso]
  );
  const out = [];
  for (const r of rows) {
    const ref = String(r.voucher_number || '').trim();
    if (ref && openRefs.has(ref)) continue;
    const billDate = isoDay(r.bill_date);
    if (!billDate || billDate > asOfIso) continue;
    out.push({
      pending_amount: money(r.amount),
      due_date: null,
      bill_date: billDate,
      bill_name: ref || null,
      ledger_name: r.party_name || null,
    });
  }
  return out;
}

/**
 * Build bill rows as they would have appeared on asOfIso.
 * @param {Array<{pending_amount:number, due_date?:string, bill_date?:string, bill_name?:string, ledger_name?:string, amount?:number}>} currentBills
 */
export async function reconstructBillsAsOf(companyId, side, asOfIso, currentBills) {
  const { byRefParty, byRef } = await loadSettlementAddBacks(companyId, side, asOfIso);
  const openRefs = new Set();
  const out = [];
  for (const b of currentBills) {
    const billDate = isoDay(b.bill_date);
    if (billDate && billDate > asOfIso) continue; // invoice didn't exist yet
    const ref = String(b.bill_name || b.ref || '').trim();
    if (ref) openRefs.add(ref);
    const party = String(b.ledger_name || b.party || '').toLowerCase();
    let addBack = 0;
    if (ref) {
      addBack = byRefParty.get(`${ref}||${party}`) ?? byRef.get(ref) ?? 0;
    }
    const pending = money((Number(b.pending_amount) || 0) + addBack);
    if (pending < 0.005) continue;
    out.push({
      pending_amount: pending,
      due_date: isoDay(b.due_date),
      bill_date: billDate,
      bill_name: ref || null,
      ledger_name: b.ledger_name || b.party || null,
    });
  }
  try {
    const cleared = await loadClearedInvoicesAsOf(companyId, side, asOfIso, openRefs);
    for (const c of cleared) out.push(c);
  } catch (e) {
    console.warn('[arApHistory] cleared-invoice prior skipped:', e.message);
  }
  return out;
}

/** Due-date (or bill-date fallback) aging — same keys as arApService.buildAgingBucketsDueBased */
export function buildAgingBucketsDueBased(bills, asOfIso) {
  const buckets = {
    NOT_DUE: { bucket: 'NOT_DUE', label: 'Not Due', amount: 0, count: 0 },
    '0-30d': { bucket: '0-30d', label: '0–30d', amount: 0, count: 0 },
    '31-60d': { bucket: '31-60d', label: '31–60d', amount: 0, count: 0 },
    '61-90d': { bucket: '61-90d', label: '61–90d', amount: 0, count: 0 },
    '90+d': { bucket: '90+d', label: '90+d', amount: 0, count: 0 },
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
  }));
}

/** Bills due on asOfIso (due_date preferred; else bill_date). */
export function dueTodayAmount(bills, asOfIso) {
  let amount = 0;
  let count = 0;
  for (const r of bills) {
    const amt = money(r.pending_amount);
    if (!amt) continue;
    const due = isoDay(r.due_date) || isoDay(r.bill_date);
    if (due === asOfIso) {
      amount += amt;
      count += 1;
    }
  }
  return { amount: money(amount), count };
}

/**
 * Compute trend fields for total + each aging bucket + due-today using per-key lookbacks.
 * Prefers reconstruction; uses snapshot only if reconstruction prior is unavailable (should not happen).
 */
export async function computeArApTrends({
  companyId,
  side,
  asOf,
  currentTotal,
  currentAging,
  currentBillsRaw,
  currentDueToday,
}) {
  const uniqueLookbacks = [...new Set([
    lookbackDaysForKey('TOTAL'),
    lookbackDaysForKey('DUE_TODAY'),
    ...currentAging.map((b) => lookbackDaysForKey(b.bucket)),
  ])];

  // Cache reconstructed bill sets + aging maps per lookback day
  const priorByLookback = new Map();
  for (const days of uniqueLookbacks) {
    const priorAsOf = addDays(asOf, -days);
    const billsPrior = await reconstructBillsAsOf(companyId, side, priorAsOf, currentBillsRaw);
    const agingPrior = buildAgingBucketsDueBased(billsPrior, priorAsOf);
    const agingMap = {};
    for (const b of agingPrior) agingMap[b.bucket] = b.amount;
    const duePrior = dueTodayAmount(billsPrior, priorAsOf);
    const totalPrior = await reconstructTotalAsOf(companyId, side, priorAsOf, currentTotal);
    priorByLookback.set(days, {
      priorAsOf,
      agingMap,
      dueToday: duePrior.amount,
      total: totalPrior.total,
      totalSource: totalPrior.source,
    });
  }

  const totalLb = lookbackDaysForKey('TOTAL');
  const totalPrior = priorByLookback.get(totalLb);
  const trend_pct = computeTrendPct(currentTotal, totalPrior?.total);

  const aging = currentAging.map((b) => {
    const days = lookbackDaysForKey(b.bucket);
    const prior = priorByLookback.get(days);
    const priorAmt = prior?.agingMap?.[b.bucket];
    const trend = priorAmt == null ? null : computeTrendPct(b.amount, priorAmt);
    return {
      ...b,
      trend,
      trend_pct: trend,
      trend_positive: trend == null ? null : trend >= 0,
      trendState: trend == null ? 'UNKNOWN' : (trend >= 0 ? 'UP' : 'DOWN'),
      trendSource: trend == null ? 'UNKNOWN' : 'RECONSTRUCTED',
      trend_lookback_days: days,
      prior_as_of: prior?.priorAsOf || null,
      prior_amount: priorAmt ?? null,
    };
  });

  const dueLb = lookbackDaysForKey('DUE_TODAY');
  const duePrior = priorByLookback.get(dueLb);
  const dueTrend = computeTrendPct(currentDueToday, duePrior?.dueToday);

  return {
    trend_pct,
    trend_positive: trend_pct == null ? null : trend_pct >= 0,
    trend_lookback_days: totalLb,
    prior_as_of: totalPrior?.priorAsOf || null,
    prior_total: totalPrior?.total ?? null,
    trend_source: totalPrior?.totalSource || 'RECONSTRUCTED',
    aging,
    due_today: {
      bucket: 'DUE_TODAY',
      label: 'Due Today',
      amount: money(currentDueToday),
      trend: dueTrend,
      trend_pct: dueTrend,
      trend_positive: dueTrend == null ? null : dueTrend >= 0,
      trendState: dueTrend == null ? 'UNKNOWN' : (dueTrend >= 0 ? 'UP' : 'DOWN'),
      trendSource: dueTrend == null ? 'UNKNOWN' : 'RECONSTRUCTED',
      trend_lookback_days: dueLb,
      prior_as_of: duePrior?.priorAsOf || null,
      prior_amount: duePrior?.dueToday ?? null,
    },
  };
}
