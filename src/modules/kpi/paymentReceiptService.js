/**
 * Payments / Receipts KPI — totals, daily series, trend pills (Phase 1).
 * Trend % = current window vs prior equal-length window.
 * Today card = today vs previous calendar day.
 * Null trend when prior denominator is 0 / insufficient data.
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

function addDays(iso, delta) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

function inclusiveDays(from, to) {
  const a = new Date(`${from}T12:00:00`);
  const b = new Date(`${to}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
  return Math.max(1, Math.floor((b - a) / 86400000) + 1);
}

function enumerateDays(from, to) {
  const days = [];
  let cur = from;
  while (cur <= to) {
    days.push(cur);
    cur = addDays(cur, 1);
    if (days.length > 366) break;
  }
  return days;
}

/** @returns {number|null} */
export function computeTrendPct(current, prior) {
  const cur = Number(current) || 0;
  const prv = Number(prior) || 0;
  if (prv === 0) return null;
  return Math.round(((cur - prv) / Math.abs(prv)) * 1000) / 10;
}

function modeCaseSql(modeDrCr) {
  // Payments: cash/bank legs are typically Cr; Receipts: Dr
  return `
    COALESCE((
      SELECT CASE
        WHEN bool_or(l.parent ILIKE '%Cash%' OR l.name ILIKE '%Cash%') THEN 'Cash'
        WHEN bool_or(l.parent ILIKE '%Bank%') THEN 'Bank'
        ELSE 'Other'
      END
      FROM voucher_ledger_entries vle
      JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
      WHERE vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid
        AND vle.dr_cr = '${modeDrCr}'
    ), 'Other')`;
}

async function sumWindow(companyGuid, voucherTypeLike, from, to, modeDrCr) {
  const { rows } = await query(
    `SELECT
       COALESCE(SUM(ABS(amount)), 0) AS total,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE mode = 'Cash'), 0) AS cash_total,
       COALESCE(SUM(ABS(amount)) FILTER (WHERE mode = 'Bank'), 0) AS bank_total
     FROM (
       SELECT v.amount,
         ${modeCaseSql(modeDrCr)} AS mode
       FROM vouchers v
       WHERE v.company_guid = $1
         AND v.voucher_type ILIKE $2
         AND v.is_cancelled = FALSE
         AND v.date BETWEEN $3 AND $4
     ) t`,
    [companyGuid, `%${voucherTypeLike}%`, from, to]
  );
  const r = rows[0] || {};
  return {
    total: money(r.total),
    cash_total: money(r.cash_total),
    bank_total: money(r.bank_total),
  };
}

async function sumDay(companyGuid, voucherTypeLike, day) {
  const { rows } = await query(
    `SELECT COALESCE(SUM(ABS(v.amount)), 0) AS total
     FROM vouchers v
     WHERE v.company_guid = $1
       AND v.voucher_type ILIKE $2
       AND v.is_cancelled = FALSE
       AND v.date = $3`,
    [companyGuid, `%${voucherTypeLike}%`, day]
  );
  return money(rows[0]?.total);
}

async function dailySeries(companyGuid, voucherTypeLike, from, to) {
  const { rows } = await query(
    `SELECT v.date::text AS day, COALESCE(SUM(ABS(v.amount)), 0) AS amount
     FROM vouchers v
     WHERE v.company_guid = $1
       AND v.voucher_type ILIKE $2
       AND v.is_cancelled = FALSE
       AND v.date BETWEEN $3 AND $4
     GROUP BY v.date
     ORDER BY v.date ASC`,
    [companyGuid, `%${voucherTypeLike}%`, from, to]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(isoDay(r.day), money(r.amount));
  }
  return enumerateDays(from, to).map((day) => ({
    day,
    amount: map.get(day) || 0,
  }));
}

