import { requireResolvedCompanyId } from '../utils/companyOwnership.js';
/**
 * AI Routes — Real data-driven analytics
 * Uses statistical models on actual historical data
 * No external AI API needed
 */

import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { verifyCompanyAccess } from '../middleware/companyAccess.js';
import { linearRegression, movingAverage, pctChange, generateInsights } from '../services/aiAnalytics.js';
import { retrieveKBContext, retrieveKBContextSemantic, buildSystemPrompt } from '../services/helpRetrieval.js';
import { tryFAQAnswer, tryDirectKBAnswer } from '../services/helpDirectAnswer.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /ai-insights — Full AI dashboard with forecast + insights + growth
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ai-insights', authMiddleware, async (req, res) => {
  const companyGuid = req.query.companyGuid || req.query.companyId;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyAccess(req, res, companyGuid, {
    capability: 'ai_insights.view',
    responseShape: 'data',
  })) return;
  const companyId = requireResolvedCompanyId(req);

  try {
    const now = new Date();
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const fyStart = `${fyYear}-04-01`;
    const fyEnd   = `${fyYear + 1}-03-31`;

    // ── 1. Weekly sales — last 16 weeks (8 actual + 8 for comparison) ──────
    const { rows: weeklyRows } = await query(`
      SELECT
        DATE_TRUNC('week', date::date) as week_start,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' THEN amount ELSE 0 END) as sales,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN amount ELSE 0 END) as purchases,
        COUNT(CASE WHEN voucher_type ILIKE '%Sales%' THEN 1 END) as invoice_count
      FROM vouchers
      WHERE company_id=$1
        AND is_cancelled=FALSE
        AND date::date >= NOW() - INTERVAL '16 weeks'
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY DATE_TRUNC('week', date::date)
      ORDER BY week_start
    `, [companyId]).catch(() => ({ rows: [] }));

    // Split into prev 8 weeks (forecast base) and last 8 weeks (actual)
    const allWeeks = weeklyRows;
    const prevWeeks = allWeeks.slice(0, Math.max(0, allWeeks.length - 8));
    const lastWeeks = allWeeks.slice(-8);

    const actualSales = lastWeeks.map(r => parseFloat(r.sales || 0));
    const prevSales   = prevWeeks.map(r => parseFloat(r.sales || 0));

    // Linear regression on prev weeks to forecast last 8
    const reg = linearRegression(prevSales.length >= 3 ? prevSales : actualSales);
    const forecastSales = Array.from({ length: 8 }, (_, i) =>
      Math.round(reg.predict(prevSales.length + i))
    );

    // Smooth actuals with 3-week moving average for cleaner chart
    const smoothedActual = movingAverage(actualSales, 3).map(v => Math.round(v));

    // Week labels
    const weekLabels = lastWeeks.length > 0
      ? lastWeeks.map((r, i) => `Wk${i + 1}`)
      : ['Wk1','Wk2','Wk3','Wk4','Wk5','Wk6','Wk7','Wk8'];

    // Pad to 8 if less data
    while (smoothedActual.length < 8) smoothedActual.unshift(0);
    while (forecastSales.length < 8) forecastSales.unshift(0);

    // ── 2. Monthly sales — FY ───────────────────────────────────────────────
    const { rows: monthlyRows } = await query(`
      SELECT
        TO_CHAR(date::date, 'Mon') as month,
        EXTRACT(MONTH FROM date::date) as month_num,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' THEN amount ELSE 0 END) as sales,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN amount ELSE 0 END) as purchases
      FROM vouchers
      WHERE company_id=$1 AND is_cancelled=FALSE
        AND date BETWEEN $2 AND $3
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date, 'Mon'), EXTRACT(MONTH FROM date::date)
      ORDER BY month_num
    `, [companyId, fyStart, fyEnd]).catch(() => ({ rows: [] }));

    const monthlySales = monthlyRows.map(r => parseFloat(r.sales || 0));
    const monthlyPurchases = monthlyRows.map(r => parseFloat(r.purchases || 0));

    // ── 3. Growth metrics ───────────────────────────────────────────────────
    const totalSalesFY = monthlySales.reduce((a, b) => a + b, 0);
    const totalPurchFY = monthlyPurchases.reduce((a, b) => a + b, 0);

    // Last month vs prev month
    const lastMonthSales = monthlySales[monthlySales.length - 1] || 0;
    const prevMonthSales = monthlySales[monthlySales.length - 2] || 0;
    const momGrowth = pctChange(lastMonthSales, prevMonthSales);

    // Last 4 weeks vs prev 4 weeks
    const last4 = actualSales.slice(-4).reduce((a, b) => a + b, 0);
    const prev4 = (prevSales.slice(-4).reduce((a, b) => a + b, 0)) || last4;
    const weeklyGrowth = pctChange(last4, prev4);

    // Gross margin
    const grossMargin = totalSalesFY > 0
      ? ((totalSalesFY - totalPurchFY) / totalSalesFY * 100)
      : 0;

    // Average ticket size (FY)
    const totalInvoices = weeklyRows.reduce((s, r) => s + parseInt(r.invoice_count || 0), 0);
    const avgTicket = totalInvoices > 0 ? Math.round(totalSalesFY / totalInvoices) : 0;

    // ── 4. Customer analytics ───────────────────────────────────────────────
    const { rows: custRows } = await query(`
      SELECT party_name as name,
        SUM(amount) as revenue,
        COUNT(*) as invoice_count
      FROM vouchers
      WHERE company_id=$1 AND voucher_type ILIKE '%Sales%'
        AND is_cancelled=FALSE AND date BETWEEN $2 AND $3
        AND party_name IS NOT NULL AND party_name != ''
      GROUP BY party_name ORDER BY revenue DESC LIMIT 5
    `, [companyId, fyStart, fyEnd]).catch(() => ({ rows: [] }));

    const topCustomers = custRows.map(r => ({
      name: r.name,
      revenue: parseFloat(r.revenue || 0),
      invoices: parseInt(r.invoice_count || 0),
      pct: totalSalesFY > 0
        ? parseFloat((parseFloat(r.revenue || 0) / totalSalesFY * 100).toFixed(1))
        : 0,
    }));

    // ── 5. Inventory analytics ──────────────────────────────────────────────
    // Fix: correct table is 'stocks', correct columns are closing_qty/closing_rate
    const { rows: stockRows } = await query(`
      SELECT name, closing_qty as current_stock, closing_rate as unit_price,
        COALESCE(closing_qty * closing_rate, 0) as total_value
      FROM stocks
      WHERE company_id=$1
      ORDER BY total_value DESC LIMIT 20
    `, [companyId]).catch(() => ({ rows: [] }));

    const totalInventoryValue = stockRows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
    const inventoryTurnover = totalInventoryValue > 0
      ? parseFloat((totalPurchFY / totalInventoryValue).toFixed(2))
      : 0;
    const dsi = inventoryTurnover > 0
      ? Math.round(365 / inventoryTurnover)
      : 0;

    // Fast/slow moving based on stock quantity
    const fastMoving = stockRows.filter(r => parseFloat(r.current_stock || 0) > 0).length;
    const slowMoving = stockRows.filter(r => parseFloat(r.current_stock || 0) > 100).length;

    // ── 6. Outstanding receivables ratio ───────────────────────────────────
    const { rows: recRows } = await query(`
      SELECT COALESCE(SUM(ABS(closing_balance)),0) as v
      FROM ledgers
      WHERE company_id=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors')
        AND closing_balance > 0
    `, [companyId]).catch(() => ({ rows: [{ v: 0 }] }));

    const outstanding = parseFloat(recRows[0]?.v || 0);
    const outstandingRatio = totalSalesFY > 0 ? outstanding / totalSalesFY : 0;

    // ── 7. Next month forecast ──────────────────────────────────────────────
    const nextMonthForecast = Math.round(reg.predict(prevSales.length + 8));
    const forecastConfidence = reg.r2 ? Math.round(reg.r2 * 100) : 0;

    // ── 8. Generate insights ────────────────────────────────────────────────
    const insights = generateInsights({
      salesTrend: momGrowth,
      purchaseTrend: pctChange(monthlyPurchases[monthlyPurchases.length - 1] || 0, monthlyPurchases[monthlyPurchases.length - 2] || 0),
      grossMargin,
      topCustomers,
      slowMoving,
      fastMoving: Math.max(0, fastMoving - slowMoving),
      outstandingRatio,
    });

    res.json({
      status: true,
      data: {
        // Sales forecast chart (8 weeks)
        salesForecast: forecastSales.slice(-8),
        salesActual:   smoothedActual.slice(-8),
        weekLabels:    weekLabels.slice(-8),

        // Growth metrics
        growth: {
          revenue:    momGrowth,         // month-over-month %
          weeklyGrowth,                  // week-over-week 4W %
          customers:  topCustomers.length,
          avgTicket,
          grossMargin: parseFloat(grossMargin.toFixed(1)),
        },

        // Inventory analytics
        inventory: {
          turnoverRatio: inventoryTurnover,
          dsi,
          fastMoving: Math.max(0, fastMoving - slowMoving),
          slowMoving,
          totalValue: totalInventoryValue,
        },

        // Top customers
        topCustomers: topCustomers.slice(0, 5),

        // Next month prediction
        forecast: {
          nextMonthSales: nextMonthForecast,
          confidence: forecastConfidence,
          trend: momGrowth > 0 ? 'up' : momGrowth < 0 ? 'down' : 'flat',
        },

        // AI-generated text insights
        insights,

        // Data quality flag
        hasEnoughData: weeklyRows.length >= 4 && monthlySales.filter(v => v > 0).length >= 2,
      },
    });
  } catch (err) {
    console.error('[ai-insights]', err.message);
    res.status(500).json({ status: false, message: 'Failed to compute AI insights' });
  }
});

