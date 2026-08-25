/**
 * Loans & ODs calculation service (loan-calc-v1)
 * Spec: TallyDekho_Loans_ODs_Data_Acquisition_Calculation_Spec.md
 *
 * Sources: TALLY_EXACT | DERIVED | PREDICTED | UNKNOWN
 * Never present PREDICTED as bank/Tally contractual fact.
 */
import { query } from '../../db/schema.js';

export const CALC_VERSION = 'loan-calc-v1';

const LOAN_PARENT_RE = /^(secured loans|unsecured loans)$/i;
const OD_PARENT_RE = /bank\s*od|overdraft|cash\s*credit|\bcc\b/i;
const ASSET_LOAN_RE = /loans?\s*&\s*advances|deposits?\s*\(asset\)|employee\s*advance|prepaid/i;
const INTEREST_NAME_RE = /int(?:e)?rest|finance\s*cost|finance\s*charg/i;
const BANK_PARENT_RE = /bank\s*account|bank\s*od|cash|overdraft/i;

function money(n) {
  const v = Math.abs(parseFloat(n) || 0);
  return Math.round(v * 100) / 100;
}

function field(value, source, confidence = 1, extra = {}) {
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) {
    return { value: null, source: 'UNKNOWN', confidence: 0, ...extra };
  }
  return { value, source, confidence, ...extra };
}

function isoDate(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null;
}

function addMonths(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  const day = d.getDate();
  d.setMonth(d.getMonth() + n);
  // clamp shorter months
  if (d.getDate() < day) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = new Date(`${a}T12:00:00`);
  const db = new Date(`${b}T12:00:00`);
  return Math.round((db - da) / 86400000);
}

function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function classifyFacility(parent, name) {
  const p = String(parent || '').trim();
  const n = String(name || '').trim();
  if (ASSET_LOAN_RE.test(p) || ASSET_LOAN_RE.test(n)) return null;
  if (OD_PARENT_RE.test(p) || OD_PARENT_RE.test(n)) {
    return { facilityType: 'OD', securityType: 'UNKNOWN' };
  }
  if (LOAN_PARENT_RE.test(p) || /^secured loans$/i.test(p) || /^unsecured loans$/i.test(p)) {
    const securityType = /unsecured/i.test(p) ? 'UNSECURED' : (/secured/i.test(p) ? 'SECURED' : 'UNKNOWN');
    return { facilityType: 'LOAN', securityType };
  }
  // Exact parent tokens used in Tally (allow "Secured Loans" etc. already covered)
  if (/secured\s+loans?/i.test(p) || /unsecured\s+loans?/i.test(p)) {
    return {
      facilityType: 'LOAN',
      securityType: /unsecured/i.test(p) ? 'UNSECURED' : 'SECURED',
    };
  }
  return null;
}

async function loadCandidateLedgers(companyGuid) {
  const { rows } = await query(
    `SELECT guid, name, parent, closing_balance, balance_type, opening_balance,
            credit_limit
     FROM ledgers
     WHERE company_guid = $1
       AND (
         parent ILIKE 'Secured Loans'
         OR parent ILIKE 'Unsecured Loans'
         OR parent ILIKE '%Bank OD%'
         OR parent ILIKE '%Overdraft%'
         OR parent ILIKE '%Cash Credit%'
         OR parent ILIKE 'Bank OD A/c'
         OR parent ILIKE 'Bank OD Accounts'
       )
     ORDER BY ABS(closing_balance) DESC`,
    [companyGuid]
  );
  return rows
    .map((r) => {
      const c = classifyFacility(r.parent, r.name);
      if (!c) return null;
      return {
        ledgerGuid: r.guid,
        name: r.name,
        parent: r.parent || '',
        facilityType: c.facilityType,
        securityType: c.securityType,
        outstanding: money(r.closing_balance),
        balanceType: r.balance_type || 'Cr',
        openingBalance: money(r.opening_balance),
        creditLimit: r.credit_limit != null ? money(r.credit_limit) : null,
      };
    })
    .filter(Boolean);
}

