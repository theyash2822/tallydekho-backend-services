import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeStockHealthPct,
  computeValueTrend,
  formatTurnover,
  buildStockValueTrend,
  normalizeCategoryLabel,
} from '../utils/stockDashboardInsights.js';

test('computeStockHealthPct — healthy majority', () => {
  assert.equal(computeStockHealthPct(100, 12, 3), 85);
});

test('computeStockHealthPct — zero items', () => {
  assert.equal(computeStockHealthPct(0, 0, 0), 0);
});

test('computeValueTrend — positive month-over-month', () => {
  const { valueTrendPct, valueTrendPositive } = computeValueTrend([
    { label: 'Jan', value: 10 },
    { label: 'Feb', value: 11 },
  ]);
  assert.equal(valueTrendPositive, true);
  assert.equal(valueTrendPct, 10);
});

test('formatTurnover — ratio with one decimal', () => {
  assert.equal(formatTurnover(420000, 100000), '4.2x');
  assert.equal(formatTurnover(0, 100000), '0x');
});

test('buildStockValueTrend — returns 6 points in lakhs', () => {
  const trend = buildStockValueTrend(1300000, [
    { month_start: new Date(new Date().getFullYear(), new Date().getMonth() - 2, 1), net_change: 50000 },
  ]);
  assert.equal(trend.length, 6);
  assert.ok(trend.every(p => typeof p.label === 'string' && typeof p.value === 'number'));
});

test('normalizeCategoryLabel — group_name preferred', () => {
  assert.equal(normalizeCategoryLabel('Electronics', ''), 'Electronics');
  assert.equal(normalizeCategoryLabel('', 'Grocery'), 'Grocery');
  assert.equal(normalizeCategoryLabel('', ''), 'Other');
});