export default router;

// ── POST /ai/help — AI Help Chat with KB Retrieval + Groq ─────────────────
// Architecture: Intent Router → KB Retrieval → Focused Context → Groq LLM
// Token target: 500–1200 tokens/query (not 3000–10000 for full KB stuffing)
// The body limit is 10mb and every byte here becomes a paid Groq token, so the
// prompt is bounded before anything else looks at it.
const MAX_MESSAGE_CHARS = 2000;
const MAX_HISTORY_TURNS = 8;
const MAX_HISTORY_CHARS = 1000;

router.post('/help', authMiddleware, async (req, res) => {
  const { message, history = [] } = req.body || {};
  if (!message) return res.status(400).json({ success: false, error: { code: 'MISSING_MESSAGE', message: 'message required' } });
  if (typeof message !== 'string' || message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({
      success: false,
      error: { code: 'MESSAGE_TOO_LONG', message: `message must be a string of at most ${MAX_MESSAGE_CHARS} characters` },
    });
  }
  const recentHistory = (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY_TURNS)
    .map((h) => ({ role: h?.role === 'user' ? 'user' : 'assistant', content: String(h?.text ?? '').slice(0, MAX_HISTORY_CHARS) }))
    .filter((h) => h.content);

  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) {
    return res.json({ success: true, data: { reply: "I'm the TallyDekho assistant. I can help with syncing, invoices, ledgers, stocks, and reports. Please ask about a specific feature." } });
  }

  try {
    // ── Step 1: FAQ Direct Answer Gate (no Groq needed for common questions) ──
    const faqAnswer = await tryFAQAnswer(message);
    if (faqAnswer) {
      return res.json({ success: true, data: { reply: faqAnswer, source: 'faq' } });
    }

    // ── Step 2: Semantic retrieval (Phase 2) with keyword fallback (Phase 1) ──
    const { context, modules, hasContext, method } = await retrieveKBContextSemantic(message);
    // The question is the user's own text; log what it matched, not what it said.
    console.log(`[AI Help] [${method}] modules: [${modules.join(', ')}] chars=${message.length}`);

    // ── Step 3: High-confidence KB Direct Answer Gate ───────────────────
    // (only if semanticSearch returned results with similarity scores)
    // Skip Groq if KB chunk alone is sufficient
    // [Note: semanticResults not exposed here — handled via FAQ gate above]

    // ── Step 4: Build focused system prompt with KB context only ─────────
    const systemPrompt = buildSystemPrompt(
      hasContext ? context : 'No specific KB section found. Use general TallyDekho knowledge only.'
    );

    // ── Step 5: Build message list (last 8 messages for continuity) ──────
    const messages = [
      { role: 'system', content: systemPrompt },
      ...recentHistory,
      { role: 'user', content: message },
    ];

    // ── Step 6: Groq LLM — LAST RESORT (only when FAQ + KB gates didn't answer) ─
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages,
        max_tokens: 450,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) throw new Error(`Groq error: ${response.status}`);
    const data  = await response.json();
    const reply = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response. Please try again.';
    res.json({ success: true, data: { reply, modules, source: 'groq' } });
  } catch (err) {
    console.error('[AI Help]', err.message);
    res.json({ success: true, data: { reply: "I'm having trouble right now. For immediate help, contact support at support@tallydekho.com or WhatsApp +91 90244 66791." } });
  }
});


