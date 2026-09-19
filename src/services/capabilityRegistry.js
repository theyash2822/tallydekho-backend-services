/**
 * Capability catalogue — Universal Architecture §22 (LOCKED).
 * Do NOT invent generic voucher edit/delete/cancel capabilities.
 * Entry Mode applies only to sales_invoice.create and sales_order.create.
 */

const CAPABILITIES = [
  // Read / navigation
  { key: 'dashboard.view', display_name: 'Dashboard', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'sales.view', display_name: 'Sales', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'purchase.view', display_name: 'Purchase', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'vouchers.view', display_name: 'Vouchers', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'expenses.view', display_name: 'Expenses', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.view', display_name: 'Inventory', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.stock_ledger.view', display_name: 'Stock Ledger', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.warehouses.view', display_name: 'Warehouses', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.negative_stock.view', display_name: 'Negative Stock', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.aged_items.view', display_name: 'Aged Items', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.expiry.view', display_name: 'Expiry', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.reorder.view', display_name: 'Reorder', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.barcodes.view', display_name: 'Barcodes', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.view', display_name: 'Financials', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.profit_loss.view', display_name: 'Profit & Loss', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.balance_sheet.view', display_name: 'Balance Sheet', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.trial_balance.view', display_name: 'Trial Balance', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.cash_register.view', display_name: 'Cash Register', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.receivables.view', display_name: 'Receivables', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.payables.view', display_name: 'Payables', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.bank_balance.view', display_name: 'Bank Balance', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.loans_od.view', display_name: 'Loans / OD', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'financials.cost_centres.view', display_name: 'Cost Centres', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'ledgers.view', display_name: 'Ledgers', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'audit_trail.view', display_name: 'Audit Trail', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'daybook.view', display_name: 'Daybook', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'compliance.view', display_name: 'Compliance', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'ai_insights.view', display_name: 'AI Insights', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'my_entries.view', display_name: 'My Entries', category: 'NAV', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Sales actions (no generic edit/delete)
  { key: 'sales_invoice.create', display_name: 'Create Sales Invoice', category: 'SALES', supports_entry_mode: true, protected_authority: null, customer_surface: true },
  { key: 'sales_order.create', display_name: 'Create Sales Order', category: 'SALES', supports_entry_mode: true, protected_authority: null, customer_surface: true },
  { key: 'delivery_note.create', display_name: 'Create Delivery Note', category: 'SALES', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'credit_note.create', display_name: 'Create Credit Note', category: 'SALES', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'sales_proforma.convert_to_regular', display_name: 'Convert Proforma to Regular', category: 'SALES', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Purchase actions
  { key: 'purchase_invoice.create', display_name: 'Create Purchase Invoice', category: 'PURCHASE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'purchase_order.create', display_name: 'Create Purchase Order', category: 'PURCHASE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'debit_note.create', display_name: 'Create Debit Note', category: 'PURCHASE', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Accounting actions
  { key: 'receipt.create', display_name: 'Create Receipt', category: 'ACCOUNTING', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'payment.create', display_name: 'Create Payment', category: 'ACCOUNTING', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'expense.create', display_name: 'Create Expense', category: 'ACCOUNTING', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'journal.create', display_name: 'Create Journal', category: 'ACCOUNTING', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'contra.create', display_name: 'Create Contra', category: 'ACCOUNTING', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Master / Inventory actions
  { key: 'ledger_master.create', display_name: 'Create Ledger', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'stock_item.create', display_name: 'Create Stock Item', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'stock_item.alter', display_name: 'Alter Stock Item', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'warehouse.create', display_name: 'Create Warehouse', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'stock_transfer.create', display_name: 'Stock Transfer', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'stock_adjustment.create', display_name: 'Stock Adjustment', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'inventory.barcodes.manage', display_name: 'Manage Barcodes', category: 'MASTERS', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Documents — PDF only (no Excel/CSV)
  { key: 'document.pdf.generate', display_name: 'Generate PDF', category: 'DOCUMENTS', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Workspace operational (Web role editor; Mobile consumes effective caps only)
  { key: 'members.view', display_name: 'View Members', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'members.invite', display_name: 'Invite Members', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'members.role_assign', display_name: 'Assign Roles', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'members.scope_manage', display_name: 'Manage Scopes', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'members.remove', display_name: 'Remove Members', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'roles.view', display_name: 'View Roles', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'roles.create', display_name: 'Create Roles', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'roles.edit', display_name: 'Edit Roles', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'roles.delete', display_name: 'Delete Roles', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'workspace.settings.view', display_name: 'View Workspace Settings', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'workspace.settings.manage', display_name: 'Manage Workspace Settings', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'integrations.configure', display_name: 'Configure Integrations', category: 'WORKSPACE', supports_entry_mode: false, protected_authority: null, customer_surface: true },

  // Protected Owner/Admin
  { key: 'tally.pair', display_name: 'Pair Tally', category: 'PROTECTED', supports_entry_mode: false, protected_authority: 'OWNER_OR_ADMIN_ROLE', customer_surface: true },
  { key: 'tally.unpair', display_name: 'Unpair Tally', category: 'PROTECTED', supports_entry_mode: false, protected_authority: 'OWNER_OR_ADMIN_ROLE', customer_surface: true },
  { key: 'tally.restore_replace', display_name: 'Approve Restore / Replace', category: 'PROTECTED', supports_entry_mode: false, protected_authority: 'OWNER_OR_ADMIN_ROLE', customer_surface: true },
  { key: 'members.suspend', display_name: 'Suspend Members', category: 'PROTECTED', supports_entry_mode: false, protected_authority: 'OWNER_OR_ADMIN_ROLE', customer_surface: true },
  { key: 'members.unsuspend', display_name: 'Unsuspend Members', category: 'PROTECTED', supports_entry_mode: false, protected_authority: 'OWNER_OR_ADMIN_ROLE', customer_surface: true },

  // Owner-only
  { key: 'billing.manage', display_name: 'Manage Billing', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'credits.recharge', display_name: 'Recharge Credits', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'seats.purchase', display_name: 'Purchase Seats', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'workspace.purchase', display_name: 'Purchase Workspace', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'ownership.transfer', display_name: 'Transfer Ownership', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'workspace.reset', display_name: 'Reset Workspace', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },
  { key: 'workspace.close', display_name: 'Close Workspace', category: 'OWNER', supports_entry_mode: false, protected_authority: 'OWNER', customer_surface: true },

  // GST / E-Invoice / E-Way (§23)
  { key: 'gst.view', display_name: 'View GST', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'gst.report.generate', display_name: 'Generate GST Report', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'gst.return.submit', display_name: 'Submit GST Return', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'einvoice.view', display_name: 'View E-Invoice', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'einvoice.generate', display_name: 'Generate E-Invoice', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'einvoice.update', display_name: 'Update E-Invoice', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'eway.view', display_name: 'View E-Way Bill', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'eway.generate', display_name: 'Generate E-Way Bill', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
  { key: 'eway.update', display_name: 'Update E-Way Bill', category: 'GST', supports_entry_mode: false, protected_authority: null, customer_surface: true },
];

export { CAPABILITIES };

const BY_KEY = new Map(CAPABILITIES.map((c) => [c.key, c]));

export function getCapability(key) {
  return BY_KEY.get(key) || null;
}

export function allKeys() {
  return CAPABILITIES.map((c) => c.key);
}

export function ownerOnlyKeys() {
  return CAPABILITIES.filter((c) => c.protected_authority === 'OWNER').map((c) => c.key);
}

export function ownerAdminKeys() {
  return CAPABILITIES.filter(
    (c) => c.protected_authority === 'OWNER_OR_ADMIN_ROLE' || c.protected_authority === 'OWNER'
  ).map((c) => c.key);
}

/** Sensitive field policies — Universal §19 / Mobile §19. */
export const SENSITIVE_POLICIES = [
  { key: 'cost_price', display_name: 'Cost Price', masking: 'HIDDEN' },
  { key: 'inventory_valuation', display_name: 'Inventory Valuation', masking: 'HIDDEN' },
  { key: 'margin', display_name: 'Margin', masking: 'HIDDEN' },
  { key: 'bank_balance', display_name: 'Bank Balance', masking: 'MASKED' },
  { key: 'cash_balance', display_name: 'Cash Balance', masking: 'MASKED' },
  { key: 'credit_limit', display_name: 'Credit Limit', masking: 'HIDDEN' },
  { key: 'tax_identity', display_name: 'Tax Identity', masking: 'MASKED' },
  { key: 'purchase_values', display_name: 'Purchase Values', masking: 'HIDDEN' },
];

const SENSITIVE_BY_KEY = new Map(SENSITIVE_POLICIES.map((p) => [p.key, p]));

export function getSensitivePolicy(key) {
  return SENSITIVE_BY_KEY.get(key) || null;
}

export function allSensitivePolicyKeys() {
  return SENSITIVE_POLICIES.map((p) => p.key);
}

const ALL_READ = CAPABILITIES.filter((c) => c.key.endsWith('.view') || c.category === 'NAV').map((c) => c.key);
const OPS_CREATE = [
  'sales_invoice.create', 'sales_order.create', 'delivery_note.create', 'credit_note.create',
  'sales_proforma.convert_to_regular',
  'purchase_invoice.create', 'purchase_order.create', 'debit_note.create',
  'receipt.create', 'payment.create', 'expense.create', 'journal.create', 'contra.create',
  'ledger_master.create', 'stock_item.create', 'stock_item.alter', 'warehouse.create',
  'stock_transfer.create', 'stock_adjustment.create', 'inventory.barcodes.manage',
  'document.pdf.generate',
  'gst.view', 'gst.report.generate', 'einvoice.view', 'einvoice.generate',
  'eway.view', 'eway.generate',
];

const TEMPLATE_KEYS = {
  ADMIN: null,
  ACCOUNTANT: [
    ...ALL_READ,
    ...OPS_CREATE,
    'members.view', 'roles.view', 'workspace.settings.view',
    'gst.return.submit', 'einvoice.update', 'eway.update',
  ],
  SALES: [
    'dashboard.view', 'sales.view', 'vouchers.view', 'daybook.view', 'ledgers.view',
    'my_entries.view', 'financials.receivables.view',
    'sales_invoice.create', 'sales_order.create', 'delivery_note.create', 'credit_note.create',
    'sales_proforma.convert_to_regular', 'receipt.create', 'document.pdf.generate',
  ],
  COLLECTION: [
    'dashboard.view', 'sales.view', 'financials.receivables.view', 'ledgers.view',
    'my_entries.view', 'receipt.create', 'document.pdf.generate',
  ],
  INVENTORY: [
    'dashboard.view', 'inventory.view', 'inventory.stock_ledger.view', 'inventory.warehouses.view',
    'inventory.negative_stock.view', 'inventory.aged_items.view', 'inventory.expiry.view',
    'inventory.reorder.view', 'inventory.barcodes.view',
    'stock_item.create', 'stock_item.alter', 'warehouse.create',
    'stock_transfer.create', 'stock_adjustment.create', 'inventory.barcodes.manage',
  ],
  VIEWER: [...ALL_READ, 'document.pdf.generate'],
  AUDITOR: [...ALL_READ, 'audit_trail.view', 'document.pdf.generate'],
};

const TEMPLATE_SENSITIVE = {
  ADMIN: () => Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, true])),
  ACCOUNTANT: () => Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, true])),
  SALES: () => ({
    cost_price: false,
    inventory_valuation: false,
    margin: false,
    bank_balance: false,
    cash_balance: false,
    credit_limit: true,
    tax_identity: true,
    purchase_values: false,
  }),
  COLLECTION: () => ({
    cost_price: false,
    inventory_valuation: false,
    margin: false,
    bank_balance: false,
    cash_balance: false,
    credit_limit: true,
    tax_identity: true,
    purchase_values: false,
  }),
  INVENTORY: () => ({
    cost_price: true,
    inventory_valuation: true,
    margin: false,
    bank_balance: false,
    cash_balance: false,
    credit_limit: false,
    tax_identity: false,
    purchase_values: true,
  }),
  VIEWER: () => Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, false])),
  AUDITOR: () => Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, true])),
};

