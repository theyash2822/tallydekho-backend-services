// Data routes — read endpoints for mobile & web portal
import { Router } from 'express';
import { getDb } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// ─── Ledgers ──────────────────────────────────────────────────────────────────
// POST /app/ledgers
router.post('/ledgers', authMiddleware, (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', parent } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  const db = getDb();
  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  let query = 'SELECT * FROM ledgers WHERE company_guid=? AND (name LIKE ? OR alias LIKE ? OR gstin LIKE ?)';
  const params = [companyGuid, search, search, search];

  if (parent) { query += ' AND parent=?'; params.push(parent); }
  query += ' ORDER BY name LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const ledgers = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM ledgers WHERE company_guid=?').get(companyGuid)?.c || 0;

  res.json({ status: true, data: { ledgers, total, page, pageSize } });
});

// POST /app/ledger — single ledger detail
router.post('/ledger', authMiddleware, (req, res) => {
  const { companyGuid, ledgerGuid } = req.body || {};
  const db = getDb();
  const ledger = db.prepare('SELECT * FROM ledgers WHERE company_guid=? AND guid=?').get(companyGuid, ledgerGuid);
  if (!ledger) return res.status(404).json({ status: false, message: 'Ledger not found' });
  res.json({ status: true, data: { ledger } });
});

// ─── Stocks ───────────────────────────────────────────────────────────────────
// POST /app/stock-dashboard
router.post('/stock-dashboard', authMiddleware, (req, res) => {
  const { companyGuid } = req.body || {};
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c, SUM(closing_value) as v FROM stocks WHERE company_guid=?').get(companyGuid);
  const lowStock = db.prepare('SELECT COUNT(*) as c FROM stocks WHERE company_guid=? AND closing_qty > 0 AND closing_qty <= reorder_level AND reorder_level > 0').get(companyGuid);
  const outOfStock = db.prepare('SELECT COUNT(*) as c FROM stocks WHERE company_guid=? AND closing_qty = 0').get(companyGuid);

  res.json({ status: true, data: {
    totalItems: total?.c || 0,
    totalValue: total?.v || 0,
    lowStock: lowStock?.c || 0,
    outOfStock: outOfStock?.c || 0,
  }});
});

// POST /app/stock-filters
router.post('/stock-filters', authMiddleware, (req, res) => {
  const { companyGuid } = req.body || {};
  const db = getDb();
  const categories = db.prepare('SELECT DISTINCT category FROM stocks WHERE company_guid=? AND category IS NOT NULL').all(companyGuid).map(r => r.category);
  const groups = db.prepare('SELECT DISTINCT group_name FROM stocks WHERE company_guid=? AND group_name IS NOT NULL').all(companyGuid).map(r => r.group_name);
  res.json({ status: true, data: { categories, groups } });
});

// POST /app/stocks
router.post('/stocks', authMiddleware, (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', category, lowStockOnly } = req.body || {};
  const db = getDb();
  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  let query = 'SELECT * FROM stocks WHERE company_guid=? AND (name LIKE ? OR alias LIKE ? OR hsn LIKE ?)';
  const params = [companyGuid, search, search, search];

  if (category) { query += ' AND category=?'; params.push(category); }
  if (lowStockOnly) { query += ' AND closing_qty <= reorder_level AND reorder_level > 0'; }
  query += ' ORDER BY name LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const stocks = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM stocks WHERE company_guid=?').get(companyGuid)?.c || 0;

  res.json({ status: true, data: { stocks, totalStocks: total, page } });
});

// POST /app/stock — single item
router.post('/stock', authMiddleware, (req, res) => {
  const { companyGuid, stockGuid } = req.body || {};
  const db = getDb();
  const stock = db.prepare('SELECT * FROM stocks WHERE company_guid=? AND guid=?').get(companyGuid, stockGuid);
  const movements = db.prepare('SELECT * FROM stock_transactions WHERE company_guid=? AND stock_guid=? ORDER BY date DESC LIMIT 20').all(companyGuid, stockGuid);
  if (!stock) return res.status(404).json({ status: false, message: 'Item not found' });
  res.json({ status: true, data: { stock, movements } });
});

