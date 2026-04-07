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
    // Sort by balance descending so ledgers with real balances appear first
    q += ` ORDER BY ABS(closing_balance) DESC, name LIMIT $${idx++} OFFSET $${idx}`;
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
    // Exclude stub vouchers (SimplifiedVoucher stubs have type='Voucher' and amount=0)
    let q = `SELECT * FROM vouchers WHERE company_guid = $1 AND is_cancelled = FALSE AND NOT (voucher_type = 'Voucher' AND (amount = 0 OR amount IS NULL)) AND (party_name ILIKE $2 OR voucher_number ILIKE $2)`;
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
      // Try company_years first (most accurate)
      const { rows: yearRows } = await query(
        'SELECT begin_date, end_date FROM company_years WHERE company_guid=$1 ORDER BY begin_date DESC LIMIT 1',
        [companyGuid]
      );
      if (yearRows[0]?.begin_date && yearRows[0]?.end_date) {
        from = yearRows[0].begin_date;
        to   = yearRows[0].end_date;
      } else {
        // Fallback: use actual voucher date range from the company
        const { rows: dateRows } = await query(
          'SELECT MIN(date) as min_d, MAX(date) as max_d FROM vouchers WHERE company_guid=$1 AND date IS NOT NULL',
          [companyGuid]
        );
        if (dateRows[0]?.min_d) {
          const maxDate = new Date(dateRows[0].max_d);
          const fyYear = maxDate.getMonth() >= 3 ? maxDate.getFullYear() : maxDate.getFullYear() - 1;
          from = `${fyYear}-04-01`;
          to   = `${fyYear + 1}-03-31`;
        } else {
          const now = new Date();
          const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
          from = `${fyYear}-04-01`;
          to   = `${fyYear + 1}-03-31`;
        }
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

    // Monthly sales/purchase chart data - cast text date to date type
    const { rows: monthlyRows } = await query(`
      SELECT 
        TO_CHAR(date::date, 'Mon') as month,
        EXTRACT(MONTH FROM date::date) as month_num,
        EXTRACT(YEAR FROM date::date) as year,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' THEN amount ELSE 0 END) as sales,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' THEN amount ELSE 0 END) as purchase
      FROM vouchers
      WHERE company_guid=$1 AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date, 'Mon'), EXTRACT(MONTH FROM date::date), EXTRACT(YEAR FROM date::date)
      ORDER BY year, month_num
      LIMIT 12
    `, [companyGuid, from, to]);

    // Top customers by sales amount
    const { rows: topCustRows } = await query(`
      SELECT party_name as name, SUM(amount) as revenue, COUNT(*) as invoices
      FROM vouchers
      WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND party_name IS NOT NULL
        AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE
      GROUP BY party_name ORDER BY revenue DESC LIMIT 5
    `, [companyGuid, from, to]);

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
      fromDate: from,
      toDate: to,
      monthlySales: monthlyRows.map(r => ({ month: r.month, sales: parseFloat(r.sales||0), purchase: parseFloat(r.purchase||0) })),
      topCustomers: topCustRows.map(r => ({ name: r.name, revenue: parseFloat(r.revenue||0), invoices: parseInt(r.invoices||0) })),
    }});
  } catch (err) {
    console.error('[dashboard] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch dashboard' });
  }
});

// ─── Single Voucher Detail (with line items) ────────────────────────────────
router.post('/voucher-detail', authMiddleware, async (req, res) => {
  const { companyGuid, voucherId } = req.body || {};
  if (!companyGuid || !voucherId) return res.status(400).json({ status: false, message: 'companyGuid and voucherId required' });

  try {
    // Try by integer id first, then by guid
    const { rows: vouchers } = await query(
      'SELECT * FROM vouchers WHERE company_guid = $1 AND (id = $2 OR guid = $3)',
      [companyGuid, parseInt(voucherId) || 0, String(voucherId)]
    );
    if (!vouchers[0]) return res.status(404).json({ status: false, message: 'Voucher not found' });

    const voucher = vouchers[0];

    // Get line items - use DISTINCT to prevent duplicates even if sync created them
    const { rows: items } = await query(
      `SELECT DISTINCT ON (ledger_name, type, amount, item_name) *
       FROM voucher_items WHERE company_guid = $1 AND voucher_guid = $2
       ORDER BY ledger_name, type, amount, item_name, id`,
      [companyGuid, voucher.guid]
    );

    // Get company info
    const { rows: companies } = await query('SELECT * FROM companies WHERE guid = $1', [companyGuid]);
    const company = companies[0];

    res.json({ status: true, data: { voucher, items, company } });
  } catch (err) {
    console.error('[voucher-detail] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch voucher' });
  }
});

