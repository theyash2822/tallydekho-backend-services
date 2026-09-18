/**
 * Map request URL → view capability for /api and /app data routes.
 * Shared so Web legacy /app cannot bypass Mobile /api caps.
 */
export function resolveViewCapability(req) {
  const u = String(req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`)
    .toLowerCase()
    .split('?')[0];
  if (
    u.includes('/dashboard') || u.includes('/kpi/') || u.includes('/alerts')
    || u.includes('/reports-dashboard') || u.includes('/home-metrics') || u.includes('/home_metrics')
  ) {
    return 'dashboard.view';
  }
  if (u.includes('/sales')) return 'sales.view';
  if (u.includes('/purchase')) return 'purchase.view';
  if (u.includes('/expenses')) return 'expenses.view';
  if (u.includes('/daybook')) return 'daybook.view';
  if (u.includes('/my-entries') || u.includes('/my_entries')) return 'my_entries.view';
  if (u.includes('/audit')) return 'audit_trail.view';
  if (u.includes('/ai-insights') || u.includes('/ai_insights') || u.includes('/insights')) {
    return 'ai_insights.view';
  }
  if (u.includes('/cost-centre')) return 'ledgers.view';
  if (u.includes('/payment-mode') || u.includes('/payment_mode')) return 'vouchers.view';
  if (u.includes('/ledgers') || u.includes('/parties') || u.includes('/party') || u.includes('/ledger')) {
    return 'ledgers.view';
  }
  if (
    u.includes('/stocks') || u.includes('/inventory') || u.includes('/stock')
    || u.includes('/reorder') || u.includes('/negative-stock') || u.includes('/negative_stock')
  ) {
    if (u.includes('negative')) return 'inventory.negative_stock.view';
    if (u.includes('aged')) return 'inventory.aged_items.view';
    if (u.includes('expiry')) return 'inventory.expiry.view';
    if (u.includes('warehouse') || u.includes('godown')) return 'inventory.warehouses.view';
    if (u.includes('barcode')) return 'inventory.barcodes.view';
    if (u.includes('reorder')) return 'inventory.reorder.view';
    if (u.includes('ledger')) return 'inventory.stock_ledger.view';
    return 'inventory.view';
  }
  if (
    u.includes('/financial') || u.includes('/receivable') || u.includes('/payable')
    || u.includes('/cash-in-hand') || u.includes('/bank-balance') || u.includes('/loans')
    || u.includes('/profit') || u.includes('/balance-sheet') || u.includes('/trial-balance')
    || u.includes('/cash-bank') || u.includes('/receivables-payables')
    || u.includes('/reports/pl') || u.includes('/reports/balance') || u.includes('/reports/trial')
  ) {
    if (u.includes('receivable')) return 'financials.receivables.view';
    if (u.includes('payable')) return 'financials.payables.view';
    if (u.includes('bank')) return 'financials.bank_balance.view';
    if (u.includes('loan')) return 'financials.loans_od.view';
    if (u.includes('profit') || u.includes('/reports/pl')) return 'financials.profit_loss.view';
    if (u.includes('balance-sheet') || u.includes('/reports/balance')) return 'financials.balance_sheet.view';
    if (u.includes('trial')) return 'financials.trial_balance.view';
    if (u.includes('cash')) return 'financials.cash_register.view';
    return 'financials.view';
  }
  if (u.includes('/eway') || u.includes('/einvoice') || u.includes('/e-invoice') || u.includes('/gst')) {
    if (u.includes('eway') || u.includes('e-way')) return 'eway.view';
    if (u.includes('einvoice') || u.includes('e-invoice')) return 'einvoice.view';
    return 'gst.view';
  }
  if (u.includes('/voucher')) return 'vouchers.view';
  // Bootstrap / session: membership + company/FY scope only (Owner must not 403 here)
  if (
    /\/companies\/?$/.test(u)
    || u.includes('/company/years')
    || u.includes('/company/profile')
    || u.includes('/tally-sync')
    || u.includes('/me/workspaces')
    || u.includes('/workspaces/') && u.includes('/context')
  ) {
    return '__scope_only__';
  }
  // Fail closed for unknown business data paths — callers must pass an explicit override
  return null;
}