// ─── Vouchers (NEW) ───────────────────────────────────────────────────────────
// POST /app/vouchers
router.post('/vouchers', authMiddleware, (req, res) => {
  const { companyGuid, voucherType, page = 1, pageSize = 50, searchText = '', fromDate, toDate, status } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  const db = getDb();
  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  let query = 'SELECT * FROM vouchers WHERE company_guid=? AND is_cancelled=0 AND (party_name LIKE ? OR voucher_number LIKE ?)';
  const params = [companyGuid, search, search];

  if (voucherType) { query += ' AND voucher_type=?'; params.push(voucherType); }
  if (fromDate) { query += ' AND date >= ?'; params.push(fromDate); }
  if (toDate) { query += ' AND date <= ?'; params.push(toDate); }
  query += ' ORDER BY date DESC, id DESC LIMIT ? OFFSET ?';
  params.push(pageSize, offset);

  const vouchers = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM vouchers WHERE company_guid=? AND is_cancelled=0').get(companyGuid)?.c || 0;

  res.json({ status: true, data: { vouchers, total, page } });
});

// ─── Dashboard KPIs (NEW) ─────────────────────────────────────────────────────
// POST /app/dashboard
router.post('/dashboard', authMiddleware, (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  const db = getDb();
  const from = fromDate || '2025-04-01';
  const to   = toDate   || '2026-03-31';

  const totalSales = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=? AND voucher_type LIKE '%Sales%' AND date BETWEEN ? AND ? AND is_cancelled=0").get(companyGuid, from, to)?.v || 0;
  const totalPurchase = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=? AND voucher_type LIKE '%Purchase%' AND date BETWEEN ? AND ? AND is_cancelled=0").get(companyGuid, from, to)?.v || 0;
  const totalPayments = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=? AND voucher_type LIKE '%Payment%' AND date BETWEEN ? AND ? AND is_cancelled=0").get(companyGuid, from, to)?.v || 0;
  const totalReceipts = db.prepare("SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=? AND voucher_type LIKE '%Receipt%' AND date BETWEEN ? AND ? AND is_cancelled=0").get(companyGuid, from, to)?.v || 0;

  const cashLedger = db.prepare("SELECT closing_balance FROM ledgers WHERE company_guid=? AND (name LIKE '%Cash%' OR parent LIKE '%Cash%') LIMIT 1").get(companyGuid);
  const bankLedgers = db.prepare("SELECT SUM(closing_balance) as v FROM ledgers WHERE company_guid=? AND parent LIKE '%Bank%'").get(companyGuid);
  const receivables = db.prepare("SELECT SUM(closing_balance) as v FROM ledgers WHERE company_guid=? AND parent LIKE '%Sundry Debtor%'").get(companyGuid);
  const payables = db.prepare("SELECT SUM(closing_balance) as v FROM ledgers WHERE company_guid=? AND parent LIKE '%Sundry Creditor%'").get(companyGuid);

  res.json({ status: true, data: {
    totalSales, totalPurchase, totalPayments, totalReceipts,
    cashBalance: cashLedger?.closing_balance || 0,
    bankBalance: bankLedgers?.v || 0,
    receivables: receivables?.v || 0,
    payables: payables?.v || 0,
    netProfit: totalSales - totalPurchase,
  }});
});

// ─── Reports (NEW) ────────────────────────────────────────────────────────────
// POST /app/reports/pl
router.post('/reports/pl', authMiddleware, (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  const db = getDb();

  // Income ledgers
  const income = db.prepare("SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=? AND (parent LIKE '%Income%' OR parent LIKE '%Revenue%' OR parent LIKE '%Sales%')").all(companyGuid);
  // Expense ledgers
  const expenses = db.prepare("SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=? AND (parent LIKE '%Expense%' OR parent LIKE '%Purchase%')").all(companyGuid);

  const totalIncome = income.reduce((s, l) => s + (l.closing_balance || 0), 0);
  const totalExpenses = expenses.reduce((s, l) => s + (l.closing_balance || 0), 0);

  res.json({ status: true, data: {
    income, expenses,
    summary: { totalIncome, totalExpenses, grossProfit: totalIncome - totalExpenses, netProfit: totalIncome - totalExpenses },
  }});
});

// POST /app/reports/balance-sheet
router.post('/reports/balance-sheet', authMiddleware, (req, res) => {
  const { companyGuid } = req.body || {};
  const db = getDb();

  const assets = db.prepare("SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=? AND balance_type='Dr'").all(companyGuid);
  const liabilities = db.prepare("SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=? AND balance_type='Cr'").all(companyGuid);

  const totalAssets = assets.reduce((s, l) => s + (l.closing_balance || 0), 0);
  const totalLiabilities = liabilities.reduce((s, l) => s + (l.closing_balance || 0), 0);

  res.json({ status: true, data: { assets, liabilities, summary: { totalAssets, totalLiabilities } } });
});

export default router;