async function loadLedgerMovements(companyGuid, ledgerName) {
  const { rows } = await query(
    `SELECT v.guid AS voucher_guid, v.date, v.voucher_number, v.voucher_type, v.party_name,
            vle.amount, vle.dr_cr, vle.ledger_name
     FROM voucher_ledger_entries vle
     JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
     WHERE vle.company_guid = $1 AND vle.ledger_name = $2 AND v.is_cancelled = FALSE
       AND v.date IS NOT NULL AND v.date <> ''
     ORDER BY v.date ASC, v.voucher_number ASC NULLS LAST`,
    [companyGuid, ledgerName]
  );
  return rows;
}

async function loadVoucherLegs(companyGuid, voucherGuids) {
  if (!voucherGuids.length) return new Map();
  const { rows } = await query(
    `SELECT vle.voucher_guid, vle.ledger_name, vle.amount, vle.dr_cr, l.parent
     FROM voucher_ledger_entries vle
     LEFT JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
     WHERE vle.company_guid = $1 AND vle.voucher_guid = ANY($2::text[])`,
    [companyGuid, voucherGuids]
  );
  const map = new Map();
  for (const r of rows) {
    const list = map.get(r.voucher_guid) || [];
    list.push(r);
    map.set(r.voucher_guid, list);
  }
  return map;
}

/**
 * Signed liability movement: Cr increases outstanding, Dr decreases.
 */
function signedLiabilityMove(amount, drCr) {
  const a = Math.abs(parseFloat(amount) || 0);
  if (String(drCr).toUpperCase() === 'CR') return a;
  if (String(drCr).toUpperCase() === 'DR') return -a;
  // signed amount fallback
  const raw = parseFloat(amount) || 0;
  return raw;
}

