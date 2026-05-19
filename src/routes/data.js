// Data routes — read endpoints for mobile & web portal
import { Router } from 'express';
import { query } from '../db/schema.js';
import { authMiddleware, requirePaired, requireCompanySynced } from '../middleware/auth.js';
import { resolveFYDates } from './api-v1.js';

const router = Router();

// ── Ownership guard — verifies companyGuid belongs to the authenticated user ────
async function verifyCompanyOwnership(req, res, companyGuid) {
  if (!companyGuid) return true;
  try {
    const { rows } = await query(
      'SELECT guid FROM companies WHERE guid = $1 AND user_id = $2 LIMIT 1',
      [companyGuid, req.user.userId]
    );
    if (rows.length === 0) {
      res.status(403).json({ status: false, message: 'Access denied: company not owned by this user' });
      return false;
    }
    return true;
  } catch (err) {
    res.status(500).json({ status: false, message: 'Ownership check failed' });
    return false;
  }
}

// GET /ping — lightweight health check for desktop connectivity detection
router.get('/ping', (_req, res) => res.json({ ok: true }));

// ─── Ledgers ──────────────────────────────────────────────────────────────────
// POST /parties — unique party names from vouchers (customers/vendors)
router.post('/parties', authMiddleware, async (req, res) => {
  const { companyGuid, searchText = '', pageSize = 30 } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const search = `%${searchText}%`;
    const { rows } = await query(
      `SELECT DISTINCT party_name as name,
        MAX(CASE WHEN voucher_type ILIKE '%Sales%' THEN 'Sundry Debtors' WHEN voucher_type ILIKE '%Purchase%' THEN 'Sundry Creditors' ELSE '' END) as parent
       FROM vouchers
       WHERE company_guid=$1 AND party_name IS NOT NULL AND party_name ILIKE $2
       GROUP BY party_name ORDER BY party_name LIMIT $3`,
      [companyGuid, search, pageSize]
    );
    res.json({ status: true, data: { parties: rows } });
  } catch (e) {
    res.status(500).json({ status: false, message: e.message });
  }
});

