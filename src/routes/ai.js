/**
 * AI Routes — Real data-driven analytics
 * Uses statistical models on actual historical data
 * No external AI API needed
 */

import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';
import { linearRegression, movingAverage, pctChange, generateInsights } from '../services/aiAnalytics.js';

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// GET /ai-insights — Full AI dashboard with forecast + insights + growth
// ─────────────────────────────────────────────────────────────────────────────
router.get('/ai-insights', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

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
      WHERE company_guid=$1
        AND is_cancelled=FALSE
        AND date::date >= NOW() - INTERVAL '16 weeks'
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY DATE_TRUNC('week', date::date)
      ORDER BY week_start
    `, [companyGuid]).catch(() => ({ rows: [] }));

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
      WHERE company_guid=$1 AND is_cancelled=FALSE
        AND date BETWEEN $2 AND $3
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date, 'Mon'), EXTRACT(MONTH FROM date::date)
      ORDER BY month_num
    `, [companyGuid, fyStart, fyEnd]).catch(() => ({ rows: [] }));

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
      WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%'
        AND is_cancelled=FALSE AND date BETWEEN $2 AND $3
        AND party_name IS NOT NULL AND party_name != ''
      GROUP BY party_name ORDER BY revenue DESC LIMIT 5
    `, [companyGuid, fyStart, fyEnd]).catch(() => ({ rows: [] }));

    const topCustomers = custRows.map(r => ({
      name: r.name,
      revenue: parseFloat(r.revenue || 0),
      invoices: parseInt(r.invoice_count || 0),
      pct: totalSalesFY > 0
        ? parseFloat((parseFloat(r.revenue || 0) / totalSalesFY * 100).toFixed(1))
        : 0,
    }));

    // ── 5. Inventory analytics ──────────────────────────────────────────────
    const { rows: stockRows } = await query(`
      SELECT name, current_stock, unit_price,
        COALESCE(current_stock * unit_price, 0) as total_value
      FROM stock_items
      WHERE company_guid=$1
      ORDER BY total_value DESC LIMIT 20
    `, [companyGuid]).catch(() => ({ rows: [] }));

    const totalInventoryValue = stockRows.reduce((s, r) => s + parseFloat(r.total_value || 0), 0);
    const inventoryTurnover = totalInventoryValue > 0
      ? parseFloat((totalPurchFY / totalInventoryValue).toFixed(2))
      : 0;
    const dsi = inventoryTurnover > 0
      ? Math.round(365 / inventoryTurnover)
      : 0;

    // Fast/slow moving (approx by stock level vs purchase frequency)
    const fastMoving = stockRows.filter(r => parseFloat(r.current_stock || 0) > 0 && parseFloat(r.unit_price || 0) > 0).length;
    const slowMoving = stockRows.filter(r => parseFloat(r.current_stock || 0) > 100).length; // high stock = slow moving

    // ── 6. Outstanding receivables ratio ───────────────────────────────────
    const { rows: recRows } = await query(`
      SELECT COALESCE(SUM(ABS(closing_balance)),0) as v
      FROM ledgers
      WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent='Sundry Debtors')
        AND closing_balance > 0
    `, [companyGuid]).catch(() => ({ rows: [{ v: 0 }] }));

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