function detectEmiEvents(loanName, movements, legsByVoucher) {
  const byVoucher = new Map();
  for (const m of movements) {
    const list = byVoucher.get(m.voucher_guid) || [];
    list.push(m);
    byVoucher.set(m.voucher_guid, list);
  }

  const events = [];
  for (const [voucherGuid, loanLegs] of byVoucher) {
    const meta = loanLegs[0];
    const allLegs = legsByVoucher.get(voucherGuid) || loanLegs;
    const loanLeg = allLegs.find((l) => l.ledger_name === loanName);
    if (!loanLeg) continue;

    const principalMove = signedLiabilityMove(loanLeg.amount, loanLeg.dr_cr);
    const vtype = String(meta.voucher_type || '');

    if (principalMove > 0) {
      events.push({
        eventType: 'DRAWDOWN',
        voucherGuid,
        date: isoDate(meta.date),
        voucherNumber: meta.voucher_number,
        voucherType: vtype,
        partyName: meta.party_name,
        principalAmount: money(principalMove),
        interestAmount: 0,
        charges: 0,
        emiPaidAmount: 0,
      });
      continue;
    }

    if (principalMove >= 0) continue; // no reduction

    const principalRepaid = money(-principalMove);
    let interestAmount = 0;
    let charges = 0;
    let bankSettlement = 0;

    for (const leg of allLegs) {
      if (leg.ledger_name === loanName) continue;
      const amt = money(leg.amount);
      const isDr = String(leg.dr_cr).toUpperCase() === 'DR' || parseFloat(leg.amount) < 0;
      const parent = String(leg.parent || '');
      if (INTEREST_NAME_RE.test(leg.ledger_name)) {
        if (isDr) interestAmount += amt;
        continue;
      }
      if (BANK_PARENT_RE.test(parent) || /bank|cash/i.test(leg.ledger_name)) {
        // bank credit = money leaving company for EMI
        if (String(leg.dr_cr).toUpperCase() === 'CR' || parseFloat(leg.amount) > 0) {
          bankSettlement += amt;
        }
        continue;
      }
      if (isDr && /charge|fee|penal|bounce|process/i.test(leg.ledger_name)) {
        charges += amt;
      }
    }

    const emiPaid = money(principalRepaid + interestAmount + charges);
    const bankCheck = money(bankSettlement);
    const inconsistent = bankCheck > 0 && Math.abs(bankCheck - emiPaid) > Math.max(1, emiPaid * 0.05);

    events.push({
      eventType: principalRepaid > (medianEmiHint(events) || principalRepaid) * 1.75 ? 'PREPAYMENT' : 'EMI',
      voucherGuid,
      date: isoDate(meta.date),
      voucherNumber: meta.voucher_number,
      voucherType: vtype,
      partyName: meta.party_name,
      principalAmount: principalRepaid,
      interestAmount: money(interestAmount),
      charges: money(charges),
      emiPaidAmount: bankCheck > 0 ? bankCheck : emiPaid,
      inconsistent,
      source: interestAmount > 0 ? 'DERIVED' : 'DERIVED',
    });
  }

  // reclassify prepayments with full list
  const emiAmounts = events.filter((e) => e.eventType === 'EMI').map((e) => e.emiPaidAmount);
  const med = median(emiAmounts);
  if (med) {
    for (const e of events) {
      if (e.eventType === 'EMI' && e.principalAmount > med * 1.75 && e.interestAmount === 0) {
        e.eventType = 'PREPAYMENT';
      }
    }
  }

  return events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function medianEmiHint(events) {
  const amts = events.filter((e) => e.eventType === 'EMI').map((e) => e.emiPaidAmount).filter(Boolean);
  return median(amts);
}

function estimateOriginalPrincipal(facility, events) {
  const drawdowns = events.filter((e) => e.eventType === 'DRAWDOWN');
  const drawdownSum = drawdowns.reduce((s, e) => s + e.principalAmount, 0);

  // Opening (synced period) + subsequent drawdowns ≈ principal basis when history is partial
  if (facility.openingBalance > 0 || drawdownSum > 0) {
    const basis = money(facility.openingBalance + drawdownSum);
    if (basis >= facility.outstanding && basis > 0) {
      return field(basis, 'DERIVED', facility.openingBalance > 0 && drawdownSum > 0 ? 0.85 : 0.7, {
        method: 'OPENING_PLUS_DRAWDOWNS',
        principalBasis: 'PERIOD_PRINCIPAL_BASIS',
      });
    }
  }

  if (drawdowns.length === 1 && facility.openingBalance === 0) {
    return field(drawdowns[0].principalAmount, 'DERIVED', 0.9, {
      method: 'FIRST_DRAWDOWN',
      principalBasis: 'DISBURSEMENT',
    });
  }

  if (facility.openingBalance > 0) {
    return field(facility.openingBalance, 'DERIVED', 0.7, {
      method: 'OPENING_BALANCE',
      principalBasis: 'OPENING_BALANCE',
    });
  }

  const repaid = events
    .filter((e) => e.eventType === 'EMI' || e.eventType === 'PREPAYMENT')
    .reduce((s, e) => s + e.principalAmount, 0);
  const est = money(facility.outstanding + repaid - drawdownSum);
  if (est > facility.outstanding) {
    return field(est, 'DERIVED', 0.65, {
      method: 'REVERSE_HISTORY',
      principalBasis: 'HISTORICAL_RECONSTRUCTION',
    });
  }
  return field(facility.outstanding, 'DERIVED', 0.5, {
    method: 'CURRENT_AS_FALLBACK',
    principalBasis: 'CURRENT_OUTSTANDING',
  });
}

function estimateRateWithOpenings(emiEventsWithOpening) {
  const clean = emiEventsWithOpening.filter(
    (e) => e.eventType === 'EMI' && e.interestAmount > 0 && e.openingPrincipal > 0 && !e.inconsistent
  );
  if (!clean.length) {
    return field(null, 'UNKNOWN', 0, {
      method: 'NO_INTEREST_SPLIT',
      periodsUsed: 0,
      label: 'Estimated Rate',
    });
  }

  const annuals = [];
  for (let i = 0; i < clean.length; i++) {
    const e = clean[i];
    const prevDate = i > 0 ? clean[i - 1].date : null;
    const days = prevDate ? Math.max(1, daysBetween(prevDate, e.date)) : 30;
    const annual = (e.interestAmount / e.openingPrincipal) * (365 / days);
    if (Number.isFinite(annual) && annual > 0 && annual < 0.8) annuals.push(annual * 100);
  }
  if (!annuals.length) {
    return field(null, 'UNKNOWN', 0, { method: 'INSUFFICIENT_CLEAN_RATES', periodsUsed: 0, label: 'Estimated Rate' });
  }
  const med = median(annuals);
  // Spec: 1 period = low confidence / still show as Estimated; >=2 stronger
  const conf = annuals.length >= 6 ? 0.95 : annuals.length >= 3 ? 0.85 : annuals.length >= 2 ? 0.7 : 0.55;
  return field(Math.round(med * 100) / 100, annuals.length >= 2 ? 'DERIVED' : 'PREDICTED', conf, {
    method: 'MEDIAN_PERIOD_INTEREST_RATE',
    periodsUsed: annuals.length,
    periodRates: annuals.map((r) => Math.round(r * 100) / 100),
    label: 'Estimated Rate',
  });
}

function estimateEmiCadence(emiEvents) {
  const paid = emiEvents.filter((e) => e.eventType === 'EMI' && e.emiPaidAmount > 0 && e.date);
  if (!paid.length) {
    return {
      emiAmount: field(null, 'UNKNOWN', 0, { label: 'Expected EMI' }),
      nextDate: field(null, 'UNKNOWN', 0, { label: 'Expected EMI Date' }),
      preferredDay: null,
      richMode: false,
    };
  }

  const amounts = paid.map((e) => e.emiPaidAmount);
  const medAmt = median(amounts);
  const near = amounts.filter((a) => a >= medAmt * 0.75 && a <= medAmt * 1.25);
  const expectedEmi = median(near.length ? near : amounts);

  const days = paid.map((e) => new Date(`${e.date}T12:00:00`).getDate());
  const dayCounts = {};
  for (const d of days) dayCounts[d] = (dayCounts[d] || 0) + 1;
  const preferredDay = Number(
    Object.entries(dayCounts).sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))[0][0]
  );

  const last = paid[paid.length - 1].date;
  let next = addMonths(last, 1);
  const y = Number(next.slice(0, 4));
  const m = Number(next.slice(5, 7));
  const lastDay = new Date(y, m, 0).getDate();
  const day = Math.min(preferredDay, lastDay);
  next = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (next <= last) {
    next = addMonths(next, 1);
    const y2 = Number(next.slice(0, 4));
    const m2 = Number(next.slice(5, 7));
    const ld2 = new Date(y2, m2, 0).getDate();
    next = `${y2}-${String(m2).padStart(2, '0')}-${String(Math.min(preferredDay, ld2)).padStart(2, '0')}`;
  }

  const confAmt = paid.length >= 6 ? 0.9 : paid.length >= 3 ? 0.8 : paid.length >= 2 ? 0.7 : 0.55;
  const confDate = paid.length >= 6 ? 0.9 : paid.length >= 3 ? 0.75 : paid.length >= 2 ? 0.65 : 0.5;
  const hasInterest = paid.some((e) => e.interestAmount > 0);

  return {
    emiAmount: field(money(expectedEmi), paid.length >= 2 ? 'PREDICTED' : 'DERIVED', confAmt, {
      method: paid.length >= 2 ? 'MEDIAN_RECURRING_EMI' : 'SINGLE_EMI_PAID',
      label: 'Expected EMI',
      samples: paid.length,
    }),
    nextDate: field(next, 'PREDICTED', confDate, {
      method: 'CADENCE_DAY_OF_MONTH',
      label: 'Expected EMI Date',
      preferredDay,
    }),
    preferredDay,
    // RICH when we can show EMI economics (interest split) or recurring pattern
    richMode: hasInterest || paid.length >= 2,
  };
}

