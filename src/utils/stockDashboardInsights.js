/**
 * Stock dashboard insights — pure helpers + DB aggregation for mobile Stock tab/reports.
 */

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Healthy SKU %: items that are neither low-stock nor out-of-stock. */
export function computeStockHealthPct(totalItems, lowStock, outOfStock) {
  const total = Number(totalItems) || 0;
  if (total <= 0) return 0;
  const healthy = Math.max(0, total - (Number(lowStock) || 0) - (Number(outOfStock) || 0));
  return Math.round((healthy / total) * 100);
}

/** Month-over-month % change from trend points (values in lakhs). */
export function computeValueTrend(trend) {
  if (!Array.isArray(trend) || trend.length < 2) {
    return { valueTrendPct: 0, valueTrendPositive: true };
  }
  const last = Number(trend[trend.length - 1]?.value) || 0;
  const prev = Number(trend[trend.length - 2]?.value) || 0;
  if (prev === 0) {
    return { valueTrendPct: last > 0 ? 100 : 0, valueTrendPositive: last >= 0 };
  }
  const pct = Math.round(((last - prev) / prev) * 1000) / 10;
  return { valueTrendPct: pct, valueTrendPositive: pct >= 0 };
}

/** Portfolio turnover ratio formatted as e.g. "4.2x". */
export function formatTurnover(outwardValue, avgInventoryValue) {
  const out = Number(outwardValue) || 0;
  const avg = Number(avgInventoryValue) || 0;
  if (avg <= 0) return '0x';
  const ratio = Math.round((out / avg) * 10) / 10;
  return `${ratio}x`;
}

/**
 * Build 6-month trend (values in lakhs) working backwards from current total value.
 * @param {number} currentTotalValue — rupees
 * @param {{ month_start: Date, net_change: number }[]} monthlyRows — ascending by month
 */
export function buildStockValueTrend(currentTotalValue, monthlyRows) {
  const now = new Date();
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: MONTH_LABELS[d.getMonth()],
    });
  }

  const netByKey = {};
  for (const row of monthlyRows || []) {
    const d = row.month_start instanceof Date ? row.month_start : new Date(row.month_start);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    netByKey[key] = (netByKey[key] || 0) + (Number(row.net_change) || 0);
  }

  const trend = [];
  let futureNet = 0;
  for (let i = months.length - 1; i >= 0; i--) {
    const m = months[i];
    const net = netByKey[m.key] || 0;
    const valueAtMonthEnd = Math.max(0, (Number(currentTotalValue) || 0) - futureNet);
    trend.unshift({
      label: m.label,
      value: Math.round((valueAtMonthEnd / 100000) * 100) / 100,
    });
    futureNet += net;
  }
  return trend;
}

export function normalizeCategoryLabel(groupName, category) {
  const g = (groupName || '').trim();
  const c = (category || '').trim();
  return g || c || 'Other';
}

/**
 * Aggregate stock dashboard payload (async — uses injected query fn).
 */
