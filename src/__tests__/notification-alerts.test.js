import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRelativeTime,
  deriveGroup,
  enrichNotification,
  stockNotification,
  receivableNotification,
  parseReadNotificationIds,
} from '../utils/notificationAlerts.js';

test('formatRelativeTime — minutes ago', () => {
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  assert.match(formatRelativeTime(fiveMinAgo), /^5m ago$/);
});

test('deriveGroup — today vs earlier', () => {
  assert.equal(deriveGroup(new Date()), 'today');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 2);
  assert.equal(deriveGroup(yesterday), 'earlier');
});

test('enrichNotification — maps body to message and read flag', () => {
  const out = enrichNotification({
    id: 'stock_A',
    type: 'stock',
    category: 'Stock',
    title: 'Low Stock',
    body: 'Only 2 left',
    route: '/stocks/on-hand-stock',
    actionLabel: 'View stock',
    created_at: new Date().toISOString(),
  }, new Set(['stock_B']));
  assert.equal(out.message, 'Only 2 left');
  assert.equal(out.read, false);
  assert.equal(out.group, 'today');
});

test('stockNotification — shape', () => {
  const n = stockNotification({ name: 'Widget', closing_qty: 2 });
  assert.equal(n.category, 'Stock');
  assert.equal(n.type, 'stock');
  assert.ok(n.route.includes('on-hand-stock'));
});

test('receivableNotification — formats amount', () => {
  const n = receivableNotification({ name: 'Acme Corp', bal: 75000 });
  assert.match(n.body, /Acme Corp/);
  assert.equal(n.category, 'Receivables');
});

test('parseReadNotificationIds — from alert_settings', () => {
  const set = parseReadNotificationIds({ read_notification_ids: ['a', 'b'] });
  assert.equal(set.size, 2);
  assert.ok(set.has('a'));
});