export function defaultKeysForTemplate(systemKey) {
  const key = String(systemKey || '').toUpperCase();
  if (key === 'ADMIN') {
    const ownerOnly = new Set(ownerOnlyKeys());
    return allKeys().filter((k) => !ownerOnly.has(k));
  }
  return [...new Set(TEMPLATE_KEYS[key] || [])];
}

export function defaultSensitiveForTemplate(systemKey) {
  const key = String(systemKey || '').toUpperCase();
  const fn = TEMPLATE_SENSITIVE[key];
  return fn ? fn() : Object.fromEntries(allSensitivePolicyKeys().map((k) => [k, false]));
}

export const BUILTIN_ROLE_DEFS = [
  { system_key: 'ADMIN', display_name: 'Admin', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'ACCOUNTANT', display_name: 'Accountant', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'SALES', display_name: 'Sales', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'COLLECTION', display_name: 'Collection', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'INVENTORY', display_name: 'Inventory', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'VIEWER', display_name: 'Viewer', entry_mode: 'BOTH', is_editable: true },
  { system_key: 'AUDITOR', display_name: 'Auditor', entry_mode: 'BOTH', is_editable: false },
];

export function adminProtectedKeys() {
  return CAPABILITIES.filter((c) => c.protected_authority === 'OWNER_OR_ADMIN_ROLE').map((c) => c.key);
}

/** High-risk caps custom roles must never receive (CTO Phase 3). */
export function nonDelegableCapabilityKeys() {
  return [
    ...ownerOnlyKeys(),
    ...adminProtectedKeys(),
    'members.remove',
    'members.role_assign',
    'members.suspend',
    'members.unsuspend',
    'roles.create',
    'roles.edit',
    'roles.delete',
  ];
}

/** Capability keys are canonical only — aliases removed in Phase 3. */
export function resolveCapabilityKey(key) {
  return key;
}
