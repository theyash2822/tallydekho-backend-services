// Data routes — read endpoints for mobile & web portal
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();

// ─── Ledgers ──────────────────────────────────────────────────────────────────
router.post('/ledgers', authMiddleware, async (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', parent } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  try {
    let q = `SELECT * FROM ledgers WHERE company_guid = $1 AND (name ILIKE $2 OR alias ILIKE $2 OR gstin ILIKE $2)`;
    const params = [companyGuid, search];
    let idx = 3;

    if (parent) { q += ` AND parent = $${idx++}`; params.push(parent); }
    q += ` ORDER BY name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(pageSize, offset);

    const { rows: ledgers } = await query(q, params);
    const { rows: countRows } = await query('SELECT COUNT(*) as c FROM ledgers WHERE company_guid = $1', [companyGuid]);
    const { rows: balRows } = await query('SELECT COUNT(*) as c FROM ledgers WHERE company_guid = $1 AND closing_balance != 0', [companyGuid]);

    res.json({ status: true, data: { ledgers, total: parseInt(countRows[0].c), withBalance: parseInt(balRows[0].c), page, pageSize } });
  } catch (err) {
    console.error('[ledgers] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch ledgers' });
  }
});

router.post('/ledger', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerGuid } = req.body || {};
  try {
    const { rows } = await query('SELECT * FROM ledgers WHERE company_guid = $1 AND guid = $2', [companyGuid, ledgerGuid]);
    if (!rows[0]) return res.status(404).json({ status: false, message: 'Ledger not found' });
    res.json({ status: true, data: { ledger: rows[0] } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ─── Stocks ───────────────────────────────────────────────────────────────────
router.post('/stock-dashboard', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  try {
    const { rows: total } = await query('SELECT COUNT(*) as c, SUM(closing_value) as v FROM stocks WHERE company_guid = $1', [companyGuid]);
    const { rows: low } = await query('SELECT COUNT(*) as c FROM stocks WHERE company_guid = $1 AND closing_qty > 0 AND closing_qty <= reorder_level AND reorder_level > 0', [companyGuid]);
    const { rows: out } = await query('SELECT COUNT(*) as c FROM stocks WHERE company_guid = $1 AND closing_qty = 0', [companyGuid]);

    res.json({ status: true, data: {
      totalItems: parseInt(total[0].c || 0),
      totalValue: parseFloat(total[0].v || 0),
      lowStock: parseInt(low[0].c || 0),
      outOfStock: parseInt(out[0].c || 0),
    }});
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/stock-filters', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  try {
    const { rows: cats } = await query('SELECT DISTINCT category FROM stocks WHERE company_guid = $1 AND category IS NOT NULL', [companyGuid]);
    const { rows: grps } = await query('SELECT DISTINCT group_name FROM stocks WHERE company_guid = $1 AND group_name IS NOT NULL', [companyGuid]);
    res.json({ status: true, data: { categories: cats.map(r => r.category), groups: grps.map(r => r.group_name) } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/stocks', authMiddleware, async (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', category, lowStockOnly } = req.body || {};
  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  try {
    let q = `SELECT * FROM stocks WHERE company_guid = $1 AND (name ILIKE $2 OR alias ILIKE $2 OR hsn ILIKE $2)`;
    const params = [companyGuid, search];
    let idx = 3;

    if (category) { q += ` AND category = $${idx++}`; params.push(category); }
    if (lowStockOnly) { q += ` AND closing_qty <= reorder_level AND reorder_level > 0`; }
    q += ` ORDER BY name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(pageSize, offset);

    const { rows: stocks } = await query(q, params);
    const { rows: countRows } = await query('SELECT COUNT(*) as c FROM stocks WHERE company_guid = $1', [companyGuid]);

    res.json({ status: true, data: { stocks, totalStocks: parseInt(countRows[0].c), page } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/stock', authMiddleware, async (req, res) => {
  const { companyGuid, stockGuid } = req.body || {};
  try {
    const { rows } = await query('SELECT * FROM stocks WHERE company_guid = $1 AND guid = $2', [companyGuid, stockGuid]);
    const { rows: movements } = await query('SELECT * FROM stock_transactions WHERE company_guid = $1 AND stock_guid = $2 ORDER BY date DESC LIMIT 20', [companyGuid, stockGuid]);
    if (!rows[0]) return res.status(404).json({ status: false, message: 'Item not found' });
    res.json({ status: true, data: { stock: rows[0], movements } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ─── Vouchers ─────────────────────────────────────────────────────────────────
router.post('/vouchers', authMiddleware, async (req, res) => {
  const { companyGuid, voucherType, page = 1, pageSize = 50, searchText = '', fromDate, toDate, status } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  try {
    let q = `SELECT * FROM vouchers WHERE company_guid = $1 AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
    const params = [companyGuid, search];
    let idx = 3;

    if (voucherType) { q += ` AND voucher_type = $${idx++}`; params.push(voucherType); }
    if (fromDate) { q += ` AND date >= $${idx++}`; params.push(fromDate); }
    if (toDate) { q += ` AND date <= $${idx++}`; params.push(toDate); }

    if (status === 'cancelled') {
      q += ` AND is_cancelled = TRUE`;
    } else if (status === 'completed') {
      q += ` AND is_cancelled = FALSE AND amount != 0 AND party_name IS NOT NULL`;
    } else if (status === 'pending') {
      q += ` AND is_cancelled = FALSE AND (amount = 0 OR party_name IS NULL)`;
    } else {
      q += ` AND is_cancelled = FALSE`;
    }

    q += ` ORDER BY date DESC, id DESC LIMIT $${idx++} OFFSET $${idx}`;
    params.push(pageSize, offset);

    const { rows: vouchers } = await query(q, params);
    const { rows: countRows } = await query('SELECT COUNT(*) as c FROM vouchers WHERE company_guid = $1 AND is_cancelled = FALSE', [companyGuid]);

    res.json({ status: true, data: { vouchers, total: parseInt(countRows[0].c), page } });
  } catch (err) {
    console.error('[vouchers] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch vouchers' });
  }
});

// ─── Dashboard ────────────────────────────────────────────────────────────────
router.post('/dashboard', authMiddleware, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });

  try {
    let from = fromDate;
    let to = toDate;

    if (!from || !to) {
      const { rows: companyRows } = await query('SELECT fy_start, fy_end FROM companies WHERE guid = $1', [companyGuid]);
      const company = companyRows[0];
      if (company?.fy_start && company?.fy_end) {
        const normalize = d => { const s = String(d).replace(/-/g, ''); return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`; };
        from = normalize(company.fy_start);
        to   = normalize(company.fy_end);
      } else {
        const now = new Date();
        const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
        from = `${fyYear}-04-01`;
        to   = `${fyYear + 1}-03-31`;
      }
    }

    const [sales, purchase, payments, receipts, cash, bank, receivables, payables] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Payment%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Receipt%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Bank%' OR parent ILIKE '%Bank Account%')`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent = 'Sundry Debtors') AND closing_balance != 0`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Creditor%' OR parent = 'Sundry Creditors') AND closing_balance != 0`, [companyGuid]),
    ]);

    const totalSales    = parseFloat(sales.rows[0].v || 0);
    const totalPurchase = parseFloat(purchase.rows[0].v || 0);

    res.json({ status: true, data: {
      totalSales,
      totalPurchase,
      totalPayments:  parseFloat(payments.rows[0].v || 0),
      totalReceipts:  parseFloat(receipts.rows[0].v || 0),
      cashBalance:    parseFloat(cash.rows[0].v || 0),
      bankBalance:    parseFloat(bank.rows[0].v || 0),
      receivables:    parseFloat(receivables.rows[0].v || 0),
      payables:       parseFloat(payables.rows[0].v || 0),
      netProfit:      totalSales - totalPurchase,
    }});
  } catch (err) {
    console.error('[dashboard] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch dashboard' });
  }
});

// ─── Ledger Vouchers (vouchers linked to a specific ledger via line items) ──────
router.post('/ledger-vouchers', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerName, page = 1, pageSize = 25 } = req.body || {};
  if (!companyGuid || !ledgerName) return res.status(400).json({ status: false, message: 'companyGuid and ledgerName required' });

  const offset = (page - 1) * pageSize;
  try {
    // Get voucher GUIDs that have this ledger as a line item
    const { rows: items } = await query(
      `SELECT DISTINCT vi.voucher_guid FROM voucher_items vi
       WHERE vi.company_guid = $1 AND vi.ledger_name ILIKE $2
       LIMIT $3 OFFSET $4`,
      [companyGuid, ledgerName, pageSize, offset]
    );

    if (items.length === 0) {
      // Fallback: search by party_name in vouchers
      const { rows: vouchers } = await query(
        `SELECT * FROM vouchers WHERE company_guid = $1
         AND (party_name ILIKE $2 OR voucher_number ILIKE $2)
         AND is_cancelled = FALSE
         ORDER BY date DESC LIMIT $3 OFFSET $4`,
        [companyGuid, `%${ledgerName}%`, pageSize, offset]
      );
      const { rows: countRows } = await query(
        `SELECT COUNT(*) as c FROM vouchers WHERE company_guid = $1
         AND (party_name ILIKE $2 OR voucher_number ILIKE $2) AND is_cancelled = FALSE`,
        [companyGuid, `%${ledgerName}%`]
      );
      return res.json({ status: true, data: { vouchers, total: parseInt(countRows[0].c), page, source: 'party_name' } });
    }

    const guids = items.map(i => i.voucher_guid);
    const placeholders = guids.map((_, i) => `$${i + 2}`).join(',');
    const { rows: vouchers } = await query(
      `SELECT * FROM vouchers WHERE company_guid = $1
       AND guid IN (${placeholders})
       ORDER BY date DESC`,
      [companyGuid, ...guids]
    );

    res.json({ status: true, data: { vouchers, total: vouchers.length, page, source: 'ledger_items' } });
  } catch (err) {
    console.error('[ledger-vouchers] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch ledger vouchers' });
  }
});

// ─── Reports ──────────────────────────────────────────────────────────────────
router.post('/reports/pl', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  try {
    const { rows: income }   = await query(`SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Income%' OR parent ILIKE '%Revenue%' OR parent ILIKE '%Sales%')`, [companyGuid]);
    const { rows: expenses } = await query(`SELECT name, parent, closing_balance FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Expense%' OR parent ILIKE '%Purchase%')`, [companyGuid]);

    const totalIncome   = income.reduce((s, l)   => s + parseFloat(l.closing_balance || 0), 0);
    const totalExpenses = expenses.reduce((s, l) => s + parseFloat(l.closing_balance || 0), 0);

    res.json({ status: true, data: { income, expenses, summary: { totalIncome, totalExpenses, grossProfit: totalIncome - totalExpenses, netProfit: totalIncome - totalExpenses } } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/reports/balance-sheet', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  try {
    const { rows: assets }      = await query(`SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=$1 AND balance_type='Dr'`, [companyGuid]);
    const { rows: liabilities } = await query(`SELECT name, parent, closing_balance, balance_type FROM ledgers WHERE company_guid=$1 AND balance_type='Cr'`, [companyGuid]);

    const totalAssets      = assets.reduce((s, l)      => s + parseFloat(l.closing_balance || 0), 0);
    const totalLiabilities = liabilities.reduce((s, l) => s + parseFloat(l.closing_balance || 0), 0);

    res.json({ status: true, data: { assets, liabilities, summary: { totalAssets, totalLiabilities } } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

export default router;
