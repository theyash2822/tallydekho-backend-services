import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStockFyBalanceRows } from '../utils/stockFyBalance.js';
import { isTallyTrue } from '../utils/tallyFields.js';

const fy = (label, begin, end) => ({ label, begin, end });
const Y1 = fy('2023-2024', '20230401', '20240331');
const Y2 = fy('2024-2025', '20240401', '20250331');
const Y3 = fy('2025-2026', '20250401', '20260331');
const CAL = fy('2025-2026', '20250101', '20251231');

const prevDay = (ymd) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) - 1));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const row = (y, role, name, value, extra = {}) => {
  const date = role === 'closing' ? y.end : prevDay(y.begin);
  return {
    NAME: name, CLOSINGQTY: '10 Nos', CLOSINGRATE: '12.10', CLOSINGVALUE: value,
    FROM_DATE: date, TO_DATE: date,
    _FINANCIAL_YEAR: y.label, FY_BEGIN: y.begin, FY_END: y.end, BALANCE_DATE: date, BALANCE_ROLE: role,
    ...extra,
  };
};

const scopes = (groups) => groups.map((g) => `${g.financialYear}:${g.role}:${g.items.map((i) => `${i.name}=${i.value}`).join('|')}`).sort();

test('three April–March years mixed and reordered in one batch keep their own scope and role', () => {
  const data = [
    row(Y3, 'opening', 'Widget', '-300'),
    row(Y1, 'closing', 'Widget', '-100'),
    row(Y2, 'opening', 'Widget', '-100'),
    row(Y3, 'closing', 'Widget', '-400'),
    row(Y1, 'opening', 'Widget', '-50'),
    row(Y2, 'closing', 'Widget', '-300'),
  ];
  const { groups, rejected } = classifyStockFyBalanceRows(data);
  assert.deepEqual(rejected, []);
  assert.deepEqual(scopes(groups), [
    '2023-2024:closing:Widget=100', '2023-2024:opening:Widget=50',
    '2024-2025:closing:Widget=300', '2024-2025:opening:Widget=100',
    '2025-2026:closing:Widget=400', '2025-2026:opening:Widget=300',
  ]);
});

test('January–December fiscal year is classified from explicit boundaries, not a March 31 rule', () => {
  const { groups, rejected } = classifyStockFyBalanceRows([row(CAL, 'closing', 'A', '-5'), row(CAL, 'opening', 'A', '-4')]);
  assert.deepEqual(rejected, []);
  assert.deepEqual(scopes(groups), ['2025-2026:closing:A=5', '2025-2026:opening:A=4']);
});

test('opening and closing at the same boundary date stay in different fiscal scopes', () => {
  const { groups } = classifyStockFyBalanceRows([row(Y1, 'closing', 'A', '-7'), row(Y2, 'opening', 'A', '-7')]);
  assert.deepEqual(scopes(groups), ['2023-2024:closing:A=7', '2024-2025:opening:A=7']);
});

test('repeated upload is deterministic; contradictory duplicates are rejected, not last-wins', () => {
  const same = classifyStockFyBalanceRows([row(Y2, 'closing', 'A', '-9'), row(Y2, 'closing', 'A', '-9')]);
  assert.deepEqual(scopes(same.groups), ['2024-2025:closing:A=9']);
  const clash = classifyStockFyBalanceRows([row(Y2, 'closing', 'A', '-9'), row(Y2, 'closing', 'A', '-8'), row(Y2, 'closing', 'B', '-1')]);
  assert.deepEqual(scopes(clash.groups), ['2024-2025:closing:B=1']);
  assert.deepEqual(clash.rejected.map((r) => r.reason), ['contradictory_duplicate']);
});

test('a role that contradicts its date or missing metadata is rejected', () => {
  const wrongDate = row(Y2, 'closing', 'A', '-1', { BALANCE_DATE: '20240331' });
  const noFy = row(Y2, 'opening', 'B', '-1', { FY_BEGIN: undefined });
  const { groups, rejected } = classifyStockFyBalanceRows([wrongDate, noFy]);
  assert.equal(groups.length, 0);
  assert.deepEqual(rejected.map((r) => r.reason).sort(), ['missing_fiscal_metadata', 'role_date_mismatch']);
});

test('legacy rows without role are classified per row, not from data[0]', () => {
  const legacy = [
    { NAME: 'A', CLOSINGVALUE: '-1', FROM_DATE: '20240331', _FINANCIAL_YEAR: '2024-2025' },
    { NAME: 'A', CLOSINGVALUE: '-2', FROM_DATE: '20250331', _FINANCIAL_YEAR: '2024-2025' },
  ];
  const { groups } = classifyStockFyBalanceRows(legacy);
  assert.deepEqual(scopes(groups), ['2024-2025:closing:A=2', '2024-2025:opening:A=1']);
});

test('quantity and rate keep decimal precision from text', () => {
  const { groups } = classifyStockFyBalanceRows([row(Y2, 'closing', 'A', '-1234.56')]);
  const it = groups[0].items[0];
  assert.equal(it.qty, 10);
  assert.equal(it.rate, 12.1);
  assert.equal(it.value, 1234.56);
});

test('isTallyTrue accepts text and legacy coerced flags', () => {
  for (const v of ['Yes', 'yes', ' true ', '1', true, 1]) assert.equal(isTallyTrue(v), true, String(v));
  for (const v of ['No', 'false', '0', '', null, undefined, false, 0]) assert.equal(isTallyTrue(v), false, String(v));
});