function monthEndSeries(facility, movements, months = 6) {
  // Build signed outstanding from opening + movements
  const today = new Date();
  const ends = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i + 1, 0); // last day of month
    ends.push(d.toISOString().slice(0, 10));
  }

  let bal = facility.openingBalance || 0;
  // If opening is 0 but we have movements before first month, reconstruct
  const sorted = [...movements].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let idx = 0;
  // Start from before first end: apply all moves before first month start
  const firstMonthStart = ends[0].slice(0, 8) + '01';
  while (idx < sorted.length && String(sorted[idx].date).slice(0, 10) < firstMonthStart) {
    bal += signedLiabilityMove(sorted[idx].amount, sorted[idx].dr_cr);
    idx++;
  }

  const series = [];
  for (const end of ends) {
    while (idx < sorted.length && String(sorted[idx].date).slice(0, 10) <= end) {
      bal += signedLiabilityMove(sorted[idx].amount, sorted[idx].dr_cr);
      idx++;
    }
    series.push({
      month: end.slice(0, 7),
      outstanding: money(Math.max(bal, 0)),
    });
  }

  // If series ends far from current outstanding, snap last point to current (sync truth)
  if (series.length) {
    series[series.length - 1].outstanding = facility.outstanding;
  }
  return series;
}

function attachOpenings(events, facility) {
  let bal = facility.openingBalance || 0;
  // If opening 0, start from 0 and apply chronologically
  const out = [];
  for (const e of events) {
    if (e.eventType === 'DRAWDOWN') {
      out.push({ ...e, openingPrincipal: money(bal) });
      bal += e.principalAmount;
    } else if (e.eventType === 'EMI' || e.eventType === 'PREPAYMENT') {
      out.push({ ...e, openingPrincipal: money(bal) });
      bal = Math.max(0, bal - e.principalAmount);
    } else {
      out.push({ ...e, openingPrincipal: money(bal) });
    }
  }
  // If final bal mismatches outstanding badly and opening was 0, re-base using reverse
  if (facility.openingBalance === 0 && Math.abs(bal - facility.outstanding) > 1) {
    // reverse-walk from outstanding
    let b = facility.outstanding;
    const rev = [...events].reverse();
    const openings = new Map();
    for (const e of rev) {
      if (e.eventType === 'EMI' || e.eventType === 'PREPAYMENT') {
        b = b + e.principalAmount;
        openings.set(e.voucherGuid, money(b));
      } else if (e.eventType === 'DRAWDOWN') {
        openings.set(e.voucherGuid, money(b));
        b = Math.max(0, b - e.principalAmount);
      }
    }
    return events.map((e) => ({ ...e, openingPrincipal: openings.get(e.voucherGuid) || e.openingPrincipal || 0 }));
  }
  return out;
}

