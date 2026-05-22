# TallyDekho — AI Insights

## What is AI Insights?
AI Insights is an analytics screen that gives business intelligence from your Tally data.
It uses real accounting data — not estimates or mock values.

## How to Access
Reports tab → AI Insights
OR from the Dashboard → AI Insights card

## Cards Available

### Revenue Forecast (Current FY only)
- Shows monthly actual revenue with a 3-month moving average forecast
- AI forecast dots show projected next 3 months
- For historical FY: shows "Revenue Trend" (actual months only, no forecast)

### Cash Flow Summary
- Revenue (inflows) vs Expenses (outflows) vs Net for the period

### Stock-out Risk
- Items where stock is at or below reorder level
- Critical = out of stock (qty ≤ 0)
- Warning = low stock (qty ≤ reorder × 0.5)

### Expense Spike Alert
- Bar chart of monthly expenses
- Red spike marker on months >30% above average

### Receivables Risk
- Donut chart: 0-30 days / 31-60 days / 61+ days overdue
- Tap a segment to see percentage

### Top Customers
- Top 5 customers by revenue for the period
- Shows revenue amount and % of total

### Top Suppliers
- Top 5 suppliers by purchase spend
- Shows spend amount and % of total

### AI Recommendations (Current FY)
- Groq LLM-generated recommendations based on your real data
- Uses actual party names and amounts (not generic advice)
- Regenerated monthly and cached — refreshes at month start
- Disclaimer shows "Generated on [date] · Refreshes on [date]"

### Business Highlights (Historical FY)
- Rules-based retrospective observations for past years
- No LLM, no forecasting language
- Examples: expense spikes, revenue peaks, concentration risks

## Switching Between FY
- Use the FY selector in the header to switch years
- Current FY: live analytics + AI recommendations + forecasting
- Historical FY: deterministic analysis + business highlights

## Custom Date Range
- Tap the date bar to pick a custom From/To date
- Tap the X to clear and go back to full FY view

## Refresh
- Tap the refresh icon (top right) to reload live analytics
- AI recommendations only regenerate monthly (not on every refresh)
- Live analytics (charts, stock, receivables) update on every sync
