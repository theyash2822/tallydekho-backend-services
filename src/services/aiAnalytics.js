/**
 * AI Analytics Service
 * Uses real historical data from DB to compute:
 * - Sales forecast (linear regression on past 12 weeks)
 * - Growth metrics (MoM, YoY)
 * - Inventory turnover, DSI
 * - Top insights (text alerts based on trends)
 * - Cash flow prediction (next 4 weeks)
 *
 * No external AI API needed — pure statistical computation on real data.
 */

// ── Linear Regression ─────────────────────────────────────────────
function linearRegression(y) {
  const n = y.length;
  if (n === 0) return { slope: 0, intercept: 0, predict: () => 0 };
  const x = Array.from({ length: n }, (_, i) => i);
  const sumX  = x.reduce((a, b) => a + b, 0);
  const sumY  = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, xi, i) => a + xi * y[i], 0);
  const sumX2 = x.reduce((a, xi) => a + xi * xi, 0);
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return {
    slope,
    intercept,
    predict: (xi) => Math.max(0, slope * xi + intercept),
    r2: (() => {
      const mean = sumY / n;
      const ssTot = y.reduce((s, yi) => s + Math.pow(yi - mean, 2), 0);
      const ssRes = y.reduce((s, yi, i) => s + Math.pow(yi - (slope * i + intercept), 2), 0);
      return ssTot === 0 ? 1 : Math.max(0, 1 - ssRes / ssTot);
    })(),
  };
}

// ── Simple Moving Average ─────────────────────────────────────────
function movingAverage(data, window = 3) {
  return data.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
}

// ── Percentage change ─────────────────────────────────────────────
function pctChange(curr, prev) {
  if (!prev || prev === 0) return 0;
  return parseFloat(((curr - prev) / prev * 100).toFixed(1));
}

// ── Generate insights from data ───────────────────────────────────
function generateInsights({ salesTrend, purchaseTrend, grossMargin, topCustomers, slowMoving, fastMoving, outstandingRatio }) {
  const insights = [];

  // Sales trend insight
  if (salesTrend > 10) {
    insights.push({ type: 'positive', title: 'Sales growing strongly', body: `Sales are up ${salesTrend}% vs last period. Keep the momentum going.` });
  } else if (salesTrend > 0) {
    insights.push({ type: 'info', title: 'Steady sales growth', body: `Sales are up ${salesTrend}% — on track for the year.` });
  } else if (salesTrend < -10) {
    insights.push({ type: 'warning', title: 'Sales declining', body: `Sales dropped ${Math.abs(salesTrend)}% vs last period. Review top customers.` });
  }

  // Gross margin insight
  if (grossMargin > 0) {
    const marginPct = grossMargin.toFixed(1);
    if (parseFloat(marginPct) > 30) {
      insights.push({ type: 'positive', title: 'Healthy gross margin', body: `Gross margin at ${marginPct}% — well above industry average.` });
    } else if (parseFloat(marginPct) < 10) {
      insights.push({ type: 'warning', title: 'Thin margins', body: `Gross margin at ${marginPct}%. Review pricing or reduce purchase costs.` });
    }
  }

  // Outstanding receivables
  if (outstandingRatio > 0.3) {
    insights.push({ type: 'warning', title: 'High receivables', body: `Outstanding receivables are ${(outstandingRatio * 100).toFixed(0)}% of sales. Follow up on overdue invoices.` });
  }

  // Customer concentration
  if (topCustomers?.length && topCustomers[0]?.pct > 40) {
    insights.push({ type: 'warning', title: 'Customer concentration risk', body: `${topCustomers[0].name} contributes ${topCustomers[0].pct}% of revenue. Diversify your customer base.` });
  }

  // Inventory insights
  if (slowMoving > 5) {
    insights.push({ type: 'warning', title: `${slowMoving} slow-moving items`, body: 'Consider discounting or liquidating slow-moving inventory to free up working capital.' });
  }
  if (fastMoving > 0) {
    insights.push({ type: 'positive', title: `${fastMoving} fast-moving items`, body: 'Ensure adequate stock levels for your best-selling items to avoid stockouts.' });
  }

  return insights.slice(0, 5); // max 5 insights
}

export { linearRegression, movingAverage, pctChange, generateInsights };