function remainingPayments(P, A, annualPct) {
  if (!P || !A || !annualPct) return null;
  const i = annualPct / 100 / 12;
  if (i <= 0 || A <= i * P) return null;
  const n = Math.log(A / (A - i * P)) / Math.log(1 + i);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n);
}

function buildOdUtilisation(facility, movements, days = 30) {
  const limit = facility.creditLimit;
  const today = new Date();
  const dates = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(d.toISOString().slice(0, 10));
  }

  const sorted = [...movements].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let bal = facility.openingBalance || 0;
  let idx = 0;
  const windowStart = dates[0];
  while (idx < sorted.length && String(sorted[idx].date).slice(0, 10) < windowStart) {
    bal += signedLiabilityMove(sorted[idx].amount, sorted[idx].dr_cr);
    idx++;
  }

  const series = [];
  for (const day of dates) {
    while (idx < sorted.length && String(sorted[idx].date).slice(0, 10) <= day) {
      bal += signedLiabilityMove(sorted[idx].amount, sorted[idx].dr_cr);
      idx++;
    }
    const utilised = money(Math.max(bal, 0));
    const pct = limit > 0 ? Math.round((utilised / limit) * 1000) / 10 : null;
    series.push({ date: day, utilised, utilisationPct: pct });
  }
  if (series.length) {
    series[series.length - 1].utilised = facility.outstanding;
    if (limit > 0) {
      series[series.length - 1].utilisationPct = Math.round((facility.outstanding / limit) * 1000) / 10;
    }
  }
  const utilisedVals = series.map((s) => s.utilised);
  return {
    series,
    averageUtilisation: money(utilisedVals.reduce((a, b) => a + b, 0) / (utilisedVals.length || 1)),
    peakUtilisation: money(Math.max(0, ...utilisedVals)),
    creditLimit: limit != null ? field(limit, 'TALLY_EXACT', 1) : field(null, 'UNKNOWN', 0),
    utilised: field(facility.outstanding, 'TALLY_EXACT', 1),
    available: limit != null
      ? field(money(Math.max(limit - facility.outstanding, 0)), 'DERIVED', 1)
      : field(null, 'UNKNOWN', 0),
    utilisationPct: limit > 0
      ? field(Math.round((facility.outstanding / limit) * 1000) / 10, 'DERIVED', 1)
      : field(null, 'UNKNOWN', 0),
  };
}

