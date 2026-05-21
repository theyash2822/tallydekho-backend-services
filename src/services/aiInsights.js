/**
 * TallyDekho — AI Insights Service
 *
 * Architecture: Hybrid (SQL calculates, LLM only narrates)
 *   SQL → Deterministic Insight Objects → Cached LLM Narration → UI Cards
 *
 * Rules:
 *   - LLM NEVER calculates. SQL always calculates.
 *   - LLM only narrates summarized metrics.
 *   - Current FY: live analytics + monthly cached LLM narration + forecasting
 *   - Historical FY: deterministic rules only, no LLM, no forecasting
 *   - Cache regenerates once per month per company (not per sync/refresh)
 */

import fetch from 'node-fetch';
import { query } from '../db/schema.js';

const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const GROQ_MODEL    = 'llama-3.1-8b-instant';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Determine current Indian FY label (e.g. "2026-2027")
// ─────────────────────────────────────────────────────────────────────────────
export function currentFYLabel() {
  const now   = new Date();
  const month = now.getMonth() + 1; // 1-indexed
  const year  = now.getFullYear();
  const start = month >= 4 ? year : year - 1;
  return `${start}-${start + 1}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY: Current month key (e.g. "2026-05")
// ─────────────────────────────────────────────────────────────────────────────
export function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — SQL Analytics Engine (deterministic, runs always)
// ─────────────────────────────────────────────────────────────────────────────
export async function computeInsightMetrics(companyGuid, from, to, financialYear = '') {
  const nowStr = new Date().toISOString().split('T')[0];

  const [monthlyRows, topSuppliersRows, topCustomersRows, stockoutRows, receivablesRows] =
    await Promise.all([

      // Monthly revenue + expenses
      query(`
        SELECT
          TO_CHAR(date::date, 'Mon YY') AS lbl,
          EXTRACT(YEAR  FROM date::date)::int AS yr,
          EXTRACT(MONTH FROM date::date)::int AS mn,
          COALESCE(SUM(CASE WHEN voucher_type ILIKE '%Sales%'
            AND voucher_type NOT ILIKE '%Order%'
            AND voucher_type NOT ILIKE '%Purchase%' THEN ABS(amount) ELSE 0 END), 0) AS revenue,
          COALESCE(SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN ABS(amount) ELSE 0 END), 0) AS expenses
        FROM vouchers
        WHERE company_guid=$1 AND is_cancelled=FALSE
          AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          AND date BETWEEN $2 AND $3
        GROUP BY lbl, yr, mn ORDER BY yr, mn
      `, [companyGuid, from, to]),

      // Top 5 suppliers
      query(`
        SELECT party_name, SUM(ABS(amount)) AS total_spend, COUNT(*) AS txns
        FROM vouchers
        WHERE company_guid=$1 AND is_cancelled=FALSE
          AND voucher_type ILIKE '%Purchase%'
          AND party_name IS NOT NULL AND party_name != ''
          AND date BETWEEN $2 AND $3
        GROUP BY party_name ORDER BY total_spend DESC LIMIT 5
      `, [companyGuid, from, to]),

      // Top 5 customers
      query(`
        SELECT party_name, SUM(ABS(amount)) AS total_rev, COUNT(*) AS txns
        FROM vouchers
        WHERE company_guid=$1 AND is_cancelled=FALSE
          AND voucher_type ILIKE '%Sales%'
          AND voucher_type NOT ILIKE '%Order%'
          AND party_name IS NOT NULL AND party_name != ''
          AND date BETWEEN $2 AND $3
        GROUP BY party_name ORDER BY total_rev DESC LIMIT 5
      `, [companyGuid, from, to]),

      // Stockout / low-stock
      query(`
        SELECT name, closing_qty, reorder_level, unit
        FROM stocks
        WHERE company_guid=$1
          AND reorder_level > 0 AND closing_qty <= reorder_level
        ORDER BY closing_qty ASC LIMIT 8
      `, [companyGuid]),

      // Receivables aging
      query(`
        SELECT
          SUM(CASE WHEN b.due_date IS NOT NULL AND b.due_date != ''
                   AND b.due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                   AND ($1::date - b.due_date::date) BETWEEN 0  AND 30  THEN ABS(b.pending_amount) ELSE 0 END) AS bucket_0_30,
          SUM(CASE WHEN b.due_date IS NOT NULL AND b.due_date != ''
                   AND b.due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                   AND ($1::date - b.due_date::date) BETWEEN 31 AND 60  THEN ABS(b.pending_amount) ELSE 0 END) AS bucket_31_60,
          SUM(CASE WHEN b.due_date IS NOT NULL AND b.due_date != ''
                   AND b.due_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
                   AND ($1::date - b.due_date::date) > 60              THEN ABS(b.pending_amount) ELSE 0 END) AS bucket_61plus,
          SUM(ABS(b.pending_amount)) AS total
        FROM bill_outstanding b
        WHERE b.company_guid=$2 AND b.pending_amount > 0
          AND b.bill_type NOT ILIKE '%Cr%'
      `, [nowStr, companyGuid]),
    ]);

  // ── Revenue forecast (current FY only) ─────────────────────────────────────
  const months = monthlyRows.rows;
  const forecastData = months.map(r => ({
    month:    r.lbl,
    actual:   parseFloat(r.revenue),
    expenses: parseFloat(r.expenses),
  }));

  // Only add forecast if ≥4 months of actual data (no artificial bias)
  if (months.length >= 4) {
    const last3 = forecastData.slice(-3).map(d => d.actual);
    const avg   = last3.reduce((s, v) => s + v, 0) / last3.length;
    const lastRow = months[months.length - 1];
    for (let i = 1; i <= 3; i++) {
      const nm = ((lastRow.mn - 1 + i) % 12) + 1;
      const ny = lastRow.yr + Math.floor((lastRow.mn - 1 + i) / 12);
      const d  = new Date(ny, nm - 1, 1);
      const lbl = d.toLocaleString('en-IN', { month: 'short', year: '2-digit' });
      // Pure moving average — no artificial growth bias
      forecastData.push({ month: lbl, actual: null, expenses: null, forecast: Math.round(avg) });
    }
  }

  // Backfill forecast line for actual months (3-month rolling avg)
  for (let i = 0; i < forecastData.length; i++) {
    if (forecastData[i].forecast !== undefined) continue;
    const window = forecastData.slice(Math.max(0, i - 2), i + 1).map(d => d.actual || 0);
    forecastData[i].forecast = Math.round(window.reduce((s, v) => s + v, 0) / window.length);
  }

  // ── Expense spike detection ────────────────────────────────────────────────
  const expenseData = forecastData
    .filter(d => d.expenses !== null)
    .map(d => ({ month: d.month, amount: d.expenses || 0 }));
  const avgExpense = expenseData.length
    ? expenseData.reduce((s, d) => s + d.amount, 0) / expenseData.length : 0;
  const expenseWithSpike = expenseData.map(d => ({
    ...d,
    isSpike: avgExpense > 0 && d.amount > avgExpense * 1.3,
  }));

  // ── Receivables aging ──────────────────────────────────────────────────────
  const rec       = receivablesRows.rows[0] || {};
  const recTotal  = parseFloat(rec.total       || 0);
  const bucket030 = parseFloat(rec.bucket_0_30   || 0);
  const bucket3160= parseFloat(rec.bucket_31_60  || 0);
  const bucket61  = parseFloat(rec.bucket_61plus || 0);
  const receivablesAging = recTotal > 0 ? [
    { label: '0–30 Days',  amount: bucket030,  pct: Math.round((bucket030  / recTotal) * 100) },
    { label: '31–60 Days', amount: bucket3160, pct: Math.round((bucket3160 / recTotal) * 100) },
    { label: '61+ Days',   amount: bucket61,   pct: Math.round((bucket61   / recTotal) * 100) },
  ] : [];

  // ── Top suppliers ──────────────────────────────────────────────────────────
  const totalSpend = topSuppliersRows.rows.reduce((s, r) => s + parseFloat(r.total_spend), 0);
  const topSuppliers = topSuppliersRows.rows.map(r => ({
    name:  r.party_name,
    spend: parseFloat(r.total_spend),
    pct:   totalSpend > 0 ? Math.round((parseFloat(r.total_spend) / totalSpend) * 100) : 0,
    txns:  parseInt(r.txns),
  }));

  // ── Top customers ──────────────────────────────────────────────────────────
  const totalRev = topCustomersRows.rows.reduce((s, r) => s + parseFloat(r.total_rev), 0);
  const topCustomers = topCustomersRows.rows.map(r => ({
    name:    r.party_name,
    revenue: parseFloat(r.total_rev),
    pct:     totalRev > 0 ? Math.round((parseFloat(r.total_rev) / totalRev) * 100) : 0,
    txns:    parseInt(r.txns),
  }));

  // ── Stockout risk ──────────────────────────────────────────────────────────
  const stockout = stockoutRows.rows.map(r => ({
    item:     r.name,
    qty:      parseFloat(r.closing_qty),
    reorder:  parseFloat(r.reorder_level),
    unit:     r.unit || '',
    critical: parseFloat(r.closing_qty) <= 0,
  }));

  // ── Summary totals ─────────────────────────────────────────────────────────
  const totalRevenue  = forecastData.filter(d => d.actual !== null).reduce((s, d) => s + (d.actual || 0), 0);
  const totalExpenses = expenseData.reduce((s, d) => s + d.amount, 0);

  // ── Helpers for enriched LLM payload ─────────────────────────────────────
  const fmt = n => `₹${(n/100000).toFixed(1)}L`;
  const actualMonthsData = forecastData.filter(d => d.actual !== null);
  const spikeMonthsData  = expenseWithSpike.filter(d => d.isSpike);
  const revenueContext   = actualMonthsData.length >= 2 ? (() => {
    const last  = actualMonthsData[actualMonthsData.length - 1];
    const prev  = actualMonthsData[actualMonthsData.length - 2];
    const delta = last.actual - prev.actual;
    return `${delta >= 0 ? 'Up' : 'Down'} ${fmt(Math.abs(delta))} from ${prev.month} to ${last.month}`;
  })() : 'Insufficient data';

  const llmPayload = {
    financialYear,
    dataMonths:        actualMonthsData.length,
    totalRevenue:      fmt(totalRevenue),
    totalExpenses:     fmt(totalExpenses),
    netProfit:         fmt(totalRevenue - totalExpenses),
    profitMarginPct:   totalRevenue > 0 ? Math.round(((totalRevenue - totalExpenses) / totalRevenue) * 100) : 0,
    revenueContext,
    monthlyRevenue:    actualMonthsData.map(d => ({ month: d.month, revenue: fmt(d.actual) })),
    expenseSpikes:     spikeMonthsData.map(d => ({
      month: d.month, amount: fmt(d.amount),
      vsAvg: `avg ${fmt(avgExpense)}`, excessPct: Math.round(((d.amount - avgExpense) / avgExpense) * 100),
    })),
    overdueReceivables: {
      total: fmt(recTotal),
      overdue60Plus: fmt(bucket61),
      overdue60PlusPct: recTotal > 0 ? Math.round((bucket61 / recTotal) * 100) : 0,
      overdue31to60: fmt(bucket3160),
      current0to30: fmt(bucket030),
    },
    topCustomers: topCustomers.slice(0, 3).map(c => ({
      name: c.name, revenue: fmt(c.revenue), shareOfTotalPct: c.pct, transactions: c.txns,
    })),
    topSuppliers: topSuppliers.slice(0, 3).map(s => ({
      name: s.name, spend: fmt(s.spend), shareOfTotalPct: s.pct, transactions: s.txns,
    })),
    criticalStock: stockout.filter(s => s.critical).slice(0, 4).map(s => ({
      item: s.item, qty: s.qty, reorderLevel: s.reorder, unit: s.unit,
    })),
    lowStock: stockout.filter(s => !s.critical).slice(0, 3).map(s => ({
      item: s.item, qty: s.qty, reorderLevel: s.reorder, unit: s.unit,
    })),
  };

  return {
    forecastData, expenseWithSpike, receivablesAging,
    topSuppliers, topCustomers, stockout,
    summary: { totalRevenue, totalExpenses, totalReceivables: recTotal, stockoutCount: stockout.length },
    llmPayload,
    bucket61, recTotal, avgExpense,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2A — Groq LLM Narration (current FY only, monthly cached)
// ─────────────────────────────────────────────────────────────────────────────
export async function generateGroqNarration(llmPayload, financialYear) {
  if (!GROQ_API_KEY) return null;

  const systemPrompt = `You are an elite business advisor embedded inside TallyDekho, a Tally Prime sync app used by Indian SMEs.
