/**
 * Cash in Hand + Bank Balance KPI — daily series + trend pills (Phase 2).
 * Balance trend = current vs balance at start of series window (equal-length lookback).
 * Today in/out/net = today vs previous calendar day (null if prior = 0).
 */
import { query } from '../../db/schema.js';
import {
  money, isoDay, addDays, computeTrendPct, trendFields,
} from './trendUtil.js';

const CASH_LEDGER_SQL = `(l.parent ILIKE '%Cash%' OR l.name ILIKE '%Cash in Hand%' OR l.name ILIKE 'Cash')`;
const BANK_LEDGER_SQL = `(
  l.parent ILIKE '%Bank Accounts%' OR l.parent ILIKE '%Bank Account%'
  OR l.parent ILIKE '%Bank OD%' OR l.parent ILIKE '%Overdraft%'
  OR (l.parent ILIKE '%Bank%' AND l.parent NOT ILIKE '%Bank Charge%'
      AND l.parent NOT ILIKE '%Bank Interest%' AND l.parent NOT ILIKE '%Bank Exp%')
)`;

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

async function dailyCashMoves(companyId, from, to) {
  const { rows } = await query(
    `SELECT v.date::text AS day,
            SUM(CASE WHEN vle.dr_cr = 'Dr' THEN ABS(vle.amount) ELSE 0 END) AS inflow,
            SUM(CASE WHEN vle.dr_cr = 'Cr' THEN ABS(vle.amount) ELSE 0 END) AS outflow
     FROM voucher_ledger_entries vle
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
     WHERE vle.company_id=$1 AND v.is_cancelled = FALSE
       AND v.date BETWEEN $2 AND $3
       AND ${CASH_LEDGER_SQL}
     GROUP BY v.date
     ORDER BY v.date ASC`,
    [companyId, from, to]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(isoDay(r.day), {
      inflow: money(r.inflow),
      outflow: money(r.outflow),
    });
  }
  return map;
}

async function dailyBankMoves(companyId, from, to) {
  const { rows } = await query(
    `SELECT v.date::text AS day,
            SUM(CASE WHEN vle.dr_cr = 'Dr' THEN ABS(vle.amount) ELSE 0 END) AS inflow,
            SUM(CASE WHEN vle.dr_cr = 'Cr' THEN ABS(vle.amount) ELSE 0 END) AS outflow
     FROM voucher_ledger_entries vle
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_id = vle.company_id
     JOIN ledgers l ON l.name = vle.ledger_name AND l.company_id = vle.company_id
     WHERE vle.company_id=$1 AND v.is_cancelled = FALSE
       AND v.date BETWEEN $2 AND $3
       AND ${BANK_LEDGER_SQL}
     GROUP BY v.date
     ORDER BY v.date ASC`,
    [companyId, from, to]
  );
  const map = new Map();
  for (const r of rows) {
    map.set(isoDay(r.day), {
      inflow: money(r.inflow),
      outflow: money(r.outflow),
    });
  }
  return map;
}

/** Walk back from current book balance using daily net moves. */
function buildDailyBalanceSeries(dayKeys, moveMap, currentBalance) {
  const closingByDay = new Map();
  let cursor = currentBalance;
  for (let i = dayKeys.length - 1; i >= 0; i--) {
    const day = dayKeys[i];
    closingByDay.set(day, cursor);
    const m = moveMap.get(day) || { inflow: 0, outflow: 0 };
    cursor = cursor - m.inflow + m.outflow;
  }
  return dayKeys.map((day, i) => ({
    day,
    label: String(i + 1),
    balance: money(closingByDay.get(day) || 0),
    inflow: money(moveMap.get(day)?.inflow || 0),
    outflow: money(moveMap.get(day)?.outflow || 0),
  }));
}