function buildUpcomingFromCadence(emiAmountField, nextDateField, count = 6) {
  if (!emiAmountField?.value || !nextDateField?.value) return [];
  const rows = [];
  let d = nextDateField.value;
  for (let i = 0; i < count; i++) {
    rows.push({
      installmentNo: i + 1,
      dueDate: d,
      scheduledAmount: emiAmountField.value,
      status: i === 0 ? 'UPCOMING' : 'UPCOMING',
      source: 'PREDICTED',
      label: 'Expected EMI',
    });
    d = addMonths(d, 1);
  }
  return rows;
}

async function enrichLoan(companyGuid, facility) {
  const movements = await loadLedgerMovements(companyGuid, facility.name);
  const voucherGuids = [...new Set(movements.map((m) => m.voucher_guid))];
  const legsByVoucher = await loadVoucherLegs(companyGuid, voucherGuids);
  let events = detectEmiEvents(facility.name, movements, legsByVoucher);
  events = attachOpenings(events, facility);

  const emiEvents = events.filter((e) => e.eventType === 'EMI');
  const original = estimateOriginalPrincipal(facility, events);
  const rate = estimateRateWithOpenings(events);
  const cadence = estimateEmiCadence(emiEvents);
  const richMode = !!cadence.richMode;

  const outstandingHistory = monthEndSeries(facility, movements, 6);
  let remainingPct = null;
  let repaidPct = null;
  if (
    original.value
    && original.value > 0
    && original.principalBasis !== 'CURRENT_OUTSTANDING'
    && original.value >= facility.outstanding
  ) {
    remainingPct = field(
      Math.round((facility.outstanding / original.value) * 1000) / 10,
      'DERIVED',
      original.confidence,
      { label: 'Outstanding remaining %' }
    );
    repaidPct = field(
      Math.round(((original.value - facility.outstanding) / original.value) * 1000) / 10,
      'DERIVED',
      original.confidence,
      { label: 'Principal repaid %' }
    );
  }

  let maturity = field(null, 'UNKNOWN', 0);
  if (richMode && rate.value && cadence.emiAmount.value && cadence.nextDate.value) {
    const n = remainingPayments(facility.outstanding, cadence.emiAmount.value, rate.value);
    if (n) {
      const mat = addMonths(cadence.nextDate.value, n - 1);
      maturity = field(mat, 'DERIVED', Math.min(0.9, rate.confidence), {
        method: 'AMORTISATION_REMAINING',
        label: 'Estimated Payoff',
        remainingPayments: n,
      });
    }
  }

  const transactions = [...events].reverse().slice(0, 20).map((e) => ({
    guid: e.voucherGuid,
    date: e.date,
    voucher_number: e.voucherNumber,
    voucher_type: e.voucherType,
    party_name: e.partyName,
    eventType: e.eventType,
    principalAmount: e.principalAmount,
    interestAmount: e.interestAmount,
    amount: e.eventType === 'DRAWDOWN' ? e.principalAmount : e.emiPaidAmount || e.principalAmount,
    type: e.eventType === 'DRAWDOWN' ? 'Cr' : 'Dr',
  }));

  const upcoming = richMode
    ? buildUpcomingFromCadence(cadence.emiAmount, cadence.nextDate, 6)
    : [];

  return {
    ...facility,
    mode: richMode ? 'RICH' : 'SIMPLE',
    originalPrincipal: original,
    outstanding: field(facility.outstanding, 'TALLY_EXACT', 1, { label: 'Outstanding as per Tally' }),
    interestRate: rate.value != null
      ? rate
      : field(null, 'UNKNOWN', 0, { label: 'Estimated Rate' }),
    emi: {
      amount: cadence.emiAmount,
      nextDate: cadence.nextDate,
    },
    maturity,
    remainingPct,
    repaidPct,
    outstandingHistory,
    upcomingInstallments: upcoming,
    recentEvents: events.filter((e) => e.eventType === 'EMI' || e.eventType === 'PREPAYMENT').slice(-8).reverse(),
    transactions,
    calculationVersion: CALC_VERSION,
  };
}