// ─── Ledger Vouchers (vouchers linked to a specific ledger via line items or party name) ───
router.post('/ledger-vouchers', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerName, page = 1, pageSize = 25 } = req.body || {};
  if (!companyGuid || !ledgerName) return res.status(400).json({ status: false, message: 'companyGuid and ledgerName required' });

  const offset = (page - 1) * pageSize;
  try {
    // Strategy 1: exact ledger_name match in voucher_items
    const { rows: exactItems } = await query(
      `SELECT DISTINCT vi.voucher_guid FROM voucher_items vi
       WHERE vi.company_guid = $1 AND vi.ledger_name = $2`,
      [companyGuid, ledgerName]
    );

    // Strategy 2: party_name exact match in vouchers
    const { rows: partyVouchers } = await query(
      `SELECT * FROM vouchers WHERE company_guid = $1
       AND party_name = $2 AND is_cancelled = FALSE
       ORDER BY date DESC LIMIT $3 OFFSET $4`,
      [companyGuid, ledgerName, pageSize, offset]
    );

    // Strategy 3: ILIKE match in voucher_items if exact returns nothing
    let itemGuids = exactItems.map(i => i.voucher_guid);
    if (itemGuids.length === 0) {
      const { rows: likeItems } = await query(
        `SELECT DISTINCT vi.voucher_guid FROM voucher_items vi
         WHERE vi.company_guid = $1 AND vi.ledger_name ILIKE $2
         LIMIT $3`,
        [companyGuid, `%${ledgerName}%`, pageSize]
      );
      itemGuids = likeItems.map(i => i.voucher_guid);
    }

    // Fetch vouchers from item GUIDs with enriched line item data
    let itemVouchers = [];
    if (itemGuids.length > 0) {
      const ph = itemGuids.map((_, i) => `$${i + 2}`).join(',');
      const { rows } = await query(
        `SELECT v.*,
           -- Sum Cr items as the voucher amount if voucher amount is 0
           CASE WHEN v.amount = 0 THEN
             (SELECT SUM(vi2.amount) FROM voucher_items vi2
              WHERE vi2.voucher_guid = v.guid AND vi2.company_guid = v.company_guid AND vi2.type = 'Cr')
           ELSE v.amount END as computed_amount
         FROM vouchers v
         WHERE v.company_guid = $1
         AND v.guid IN (${ph})
         ORDER BY v.date DESC LIMIT $${itemGuids.length + 2}`,
        [companyGuid, ...itemGuids, pageSize]
      );
      // Use computed_amount if present
      itemVouchers = rows.map(v => ({
        ...v,
        amount: v.computed_amount || v.amount,
      }));
    }

    // Priority: party_name results first (they have full data)
    // Only use item vouchers if party_name returns nothing
    // Filter out SimplifiedVoucher stubs (type='Voucher', amount=0)
    const realItemVouchers = itemVouchers.filter(v =>
      v.voucher_type !== 'Voucher' || parseFloat(v.amount) > 0
    );

    let finalVouchers;
    if (partyVouchers.length > 0) {
      // Merge party + real item vouchers, party first
      const seen = new Set();
      finalVouchers = [...partyVouchers, ...realItemVouchers].filter(v => {
        if (seen.has(v.id)) return false;
        seen.add(v.id);
        return true;
      });
    } else if (realItemVouchers.length > 0) {
      finalVouchers = realItemVouchers;
    } else {
      // Last resort: return item vouchers even if stubs
      finalVouchers = itemVouchers;
    }

    finalVouchers.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const source = partyVouchers.length > 0 ? 'party_name' : itemGuids.length > 0 ? 'ledger_items' : 'none';
    res.json({ status: true, data: { vouchers: finalVouchers.slice(0, pageSize), total: finalVouchers.length, page, source } });
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