Your job: analyze real accounting data and generate 4-5 recommendations that are SPECIFIC, DATA-DRIVEN, and have DIRECT BUSINESS IMPACT.

Return ONLY a valid JSON array. No markdown, no explanation, no code blocks. Just the array:
[
  {"icon": "icon-name", "text": "your recommendation", "severity": "critical|warning|info|success"}
]

Allowed Ionicons: alert-circle-outline, card-outline, business-outline, trending-up-outline, layers-outline, rocket-outline, checkmark-circle-outline, arrow-down-outline, people-outline, wallet-outline, time-outline, analytics-outline

SEVERITY GUIDE:
- critical = immediate action, cash/stock at risk
- warning = attention needed within a week
- info = optimization opportunity
- success = positive signal worth noting

GOLDEN RULES — follow every single one:
1. ALWAYS mention actual names and amounts from the data. Never say "a customer" when you have "Raj Traders (₹1.8L)".
2. NEVER state what happened as advice. "Revenue grew" is an observation. "Chase this growth by expanding to X" is advice.
3. Every recommendation must answer: "If I do this, what will improve in my business?"
4. Use Indian business language: lakhs, crores, GST, payment terms, festive season, Q1/Q2/Q3/Q4.
5. If receivables overdue: name the bucket amount + suggest collecting before month-end.
6. If stock critical: name the item + say reorder NOW before you lose sales.
7. If one customer is >40% of revenue: flag concentration risk with the name.
8. If profit margin is healthy: give a growth tip (expand, upsell, new market).
9. If expense spike: name the month + suggest reviewing that category.
10. Keep each recommendation under 140 characters.