async function listTransactions(companyGuid, voucherTypeLike, from, to, modeDrCr, limit = 100) {
  const { rows } = await query(
    `SELECT v.guid, v.voucher_number, v.party_name, v.amount, v.date, v.narration,
       ${modeCaseSql(modeDrCr)} AS mode
     FROM vouchers v
     WHERE v.company_guid = $1
       AND v.voucher_type ILIKE $2
       AND v.is_cancelled = FALSE
       AND v.date BETWEEN $3 AND $4
     ORDER BY v.date DESC, v.voucher_number DESC NULLS LAST
     LIMIT $5`,
    [companyGuid, `%${voucherTypeLike}%`, from, to, limit]
  );
  return rows.map((r) => ({
    guid: r.guid,
    voucher_number: r.voucher_number,
    party_name: r.party_name,
    amount: money(r.amount),
    date: r.date,
    narration: r.narration,
    mode: r.mode || 'Other',
  }));
}

/**
 * @param {'Payment'|'Receipt'} kind
 */
export async function buildPaymentReceiptPayload(companyGuid, { from, to, kind }) {
  const voucherTypeLike = kind === 'Receipt' ? 'Receipt' : 'Payment';
  const modeDrCr = kind === 'Receipt' ? 'Dr' : 'Cr';
  const todayIso = new Date().toISOString().slice(0, 10);
  const yesterdayIso = addDays(todayIso, -1);

  const periodDays = inclusiveDays(from, to);
  const priorTo = addDays(from, -1);
  const priorFrom = addDays(priorTo, -(periodDays - 1));

  // Series: full range capped at last 30 days ending at `to`
  let seriesTo = to;
  let seriesFrom = from;
  const span = inclusiveDays(from, to);
  if (span > 30) {
    seriesFrom = addDays(to, -(30 - 1));
  }
  // Phase 1 chart default preference: if caller asked ~7d, series is that window.
  // Longer periods still get daily (capped 30).

  const [current, prior, todayTotal, yesterdayTotal, series, transactions] = await Promise.all([
    sumWindow(companyGuid, voucherTypeLike, from, to, modeDrCr),
    sumWindow(companyGuid, voucherTypeLike, priorFrom, priorTo, modeDrCr),
    sumDay(companyGuid, voucherTypeLike, todayIso),
    sumDay(companyGuid, voucherTypeLike, yesterdayIso),
    dailySeries(companyGuid, voucherTypeLike, seriesFrom, seriesTo),
    listTransactions(companyGuid, voucherTypeLike, from, to, modeDrCr, 100),
  ]);

  const periodTrend = computeTrendPct(current.total, prior.total);
  const todayTrend = computeTrendPct(todayTotal, yesterdayTotal);
  const cashTrend = computeTrendPct(current.cash_total, prior.cash_total);
  const bankTrend = computeTrendPct(current.bank_total, prior.bank_total);

  const periodLabel = kind === 'Receipt' ? 'Receipts' : 'Payments';

  const kpi_cards = [
    {
      id: 'period',
      label: periodLabel,
      amount: current.total,
      trend_pct: periodTrend,
      trend_positive: periodTrend == null ? null : periodTrend >= 0,
    },
    {
      id: 'today',
      label: 'Today',
      amount: todayTotal,
      trend_pct: todayTrend,
      trend_positive: todayTrend == null ? null : todayTrend >= 0,
    },
    {
      id: 'cash',
      label: 'Cash',
      amount: current.cash_total,
      trend_pct: cashTrend,
      trend_positive: cashTrend == null ? null : cashTrend >= 0,
    },
    {
      id: 'bank',
      label: 'Bank',
      amount: current.bank_total,
      trend_pct: bankTrend,
      trend_positive: bankTrend == null ? null : bankTrend >= 0,
    },
  ];

  return {
    total: current.total,
    today_total: todayTotal,
    cash_total: current.cash_total,
    bank_total: current.bank_total,
    display: `₹${Math.round(current.total).toLocaleString('en-IN')}`,
    transactions,
    from,
    to,
    prior_from: priorFrom,
    prior_to: priorTo,
    daily_series: series,
    series_from: seriesFrom,
    series_to: seriesTo,
    kpi_cards,
    // Flat trend fields for easy clients
    trend_pct: periodTrend,
    trend_positive: periodTrend == null ? null : periodTrend >= 0,
    today_trend_pct: todayTrend,
    cash_trend_pct: cashTrend,
    bank_trend_pct: bankTrend,
  };
}
