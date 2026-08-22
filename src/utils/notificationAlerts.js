/**
 * Derived notification alerts for GET /api/notifications.
 * Pure helpers — DB queries live in the route handler.
 */

export function formatRelativeTime(isoOrDate) {
  const then = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const diffMs = Date.now() - then.getTime();
  if (Number.isNaN(diffMs) || diffMs < 0) return 'Just now';

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;

  return then.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function deriveGroup(isoOrDate) {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d >= startOfToday ? 'today' : 'earlier';
}

export function enrichNotification(raw, readIds = new Set()) {
  const createdAt = raw.created_at || new Date().toISOString();
  const body = raw.body || raw.message || '';
  return {
    id: raw.id,
    type: raw.type,
    category: raw.category,
    title: raw.title,
    body,
    message: body,
    time: formatRelativeTime(createdAt),
    group: deriveGroup(createdAt),
    route: raw.route || null,
    actionLabel: raw.actionLabel || null,
    read: readIds.has(raw.id),
    created_at: createdAt,
  };
}

export function stockNotification(row, createdAt = new Date()) {
  const id = `stock_${encodeURIComponent(row.name)}`;
  return {
    id,
    type: 'stock',
    category: 'Stock',
    title: 'Low Stock Alert',
    body: `${row.name} has only ${row.closing_qty} units left`,
    route: '/stocks/on-hand-stock',
    actionLabel: 'View stock',
    created_at: createdAt.toISOString(),
  };
}

export function receivableNotification(row, createdAt = new Date()) {
  const bal = Math.round(parseFloat(row.bal) || 0);
  const id = `recv_${encodeURIComponent(row.name)}`;
  return {
    id,
    type: 'receivable',
    category: 'Receivables',
    title: 'Outstanding Receivable',
    body: `${row.name} owes ₹${bal.toLocaleString('en-IN')}`,
    route: '/(tabs)/ledger',
    actionLabel: 'View ledger',
    created_at: createdAt.toISOString(),
  };
}

export function complianceNotification({ id, type, title, body, route, actionLabel, createdAt = new Date() }) {
  return {
    id,
    type: type || 'gst',
    category: 'Compliance',
    title,
    body,
    route: route || '/settings/compliance-reminders',
    actionLabel: actionLabel || 'View compliance',
    created_at: createdAt.toISOString(),
  };
}

export function invoiceNotification({ id, title, body, route, actionLabel, createdAt = new Date() }) {
  return {
    id,
    type: 'invoice',
    category: 'Invoices',
    title,
    body,
    route: route || '/sales',
    actionLabel: actionLabel || 'View invoices',
    created_at: createdAt.toISOString(),
  };
}

export function parseReadNotificationIds(alertSettings) {
  const ids = alertSettings?.read_notification_ids;
  return new Set(Array.isArray(ids) ? ids : []);
}