EXAMPLES OF BAD vs GOOD:
❌ BAD: "42% of receivables are overdue. Follow up with customers."
✅ GOOD: "₹1.8L stuck in 60+ day receivables. Contact your top overdue parties before month-end to free working capital."

❌ BAD: "Revenue trend appears positive."
✅ GOOD: "Sales up 3 months in a row — consider offering credit terms to your top 2 customers to accelerate volume."

❌ BAD: "Critical stock levels detected."
✅ GOOD: "JBL Speaker is out of stock. Reorder immediately — every day of stockout = lost sales."

❌ BAD: "Vendor concentration risk."
✅ GOOD: "68% of purchases from Sharma Enterprises alone. Add 1-2 backup suppliers to avoid supply disruption."`;

  const userMsg = `Financial Year: ${financialYear}

Business Data:
${JSON.stringify(llmPayload, null, 2)}

Generate 4-5 world-class, data-specific, impactful recommendations. Return ONLY the JSON array.`;

  try {
    const resp = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages:    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMsg }],
        temperature: 0.3,
        max_tokens:  700,
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);

    const data    = await resp.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error('Empty Groq response');

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in Groq response');

    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Invalid recommendations array');

    // Validate structure
    return parsed
      .filter(r => r.text && r.severity && r.icon)
      .slice(0, 5);

  } catch (err) {
    console.warn('[AI Insights] Groq narration failed, using rules fallback:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2B — Rules Engine Fallback (used when Groq unavailable)
// ─────────────────────────────────────────────────────────────────────────────
export function generateRulesRecommendations(metrics) {
  const { stockout, topSuppliers, expenseWithSpike, avgExpense,
          bucket61, recTotal, forecastData } = metrics;
  const recommendations = [];

  // Critical stock
  stockout.filter(s => s.critical).slice(0, 2).forEach(s => recommendations.push({
    icon: 'alert-circle-outline',
    text: `${s.item} is out of stock. Reorder immediately (min ${s.reorder} ${s.unit}).`,
    severity: 'critical',
  }));

  // Low stock
  stockout.filter(s => !s.critical && s.qty <= s.reorder * 0.5).slice(0, 2).forEach(s => recommendations.push({
    icon: 'layers-outline',
    text: `${s.item} is critically low — ${s.qty} ${s.unit} left (reorder at ${s.reorder}).`,
    severity: 'warning',
  }));

  // Receivables overdue
  if (recTotal > 0 && bucket61 / recTotal > 0.3) {
    recommendations.push({
      icon: 'card-outline',
      text: `${Math.round((bucket61 / recTotal) * 100)}% of receivables overdue 60+ days. Follow up with customers.`,
      severity: 'warning',
    });
  }

  // Vendor concentration
  if (topSuppliers.length > 0 && topSuppliers[0].pct > 50) {
    recommendations.push({
      icon: 'business-outline',
      text: `${topSuppliers[0].pct}% of purchases from ${topSuppliers[0].name}. Consider diversifying vendors.`,
      severity: 'info',
    });
  }

  // Expense spike
  const spikeMonths = expenseWithSpike.filter(d => d.isSpike);
  if (spikeMonths.length > 0) {
    const latest = spikeMonths[spikeMonths.length - 1];
    recommendations.push({
      icon: 'trending-up-outline',
      text: `Expense spike in ${latest.month} — ₹${(latest.amount/100000).toFixed(1)}L vs avg ₹${(avgExpense/100000).toFixed(1)}L. Review purchases.`,
      severity: 'info',
    });
  }

  // Revenue trend — only with ≥4 months, softer wording
  const actualMonths = forecastData.filter(d => d.actual !== null);
  if (actualMonths.length >= 4) {
    const last = actualMonths[actualMonths.length - 1];
    const prev = actualMonths[actualMonths.length - 2];
    if (prev.actual > 50000) { // min denominator ₹50K to avoid % explosion
      const growthPct = Math.round(((last.actual - prev.actual) / prev.actual) * 100);
      if (Math.abs(growthPct) >= 15) {
        recommendations.push({
          icon:     growthPct > 0 ? 'rocket-outline' : 'arrow-down-outline',
          text:     growthPct > 0
            ? `Revenue trending upward over recent months. Maintain sales momentum.`
            : `Revenue declined in ${last.month}. Review sales pipeline and follow up on pending orders.`,
          severity: growthPct > 0 ? 'success' : 'warning',
        });
      }
    }
  }

  // Healthy fallback
  if (recommendations.length === 0) {
    recommendations.push({
      icon:     'checkmark-circle-outline',
      text:     'No critical alerts. Business operations appear healthy for the selected period.',
      severity: 'success',
    });
  }

  return recommendations;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Cache Layer (monthly, per company)
// ─────────────────────────────────────────────────────────────────────────────
export async function ensureCacheTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS ai_insights_cache (
      id             SERIAL PRIMARY KEY,
      company_guid   TEXT NOT NULL,
      month_key      TEXT NOT NULL,
      metrics_json   JSONB,
      ai_output_json JSONB,
      generated_at   TIMESTAMPTZ DEFAULT NOW(),
      valid_until    TIMESTAMPTZ,
      UNIQUE(company_guid, month_key)
    )
  `);
  await query(`
    CREATE TABLE IF NOT EXISTS financial_year_summaries (
      id             SERIAL PRIMARY KEY,
      company_guid   TEXT NOT NULL,
      financial_year TEXT NOT NULL,
      summary_json   JSONB,
      generated_at   TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(company_guid, financial_year)
    )
  `);
}