export async function buildCashInHandPayload(companyId, { from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);

  const { rows: cashLedgers } = await query(
    `SELECT name, closing_balance FROM ledgers
     WHERE company_id=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%' OR name ILIKE 'Cash')
     ORDER BY ABS(closing_balance) DESC`,
    [companyId]
  );
  const { rows: txns } = await query(
    `SELECT v.guid, v.voucher_number, v.party_name, v.voucher_type, v.amount, v.date, v.narration,
            COALESCE((
              SELECT CASE WHEN bool_or(vle.dr_cr='Dr') THEN 'in' ELSE 'out' END
              FROM voucher_ledger_entries vle
              JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
              WHERE vle.voucher_guid=v.guid AND vle.company_id=v.company_id
                AND (l.parent ILIKE '%Cash%' OR l.name ILIKE '%Cash%')
            ), 'out') AS direction
     FROM vouchers v
     WHERE v.company_id=$1 AND v.is_cancelled=FALSE
       AND v.voucher_type IN ('Payment','Receipt','Contra')
       AND v.date BETWEEN $2 AND $3
       AND EXISTS (
         SELECT 1 FROM voucher_ledger_entries vle
         JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
         WHERE vle.voucher_guid=v.guid AND vle.company_id=v.company_id
           AND (l.parent ILIKE '%Cash%' OR l.name ILIKE '%Cash%')
       )
     ORDER BY v.date DESC, v.voucher_number DESC NULLS LAST
     LIMIT 50`,
    [companyId, from, to]
  );

  const balance = money(cashLedgers.reduce((s, l) => s + Math.abs(parseFloat(l.closing_balance || 0)), 0));
  const mapped = txns.map((t) => ({
    guid: t.guid,
    voucher_number: t.voucher_number,
    party_name: t.party_name,
    voucher_type: t.voucher_type,
    amount: money(t.amount),
    date: t.date,
    narration: t.narration,
    direction: t.direction === 'in' ? 'in' : 'out',
  }));

  const seriesDays = 30;
  const seriesFrom = addDays(today, -(seriesDays - 1));
  const moveMap = await dailyCashMoves(companyId, seriesFrom, today);
  const dayKeys = enumerateDays(seriesFrom, today);
  const daily_balance = buildDailyBalanceSeries(dayKeys, moveMap, balance);

  const lastBal = daily_balance[daily_balance.length - 1]?.balance ?? balance;
  const prevDayBal = daily_balance.length >= 2
    ? daily_balance[daily_balance.length - 2].balance
    : null;
  const windowStartBal = daily_balance[0]?.balance ?? null;

  const todayIn = money(moveMap.get(today)?.inflow || 0);
  const todayOut = money(moveMap.get(today)?.outflow || 0);
  const yIn = money(moveMap.get(yesterday)?.inflow || 0);
  const yOut = money(moveMap.get(yesterday)?.outflow || 0);
  const todayNet = Math.round((todayIn - todayOut) * 100) / 100;
  const yNet = Math.round((yIn - yOut) * 100) / 100;

  // Balance vs equal-length lookback (start of 30d series); day-over-day for header badge
  const balTrend = computeTrendPct(lastBal, windowStartBal);
  const balChange = prevDayBal == null ? 0 : Math.round((lastBal - prevDayBal) * 100) / 100;
  const balChangePct = prevDayBal == null ? null : computeTrendPct(lastBal, prevDayBal);

  const inTrend = computeTrendPct(todayIn, yIn);
  const outTrend = computeTrendPct(todayOut, yOut);
  const netTrend = computeTrendPct(todayNet, yNet);

  const kpi_cards = [
    {
      id: 'bal',
      label: 'Cash on Hand',
      amount: balance,
      ...trendFields(balTrend),
    },
    {
      id: 'in',
      label: 'Inflow Today',
      amount: todayIn,
      ...trendFields(inTrend),
    },
    {
      id: 'out',
      label: 'Outflow Today',
      amount: todayOut,
      ...trendFields(outTrend),
    },
    {
      id: 'net',
      label: 'Net Today',
      amount: todayNet,
      ...trendFields(netTrend),
    },
  ];

  return {
    current_balance: balance,
    today_inflow: todayIn,
    today_outflow: todayOut,
    display: `₹${Math.round(balance).toLocaleString('en-IN')}`,
    ledgers: cashLedgers.map((l) => ({
      name: l.name,
      balance: money(l.closing_balance),
    })),
    transactions: mapped,
    daily_balance,
    balance_change: balChange,
    balance_change_pct: balChangePct,
    series_days: seriesDays,
    kpi_cards,
    trend_pct: balTrend,
    trend_positive: balTrend == null ? null : balTrend >= 0,
    from,
    to,
  };
}