router.post('/ledgers', authMiddleware, requirePaired, requireCompanySynced, async (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', parent, from, to, fy } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const offset = (page - 1) * pageSize;
  const search = `%${searchText}%`;

  try {
    // Resolve FY dates for balance computation
    const { from: fyFrom, to: fyTo, financialYear } = await resolveFYDates(companyGuid, from, to, fy);

    let q = `
      SELECT l.*,
        COALESCE(lfb.opening_balance, l.opening_balance, 0) as fy_opening_abs,
        COALESCE(lfb.balance_type, l.balance_type, 'Dr') as fy_opening_type,
        COALESCE((
          SELECT SUM(vle.amount)
          FROM voucher_ledger_entries vle
          JOIN vouchers v ON v.guid = vle.voucher_guid AND v.company_guid = vle.company_guid
          WHERE vle.company_guid = l.company_guid AND vle.ledger_name = l.name
            AND (vle.financial_year = $3 OR (vle.financial_year IS NULL AND v.date BETWEEN $4 AND $5))
            AND v.is_cancelled = FALSE
        ), 0) as fy_movement,
        -- Derive nature from parent group (ledgers.nature is rarely populated directly)
        COALESCE(l.nature, g.nature) as nature
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $3
      LEFT JOIN groups g
        ON g.company_guid = l.company_guid AND g.name = l.parent
      WHERE l.company_guid = $1 AND (l.name ILIKE $2 OR l.alias ILIKE $2 OR l.gstin ILIKE $2)
    `;
    const params = [companyGuid, search, financialYear, fyFrom, fyTo];
    let idx = 6;

    if (parent) { q += ` AND l.parent = $${idx++}`; params.push(parent); }
    q += ` ORDER BY ABS(l.closing_balance) DESC, l.name LIMIT $${idx++} OFFSET $${idx}`;
    params.push(pageSize, offset);

    const { rows: rawLedgers } = await query(q, params);

    // Compute FY-specific closing balance
    const ledgers = rawLedgers.map(l => {
      const bt = l.fy_opening_type || 'Dr';
      const openSigned = bt === 'Dr' ? -Math.abs(parseFloat(l.fy_opening_abs||0)) : Math.abs(parseFloat(l.fy_opening_abs||0));
      const closeSigned = openSigned + parseFloat(l.fy_movement||0);
      return {
        ...l,
        closing_balance: Math.abs(closeSigned),
        balance_type:    closeSigned <= 0 ? 'Dr' : 'Cr',
      };
    });

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
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
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
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
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
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows: cats } = await query('SELECT DISTINCT category FROM stocks WHERE company_guid = $1 AND category IS NOT NULL', [companyGuid]);
    const { rows: grps } = await query('SELECT DISTINCT group_name FROM stocks WHERE company_guid = $1 AND group_name IS NOT NULL', [companyGuid]);
    res.json({ status: true, data: { categories: cats.map(r => r.category), groups: grps.map(r => r.group_name) } });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/stocks', authMiddleware, requirePaired, requireCompanySynced, async (req, res) => {
  const { companyGuid, page = 1, pageSize = 50, searchText = '', category, lowStockOnly } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
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
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
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
router.post('/vouchers', authMiddleware, requirePaired, requireCompanySynced, async (req, res) => {
  const { companyGuid, voucherType, page = 1, pageSize = 50, searchText = '', fromDate, toDate, status } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

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
router.post('/dashboard', authMiddleware, requirePaired, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

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

    const [sales, purchase, payments, receipts, cash, bank, receivables, payables, pendingIRN, pendingEWB, creditNotesCount] = await Promise.all([
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Purchase%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Payment%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT COALESCE(SUM(amount),0) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Receipt%' AND date BETWEEN $2 AND $3 AND is_cancelled=FALSE`, [companyGuid, from, to]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Cash%' OR name ILIKE '%Cash in Hand%')`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Bank%' OR parent ILIKE '%Bank Account%')`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent = 'Sundry Debtors') AND closing_balance != 0`, [companyGuid]),
      query(`SELECT SUM(ABS(closing_balance)) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Sundry Creditor%' OR parent = 'Sundry Creditors') AND closing_balance != 0`, [companyGuid]),
      // Pending IRN — sales invoices ≥₹50K without IRN
      query(`SELECT COUNT(*) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND amount >= 50000 AND (irn IS NULL OR irn = '') AND (irn_cancelled IS NULL OR irn_cancelled = FALSE) AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]).catch(() => ({ rows: [{ v: 0 }] })),
      // Pending EWB — sales invoices without EWB number
      query(`SELECT COUNT(*) as v FROM vouchers WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND amount >= 50000 AND (ewb_number IS NULL OR ewb_number = '') AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]).catch(() => ({ rows: [{ v: 0 }] })),
      // Credit notes count this FY
      query(`SELECT COUNT(*) as v FROM vouchers WHERE company_guid=$1 AND (voucher_type ILIKE '%Credit%' OR voucher_type ILIKE '%Debit%') AND is_cancelled=FALSE AND date BETWEEN $2 AND $3`, [companyGuid, from, to]).catch(() => ({ rows: [{ v: 0 }] })),
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

    // Fetch loans ODs separately
    const { rows: loanRows } = await query(
      `SELECT COALESCE(SUM(ABS(closing_balance)),0) as v FROM ledgers WHERE company_guid=$1 AND (parent ILIKE '%Loan%' OR parent ILIKE '%Secured Loan%' OR parent ILIKE '%Unsecured Loan%' OR parent ILIKE '%Bank OD%' OR parent ILIKE '%Overdraft%')`,
      [companyGuid]
    ).catch(() => ({ rows: [{ v: 0 }] }));

    // Recent activity — last 10 voucher entries
    const { rows: activityRows } = await query(
      `SELECT id, voucher_number, party_name, voucher_type, amount, date, created_at
       FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE
       ORDER BY created_at DESC LIMIT 10`,
      [companyGuid]
    ).catch(() => ({ rows: [] }));

    const cashInHand    = parseFloat(cash.rows[0].v || 0);
    const bankBalance   = parseFloat(bank.rows[0].v || 0);
    const totalPay      = parseFloat(payments.rows[0].v || 0);
    const totalRec      = parseFloat(receipts.rows[0].v || 0);
    const totalRec2     = parseFloat(receivables.rows[0].v || 0);
    const totalPay2     = parseFloat(payables.rows[0].v || 0);
    const loansODs      = parseFloat(loanRows[0]?.v || 0);
    const grossProfit   = totalSales - totalPurchase;
    const netProfit     = grossProfit - parseFloat(payments.rows[0].v || 0) * 0.1; // approx
    const netCash       = cashInHand + bankBalance - totalPay2;
    const grossCash     = cashInHand + bankBalance;

    // Build trend data from monthly sales
    const lastMonth = monthlyRows[monthlyRows.length - 1];
    const prevMonth = monthlyRows[monthlyRows.length - 2];
    const salesChange   = prevMonth?.sales  > 0 ? ((lastMonth?.sales  - prevMonth?.sales)  / prevMonth.sales  * 100).toFixed(1)  : 0;
    const purchChange   = prevMonth?.purchase > 0 ? ((lastMonth?.purchase - prevMonth?.purchase) / prevMonth.purchase * 100).toFixed(1) : 0;

    res.json({ status: true, data: {
      // KPI chips — all field names match mobile store exactly
      cashInHand,
      bankBalance,
      receivables:    totalRec2,
      payables:       totalPay2,
      loansODs,
      payments:       totalPay,
      receipts:       totalRec,
      // Cash flow section
      netCash,
      grossCash,
      netRealisableBalance: totalRec2 - totalPay2,
      grossProfit,
      netProfit,
      // Sales / Purchase totals
      totalSales,
      totalPurchase,
      fromDate: from,
      toDate: to,
      // Trend tiles
      trendData: {
        sales:     { value: totalSales,    change: parseFloat(String(salesChange)) },
        purchases: { value: totalPurchase, change: parseFloat(String(purchChange)) },
        expenses:  { value: totalPay,      change: 0 },
      },
      // Charts
      monthlySales: monthlyRows.map(r => ({ month: r.month, sales: parseFloat(r.sales||0), purchase: parseFloat(r.purchase||0) })),
      topCustomers: topCustRows.map(r => ({ name: r.name, revenue: parseFloat(r.revenue||0), invoices: parseInt(r.invoices||0) })),
      // Recent activity
      recentActivity: activityRows.map(r => ({
        id: r.id,
        description: `${r.voucher_type} ${r.voucher_number} — ${r.party_name || 'N/A'}`,
        timestamp: r.created_at ? new Date(r.created_at).toLocaleDateString('en-IN', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '',
        type: r.voucher_type?.toLowerCase().includes('sales') ? 'invoice' : 'voucher',
      })),
      // Alert counts
      pendingIRNCount:   parseInt(pendingIRN.rows[0]?.v || 0),
      pendingEWBCount:   parseInt(pendingEWB.rows[0]?.v || 0),
      creditNotesCount:  parseInt(creditNotesCount.rows[0]?.v || 0),
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
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

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

    // Ledger entries from vle (authoritative per-party amounts)
    const { rows: ledgerEntries } = await query(
      'SELECT ledger_name, amount, dr_cr FROM voucher_ledger_entries WHERE voucher_guid=$1 AND company_guid=$2 ORDER BY ABS(amount) DESC',
      [voucher.guid, companyGuid]
    );
    // party_amount = the Dr entry for the party ledger
    const partyEntry = ledgerEntries.find(e => e.ledger_name === voucher.party_name);
    const partyAmount = partyEntry ? Math.abs(parseFloat(partyEntry.amount||'0')) : parseFloat(voucher.amount||'0');

    res.json({ status: true, data: { voucher: { ...voucher, party_amount: partyAmount }, items, company, ledger_entries: ledgerEntries } });
  } catch (err) {
    console.error('[voucher-detail] Error:', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch voucher' });
  }
});

// ─── Ledger Balance Trend ────────────────────────────────────────────────────────────────────
router.post('/ledger-trend', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerName, fromDate, toDate } = req.body || {};
  if (!companyGuid || !ledgerName) return res.status(400).json({ status: false, message: 'companyGuid and ledgerName required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';
    const { rows } = await query(`
      SELECT
        TO_CHAR(date::date, 'Mon') as month,
        TO_CHAR(date::date, 'YYYY-MM') as ym,
        SUM(amount) as total,
        COUNT(*) as txn_count
      FROM vouchers
      WHERE company_guid=$1
        AND party_name=$2
        AND is_cancelled=FALSE
        AND date IS NOT NULL AND date != ''
        AND date BETWEEN $3 AND $4
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date, 'Mon'), TO_CHAR(date::date, 'YYYY-MM')
      ORDER BY ym
    `, [companyGuid, ledgerName, from, to]);
    res.json({ status: true, data: rows.map(r => ({ month: r.month, balance: parseFloat(r.total || 0), count: parseInt(r.txn_count || 0) })) });
  } catch (err) {
    res.status(500).json({ status: false, message: 'Failed to fetch trend' });
  }
});

// ─── Ledger Vouchers (vouchers linked to a specific ledger via line items or party name) ───
router.post('/ledger-vouchers', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerName, page = 1, pageSize = 25 } = req.body || {};
  if (!companyGuid || !ledgerName) return res.status(400).json({ status: false, message: 'companyGuid and ledgerName required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;

  const offset = (page - 1) * pageSize;
  try {
    // Strategy 1: exact ledger_name match in voucher_items
    const { rows: exactItems } = await query(
      `SELECT DISTINCT vi.voucher_guid FROM voucher_items vi
       WHERE vi.company_guid = $1 AND vi.ledger_name = $2`,
      [companyGuid, ledgerName]
    );

    // Strategy 2: party_name exact match in vouchers + ledger entry amount
    const { rows: partyRaw } = await query(
      `SELECT v.*,
        (SELECT ABS(vle.amount) FROM voucher_ledger_entries vle
         WHERE vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid
           AND vle.ledger_name = $2 LIMIT 1) as entry_amount
       FROM vouchers v
       WHERE v.company_guid = $1 AND v.party_name = $2 AND v.is_cancelled = FALSE
       ORDER BY v.date DESC LIMIT $3 OFFSET $4`,
      [companyGuid, ledgerName, pageSize, offset]
    );
    const partyVouchers = partyRaw.map(v => ({ ...v, amount: v.entry_amount != null ? v.entry_amount : v.amount }));

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
           -- Ledger-specific entry amount from voucher_ledger_entries (authoritative)
           (SELECT ABS(vle.amount) FROM voucher_ledger_entries vle
            WHERE vle.voucher_guid = v.guid AND vle.company_guid = v.company_guid
              AND vle.ledger_name = $${itemGuids.length + 2}
            LIMIT 1) as entry_amount,
           -- Sum Cr items as the voucher amount if voucher amount is 0
           CASE WHEN v.amount = 0 THEN
             (SELECT SUM(vi2.amount) FROM voucher_items vi2
              WHERE vi2.voucher_guid = v.guid AND vi2.company_guid = v.company_guid AND vi2.type = 'Cr')
           ELSE v.amount END as computed_amount
         FROM vouchers v
         WHERE v.company_guid = $1
         AND v.guid IN (${ph})
         ORDER BY v.date DESC LIMIT $${itemGuids.length + 3}`,
        [companyGuid, ...itemGuids, ledgerName, pageSize]
      );
      // Use entry_amount (per-ledger) first, then computed_amount, then v.amount
      itemVouchers = rows.map(v => ({
        ...v,
        amount: v.entry_amount != null ? v.entry_amount : (v.computed_amount || v.amount),
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
  const { companyGuid, from, to } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Resolve FY dates
    const fyTo = to || (await (async () => {
      const { rows } = await query('SELECT end_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      return rows[0]?.end_date || `${new Date().getFullYear() + 1}-03-31`;
    })());
    const fyFrom = from || (await (async () => {
      const { rows } = await query('SELECT begin_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      return rows[0]?.begin_date || `${new Date().getFullYear()}-04-01`;
    })());

    const fyYearLabel = (() => {
      const y = parseInt(String(fyFrom).slice(0, 4), 10);
      return `${y}-${y + 1}`;
    })();

    // ── FY-specific ledger balances (anchor + movements) ──────────────────
    const fyBalQuery = `
      SELECT l.name, l.parent, l.balance_type,
        CASE WHEN COALESCE(lfb.balance_type, l.balance_type, 'Dr') = 'Dr'
             THEN -ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
             ELSE  ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
        END
        + COALESCE((
            SELECT SUM(vle.amount)
            FROM voucher_ledger_entries vle
            WHERE vle.ledger_name = l.name AND vle.company_guid = l.company_guid
              AND vle.financial_year = $2
          ), 0) as fy_closing_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `;
    const { rows: allLedgers } = await query(fyBalQuery, [companyGuid, fyYearLabel]);

    const toAmt  = l => Math.abs(parseFloat(l.fy_closing_signed || 0));
    const mapLed = l => ({ name: l.name, parent: l.parent, amount: toAmt(l) });

    // ── P&L group buckets (Tally standard group names) ───────────────────
    // Use anchored regex — prevents 'Direct' from matching inside 'Indirect'
    const salesLeds        = allLedgers.filter(l => l.parent && /^Sales Accounts$/i.test(l.parent.trim()));
    const purchaseLeds     = allLedgers.filter(l => l.parent && /^Purchase Accounts$/i.test(l.parent.trim()));
    const directExpLeds    = allLedgers.filter(l => l.parent && /^Direct Expenses?$/i.test(l.parent.trim()));
    const directIncLeds    = allLedgers.filter(l => l.parent && /^Direct Incomes?$/i.test(l.parent.trim()));
    const indirectExpLeds  = allLedgers.filter(l => l.parent && /^Indirect Expenses?$/i.test(l.parent.trim()));
    const indirectIncLeds  = allLedgers.filter(l => l.parent && /^Indirect Incomes?$/i.test(l.parent.trim()));

    const sales           = salesLeds.reduce((s, l)       => s + toAmt(l), 0);
    const purchase        = purchaseLeds.reduce((s, l)    => s + toAmt(l), 0);
    const directExpenses  = directExpLeds.reduce((s, l)   => s + toAmt(l), 0);
    const directIncome    = directIncLeds.reduce((s, l)   => s + toAmt(l), 0);
    const indirectExpenses= indirectExpLeds.reduce((s, l) => s + toAmt(l), 0);
    const indirectIncome  = indirectIncLeds.reduce((s, l) => s + toAmt(l), 0);

    // ── Stock values — only use if FY-specific stock transaction data exists ───
    const { rows: stxRows } = await query(`
      SELECT COUNT(*) as txn_count,
        COALESCE(SUM(CASE WHEN type='inward' THEN qty::float*rate::float ELSE 0 END),0) as inward_val,
        COALESCE(SUM(CASE WHEN type='outward' THEN qty::float*rate::float ELSE 0 END),0) as outward_val
      FROM stock_transactions WHERE company_guid = $1 AND financial_year = $2
    `, [companyGuid, fyYearLabel]);
    const hasFYStockData = parseInt(stxRows[0]?.txn_count || 0) > 0;
    let openingStock = 0, closingStock = 0;
    if (hasFYStockData) {
      const { rows: ms } = await query('SELECT COALESCE(SUM(opening_qty::float*opening_rate::float),0) AS os FROM stocks WHERE company_guid=$1', [companyGuid]);
      openingStock = parseFloat(ms[0]?.os || 0);
      closingStock = openingStock + parseFloat(stxRows[0]?.inward_val||0) - parseFloat(stxRows[0]?.outward_val||0);
    }

    // ── Gross & Net Profit (Tally P&L formula) ────────────────────────────
    // Gross Profit = (Sales + Direct Income + Closing Stock) - (Purchase + Direct Expenses + Opening Stock)
    const grossProfit = (sales + directIncome + closingStock) - (purchase + directExpenses + openingStock);
    // Net Profit = Gross Profit + Indirect Income - Indirect Expenses
    const netProfit   = grossProfit + indirectIncome - indirectExpenses;

    res.json({
      status: true,
      data: {
        from: fyFrom, to: fyTo, financialYear: fyYearLabel,
        pl: {
          openingStock, closingStock,
          sales, purchase, directExpenses, directIncome, indirectExpenses, indirectIncome,
          grossProfit, grossLoss: grossProfit < 0 ? Math.abs(grossProfit) : 0,
          netProfit:   netProfit  > 0 ? netProfit  : 0,
          netLoss:     netProfit  < 0 ? Math.abs(netProfit) : 0,
          // Ledger breakdowns for drill-down
          salesLedgers:       salesLeds.map(mapLed),
          purchaseLedgers:    purchaseLeds.map(mapLed),
          directExpLedgers:   directExpLeds.map(mapLed),
          directIncLedgers:   directIncLeds.map(mapLed),
          indirectExpLedgers: indirectExpLeds.map(mapLed),
          indirectIncLedgers: indirectIncLeds.map(mapLed),
        },
        // Keep legacy income/expenses arrays for web portal compatibility
        income:   [...salesLeds, ...directIncLeds, ...indirectIncLeds].map(mapLed),
        expenses: [...purchaseLeds, ...directExpLeds, ...indirectExpLeds].map(mapLed),
        summary: {
          totalIncome:   sales + directIncome + indirectIncome,
          totalExpenses: purchase + directExpenses + indirectExpenses,
          grossProfit, netProfit,
        },
      },
    });
  } catch (err) {
    console.error('[pl]', err.message);
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

router.post('/reports/balance-sheet', authMiddleware, async (req, res) => {
  const { companyGuid, from, to } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const fyTo = to || (await (async () => {
      const { rows } = await query('SELECT end_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      return rows[0]?.end_date || `${new Date().getFullYear() + 1}-03-31`;
    })());

    // V2: Balance Sheet uses financial_year + ledger_fy_balances
    const bsFyYear = (() => { const y = parseInt(String(fyTo).slice(0, 4), 10); return new Date(fyTo).getMonth() < 3 ? `${y - 1}-${y}` : `${y}-${y + 1}`; })();
    const { rows: allLedgers } = await query(`
      SELECT l.name, l.parent, l.balance_type,
        CASE WHEN COALESCE(lfb.balance_type, l.balance_type, 'Dr') = 'Dr'
             THEN -ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
             ELSE  ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
        END
        + COALESCE((
            SELECT SUM(vle.amount)
            FROM voucher_ledger_entries vle
            WHERE vle.ledger_name = l.name AND vle.company_guid = l.company_guid
              AND vle.financial_year = $2
          ), 0) as fy_closing_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
    `, [companyGuid, bsFyYear]);

    const assets      = allLedgers.filter(l => parseFloat(l.fy_closing_signed || 0) < 0)
      .map(l => ({ name: l.name, parent: l.parent, balance_type: 'Dr', closing_balance: Math.abs(parseFloat(l.fy_closing_signed || 0)) }));
    const liabilities = allLedgers.filter(l => parseFloat(l.fy_closing_signed || 0) > 0)
      .map(l => ({ name: l.name, parent: l.parent, balance_type: 'Cr', closing_balance: Math.abs(parseFloat(l.fy_closing_signed || 0)) }));

    const totalAssets      = assets.reduce((s, l)      => s + parseFloat(l.closing_balance || 0), 0);
    const totalLiabilities = liabilities.reduce((s, l) => s + parseFloat(l.closing_balance || 0), 0);

    res.json({ status: true, data: { assets, liabilities, to: fyTo, summary: { totalAssets, totalLiabilities } } });
  } catch (err) {
    console.error('[balance-sheet]', err.message);
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ─── POST /cash-bank ─────────────────────────────────────────────────────────
router.post('/cash-bank', authMiddleware, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // Cash vouchers (Contra + Payment to cash)
    const { rows: cashRows } = await query(`
      SELECT v.voucher_number as ref, v.party_name as description, v.amount, v.date,
             v.voucher_type,
             CASE WHEN v.voucher_type='Receipt' THEN v.amount ELSE 0 END as dr,
             CASE WHEN v.voucher_type IN ('Payment','Contra') THEN v.amount ELSE 0 END as cr
      FROM vouchers v
      WHERE v.company_guid=$1
        AND v.voucher_type IN ('Payment','Receipt','Contra')
        AND v.date BETWEEN $2 AND $3
        AND v.is_cancelled = FALSE
        AND v.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY v.date DESC
      LIMIT 200
    `, [companyGuid, from, to]);

    // Bank ledger balances
    const { rows: bankLedgers } = await query(`
      SELECT name, closing_balance, balance_type
      FROM ledgers
      WHERE company_guid=$1
        AND (name ILIKE '%bank%' OR name ILIKE '%hdfc%' OR name ILIKE '%sbi%'
             OR name ILIKE '%icici%' OR name ILIKE '%axis%' OR name ILIKE '%kotak%'
             OR name ILIKE '%pnb%' OR name ILIKE '%boi%' OR parent ILIKE '%bank%')
      ORDER BY ABS(closing_balance) DESC
      LIMIT 20
    `, [companyGuid]);

    const totalCash   = cashRows.filter(r => r.voucher_type === 'Receipt').reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const totalPaid   = cashRows.filter(r => r.voucher_type === 'Payment').reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const bankBalance = bankLedgers.reduce((s, l) => s + parseFloat(l.closing_balance || 0), 0);

    res.json({
      status: true,
      data: {
        transactions: cashRows.map(r => ({ ...r, amount: parseFloat(r.amount), dr: parseFloat(r.dr), cr: parseFloat(r.cr) })),
        bankAccounts: bankLedgers.map(l => ({ name: l.name, balance: parseFloat(l.closing_balance || 0), type: l.balance_type })),
        summary: { totalReceipts: totalCash, totalPayments: totalPaid, bankBalance, netCash: totalCash - totalPaid },
      },
    });
  } catch (err) {
    console.error('[cash-bank]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch cash & bank data' });
  }
});

// ─── POST /receivables-payables ───────────────────────────────────────────────
router.post('/receivables-payables', authMiddleware, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // Receivables: Sales parties with outstanding amounts
    const { rows: receivableRows } = await query(`
      SELECT party_name as name,
             SUM(amount) as total_amount,
             COUNT(*) as invoice_count,
             MAX(date) as last_date
      FROM vouchers
      WHERE company_guid=$1
        AND voucher_type ILIKE '%Sales%'
        AND party_name IS NOT NULL
        AND is_cancelled = FALSE
        AND date BETWEEN $2 AND $3
      GROUP BY party_name
      ORDER BY total_amount DESC
      LIMIT 50
    `, [companyGuid, from, to]);

    // Payables: Purchase parties with outstanding amounts
    const { rows: payableRows } = await query(`
      SELECT party_name as name,
             SUM(amount) as total_amount,
             COUNT(*) as invoice_count,
             MAX(date) as last_date
      FROM vouchers
      WHERE company_guid=$1
        AND voucher_type ILIKE '%Purchase%'
        AND party_name IS NOT NULL
        AND is_cancelled = FALSE
        AND date BETWEEN $2 AND $3
      GROUP BY party_name
      ORDER BY total_amount DESC
      LIMIT 50
    `, [companyGuid, from, to]);

    const totalReceivables = receivableRows.reduce((s, r) => s + parseFloat(r.total_amount || 0), 0);
    const totalPayables    = payableRows.reduce((s, r)    => s + parseFloat(r.total_amount || 0), 0);

    res.json({
      status: true,
      data: {
        receivables: receivableRows.map(r => ({ ...r, total_amount: parseFloat(r.total_amount), invoice_count: parseInt(r.invoice_count) })),
        payables:    payableRows.map(r =>    ({ ...r, total_amount: parseFloat(r.total_amount), invoice_count: parseInt(r.invoice_count) })),
        summary: { totalReceivables, totalPayables, net: totalReceivables - totalPayables },
      },
    });
  } catch (err) {
    console.error('[receivables-payables]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch receivables/payables' });
  }
});

// ─── POST /expenses ───────────────────────────────────────────────────────────
router.post('/expenses', authMiddleware, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // Expense vouchers: Journal + Payment entries
    const { rows: expenseRows } = await query(`
      SELECT v.voucher_number as ref, v.party_name as vendor,
             v.amount, v.date, v.voucher_type,
             vi.ledger_name as category
      FROM vouchers v
      LEFT JOIN voucher_items vi ON vi.voucher_guid = v.guid
        AND vi.company_guid = v.company_guid
        AND vi.type = 'Dr'
      WHERE v.company_guid=$1
        AND v.voucher_type IN ('Journal','Payment','Contra')
        AND v.is_cancelled = FALSE
        AND v.amount > 0
        AND v.date BETWEEN $2 AND $3
        AND v.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      ORDER BY v.date::date DESC
      LIMIT 200
    `, [companyGuid, from, to]);

    // Category totals
    const categoryMap = {};
    expenseRows.forEach(r => {
      const cat = r.category || r.voucher_type || 'Other';
      if (!categoryMap[cat]) categoryMap[cat] = 0;
      categoryMap[cat] += parseFloat(r.amount || 0);
    });
    const categories = Object.entries(categoryMap)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10);

    const totalExpenses = expenseRows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    res.json({
      status: true,
      data: {
        expenses: expenseRows.map(r => ({ ...r, amount: parseFloat(r.amount || 0) })),
        categories,
        summary: { totalExpenses, count: expenseRows.length },
      },
    });
  } catch (err) {
    console.error('[expenses]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch expenses' });
  }
});

// ─── POST /gst-summary ────────────────────────────────────────────────────────
router.post('/gst-summary', authMiddleware, async (req, res) => {
  const { companyGuid, fromDate, toDate } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const from = fromDate || '2024-04-01';
    const to   = toDate   || '2025-03-31';

    // GST from voucher items — CGST/SGST/IGST ledger entries
    const { rows: gstRows } = await query(`
      SELECT
        SUM(CASE WHEN vi.ledger_name ILIKE '%cgst%' THEN vi.amount ELSE 0 END) as cgst,
        SUM(CASE WHEN vi.ledger_name ILIKE '%sgst%' THEN vi.amount ELSE 0 END) as sgst,
        SUM(CASE WHEN vi.ledger_name ILIKE '%igst%' THEN vi.amount ELSE 0 END) as igst,
        SUM(vi.amount) as total_tax
      FROM voucher_items vi
      JOIN vouchers v ON v.guid = vi.voucher_guid AND v.company_guid = vi.company_guid
      WHERE vi.company_guid=$1
        AND (vi.ledger_name ILIKE '%cgst%' OR vi.ledger_name ILIKE '%sgst%' OR vi.ledger_name ILIKE '%igst%')
        AND v.is_cancelled = FALSE
        AND v.date BETWEEN $2 AND $3
    `, [companyGuid, from, to]);

    // Monthly GST trend
    const { rows: monthlyGst } = await query(`
      SELECT
        TO_CHAR(v.date::date, 'Mon') as month,
        EXTRACT(MONTH FROM v.date::date) as month_num,
        SUM(CASE WHEN vi.ledger_name ILIKE '%cgst%' THEN vi.amount ELSE 0 END) as cgst,
        SUM(CASE WHEN vi.ledger_name ILIKE '%sgst%' THEN vi.amount ELSE 0 END) as sgst,
        SUM(CASE WHEN vi.ledger_name ILIKE '%igst%' THEN vi.amount ELSE 0 END) as igst
      FROM voucher_items vi
      JOIN vouchers v ON v.guid = vi.voucher_guid AND v.company_guid = vi.company_guid
      WHERE vi.company_guid=$1
        AND (vi.ledger_name ILIKE '%cgst%' OR vi.ledger_name ILIKE '%sgst%' OR vi.ledger_name ILIKE '%igst%')
        AND v.is_cancelled = FALSE
        AND v.date BETWEEN $2 AND $3
        AND v.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(v.date::date, 'Mon'), EXTRACT(MONTH FROM v.date::date)
      ORDER BY month_num
    `, [companyGuid, from, to]);

    const g = gstRows[0] || {};
    res.json({
      status: true,
      data: {
        summary: {
          cgst:  parseFloat(g.cgst  || 0),
          sgst:  parseFloat(g.sgst  || 0),
          igst:  parseFloat(g.igst  || 0),
          total: parseFloat(g.total_tax || 0),
        },
        monthly: monthlyGst.map(r => ({
          month: r.month,
          cgst:  parseFloat(r.cgst || 0),
          sgst:  parseFloat(r.sgst || 0),
          igst:  parseFloat(r.igst || 0),
        })),
      },
    });
  } catch (err) {
    console.error('[gst-summary]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch GST data' });
  }
});

// ─── Alerts endpoint ─────────────────────────────────────────────────────────
// GET /alerts — real-time compliance + IRN + EWB alert counts for dashboard & sales screen
router.get('/alerts', authMiddleware, async (req, res) => {
  const { companyGuid, fy } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    // Use selectedFY from client — fall back to current real-world FY
    const { from, to } = await resolveFYDates(companyGuid, null, null, fy);

    const [
      pendingIRN, pendingEWB, expiredEWB,
      outstandingRec, creditNotes, unmatched,
      ewbGenerated, irnGenerated
    ] = await Promise.all([
      // Invoices needing IRN (≥₹50K sales, no IRN)
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%'
           AND amount >= 50000
           AND (irn IS NULL OR irn = '')
           AND (irn_cancelled IS NULL OR irn_cancelled = FALSE)
           AND is_cancelled = FALSE AND date BETWEEN $2 AND $3`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),

      // Invoices needing EWB (≥₹50K sales, no EWB)
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%'
           AND amount >= 50000
           AND (ewb_number IS NULL OR ewb_number = '')
           AND is_cancelled = FALSE AND date BETWEEN $2 AND $3`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),

      // Expired EWBs needing extension
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1 AND ewb_number IS NOT NULL AND ewb_number != ''
           AND ewb_valid_upto IS NOT NULL AND ewb_valid_upto < NOW()
           AND is_cancelled = FALSE`,
        [companyGuid]
      ).catch(() => ({ rows: [{ count: 0 }] })),

      // Outstanding receivables (overdue > 30 days)
      query(
        `SELECT COUNT(*) as count, COALESCE(SUM(ABS(closing_balance)),0) as amount
         FROM ledgers
         WHERE company_guid=$1 AND (parent ILIKE '%Sundry Debtor%' OR parent = 'Sundry Debtors')
           AND closing_balance > 0`,
        [companyGuid]
      ).catch(() => ({ rows: [{ count: 0, amount: 0 }] })),

      // Credit notes this FY
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1
           AND (voucher_type ILIKE '%Credit Note%' OR voucher_type ILIKE '%Debit Note%')
           AND is_cancelled = FALSE AND date BETWEEN $2 AND $3`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),

      // GST unmatched invoices: B2B sales (amount >= 10000) missing party GSTIN
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1
           AND voucher_type_parent = 'Sales'
           AND is_cancelled = FALSE AND date BETWEEN $2 AND $3
           AND amount >= 10000
           AND (party_gstin IS NULL OR party_gstin = '')`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),
      // EWB generated: vouchers with ewb_number populated
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1 AND is_cancelled=FALSE
           AND ewb_number IS NOT NULL AND ewb_number != ''
           AND date BETWEEN $2 AND $3`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),
      // IRN generated: vouchers with irn populated
      query(
        `SELECT COUNT(*) as count FROM vouchers
         WHERE company_guid=$1 AND is_cancelled=FALSE
           AND irn IS NOT NULL AND irn != '' AND irn_cancelled=FALSE
           AND date BETWEEN $2 AND $3`,
        [companyGuid, from, to]
      ).catch(() => ({ rows: [{ count: 0 }] })),
    ]);

    const irnCount        = parseInt(pendingIRN.rows[0]?.count  || 0);
    const ewbCount        = parseInt(pendingEWB.rows[0]?.count  || 0);
    const ewbExpired      = parseInt(expiredEWB.rows[0]?.count  || 0);
    const ewbGeneratedCnt = parseInt(ewbGenerated.rows[0]?.count || 0);
    const irnGeneratedCnt = parseInt(irnGenerated.rows[0]?.count || 0);
    const recCount     = parseInt(outstandingRec.rows[0]?.count || 0);
    const recAmount    = parseFloat(outstandingRec.rows[0]?.amount || 0);
    const cnCount      = parseInt(creditNotes.rows[0]?.count || 0);
    const unmatchedCnt = parseInt(unmatched.rows[0]?.count || 0);

    // GST filing percentage — months with at least 1 sales GST voucher in FY vs months elapsed
    // (proxy for active filing months since we don't have portal filing status)
    const gstFilingRows = await query(`
      SELECT COUNT(DISTINCT TO_CHAR(date::date, 'YYYY-MM')) as filed_months
      FROM vouchers
      WHERE company_guid=$1
        AND voucher_type_parent = 'Sales'
        AND is_cancelled = FALSE
        AND date BETWEEN $2 AND $3
    `, [companyGuid, from, to]).catch(() => ({ rows: [{ filed_months: 0 }] }));
    const now = new Date();
    const fyFrom = new Date(from);
    const monthsInFY  = 12;
    const monthsElapsed = Math.max(1, Math.min(
      Math.ceil((now - fyFrom) / (30 * 24 * 60 * 60 * 1000)), monthsInFY
    ));
    const filedMonths = parseInt(gstFilingRows.rows[0]?.filed_months || 0);
    const gstPercent  = Math.min(100, Math.round((filedMonths / monthsElapsed) * 100));
    const gstStatus   = gstPercent >= 100 ? 'Filed' : gstPercent > 0 ? 'Partial' : 'Pending';

    // Build alerts array (only show non-zero)
    const alerts = [
      irnCount > 0 && {
        id: 'irn_pending',
        type: 'irn',
        severity: 'warning',
        message: `${irnCount} invoice${irnCount > 1 ? 's' : ''} due for IRN generation`,
        action: 'generate_irn',
        count: irnCount,
      },
      ewbCount > 0 && {
        id: 'ewb_pending',
        type: 'ewb',
        severity: 'warning',
        message: `${ewbCount} invoice${ewbCount > 1 ? 's' : ''} need E-Way Bill`,
        action: 'generate_ewb',
        count: ewbCount,
      },
      ewbExpired > 0 && {
        id: 'ewb_expired',
        type: 'ewb',
        severity: 'error',
        message: `${ewbExpired} E-Way Bill${ewbExpired > 1 ? 's' : ''} expired`,
        action: 'extend_ewb',
        count: ewbExpired,
      },
      unmatchedCnt > 0 && {
        id: 'gst_unmatched',
        type: 'gst',
        severity: 'warning',
        message: `${unmatchedCnt} invoice${unmatchedCnt > 1 ? 's' : ''} have GST mismatch`,
        action: 'fix_gst',
        count: unmatchedCnt,
      },
    ].filter(Boolean);

    res.json({
      status: true,
      data: {
        pendingIRNCount:   irnCount,
        pendingEWBCount:   ewbCount,
        expiredEWBCount:   ewbExpired,
        ewbGeneratedCount: ewbGeneratedCnt,
        irnGeneratedCount: irnGeneratedCnt,
        outstandingCount:  recCount,
        outstandingAmount: recAmount,
        creditNotesCount:  cnCount,
        unmatchedGSTCount: unmatchedCnt,
        gstPercent, gstStatus, gstFiledMonths: filedMonths, gstTotalMonths: monthsElapsed,
        alerts,
        totalAlerts: alerts.length,
      },
    });
  } catch (err) {
    console.error('[alerts]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch alerts' });
  }
});


// ─── Reports Dashboard endpoint ───────────────────────────────────────────────
// GET /reports-dashboard — financial charts, GST %, audit count, AI forecast
router.get('/reports-dashboard', authMiddleware, async (req, res) => {
  const { companyGuid } = req.query;
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const now = new Date();
    const fyYear = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const from = `${fyYear}-04-01`;
    const to   = `${fyYear + 1}-03-31`;

    // Monthly revenue vs expenses (last 8 months) — for financial chart
    const { rows: monthlyFinancial } = await query(`
      SELECT
        TO_CHAR(date::date, 'Mon') as month,
        EXTRACT(MONTH FROM date::date) as month_num,
        SUM(CASE WHEN voucher_type ILIKE '%Sales%' THEN amount ELSE 0 END) as revenue,
        SUM(CASE WHEN voucher_type ILIKE '%Purchase%' OR voucher_type ILIKE '%Expense%' THEN amount ELSE 0 END) as expenses
      FROM vouchers
      WHERE company_guid=$1 AND is_cancelled=FALSE
        AND date BETWEEN $2 AND $3
        AND date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      GROUP BY TO_CHAR(date::date, 'Mon'), EXTRACT(MONTH FROM date::date)
      ORDER BY month_num
      LIMIT 8
    `, [companyGuid, from, to]).catch(() => ({ rows: [] }));

    // GST filing percentage — months filed vs total months in FY
    const { rows: gstRows } = await query(`
      SELECT COUNT(DISTINCT TO_CHAR(date::date, 'YYYY-MM')) as filed_months
      FROM vouchers
      WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%'
        AND (irn IS NOT NULL AND irn != '')
        AND date BETWEEN $2 AND $3
    `, [companyGuid, from, to]).catch(() => ({ rows: [{ filed_months: 0 }] }));

    // Total months elapsed in FY
    const monthsElapsed = Math.min(
      Math.ceil((now - new Date(`${fyYear}-04-01`)) / (30 * 24 * 60 * 60 * 1000)),
      12
    );
    const filedMonths = parseInt(gstRows[0]?.filed_months || 0);
    const gstPercent = monthsElapsed > 0 ? Math.round((filedMonths / monthsElapsed) * 100) : 0;

    // Audit trail — unreconciled vouchers (write_queue pending)
    const { rows: auditRows } = await query(`
      SELECT COUNT(*) as count FROM write_queue
      WHERE status IN ('pending', 'failed')
    `).catch(() => ({ rows: [{ count: 0 }] }));
    const auditCount = parseInt(auditRows[0]?.count || 0);

    // Weekly sales trend (last 8 weeks) — actual vs same period last year as "forecast"
    const { rows: weeklyRows } = await query(`
      SELECT
        EXTRACT(WEEK FROM date::date) as week_num,
        SUM(CASE WHEN date::date >= NOW() - INTERVAL '8 weeks' THEN amount ELSE 0 END) as actual,
        SUM(CASE WHEN date::date >= NOW() - INTERVAL '16 weeks' AND date::date < NOW() - INTERVAL '8 weeks' THEN amount ELSE 0 END) as forecast
      FROM vouchers
      WHERE company_guid=$1 AND voucher_type ILIKE '%Sales%' AND is_cancelled=FALSE
        AND date::date >= NOW() - INTERVAL '16 weeks'
      GROUP BY EXTRACT(WEEK FROM date::date)
      ORDER BY week_num
      LIMIT 8
    `, [companyGuid]).catch(() => ({ rows: [] }));

    // Pad to 8 data points
    const pad = (arr, field) => {
      const vals = arr.map(r => parseFloat(r[field] || 0));
      while (vals.length < 8) vals.unshift(0);
      return vals.slice(-8);
    };

    res.json({
      status: true,
      data: {
        // Financial chart — revenue vs expenses (8 months)
        financialChart: {
          labels: monthlyFinancial.map(r => r.month),
          revenue:  monthlyFinancial.map(r => parseFloat(r.revenue || 0)),
          expenses: monthlyFinancial.map(r => parseFloat(r.expenses || 0)),
        },
        // Compliance gauge
        gstPercent: Math.min(gstPercent, 100),
        gstFiledMonths: filedMonths,
        gstTotalMonths: monthsElapsed,
        // Audit trail pill
        auditCount,
        // AI insights — weekly actual vs "forecast" (prev period)
        aiChart: {
          labels: ['Wk1','Wk2','Wk3','Wk4','Wk5','Wk6','Wk7','Wk8'],
          actual:   pad(weeklyRows, 'actual'),
          forecast: pad(weeklyRows, 'forecast'),
        },
      },
    });
  } catch (err) {
    console.error('[reports-dashboard]', err.message);
    res.status(500).json({ status: false, message: 'Failed to fetch reports dashboard' });
  }
});

// ─── POST /reports/trial-balance ─────────────────────────────────────────────
router.post('/reports/trial-balance', authMiddleware, async (req, res) => {
  const { companyGuid, from, to } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const fyTo = to || (await (async () => {
      const { rows } = await query('SELECT end_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      return rows[0]?.end_date || `${new Date().getFullYear() + 1}-03-31`;
    })());
    const fyFrom = from || (await (async () => {
      const { rows } = await query('SELECT begin_date FROM company_years WHERE company_guid=$1 AND is_active=TRUE ORDER BY begin_date DESC LIMIT 1', [companyGuid]);
      return rows[0]?.begin_date || `${new Date().getFullYear()}-04-01`;
    })());

    // V2: Trial Balance uses financial_year column + ledger_fy_balances directly
    const tbFyYear = (() => { const y = parseInt(String(fyTo).slice(0, 4), 10); return new Date(fyTo).getMonth() < 3 ? `${y - 1}-${y}` : `${y}-${y + 1}`; })();
    const { rows: allLedgers } = await query(`
      SELECT l.name, l.parent, l.balance_type,
        CASE WHEN COALESCE(lfb.balance_type, l.balance_type, 'Dr') = 'Dr'
             THEN -ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
             ELSE  ABS(COALESCE(lfb.opening_balance, l.opening_balance, 0)::numeric)
        END
        + COALESCE((
            SELECT SUM(vle.amount)
            FROM voucher_ledger_entries vle
            WHERE vle.ledger_name = l.name AND vle.company_guid = l.company_guid
              AND vle.financial_year = $2
          ), 0) as fy_closing_signed
      FROM ledgers l
      LEFT JOIN ledger_fy_balances lfb
        ON lfb.company_guid = l.company_guid AND lfb.ledger_name = l.name AND lfb.financial_year = $2
      WHERE l.company_guid = $1
      ORDER BY l.parent, l.name
    `, [companyGuid, tbFyYear]);

    const rows = allLedgers
      .filter(l => parseFloat(l.fy_closing_signed || 0) !== 0)
      .map(l => {
        const signed = parseFloat(l.fy_closing_signed || 0);
        return {
          name: l.name,
          parent: l.parent,
          balance_type: signed <= 0 ? 'Dr' : 'Cr',
          closing_balance: Math.abs(signed),
          debit_amount:  signed < 0  ? Math.abs(signed) : 0,
          credit_amount: signed >= 0 ? Math.abs(signed) : 0,
        };
      });

    let totalDebit  = rows.reduce((s, r) => s + parseFloat(r.debit_amount  || 0), 0);
    let totalCredit = rows.reduce((s, r) => s + parseFloat(r.credit_amount || 0), 0);

    // Compute "Difference in Opening Balances" — mirrors what Tally shows to reconcile
    // any imbalance caused by incomplete/inconsistent LFB opening data.
    const { rows: lfbBalance } = await query(`
      SELECT
        SUM(CASE WHEN balance_type='Dr' THEN opening_balance::numeric ELSE -opening_balance::numeric END) as net_opening
      FROM ledger_fy_balances
      WHERE company_guid = $1 AND financial_year = $2
    `, [companyGuid, tbFyYear]);
    const netOpening = parseFloat(lfbBalance[0]?.net_opening || 0); // negative = Cr excess, positive = Dr excess
    const diffInOpening = Math.abs(netOpening);
    if (diffInOpening > 0.01) {
      const diffEntry = {
        name: 'Difference in Opening Balances',
        parent: 'Difference in Opening Balances',
        balance_type: netOpening < 0 ? 'Dr' : 'Cr',  // if Cr excess → show as Dr to balance
        closing_balance: diffInOpening,
        debit_amount:  netOpening < 0 ? diffInOpening : 0,
        credit_amount: netOpening >= 0 ? diffInOpening : 0,
      };
      rows.push(diffEntry);
      totalDebit  += diffEntry.debit_amount;
      totalCredit += diffEntry.credit_amount;
    }

    res.json({
      status: true,
      data: {
        ledgers: rows,
        from: fyFrom, to: fyTo,
        totals: { debit: totalDebit, credit: totalCredit },
        difference_in_opening: diffInOpening > 0.01 ? { amount: diffInOpening, type: netOpening < 0 ? 'Dr' : 'Cr' } : null,
      },
    });
  } catch (err) {
    console.error('[trial-balance]', err.message);
    res.status(500).json({ status: false, message: 'Failed' });
  }
});

// ─── POST /reports/bill-ageing ────────────────────────────────────────────────
router.post('/reports/bill-ageing', authMiddleware, async (req, res) => {
  const { companyGuid, ledgerGuid } = req.body || {};
  if (!companyGuid) return res.status(400).json({ status: false, message: 'companyGuid required' });
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const q = ledgerGuid
      ? `SELECT v.date, v.voucher_number, v.amount, v.party_name, v.voucher_type,
           CURRENT_DATE - v.date::date as days_overdue
         FROM vouchers v
         WHERE v.company_guid = $1
           AND v.party_guid = $2
           AND v.is_cancelled = FALSE
           AND v.voucher_type ILIKE '%Sales%'
           AND v.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         ORDER BY v.date ASC LIMIT 100`
      : `SELECT v.date, v.voucher_number, v.amount, v.party_name, v.voucher_type,
           CURRENT_DATE - v.date::date as days_overdue
         FROM vouchers v
         WHERE v.company_guid = $1
           AND v.is_cancelled = FALSE
           AND v.voucher_type ILIKE '%Sales%'
           AND v.date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         ORDER BY v.date ASC LIMIT 200`;

    const params = ledgerGuid ? [companyGuid, ledgerGuid] : [companyGuid];
    const { rows } = await query(q, params);

    const buckets = { current: [], days30: [], days60: [], days90: [], over90: [] };
    rows.forEach(r => {
      const d = parseInt(r.days_overdue || 0);
      if (d <= 0)       buckets.current.push(r);
      else if (d <= 30) buckets.days30.push(r);
      else if (d <= 60) buckets.days60.push(r);
      else if (d <= 90) buckets.days90.push(r);
      else              buckets.over90.push(r);
    });

    const sumBucket = b => b.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    res.json({
      status: true,
      data: {
        buckets,
        summary: {
          current: sumBucket(buckets.current),
          days30:  sumBucket(buckets.days30),
          days60:  sumBucket(buckets.days60),
          days90:  sumBucket(buckets.days90),
          over90:  sumBucket(buckets.over90),
          total:   rows.reduce((s, r) => s + parseFloat(r.amount || 0), 0),
        },
      },
    });
  } catch (err) {
    console.error('[bill-ageing]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// ── V2 Reports ───────────────────────────────────────────────────────────────────

// POST /reports/stock-valuation — V2 required report
// Returns: stock items with qty, rate, total value per warehouse
router.post('/reports/stock-valuation', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(`
      SELECT
        s.guid, s.name, s.unit, s.hsn, s.tax_rate,
        s.closing_qty  as qty,
        s.closing_rate as rate,
        s.closing_value as value,
        s.closing_qty * s.closing_rate as computed_value
      FROM stocks s
      WHERE s.company_guid = $1 AND s.closing_qty != 0
      ORDER BY (s.closing_qty * s.closing_rate) DESC
    `, [companyGuid]);
    const totalValue = rows.reduce((s, r) => s + parseFloat(r.computed_value || 0), 0);
    res.json({ status: true, data: { items: rows, total_value: totalValue, count: rows.length } });
  } catch (err) {
    console.error('[stock-valuation]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /reports/inventory-ageing — V2 required report
// Returns: stock items grouped by how long they've had no movement
router.post('/reports/inventory-ageing', authMiddleware, async (req, res) => {
  const { companyGuid, thresholdDays = 90 } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const { rows } = await query(`
      SELECT
        s.guid, s.name, s.unit,
        s.closing_qty  as qty,
        s.closing_rate as rate,
        s.closing_qty * s.closing_rate as value,
        MAX(st.date::date) as last_movement_date,
        CURRENT_DATE - MAX(st.date::date) as days_since_movement
      FROM stocks s
      LEFT JOIN stock_transactions st
        ON st.stock_guid = s.guid AND st.company_guid = s.company_guid
      WHERE s.company_guid = $1 AND s.closing_qty > 0
      GROUP BY s.guid, s.name, s.unit, s.closing_qty, s.closing_rate
      HAVING CURRENT_DATE - MAX(st.date::date) >= $2
         OR MAX(st.date::date) IS NULL
      ORDER BY days_since_movement DESC NULLS FIRST
    `, [companyGuid, parseInt(thresholdDays)]);
    res.json({ status: true, data: { items: rows, threshold_days: thresholdDays, count: rows.length } });
  } catch (err) {
    console.error('[inventory-ageing]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /reports/stock-movement — V2: Fast/Slow Moving Stock report
router.post('/reports/stock-movement', authMiddleware, async (req, res) => {
  const { companyGuid, from, to, topN = 20 } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const fromDate = from || `${new Date().getFullYear()}-04-01`;
    const toDate   = to   || new Date().toISOString().slice(0, 10);
    const { rows } = await query(`
      SELECT
        s.guid, s.name, s.unit,
        COALESCE(SUM(CASE WHEN st.type = 'inward'  THEN ABS(st.qty) ELSE 0 END), 0) as total_inward,
        COALESCE(SUM(CASE WHEN st.type = 'outward' THEN ABS(st.qty) ELSE 0 END), 0) as total_outward,
        COALESCE(COUNT(DISTINCT st.voucher_guid), 0) as transaction_count,
        s.closing_qty as current_qty
      FROM stocks s
      LEFT JOIN stock_transactions st
        ON st.stock_guid = s.guid AND st.company_guid = s.company_guid
        AND st.date BETWEEN $2 AND $3
      WHERE s.company_guid = $1
      GROUP BY s.guid, s.name, s.unit, s.closing_qty
      ORDER BY total_outward DESC
    `, [companyGuid, fromDate, toDate]);

    const fast = rows.slice(0, parseInt(topN));
    const slow = [...rows].sort((a, b) => parseFloat(a.total_outward) - parseFloat(b.total_outward)).slice(0, parseInt(topN));

    res.json({
      status: true,
      data: { fast_moving: fast, slow_moving: slow, from: fromDate, to: toDate }
    });
  } catch (err) {
    console.error('[stock-movement]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /reports/gst-summary — V2: GST report (GSTR-1 style summary)
router.post('/reports/gst-summary', authMiddleware, async (req, res) => {
  const { companyGuid, from, to } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const fromDate = from || `${new Date().getFullYear()}-04-01`;
    const toDate   = to   || new Date().toISOString().slice(0, 10);
    const { rows } = await query(`
      SELECT
        v.voucher_type,
        COUNT(*)                                               as count,
        COALESCE(SUM(g.taxable_amount), 0)                    as taxable_amount,
        COALESCE(SUM(g.cgst_amount),    0)                    as cgst,
        COALESCE(SUM(g.sgst_amount),    0)                    as sgst,
        COALESCE(SUM(g.igst_amount),    0)                    as igst,
        COALESCE(SUM(g.cgst_amount + g.sgst_amount + g.igst_amount), 0) as total_tax
      FROM gst_voucher_details g
      JOIN vouchers v ON v.guid = g.voucher_guid AND v.company_guid = g.company_guid
      WHERE g.company_guid = $1
        AND v.date BETWEEN $2 AND $3
        AND v.is_cancelled = FALSE
      GROUP BY v.voucher_type
      ORDER BY taxable_amount DESC
    `, [companyGuid, fromDate, toDate]);

    const totalTax = rows.reduce((s, r) => s + parseFloat(r.total_tax || 0), 0);
    const totalTaxable = rows.reduce((s, r) => s + parseFloat(r.taxable_amount || 0), 0);
    const cgstTotal = rows.reduce((s, r) => s + parseFloat(r.cgst || 0), 0);
    const sgstTotal = rows.reduce((s, r) => s + parseFloat(r.sgst || 0), 0);
    const igstTotal = rows.reduce((s, r) => s + parseFloat(r.igst || 0), 0);

    res.json({
      status: true,
      data: {
        from: fromDate, to: toDate,
        by_type: rows,
        summary: { taxable_amount: totalTaxable, cgst: cgstTotal, sgst: sgstTotal, igst: igstTotal, total_tax: totalTax },
      }
    });
  } catch (err) {
    console.error('[gst-summary]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

// POST /reports/stock-summary — V2: Stock Summary overview
router.post('/reports/stock-summary', authMiddleware, async (req, res) => {
  const { companyGuid } = req.body || {};
  if (!await verifyCompanyOwnership(req, res, companyGuid)) return;
  try {
    const [totals, byGroup] = await Promise.all([
      query(`SELECT COUNT(*) as total_items, SUM(closing_qty) as total_qty, SUM(closing_qty * closing_rate) as total_value,
                    SUM(CASE WHEN closing_qty <= reorder_level AND reorder_level > 0 THEN 1 ELSE 0 END) as low_stock_count
             FROM stocks WHERE company_guid = $1 AND closing_qty != 0`, [companyGuid]),
      query(`SELECT group_name, COUNT(*) as item_count, SUM(closing_qty * closing_rate) as value
             FROM stocks WHERE company_guid = $1 AND closing_qty != 0
             GROUP BY group_name ORDER BY value DESC LIMIT 10`, [companyGuid]),
    ]);
    res.json({
      status: true,
      data: {
        totals: totals.rows[0],
        by_group: byGroup.rows,
      }
    });
  } catch (err) {
    console.error('[stock-summary]', err.message);
    res.status(500).json({ status: false, message: err.message });
  }
});

export default router;