export async function buildStockDashboardInsights(query, companyId) {
  const { rows: total } = await query(
    'SELECT COUNT(*) as c, COALESCE(SUM(closing_value), 0) as v, COALESCE(SUM(closing_qty), 0) as qty FROM stocks WHERE company_id=$1',
    [companyId]
  );
  const totalItems = parseInt(total[0]?.c || 0, 10);
  const totalValue = parseFloat(total[0]?.v || 0);
  const totalQty = parseFloat(total[0]?.qty || 0);

  const { rows: low } = await query(`
    SELECT COUNT(*) as c, COALESCE(SUM(s.closing_value), 0) as reorder_value
    FROM stocks s
    LEFT JOIN groups g ON g.company_id = s.company_id AND g.name = s.group_name
    WHERE s.company_id=$1
      AND s.closing_qty > 0
      AND (
        (s.reorder_level > 0 AND s.closing_qty <= s.reorder_level)
        OR (s.reorder_level = 0 AND g.reorder_level > 0 AND s.closing_qty <= g.reorder_level)
      )
  `, [companyId]);

  const { rows: out } = await query(
    'SELECT COUNT(*) as c FROM stocks WHERE company_id=$1 AND closing_qty = 0',
    [companyId]
  );

  const lowStock = parseInt(low[0]?.c || 0, 10);
  const outOfStock = parseInt(out[0]?.c || 0, 10);
  const reorderValue = parseFloat(low[0]?.reorder_value || 0);

  const { rows: wh } = await query(
    'SELECT COUNT(*) as c FROM warehouses WHERE company_id=$1',
    [companyId]
  );
  const warehouseCount = parseInt(wh[0]?.c || 0, 10);

  const { rows: recent } = await query(`
    SELECT COUNT(*) as c FROM stock_transactions
    WHERE company_id=$1 AND date::date >= CURRENT_DATE - INTERVAL '7 days'
  `, [companyId]);
  const recentMovements = parseInt(recent[0]?.c || 0, 10);

  const { rows: agedSimple } = await query(`
    SELECT COALESCE(SUM(sub.value), 0) as v FROM (
      SELECT s.closing_qty * s.closing_rate as value
      FROM stocks s
      LEFT JOIN stock_transactions st ON st.stock_guid = s.name AND st.company_id = s.company_id
      WHERE s.company_id=$1 AND s.closing_qty > 0
      GROUP BY s.guid, s.closing_qty, s.closing_rate
      HAVING CURRENT_DATE - MAX(st.date::date) >= 90 OR MAX(st.date::date) IS NULL
    ) sub
  `, [companyId]);
  const agedInventoryValue = parseFloat(agedSimple[0]?.v || 0);

  const fyStart = `${new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1}-04-01`;
  const fyEnd = new Date().toISOString().slice(0, 10);

  const { rows: fastRows } = await query(`
    SELECT COUNT(*) as c FROM (
      SELECT s.name
      FROM stocks s
      LEFT JOIN stock_transactions st
        ON st.stock_guid = s.name AND st.company_id = s.company_id
        AND st.type = 'outward'
        AND st.date::date >= $2::date AND st.date::date <= $3::date
        AND st.voucher_type NOT IN ('Stock Journal','Physical Stock','Opening Balance')
      WHERE s.company_id=$1 AND COALESCE(s.closing_qty, 0) > 0
      GROUP BY s.name, s.closing_qty
      HAVING COALESCE(SUM(st.qty), 0) > 0
    ) sub
  `, [companyId, fyStart, fyEnd]);
  const fastMovingCount = parseInt(fastRows[0]?.c || 0, 10);

  const { rows: outwardRows } = await query(`
    SELECT COALESCE(SUM(CASE WHEN st.type = 'outward' THEN COALESCE(st.value, ABS(st.qty) * COALESCE(s.closing_rate, 0)) ELSE 0 END), 0) as outward_value
    FROM stocks s
    LEFT JOIN stock_transactions st
      ON st.stock_guid = s.name AND st.company_id = s.company_id
      AND st.date::date >= $2::date AND st.date::date <= $3::date
    WHERE s.company_id=$1
  `, [companyId, fyStart, fyEnd]);
  const outwardValue = parseFloat(outwardRows[0]?.outward_value || 0);

  const { rows: openVal } = await query(`
    SELECT COALESCE(SUM(opening_value), 0) as v, COALESCE(SUM(closing_value), 0) as c
    FROM stock_fy_valuation WHERE company_id=$1
  `, [companyId]);
  const openingVal = parseFloat(openVal[0]?.v || 0);
  const sfvClosing = parseFloat(openVal[0]?.c || 0);
  const avgInventory = sfvClosing > 0 && openingVal > 0
    ? (openingVal + sfvClosing) / 2
    : totalValue;

  const { rows: catRows } = await query(`
    SELECT
      COALESCE(NULLIF(TRIM(s.group_name), ''), NULLIF(TRIM(s.category), ''), 'Other') AS label,
      COALESCE(SUM(s.closing_value), 0) AS value
    FROM stocks s
    WHERE s.company_id=$1 AND COALESCE(s.closing_value, 0) != 0
    GROUP BY 1
    ORDER BY value DESC
    LIMIT 8
  `, [companyId]);

  const categories = catRows.map(r => ({
    label: r.label,
    value: Math.round(parseFloat(r.value || 0) * 100) / 100,
  }));

  const DONUT_COLORS = ['#1A1A1A', '#A89060', '#2D7D46', '#D97706', '#64748B', '#7C3AED', '#0EA5E9', '#BE123C'];
  const composition = categories.map((c, i) => ({
    ...c,
    color: DONUT_COLORS[i % DONUT_COLORS.length],
  }));

  const { rows: monthlyRows } = await query(`
    SELECT
      date_trunc('month', st.date::date) AS month_start,
      COALESCE(SUM(CASE WHEN st.type = 'inward' THEN COALESCE(st.value, ABS(st.qty) * COALESCE(s.closing_rate, 0)) ELSE 0 END), 0)
      - COALESCE(SUM(CASE WHEN st.type = 'outward' THEN COALESCE(st.value, ABS(st.qty) * COALESCE(s.closing_rate, 0)) ELSE 0 END), 0) AS net_change
    FROM stock_transactions st
    LEFT JOIN stocks s ON s.company_id = st.company_id AND s.name = st.stock_guid
    WHERE st.company_id=$1 AND st.date::date >= (CURRENT_DATE - INTERVAL '6 months')
    GROUP BY 1
    ORDER BY 1 ASC
  `, [companyId]);

  const trend = buildStockValueTrend(totalValue, monthlyRows);
  const { valueTrendPct, valueTrendPositive } = computeValueTrend(trend);
  const stockHealthPct = computeStockHealthPct(totalItems, lowStock, outOfStock);
  const turnover = formatTurnover(outwardValue, avgInventory);

  return {
    totalItems,
    totalValue,
    totalQty,
    lowStock,
    outOfStock,
    stockHealthPct,
    warehouseCount,
    fastMovingCount,
    agedInventoryValue: Math.round(agedInventoryValue * 100) / 100,
    agedInventoryDays: 90,
    recentMovements,
    reorderQueueCount: lowStock,
    reorderValue: Math.round(reorderValue * 100) / 100,
    turnover,
    valueTrendPct,
    valueTrendPositive,
    categories,
    composition,
    trend,
  };
}