export async function buildBankBalancePayload(companyId, { from, to } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = addDays(today, -1);

  const { rows: banks } = await query(
    `SELECT name, closing_balance, parent,
            bank_account_no, bank_ifsc, bank_name, bank_branch, bank_holder
     FROM ledgers
     WHERE company_id=$1
       AND (
         parent ILIKE '%Bank Accounts%' OR parent ILIKE '%Bank Account%'
         OR parent ILIKE '%Bank OD%' OR parent ILIKE '%Overdraft%'
         OR (parent ILIKE '%Bank%' AND parent NOT ILIKE '%Bank Charge%'
             AND parent NOT ILIKE '%Bank Interest%' AND parent NOT ILIKE '%Bank Exp%')
       )
     ORDER BY ABS(closing_balance) DESC`,
    [companyId]
  );
  const { rows: txnRows } = await query(
    `SELECT vle.ledger_name, v.guid, v.voucher_number, v.party_name, v.voucher_type, v.date,
            ABS(vle.amount) AS amount, vle.dr_cr
     FROM voucher_ledger_entries vle
     JOIN vouchers v ON v.guid=vle.voucher_guid AND v.company_id=vle.company_id
     JOIN ledgers l ON l.name=vle.ledger_name AND l.company_id=vle.company_id
     WHERE vle.company_id=$1 AND v.is_cancelled=FALSE
       AND v.date BETWEEN $2 AND $3
       AND ${BANK_LEDGER_SQL}
     ORDER BY v.date DESC, v.voucher_number DESC NULLS LAST
     LIMIT 300`,
    [companyId, from, to]
  );

  const byBank = new Map();
  for (const t of txnRows) {
    const list = byBank.get(t.ledger_name) || [];
    if (list.length < 15) {
      list.push({
        guid: t.guid,
        voucher_number: t.voucher_number,
        party_name: t.party_name,
        voucher_type: t.voucher_type,
        date: t.date,
        amount: money(t.amount),
        type: t.dr_cr === 'Dr' ? 'Dr' : 'Cr',
      });
      byBank.set(t.ledger_name, list);
    }
  }

  const bankList = banks.map((b) => ({
    name: b.name,
    parent: b.parent || '',
    balance: money(b.closing_balance),
    account_number: b.bank_account_no || '',
    ifsc: b.bank_ifsc || '',
    bank_name: b.bank_name || '',
    branch: b.bank_branch || '',
    account_holder: b.bank_holder || '',
    transactions: byBank.get(b.name) || [],
  }));
  const total = money(bankList.reduce((s, b) => s + b.balance, 0));

  const seriesDays = 30;
  const seriesFrom = addDays(today, -(seriesDays - 1));
  const moveMap = await dailyBankMoves(companyId, seriesFrom, today);
  const dayKeys = enumerateDays(seriesFrom, today);
  const daily_balance = buildDailyBalanceSeries(dayKeys, moveMap, total);

  const lastBal = daily_balance[daily_balance.length - 1]?.balance ?? total;
  const windowStartBal = daily_balance[0]?.balance ?? null;

  const todayIn = money(moveMap.get(today)?.inflow || 0);
  const todayOut = money(moveMap.get(today)?.outflow || 0);
  const yIn = money(moveMap.get(yesterday)?.inflow || 0);
  const yOut = money(moveMap.get(yesterday)?.outflow || 0);

  const balTrend = computeTrendPct(lastBal, windowStartBal);
  const inTrend = computeTrendPct(todayIn, yIn);
  const outTrend = computeTrendPct(todayOut, yOut);

  const kpi_cards = [
    {
      id: 'total',
      label: 'Book Balance (Tally)',
      amount: total,
      ...trendFields(balTrend),
    },
    {
      id: 'in',
      label: 'Inflow Today',
      amount: todayIn,
      ...trendFields(inTrend),
    },
    {
      id: 'out',
      label: 'Outflow Today',
      amount: todayOut,
      ...trendFields(outTrend),
    },
    {
      id: 'count',
      label: 'Bank Accounts',
      amount: bankList.length,
      trend_pct: null,
      trend_positive: null,
    },
  ];

  return {
    total_balance: total,
    today_inflow: todayIn,
    today_outflow: todayOut,
    display: `₹${Math.round(total).toLocaleString('en-IN')}`,
    balance_source: 'book',
    balance_label: 'Book Balance (Tally)',
    banks: bankList,
    daily_balance,
    series_days: seriesDays,
    kpi_cards,
    trend_pct: balTrend,
    trend_positive: balTrend == null ? null : balTrend >= 0,
    from,
    to,
  };
}