async function enrichOd(companyGuid, facility) {
  const movements = await loadLedgerMovements(companyGuid, facility.name);
  const util = buildOdUtilisation(facility, movements, 30);

  // Interest history: expense co-occurrence rough
  const voucherGuids = [...new Set(movements.map((m) => m.voucher_guid))];
  const legsByVoucher = await loadVoucherLegs(companyGuid, voucherGuids);
  const interestEvents = [];
  for (const [vg, legs] of legsByVoucher) {
    const interestLegs = legs.filter((l) => INTEREST_NAME_RE.test(l.ledger_name));
    if (!interestLegs.length) continue;
    const meta = movements.find((m) => m.voucher_guid === vg);
    if (!meta) continue;
    interestEvents.push({
      date: isoDate(meta.date),
      amount: money(interestLegs.reduce((s, l) => s + Math.abs(parseFloat(l.amount) || 0), 0)),
      voucherGuid: vg,
    });
  }
  interestEvents.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  let nextInterestDate = field(null, 'UNKNOWN', 0);
  if (interestEvents.length >= 3) {
    const days = interestEvents.map((e) => new Date(`${e.date}T12:00:00`).getDate());
    const lastDays = interestEvents.filter((e) => {
      const d = new Date(`${e.date}T12:00:00`);
      return d.getDate() === new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    });
    const last = interestEvents[interestEvents.length - 1].date;
    if (lastDays.length >= Math.ceil(interestEvents.length * 0.6)) {
      const nd = new Date(`${last}T12:00:00`);
      nd.setMonth(nd.getMonth() + 2, 0); // last day next month after last
      // last day of month after last's month
      const y = nd.getFullYear();
      const m = nd.getMonth() + 1;
      const iso = new Date(y, m, 0).toISOString().slice(0, 10);
      nextInterestDate = field(iso, 'PREDICTED', 0.85, {
        method: 'LAST_DAY_OF_MONTH',
        label: 'Expected Interest Date',
      });
    } else {
      const preferred = Number(
        Object.entries(days.reduce((a, d) => ((a[d] = (a[d] || 0) + 1), a), {}))
          .sort((a, b) => b[1] - a[1])[0][0]
      );
      let next = addMonths(last, 1);
      const y = Number(next.slice(0, 4));
      const m = Number(next.slice(5, 7));
      const ld = new Date(y, m, 0).getDate();
      next = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(preferred, ld)).padStart(2, '0')}`;
      nextInterestDate = field(next, 'PREDICTED', 0.8, {
        method: 'FIXED_DAY_OF_MONTH',
        label: 'Expected Interest Date',
      });
    }
  }

  const transactions = movements.slice(-20).reverse().map((m) => ({
    guid: m.voucher_guid,
    date: isoDate(m.date),
    voucher_number: m.voucher_number,
    voucher_type: m.voucher_type,
    party_name: m.party_name,
    amount: money(m.amount),
    type: m.dr_cr,
  }));

  return {
    ...facility,
    mode: facility.creditLimit || interestEvents.length ? 'RICH' : 'SIMPLE',
    outstanding: field(facility.outstanding, 'TALLY_EXACT', 1),
    ...util,
    interestHistory: interestEvents.slice(-12).reverse(),
    nextInterestDate,
    transactions,
    calculationVersion: CALC_VERSION,
  };
}

/**
 * Build full KPI payload for Loans & ODs screen.
 */
export async function buildLoansOdsPayload(companyGuid) {
  const asOf = new Date().toISOString();
  const facilities = await loadCandidateLedgers(companyGuid);
  const loans = [];
  const overdrafts = [];

  for (const f of facilities) {
    if (f.facilityType === 'OD') {
      overdrafts.push(await enrichOd(companyGuid, f));
    } else {
      loans.push(await enrichLoan(companyGuid, f));
    }
  }

  // normalize outstanding number for totals — enrich returns field objects
  const loanSum = loans.reduce((s, l) => s + money(l.outstanding?.value ?? l.outstanding), 0);
  const odSum = overdrafts.reduce((s, l) => s + money(l.outstanding?.value ?? l.outstanding), 0);
  const total = money(loanSum + odSum);

  return {
    total,
    loan_total: money(loanSum),
    od_total: money(odSum),
    display: `₹${Math.round(total).toLocaleString('en-IN')}`,
    loans,
    overdrafts,
    // backward compatible flat list for older clients
    facilities: [...loans, ...overdrafts],
    asOf,
    calculationVersion: CALC_VERSION,
  };
}

export { classifyFacility };