export async function getCachedInsights(companyGuid, monthKey) {
  try {
    const { rows } = await query(
      `SELECT ai_output_json, generated_at, valid_until FROM ai_insights_cache
       WHERE company_guid=$1 AND month_key=$2
         AND valid_until > NOW() LIMIT 1`,
      [companyGuid, monthKey]
    );
    if (!rows[0]) return null;
    // Inject cache timestamps into the payload so the UI can show the disclaimer
    const data = rows[0].ai_output_json;
    data._cacheGeneratedAt = rows[0].generated_at;
    data._cacheValidUntil  = rows[0].valid_until;
    return data;
  } catch { return null; }
}

export async function setCachedInsights(companyGuid, monthKey, metricsJson, aiOutputJson) {
  // valid_until = end of next month (so cache stays valid for the whole month)
  try {
    await query(`
      INSERT INTO ai_insights_cache (company_guid, month_key, metrics_json, ai_output_json, valid_until)
      VALUES ($1, $2, $3, $4, date_trunc('month', NOW()) + INTERVAL '2 months')
      ON CONFLICT (company_guid, month_key) DO UPDATE
        SET metrics_json=$3, ai_output_json=$4, generated_at=NOW(),
            valid_until=date_trunc('month', NOW()) + INTERVAL '2 months'
    `, [companyGuid, monthKey, JSON.stringify(metricsJson), JSON.stringify(aiOutputJson)]);
  } catch (err) {
    console.warn('[AI Insights] Cache write failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Historical FY (deterministic, no LLM)
// ─────────────────────────────────────────────────────────────────────────────
export async function computeHistoricalSummary(companyGuid, financialYear, from, to) {
  // Check cache first
  try {
    const { rows } = await query(
      'SELECT summary_json FROM financial_year_summaries WHERE company_guid=$1 AND financial_year=$2 LIMIT 1',
      [companyGuid, financialYear]
    );
    if (rows[0]?.summary_json) return rows[0].summary_json;
  } catch {}

  // Compute fresh
  const metrics = await computeInsightMetrics(companyGuid, from, to);
  const { forecastData, expenseWithSpike, avgExpense, topSuppliers, topCustomers,
          stockout, receivablesAging, summary, bucket61, recTotal } = metrics;

  // Build deterministic rule-based highlights (no forecasting language)
  const highlights = [];

  // Best revenue month
  const actualMonths = forecastData.filter(d => d.actual !== null);
  if (actualMonths.length > 0) {
    const best = actualMonths.reduce((a, b) => a.actual > b.actual ? a : b);
    highlights.push({
      icon: 'trending-up-outline',
      text: `Highest sales recorded in ${best.month} — ₹${(best.actual/100000).toFixed(1)}L.`,
      type: 'revenue',
    });
  }

  // Expense spikes
  const spikes = expenseWithSpike.filter(d => d.isSpike);
  spikes.slice(0, 2).forEach(s => highlights.push({
    icon: 'warning-outline',
    text: `Expense spike in ${s.month} — ₹${(s.amount/100000).toFixed(1)}L vs avg ₹${(avgExpense/100000).toFixed(1)}L.`,
    type: 'expense',
  }));

  // Receivables observation (no predictive language)
  if (recTotal > 0 && bucket61 / recTotal > 0.25) {
    highlights.push({
      icon: 'card-outline',
      text: `${Math.round((bucket61 / recTotal) * 100)}% of receivables were overdue 60+ days during this period.`,
      type: 'receivables',
    });
  }

  // Top customer concentration
  if (topCustomers.length > 0 && topCustomers[0].pct >= 30) {
    highlights.push({
      icon: 'people-outline',
      text: `${topCustomers[0].name} contributed ${topCustomers[0].pct}% of total revenue.`,
      type: 'customers',
    });
  }

  // Critical stock events
  if (stockout.filter(s => s.critical).length > 0) {
    highlights.push({
      icon: 'layers-outline',
      text: `${stockout.filter(s => s.critical).length} items reached critical stock levels during this period.`,
      type: 'stock',
    });
  }

  const summaryObj = {
    highlights,
    topSuppliers,
    topCustomers,
    receivablesAging,
    stockout,
    summary,
    forecastData: null, // no forecasting for historical
    isHistorical: true,
    financialYear,
  };

  // Cache permanently
  try {
    await query(`
      INSERT INTO financial_year_summaries (company_guid, financial_year, summary_json)
      VALUES ($1, $2, $3)
      ON CONFLICT (company_guid, financial_year) DO UPDATE SET summary_json=$3, generated_at=NOW()
    `, [companyGuid, financialYear, JSON.stringify(summaryObj)]);
  } catch (err) {
    console.warn('[AI Insights] Historical cache write failed:', err.message);
  }

  return summaryObj;
}
