/**
 * Full Demo Company seed for unpaired / demo workspaces.
 * Cloud-only sample data — never written into Tally XML.
 *
 * Fills dashboard KPI/graphs, cashflow, stocks, AR/AP, recent activity, cost analysis.
 */
import { query } from '../db/schema.js';

const now = () => Math.floor(Date.now() / 1000);

/** Stable-ish demo GUID derived from workspace (never a real Tally GUID). */
export function demoCompanyGuidForWorkspace(workspaceId) {
  const hex = String(workspaceId || '').replace(/-/g, '').slice(0, 12).padEnd(12, '0');
  return `dddddddd-dddd-4ddd-8ddd-${hex}`;
}

/** True for Demo Company rows (name or reserved GUID prefix). */
export function isDemoCompany(c) {
  if (!c) return false;
  const name = String(c.name || '').toLowerCase().trim();
  const guid = String(c.guid || c.id || '');
  return (
    name.startsWith('demo')
    || guid.startsWith('DEMO')
    || guid.startsWith('dddddddd-dddd-4ddd-8ddd-')
  );
}

/**
 * Paired (CONNECTED) → hide Demo Company (live books only).
 * Unpaired / reconnecting / unknown → Demo Company only (fail-closed).
 * Universal MD §8: real synced data stays stored but hidden from operational APIs/UI.
 */
export function filterCompaniesByPairingStatus(companies, pairingStatus) {
  const list = Array.isArray(companies) ? companies : [];
  const status = String(pairingStatus || '').toUpperCase();
  if (status === 'CONNECTED') return list.filter((c) => !isDemoCompany(c));
  // UNPAIRED | RECONNECTING | anything else → Demo only (never leak live books)
  return list.filter((c) => isDemoCompany(c));
}

function currentIndianFy(ref = new Date()) {
  const y = ref.getUTCFullYear();
  const m = ref.getUTCMonth() + 1;
  if (m >= 4) {
    return { finYear: `${y}-${y + 1}`, begin: `${y}-04-01`, end: `${y + 1}-03-31` };
  }
  return { finYear: `${y - 1}-${y}`, begin: `${y - 1}-04-01`, end: `${y}-03-31` };
}

function isoDate(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function clampIso(iso, begin, end) {
  if (iso < begin) return begin;
  if (iso > end) return end;
  return iso;
}

function gid(companyGuid, suffix) {
  return `${companyGuid}-${suffix}`;
}

async function upsertLedger(companyId, companyGuid, row, ts) {
  const {
    guid, name, parent, nature = null,
    opening = 0, closing = 0, balanceType = 'Dr',
    alias = null, gstin = null, mobile = null, phone = null,
    email = null, address = null, stateName = null, pincode = null,
    pan = null, bankAccountNo = null, bankIfsc = null, bankName = null,
  } = row;
  await query(
    `INSERT INTO ledgers
       (guid, company_guid, company_id, name, parent, nature, opening_balance, closing_balance, balance_type,
        alias, gstin, mobile, phone, email, address, state_name, pincode, pan,
        bank_account_no, bank_ifsc, bank_name, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (company_id, guid) DO UPDATE SET
       name = EXCLUDED.name, parent = EXCLUDED.parent, nature = EXCLUDED.nature,
       opening_balance = EXCLUDED.opening_balance, closing_balance = EXCLUDED.closing_balance,
       balance_type = EXCLUDED.balance_type, alias = EXCLUDED.alias, gstin = EXCLUDED.gstin,
       mobile = EXCLUDED.mobile, phone = EXCLUDED.phone, email = EXCLUDED.email,
       address = EXCLUDED.address, state_name = EXCLUDED.state_name, pincode = EXCLUDED.pincode,
       pan = EXCLUDED.pan, bank_account_no = EXCLUDED.bank_account_no,
       bank_ifsc = EXCLUDED.bank_ifsc, bank_name = EXCLUDED.bank_name, synced_at = EXCLUDED.synced_at`,
    [
      guid, companyGuid, companyId, name, parent, nature, opening, closing, balanceType,
      alias, gstin, mobile, phone, email, address, stateName, pincode, pan,
      bankAccountNo, bankIfsc, bankName, ts,
    ]
  );
}

async function clearDemoTransactions(companyId) {
  await query('DELETE FROM voucher_ledger_entries WHERE company_id = $1', [companyId]);
  await query('DELETE FROM voucher_inventory_items WHERE company_id = $1', [companyId]);
  await query('DELETE FROM stock_transactions WHERE company_id = $1', [companyId]);
  await query('DELETE FROM batch_allocations WHERE company_id = $1', [companyId]);
  await query('DELETE FROM bill_outstanding WHERE company_id = $1', [companyId]);
  await query('DELETE FROM vouchers WHERE company_id = $1', [companyId]);
  await query('DELETE FROM stock_fy_valuation WHERE company_id = $1', [companyId]);
  await query('DELETE FROM ledger_fy_balances WHERE company_id = $1', [companyId]);
  await query('DELETE FROM kpi_ar_ap_snapshots WHERE company_id = $1', [companyId]).catch(() => {});
  await query('DELETE FROM kpi_loans_snapshots WHERE company_id = $1', [companyId]).catch(() => {});
}

async function insertVoucher(companyId, companyGuid, v, ts, fy) {
  await query(
    `INSERT INTO vouchers
       (guid, company_guid, company_id, voucher_number, voucher_type, voucher_type_parent, date,
        party_name, party_guid, amount, narration, reference, is_cancelled, is_optional,
        synced_at, financial_year, party_gstin, place_of_supply, is_gst_relevant)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (company_id, guid) DO UPDATE SET
       voucher_number = EXCLUDED.voucher_number, voucher_type = EXCLUDED.voucher_type,
       date = EXCLUDED.date, party_name = EXCLUDED.party_name, party_guid = EXCLUDED.party_guid,
       amount = EXCLUDED.amount, narration = EXCLUDED.narration, financial_year = EXCLUDED.financial_year,
       synced_at = EXCLUDED.synced_at`,
    [
      v.guid, companyGuid, companyId, v.number, v.type, v.typeParent || v.type, v.date,
      v.partyName || null, v.partyGuid || null, v.amount, v.narration || null,
      v.reference || null, !!v.optional, ts, fy,
      v.partyGstin || null, v.pos || 'Karnataka', v.gst !== false,
    ]
  );
}

async function insertVle(companyId, companyGuid, voucherGuid, lines, fy) {
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    await query(
      `INSERT INTO voucher_ledger_entries
         (voucher_guid, company_guid, company_id, ledger_name, ledger_guid, amount, dr_cr, line_index, financial_year)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (company_id, voucher_guid, ledger_name, line_index) DO UPDATE SET
         amount = EXCLUDED.amount, ledger_guid = EXCLUDED.ledger_guid, dr_cr = EXCLUDED.dr_cr,
         financial_year = EXCLUDED.financial_year`,
      [voucherGuid, companyGuid, companyId, L.name, L.guid, L.amount, L.drCr, i, fy]
    );
  }
}

async function insertInvLine(companyId, companyGuid, voucherGuid, line, fy) {
  await query(
    `INSERT INTO voucher_inventory_items
       (voucher_guid, company_guid, company_id, stock_item_name, stock_item_guid, actual_qty, billed_qty,
        rate, amount, godown_name, batch_name, unit, hsn, tax_rate, financial_year)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (company_id, voucher_guid, stock_item_name, godown_name, batch_name) DO UPDATE SET
       actual_qty = EXCLUDED.actual_qty, billed_qty = EXCLUDED.billed_qty,
       rate = EXCLUDED.rate, amount = EXCLUDED.amount, financial_year = EXCLUDED.financial_year`,
    [
      voucherGuid, companyGuid, companyId, line.name, line.guid, line.qty, line.rate, line.amount,
      line.godown, line.batch, line.unit, line.hsn, line.taxRate, fy,
    ]
  );
}

async function insertStockTxn(companyId, companyGuid, row, ts, fy) {
  await query(
    `INSERT INTO stock_transactions
       (stock_guid, company_guid, company_id, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse, synced_at, financial_year)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (company_id, stock_guid, voucher_guid, warehouse, type) DO UPDATE SET
       qty = EXCLUDED.qty, rate = EXCLUDED.rate, value = EXCLUDED.value, date = EXCLUDED.date,
       financial_year = EXCLUDED.financial_year, synced_at = EXCLUDED.synced_at`,
    [
      row.stockName, companyGuid, companyId, row.voucherGuid, row.voucherType, row.date,
      Math.abs(row.qty), row.rate, Math.abs(row.value), row.type, row.warehouse, ts, fy,
    ]
  );
}

async function insertBatch(companyId, companyGuid, row, fy) {
  await query(
    `INSERT INTO batch_allocations
       (voucher_guid, company_guid, company_id, stock_item_name, stock_item_guid, batch_name,
        expiry_date, mfg_date, qty, rate, godown_name, financial_year)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (company_id, voucher_guid, stock_item_name, batch_name, godown_name) DO UPDATE SET
       qty = EXCLUDED.qty, rate = EXCLUDED.rate, expiry_date = EXCLUDED.expiry_date,
       mfg_date = EXCLUDED.mfg_date, financial_year = EXCLUDED.financial_year`,
    [
      row.voucherGuid, companyGuid, companyId, row.stockName, row.stockGuid, row.batch,
      row.expiry || null, row.mfg || null, row.qty, row.rate, row.godown, fy,
    ]
  );
}

/**
 * Full seed body — used by ensureDemoCompany and reseed scripts.
 */
export async function seedFullDemoCompany(userId, workspaceId, companyGuid) {
  const ts = now();
  const fy = currentIndianFy();
  const today = isoDate(new Date());
  const todayClamped = clampIso(today, fy.begin, fy.end);

  await query(
    `INSERT INTO companies
       (guid, workspace_id, name, formal_name, gstin, address, state, country, currency,
        fy_start, fy_end, is_active, synced_at, created_at, pincode, pan, phone, mobile, email, website,
        gst_taxpayer_type)
     VALUES ($1,$2,'Demo Company','Demo Company Pvt Ltd','29AABCD1234A1Z5',
             '42 MG Road, Indiranagar','Karnataka','India','INR',$3,$4,TRUE,$5,$5,
             '560038','AABCD1234A','08041234567','9024400000','demo@tallydekho.com','https://demo.tallydekho.com',
             'Regular')
     ON CONFLICT (workspace_id, guid) DO UPDATE SET
       name = 'Demo Company',
       formal_name = EXCLUDED.formal_name, gstin = EXCLUDED.gstin, address = EXCLUDED.address,
       state = EXCLUDED.state, fy_start = EXCLUDED.fy_start, fy_end = EXCLUDED.fy_end,
       is_active = TRUE, synced_at = EXCLUDED.synced_at, pincode = EXCLUDED.pincode,
       pan = EXCLUDED.pan, phone = EXCLUDED.phone, mobile = EXCLUDED.mobile,
       email = EXCLUDED.email, website = EXCLUDED.website`,
    [companyGuid, workspaceId, fy.begin, fy.end, ts]
  );

  const { rows: companyIdRows } = await query(
    'SELECT id FROM companies WHERE guid = $1 AND workspace_id = $2 LIMIT 1',
    [companyGuid, workspaceId]
  );
  const companyId = companyIdRows[0]?.id;
  if (!companyId) {
    throw new Error(`[demo] company_id missing after upsert for ${companyGuid}`);
  }

  await query(
    `INSERT INTO company_years (company_guid, company_id, fin_year, begin_date, end_date, is_active)
     VALUES ($1,$2,$3,$4,$5,TRUE)
     ON CONFLICT (company_id, fin_year) DO UPDATE SET
       begin_date = EXCLUDED.begin_date, end_date = EXCLUDED.end_date, is_active = TRUE`,
    [companyGuid, companyId, fy.finYear, fy.begin, fy.end]
  );

  // ── Groups ──────────────────────────────────────────────────────────────
  const groupDefs = [
    ['Primary', null, 'Assets'],
    ['Cash-in-Hand', 'Primary', 'Assets'],
    ['Bank Accounts', 'Primary', 'Assets'],
    ['Sundry Debtors', 'Primary', 'Assets'],
    ['Sundry Creditors', 'Primary', 'Liabilities'],
    ['Sales Accounts', 'Primary', 'Income'],
    ['Purchase Accounts', 'Primary', 'Expenses'],
    ['Direct Expenses', 'Primary', 'Expenses'],
    ['Indirect Expenses', 'Primary', 'Expenses'],
    ['Indirect Incomes', 'Primary', 'Income'],
    ['Duties & Taxes', 'Primary', 'Liabilities'],
    ['Secured Loans', 'Primary', 'Liabilities'],
    ['Bank OD Accounts', 'Primary', 'Liabilities'],
    ['Stock-in-Hand', 'Primary', 'Assets'],
  ];
  for (const [name, parent, nature] of groupDefs) {
    await query(
      `INSERT INTO groups (guid, company_guid, company_id, name, parent, nature, is_primary, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, guid) DO UPDATE SET
         parent = EXCLUDED.parent, nature = EXCLUDED.nature, synced_at = EXCLUDED.synced_at`,
      [gid(companyGuid, `grp-${name.replace(/\W+/g, '-').toLowerCase()}`), companyGuid, companyId, name, parent, nature, !parent, ts]
    );
  }

  // ── Units / warehouses / inventory settings ─────────────────────────────
  for (const [name, formal] of [['Nos', 'Numbers'], ['Kg', 'Kilograms'], ['Ltr', 'Litres'], ['Box', 'Boxes']]) {
    await query(
      `INSERT INTO units (guid, company_guid, company_id, name, formal_name, is_simple_unit, synced_at)
       VALUES ($1,$2,$3,$4,$5,TRUE,$6)
       ON CONFLICT (company_id, name) DO UPDATE SET formal_name = EXCLUDED.formal_name, synced_at = EXCLUDED.synced_at`,
      [gid(companyGuid, `u-${name.toLowerCase()}`), companyGuid, companyId, name, formal, ts]
    );
  }

  const warehouses = [
    { guid: gid(companyGuid, 'wh-main'), name: 'Main Godown', address: 'Indiranagar Warehouse' },
    { guid: gid(companyGuid, 'wh-shop'), name: 'Shop Floor', address: 'Retail Counter' },
  ];
  for (const w of warehouses) {
    await query(
      `INSERT INTO warehouses (guid, company_guid, company_id, name, parent, address, synced_at)
       VALUES ($1,$2,$3,$4,'Primary',$5,$6)
       ON CONFLICT (company_id, name) DO UPDATE SET address = EXCLUDED.address, synced_at = EXCLUDED.synced_at`,
      [w.guid, companyGuid, companyId, w.name, w.address, ts]
    );
  }

  await query(
    `INSERT INTO company_inventory_settings (company_guid, company_id, batch_tracking_app_enabled, expiry_tracking_app_enabled)
     VALUES ($1, $2, TRUE, TRUE)
     ON CONFLICT (company_id) DO UPDATE SET
       batch_tracking_app_enabled = TRUE, expiry_tracking_app_enabled = TRUE, updated_at = now()`,
    [companyGuid, companyId]
  ).catch(() => {});

  // ── Ledgers ─────────────────────────────────────────────────────────────
  const ledgers = {
    cash: {
      guid: gid(companyGuid, 'cash'), name: 'Cash', parent: 'Cash-in-Hand', nature: 'cash',
      opening: 45000, closing: 78500, balanceType: 'Dr',
    },
    bank: {
      guid: gid(companyGuid, 'bank'), name: 'HDFC Bank', parent: 'Bank Accounts', nature: 'bank',
      opening: 250000, closing: 312400, balanceType: 'Dr',
      bankAccountNo: '50200012345678', bankIfsc: 'HDFC0001234', bankName: 'HDFC Bank',
    },
    sales: { guid: gid(companyGuid, 'sales'), name: 'Sales', parent: 'Sales Accounts', nature: 'sales', opening: 0, closing: 0, balanceType: 'Cr' },
    purchase: { guid: gid(companyGuid, 'purchase'), name: 'Purchase', parent: 'Purchase Accounts', nature: 'purchase', opening: 0, closing: 0, balanceType: 'Dr' },
    abc: {
      guid: gid(companyGuid, 'abc'), name: 'abc', parent: 'Sundry Debtors', nature: 'party',
      opening: 0, closing: 48200, balanceType: 'Dr', mobile: '9876500001', gstin: '29AABCA1111A1Z1',
      address: 'abc Traders, Bengaluru', stateName: 'Karnataka', pincode: '560001',
    },
    xyz: {
      guid: gid(companyGuid, 'xyz'), name: 'xyz', parent: 'Sundry Creditors', nature: 'party',
      opening: 0, closing: 27500, balanceType: 'Cr', mobile: '9876500002', gstin: '29AABCX2222X1Z2',
      address: 'xyz Supplies, Bengaluru', stateName: 'Karnataka', pincode: '560002',
    },
    blueStar: {
      guid: gid(companyGuid, 'bluestar'), name: 'Blue Star Traders', parent: 'Sundry Debtors', nature: 'party',
      opening: 5000, closing: 35600, balanceType: 'Dr', mobile: '9876500003', gstin: '29AABCB3333B1Z3',
      stateName: 'Karnataka', pincode: '560003',
    },
    greenMart: {
      guid: gid(companyGuid, 'greenmart'), name: 'Green Mart', parent: 'Sundry Debtors', nature: 'party',
      opening: 0, closing: 22100, balanceType: 'Dr', mobile: '9876500004', stateName: 'Karnataka',
    },
    orangeCorp: {
      guid: gid(companyGuid, 'orangecorp'), name: 'Orange Corp', parent: 'Sundry Debtors', nature: 'party',
      opening: 0, closing: 18900, balanceType: 'Dr', mobile: '9876500005', stateName: 'Karnataka',
    },
    metroSupplies: {
      guid: gid(companyGuid, 'metro'), name: 'Metro Supplies', parent: 'Sundry Creditors', nature: 'party',
      opening: 8000, closing: 41200, balanceType: 'Cr', mobile: '9876500006', gstin: '29AABCM4444M1Z4',
      stateName: 'Karnataka',
    },
    cityWholesaler: {
      guid: gid(companyGuid, 'cityw'), name: 'City Wholesaler', parent: 'Sundry Creditors', nature: 'party',
      opening: 0, closing: 15800, balanceType: 'Cr', mobile: '9876500007', stateName: 'Karnataka',
    },
    cgst: { guid: gid(companyGuid, 'cgst'), name: 'CGST', parent: 'Duties & Taxes', nature: 'tax', opening: 0, closing: 0, balanceType: 'Cr' },
    sgst: { guid: gid(companyGuid, 'sgst'), name: 'SGST', parent: 'Duties & Taxes', nature: 'tax', opening: 0, closing: 0, balanceType: 'Cr' },
    rent: { guid: gid(companyGuid, 'rent'), name: 'Rent', parent: 'Indirect Expenses', nature: 'expense', opening: 0, closing: 0, balanceType: 'Dr' },
    salary: { guid: gid(companyGuid, 'salary'), name: 'Salary', parent: 'Indirect Expenses', nature: 'expense', opening: 0, closing: 0, balanceType: 'Dr' },
    freight: { guid: gid(companyGuid, 'freight'), name: 'Freight Charges', parent: 'Direct Expenses', nature: 'expense', opening: 0, closing: 0, balanceType: 'Dr' },
    power: { guid: gid(companyGuid, 'power'), name: 'Power & Fuel', parent: 'Indirect Expenses', nature: 'expense', opening: 0, closing: 0, balanceType: 'Dr' },
    office: { guid: gid(companyGuid, 'office'), name: 'Office Expenses', parent: 'Indirect Expenses', nature: 'expense', opening: 0, closing: 0, balanceType: 'Dr' },
    interestInc: { guid: gid(companyGuid, 'intinc'), name: 'Interest Income', parent: 'Indirect Incomes', nature: 'income', opening: 0, closing: 0, balanceType: 'Cr' },
    termLoan: {
      guid: gid(companyGuid, 'termloan'), name: 'HDFC Term Loan', parent: 'Secured Loans', nature: 'loan',
      opening: 500000, closing: 425000, balanceType: 'Cr',
    },
    bankOd: {
      guid: gid(companyGuid, 'bankod'), name: 'HDFC Bank OD', parent: 'Bank OD Accounts', nature: 'loan',
      opening: 100000, closing: 78500, balanceType: 'Cr',
    },
  };
  for (const row of Object.values(ledgers)) {
    await upsertLedger(companyId, companyGuid, row, ts);
    await query(
      `INSERT INTO ledger_fy_balances
         (ledger_guid, ledger_name, company_guid, company_id, financial_year, opening_balance, balance_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (company_id, ledger_name, financial_year) DO UPDATE SET
         opening_balance = EXCLUDED.opening_balance, balance_type = EXCLUDED.balance_type, ledger_guid = EXCLUDED.ledger_guid`,
      [row.guid, row.name, companyGuid, companyId, fy.finYear, row.opening, row.balanceType]
    );
  }

  // ── Stocks ──────────────────────────────────────────────────────────────
  const stockDefs = [
    { key: 'widget', name: 'Widget A', unit: 'Nos', hsn: '8479', rate: 250, openQty: 120, closeQty: 86, reorder: 40, cat: 'Finished Goods' },
    { key: 'gadget', name: 'Gadget B', unit: 'Nos', hsn: '8517', rate: 899, openQty: 60, closeQty: 41, reorder: 20, cat: 'Finished Goods' },
    { key: 'bolt', name: 'Bolt M8', unit: 'Nos', hsn: '7318', rate: 5, openQty: 5000, closeQty: 4200, reorder: 1000, cat: 'Raw Material' },
    { key: 'nut', name: 'Nut M8', unit: 'Nos', hsn: '7318', rate: 3.5, openQty: 5000, closeQty: 4300, reorder: 1000, cat: 'Raw Material' },
    { key: 'oil', name: 'Machine Oil 1L', unit: 'Ltr', hsn: '2710', rate: 180, openQty: 80, closeQty: 52, reorder: 25, cat: 'Consumables', batch: true, expiry: true },
    { key: 'paint', name: 'Enamel Paint 1L', unit: 'Ltr', hsn: '3208', rate: 320, openQty: 40, closeQty: 28, reorder: 15, cat: 'Consumables', batch: true, expiry: true },
    { key: 'cable', name: 'Power Cable 5m', unit: 'Nos', hsn: '8544', rate: 145, openQty: 200, closeQty: 155, reorder: 50, cat: 'Finished Goods' },
    { key: 'switch', name: 'Toggle Switch', unit: 'Nos', hsn: '8536', rate: 45, openQty: 300, closeQty: 210, reorder: 80, cat: 'Finished Goods' },
    { key: 'box', name: 'Carton Box', unit: 'Nos', hsn: '4819', rate: 22, openQty: 400, closeQty: 310, reorder: 100, cat: 'Packaging' },
    { key: 'tape', name: 'Packing Tape', unit: 'Nos', hsn: '3919', rate: 35, openQty: 150, closeQty: 95, reorder: 40, cat: 'Packaging' },
    { key: 'sensor', name: 'Temp Sensor', unit: 'Nos', hsn: '9025', rate: 520, openQty: 50, closeQty: 33, reorder: 15, cat: 'Finished Goods' },
    { key: 'relay', name: 'Relay 12V', unit: 'Nos', hsn: '8536', rate: 95, openQty: 180, closeQty: 140, reorder: 40, cat: 'Finished Goods' },
    { key: 'filter', name: 'Air Filter', unit: 'Nos', hsn: '8421', rate: 210, openQty: 70, closeQty: 48, reorder: 20, cat: 'Spare Parts' },
    { key: 'belt', name: 'Drive Belt', unit: 'Nos', hsn: '4010', rate: 175, openQty: 90, closeQty: 61, reorder: 25, cat: 'Spare Parts' },
    { key: 'grease', name: 'Industrial Grease', unit: 'Kg', hsn: '2710', rate: 240, openQty: 30, closeQty: 18, reorder: 10, cat: 'Consumables', batch: true, expiry: true },
    { key: 'lamp', name: 'LED Lamp 9W', unit: 'Nos', hsn: '8539', rate: 85, openQty: 220, closeQty: 175, reorder: 60, cat: 'Finished Goods' },
    { key: 'adapter', name: 'USB Adapter', unit: 'Nos', hsn: '8504', rate: 199, openQty: 100, closeQty: 72, reorder: 30, cat: 'Finished Goods' },
    { key: 'slow', name: 'Obsolete Bracket', unit: 'Nos', hsn: '7326', rate: 60, openQty: 40, closeQty: 38, reorder: 5, cat: 'Spare Parts' },
    { key: 'neg', name: 'Rush SKU', unit: 'Nos', hsn: '8479', rate: 400, openQty: 10, closeQty: -5, reorder: 20, cat: 'Finished Goods' },
    { key: 'kit', name: 'Service Kit', unit: 'Box', hsn: '8479', rate: 1250, openQty: 25, closeQty: 16, reorder: 8, cat: 'Finished Goods' },
  ];
  const stocks = {};
  for (const s of stockDefs) {
    const guid = gid(companyGuid, `stk-${s.key}`);
    stocks[s.key] = { ...s, guid };
    await query(
      `INSERT INTO stocks
         (guid, company_guid, company_id, name, alias, category, group_name, unit, hsn, tax_rate,
          opening_qty, opening_rate, closing_qty, closing_rate, closing_value, reorder_level,
          sku, description, batch_enabled, expiry_enabled, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Primary',$7,$8,18,$9,$10,$11,$10,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (company_id, guid) DO UPDATE SET
         name = EXCLUDED.name, closing_qty = EXCLUDED.closing_qty, closing_rate = EXCLUDED.closing_rate,
         closing_value = EXCLUDED.closing_value, reorder_level = EXCLUDED.reorder_level,
         batch_enabled = EXCLUDED.batch_enabled, expiry_enabled = EXCLUDED.expiry_enabled,
         synced_at = EXCLUDED.synced_at`,
      [
        guid, companyGuid, companyId, s.name, s.key.toUpperCase(), s.cat, s.unit, s.hsn,
        s.openQty, s.rate, s.closeQty, s.closeQty * s.rate, s.reorder,
        `SKU-${s.key.toUpperCase()}`, `Demo ${s.name}`, !!s.batch, !!s.expiry, ts,
      ]
    );
    await query(
      `INSERT INTO stock_fy_valuation
         (company_guid, company_id, financial_year, stock_name, stock_guid,
          opening_qty, opening_rate, opening_value, closing_qty, closing_rate, closing_value, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$7,$10,$11)
       ON CONFLICT (company_id, financial_year, stock_name) DO UPDATE SET
         opening_qty = EXCLUDED.opening_qty, closing_qty = EXCLUDED.closing_qty,
         closing_value = EXCLUDED.closing_value, synced_at = EXCLUDED.synced_at`,
      [
        companyGuid, companyId, fy.finYear, s.name, guid,
        s.openQty, s.rate, s.openQty * s.rate, s.closeQty, s.closeQty * s.rate, ts,
      ]
    );
  }

  await clearDemoTransactions(companyId);

  // Spread dates across FY up to today (no future vouchers) + denser recent window
  const dates = [];
  let cursor = fy.begin;
  while (cursor <= todayClamped && dates.length < 50) {
    dates.push(cursor);
    cursor = addDays(cursor, 7);
  }
  for (let i = 45; i >= 0; i -= 2) {
    const d = clampIso(addDays(todayClamped, -i), fy.begin, todayClamped);
    if (!dates.includes(d)) dates.push(d);
  }
  dates.sort();

  const debtors = [ledgers.abc, ledgers.blueStar, ledgers.greenMart, ledgers.orangeCorp];
  const creditors = [ledgers.xyz, ledgers.metroSupplies, ledgers.cityWholesaler];
  const sellable = ['widget', 'gadget', 'cable', 'switch', 'sensor', 'relay', 'lamp', 'adapter', 'kit', 'filter', 'belt'];
  const purchasable = ['bolt', 'nut', 'oil', 'paint', 'box', 'tape', 'grease', 'widget', 'gadget'];

  let salesN = 0;
  let purchN = 0;
  let rcptN = 0;
  let pmtN = 0;
  let expN = 0;
  let otherN = 0;

  const gstSplit = (taxable) => {
    const tax = Math.round(taxable * 0.18 * 100) / 100;
    const half = Math.round((tax / 2) * 100) / 100;
    return { taxable, cgst: half, sgst: tax - half, total: taxable + tax };
  };

  for (let di = 0; di < dates.length; di++) {
    const date = dates[di];
    const debtor = debtors[di % debtors.length];
    const creditor = creditors[di % creditors.length];
    const sk = stocks[sellable[di % sellable.length]];
    const pk = stocks[purchasable[di % purchasable.length]];
    const wh = warehouses[di % warehouses.length].name;
    const batch = sk.batch ? `B${String(di % 5 + 1).padStart(2, '0')}` : 'Primary Batch';
    const pBatch = pk.batch ? `P${String(di % 4 + 1).padStart(2, '0')}` : 'Primary Batch';

    // ── Sales ─────────────────────────────────────────────────────────────
    if (di % 2 === 0 || di > dates.length - 20) {
      salesN += 1;
      const qty = 2 + (di % 5);
      const taxable = qty * sk.rate;
      const g = gstSplit(taxable);
      const vGuid = gid(companyGuid, `v-sales-${String(salesN).padStart(3, '0')}`);
      await insertVoucher(companyId, companyGuid, {
        guid: vGuid, number: `DEMO-SI-${salesN}`, type: 'Sales', date,
        partyName: debtor.name, partyGuid: debtor.guid, amount: g.total,
        narration: `Demo sale of ${sk.name} to ${debtor.name}`, partyGstin: debtor.gstin || null,
      }, ts, fy.finYear);
      await insertVle(companyId, companyGuid, vGuid, [
        { name: debtor.name, guid: debtor.guid, amount: g.total, drCr: 'Dr' },
        { name: 'Sales', guid: ledgers.sales.guid, amount: g.taxable, drCr: 'Cr' },
        { name: 'CGST', guid: ledgers.cgst.guid, amount: g.cgst, drCr: 'Cr' },
        { name: 'SGST', guid: ledgers.sgst.guid, amount: g.sgst, drCr: 'Cr' },
      ], fy.finYear);
      await insertInvLine(companyId, companyGuid, vGuid, {
        name: sk.name, guid: sk.guid, qty, rate: sk.rate, amount: taxable,
        godown: wh, batch, unit: sk.unit, hsn: sk.hsn, taxRate: 18,
      }, fy.finYear);
      await insertStockTxn(companyId, companyGuid, {
        stockName: sk.name, voucherGuid: vGuid, voucherType: 'Sales', date,
        qty, rate: sk.rate, value: taxable, type: 'outward', warehouse: wh,
      }, ts, fy.finYear);
      await insertBatch(companyId, companyGuid, {
        voucherGuid: vGuid, stockName: sk.name, stockGuid: sk.guid, batch,
        qty: -qty, rate: sk.rate, godown: wh,
        mfg: addDays(date, -120),
        expiry: sk.expiry ? addDays(date, 60 + (di % 120)) : null,
      }, fy.finYear);
      await query(
        `INSERT INTO bill_outstanding
           (voucher_guid, company_guid, company_id, ledger_name, bill_name, bill_date, due_date, amount, pending_amount, bill_type, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DR',$10)`,
        [vGuid, companyGuid, companyId, debtor.name, `DEMO-SI-${salesN}`, date, addDays(date, 30), g.total, Math.round(g.total * 0.6 * 100) / 100, ts]
      );
    }

    // ── Purchase ──────────────────────────────────────────────────────────
    if (di % 3 === 0 || di > dates.length - 15) {
      purchN += 1;
      const qty = 5 + (di % 8);
      const taxable = qty * pk.rate;
      const g = gstSplit(taxable);
      const vGuid = gid(companyGuid, `v-purch-${String(purchN).padStart(3, '0')}`);
      await insertVoucher(companyId, companyGuid, {
        guid: vGuid, number: `DEMO-PI-${purchN}`, type: 'Purchase', date,
        partyName: creditor.name, partyGuid: creditor.guid, amount: g.total,
        narration: `Demo purchase of ${pk.name}`, partyGstin: creditor.gstin || null,
      }, ts, fy.finYear);
      await insertVle(companyId, companyGuid, vGuid, [
        { name: 'Purchase', guid: ledgers.purchase.guid, amount: g.taxable, drCr: 'Dr' },
        { name: 'CGST', guid: ledgers.cgst.guid, amount: g.cgst, drCr: 'Dr' },
        { name: 'SGST', guid: ledgers.sgst.guid, amount: g.sgst, drCr: 'Dr' },
        { name: creditor.name, guid: creditor.guid, amount: g.total, drCr: 'Cr' },
      ], fy.finYear);
      await insertInvLine(companyId, companyGuid, vGuid, {
        name: pk.name, guid: pk.guid, qty, rate: pk.rate, amount: taxable,
        godown: wh, batch: pBatch, unit: pk.unit, hsn: pk.hsn, taxRate: 18,
      }, fy.finYear);
      await insertStockTxn(companyId, companyGuid, {
        stockName: pk.name, voucherGuid: vGuid, voucherType: 'Purchase', date,
        qty, rate: pk.rate, value: taxable, type: 'inward', warehouse: wh,
      }, ts, fy.finYear);
      await insertBatch(companyId, companyGuid, {
        voucherGuid: vGuid, stockName: pk.name, stockGuid: pk.guid, batch: pBatch,
        qty, rate: pk.rate, godown: wh,
        mfg: addDays(date, -30),
        expiry: pk.expiry ? addDays(date, 90 + (di % 90)) : null,
      }, fy.finYear);
      await query(
        `INSERT INTO bill_outstanding
           (voucher_guid, company_guid, company_id, ledger_name, bill_name, bill_date, due_date, amount, pending_amount, bill_type, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'CR',$10)`,
        [vGuid, companyGuid, companyId, creditor.name, `DEMO-PI-${purchN}`, date, addDays(date, 21), g.total, Math.round(g.total * 0.5 * 100) / 100, ts]
      );
    }

    // ── Receipt ───────────────────────────────────────────────────────────
    if (di % 2 === 1) {
      rcptN += 1;
      const amount = 5000 + (di % 7) * 1500;
      const useCash = di % 4 === 1;
      const bankOrCash = useCash ? ledgers.cash : ledgers.bank;
      const vGuid = gid(companyGuid, `v-rcpt-${String(rcptN).padStart(3, '0')}`);
      await insertVoucher(companyId, companyGuid, {
        guid: vGuid, number: `DEMO-RCPT-${rcptN}`, type: 'Receipt', date,
        partyName: debtor.name, partyGuid: debtor.guid, amount,
        narration: `Receipt from ${debtor.name}`,
      }, ts, fy.finYear);
      await insertVle(companyId, companyGuid, vGuid, [
        { name: bankOrCash.name, guid: bankOrCash.guid, amount, drCr: 'Dr' },
        { name: debtor.name, guid: debtor.guid, amount, drCr: 'Cr' },
      ], fy.finYear);
    }

    // ── Payment ───────────────────────────────────────────────────────────
    if (di % 3 === 1) {
      pmtN += 1;
      const amount = 4000 + (di % 5) * 1200;
      const useCash = di % 5 === 0;
      const bankOrCash = useCash ? ledgers.cash : ledgers.bank;
      const vGuid = gid(companyGuid, `v-pmt-${String(pmtN).padStart(3, '0')}`);
      await insertVoucher(companyId, companyGuid, {
        guid: vGuid, number: `DEMO-PMT-${pmtN}`, type: 'Payment', date,
        partyName: creditor.name, partyGuid: creditor.guid, amount,
        narration: `Payment to ${creditor.name}`,
      }, ts, fy.finYear);
      await insertVle(companyId, companyGuid, vGuid, [
        { name: creditor.name, guid: creditor.guid, amount, drCr: 'Dr' },
        { name: bankOrCash.name, guid: bankOrCash.guid, amount, drCr: 'Cr' },
      ], fy.finYear);
    }

    // ── Expenses ──────────────────────────────────────────────────────────
    if (di % 4 === 0) {
      expN += 1;
      const expenseHeads = [ledgers.rent, ledgers.salary, ledgers.freight, ledgers.power, ledgers.office];
      const head = expenseHeads[di % expenseHeads.length];
      const amount = head === ledgers.salary ? 45000 : head === ledgers.rent ? 25000 : 2500 + (di % 6) * 400;
      const vGuid = gid(companyGuid, `v-exp-${String(expN).padStart(3, '0')}`);
      await insertVoucher(companyId, companyGuid, {
        guid: vGuid, number: `DEMO-EXP-${expN}`, type: 'Payment', typeParent: 'Payment', date,
        partyName: head.name, partyGuid: head.guid, amount,
        narration: `${head.name} for period`,
      }, ts, fy.finYear);
      await insertVle(companyId, companyGuid, vGuid, [
        { name: head.name, guid: head.guid, amount, drCr: 'Dr' },
        { name: ledgers.bank.name, guid: ledgers.bank.guid, amount, drCr: 'Cr' },
      ], fy.finYear);
    }
  }

  // Interest income (Journal)
  {
    otherN += 1;
    const amount = 3200;
    const date = clampIso(addDays(todayClamped, -10), fy.begin, fy.end);
    const vGuid = gid(companyGuid, 'v-jnl-001');
    await insertVoucher(companyId, companyGuid, {
      guid: vGuid, number: 'DEMO-JNL-1', type: 'Journal', date, amount,
      narration: 'Bank interest credited',
    }, ts, fy.finYear);
    await insertVle(companyId, companyGuid, vGuid, [
      { name: ledgers.bank.name, guid: ledgers.bank.guid, amount, drCr: 'Dr' },
      { name: ledgers.interestInc.name, guid: ledgers.interestInc.guid, amount, drCr: 'Cr' },
    ], fy.finYear);
  }

  // Contra cash ↔ bank
  {
    otherN += 1;
    const amount = 10000;
    const date = clampIso(addDays(todayClamped, -3), fy.begin, fy.end);
    const vGuid = gid(companyGuid, 'v-cntr-001');
    await insertVoucher(companyId, companyGuid, {
      guid: vGuid, number: 'DEMO-CNTR-1', type: 'Contra', date, amount,
      narration: 'Cash deposited to bank',
    }, ts, fy.finYear);
    await insertVle(companyId, companyGuid, vGuid, [
      { name: ledgers.bank.name, guid: ledgers.bank.guid, amount, drCr: 'Dr' },
      { name: ledgers.cash.name, guid: ledgers.cash.guid, amount, drCr: 'Cr' },
    ], fy.finYear);
  }

  // Sales Order / Purchase Order / Credit Note / Debit Note / Delivery Note
  const extras = [
    { key: 'so', type: 'Sales Order', party: ledgers.abc, amount: 23600, num: 'DEMO-SO-1' },
    { key: 'po', type: 'Purchase Order', party: ledgers.xyz, amount: 11800, num: 'DEMO-PO-1' },
    { key: 'cn', type: 'Credit Note', party: ledgers.blueStar, amount: 2360, num: 'DEMO-CN-1' },
    { key: 'dn', type: 'Debit Note', party: ledgers.metroSupplies, amount: 1770, num: 'DEMO-DN-1' },
    { key: 'del', type: 'Delivery Note', party: ledgers.greenMart, amount: 0, num: 'DEMO-DNY-1' },
  ];
  for (const ex of extras) {
    otherN += 1;
    const date = clampIso(addDays(todayClamped, -ex.key.length), fy.begin, fy.end);
    const vGuid = gid(companyGuid, `v-${ex.key}-001`);
    await insertVoucher(companyId, companyGuid, {
      guid: vGuid, number: ex.num, type: ex.type, date,
      partyName: ex.party.name, partyGuid: ex.party.guid, amount: ex.amount,
      narration: `Demo ${ex.type}`,
    }, ts, fy.finYear);
  }

  // Opening stock batches so godown qty > 0
  for (const s of Object.values(stocks)) {
    const openGuid = gid(companyGuid, `v-open-${s.key}`);
    await insertVoucher(companyId, companyGuid, {
      guid: openGuid, number: `DEMO-OB-${s.key.toUpperCase()}`, type: 'Stock Journal',
      date: fy.begin, amount: 0, narration: `Opening stock ${s.name}`,
    }, ts, fy.finYear);
    const mainQty = Math.max(0, Math.floor(s.openQty * 0.7));
    const shopQty = Math.max(0, s.openQty - mainQty);
    if (mainQty > 0) {
      await insertBatch(companyId, companyGuid, {
        voucherGuid: openGuid, stockName: s.name, stockGuid: s.guid,
        batch: s.batch ? 'OPEN-01' : 'Primary Batch',
        qty: mainQty, rate: s.rate, godown: 'Main Godown',
        mfg: addDays(fy.begin, -60),
        expiry: s.expiry ? addDays(fy.begin, 180) : null,
      }, fy.finYear);
      await insertStockTxn(companyId, companyGuid, {
        stockName: s.name, voucherGuid: openGuid, voucherType: 'Stock Journal',
        date: fy.begin, qty: mainQty, rate: s.rate, value: mainQty * s.rate,
        type: 'inward', warehouse: 'Main Godown',
      }, ts, fy.finYear);
    }
    if (shopQty > 0) {
      const openGuid2 = gid(companyGuid, `v-open2-${s.key}`);
      await insertVoucher(companyId, companyGuid, {
        guid: openGuid2, number: `DEMO-OB2-${s.key.toUpperCase()}`, type: 'Stock Journal',
        date: fy.begin, amount: 0, narration: `Opening shop stock ${s.name}`,
      }, ts, fy.finYear);
      await insertBatch(companyId, companyGuid, {
        voucherGuid: openGuid2, stockName: s.name, stockGuid: s.guid,
        batch: s.batch ? 'OPEN-02' : 'Primary Batch',
        qty: shopQty, rate: s.rate, godown: 'Shop Floor',
        mfg: addDays(fy.begin, -60),
        expiry: s.expiry ? addDays(fy.begin, 30) : null, // near expiry sample
      }, fy.finYear);
      await insertStockTxn(companyId, companyGuid, {
        stockName: s.name, voucherGuid: openGuid2, voucherType: 'Stock Journal',
        date: fy.begin, qty: shopQty, rate: s.rate, value: shopQty * s.rate,
        type: 'inward', warehouse: 'Shop Floor',
      }, ts, fy.finYear);
    }
  }

  // Explicit near/past expiry batches for expiry schedule UI
  {
    const oil = stocks.oil;
    const vGuid = gid(companyGuid, 'v-expbatch-001');
    const vGuid2 = gid(companyGuid, 'v-expbatch-002');
    await insertVoucher(companyId, companyGuid, {
      guid: vGuid, number: 'DEMO-BATCH-EXP', type: 'Stock Journal',
      date: todayClamped, amount: 0, narration: 'Expiry demo batches',
    }, ts, fy.finYear);
    await insertVoucher(companyId, companyGuid, {
      guid: vGuid2, number: 'DEMO-BATCH-SOON', type: 'Stock Journal',
      date: todayClamped, amount: 0, narration: 'Near-expiry demo batch',
    }, ts, fy.finYear);
    await insertBatch(companyId, companyGuid, {
      voucherGuid: vGuid, stockName: oil.name, stockGuid: oil.guid, batch: 'EXP-PAST',
      qty: 4, rate: oil.rate, godown: 'Main Godown',
      mfg: addDays(todayClamped, -200), expiry: addDays(todayClamped, -5),
    }, fy.finYear);
    await insertBatch(companyId, companyGuid, {
      voucherGuid: vGuid2, stockName: oil.name, stockGuid: oil.guid, batch: 'EXP-SOON',
      qty: 6, rate: oil.rate, godown: 'Shop Floor',
      mfg: addDays(todayClamped, -100), expiry: addDays(todayClamped, 12),
    }, fy.finYear);
  }

  // KPI snapshots for trend pills
  const asOfs = [0, 7, 14, 30].map((n) => clampIso(addDays(todayClamped, -n), fy.begin, fy.end));
  for (const asOf of asOfs) {
    const i = asOfs.indexOf(asOf);
    await query(
      `INSERT INTO kpi_ar_ap_snapshots (company_id, company_guid, side, as_of, total, aging)
       VALUES ($1,$2,'AR',$3,$4,$5::jsonb)
       ON CONFLICT (company_id, side, as_of) DO UPDATE SET total = EXCLUDED.total, aging = EXCLUDED.aging`,
      [companyId, companyGuid, asOf, 124800 - i * 4000, JSON.stringify({ '0-30': 50000, '31-60': 40000, '61-90': 20000, '90+': 14800 })]
    ).catch(() => {});
    await query(
      `INSERT INTO kpi_ar_ap_snapshots (company_id, company_guid, side, as_of, total, aging)
       VALUES ($1,$2,'AP',$3,$4,$5::jsonb)
       ON CONFLICT (company_id, side, as_of) DO UPDATE SET total = EXCLUDED.total, aging = EXCLUDED.aging`,
      [companyId, companyGuid, asOf, 84500 - i * 2000, JSON.stringify({ '0-30': 30000, '31-60': 28000, '61-90': 15000, '90+': 11500 })]
    ).catch(() => {});
    await query(
      `INSERT INTO kpi_loans_snapshots (company_id, company_guid, as_of, total, loan_total, od_total)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (company_id, as_of) DO UPDATE SET
         total = EXCLUDED.total, loan_total = EXCLUDED.loan_total, od_total = EXCLUDED.od_total`,
      [companyId, companyGuid, asOf, 503500, 425000, 78500]
    ).catch(() => {});
  }

  console.log(
    `[demo] full seed ${companyGuid} ws=${workspaceId}: sales=${salesN} purch=${purchN} rcpt=${rcptN} pmt=${pmtN} exp=${expN} stocks=${stockDefs.length}`
  );
  return { guid: companyGuid, name: 'Demo Company', counts: { salesN, purchN, rcptN, pmtN, expN, stocks: stockDefs.length } };
}

/**
 * Ensures workspace has an active Demo Company with full sample data.
 * - Unpaired: create + full seed (once — skip if vouchers already present)
 * - Connected: refresh existing Demo Company only when force=true
 * - force: always reseed (reset / ops)
 */
export async function ensureDemoCompany(userId, workspaceId, { force = false } = {}) {
  if (!userId || !workspaceId) return null;
  // RBAC / unit harnesses set SKIP_DEMO_SEED to avoid multi-minute reseeds
  // of accumulated local unpaired workspaces during initSchema backfill.
  if (process.env.SKIP_DEMO_SEED === '1' && !force) return null;

  const { rows: wsRows } = await query(
    `SELECT id, tally_connection FROM workspaces WHERE id = $1 LIMIT 1`,
    [workspaceId]
  );
  const ws = wsRows[0];
  if (!ws) return null;

  const { rows: demoRows } = await query(
    `SELECT guid, name FROM companies
     WHERE workspace_id = $1 AND (name ILIKE 'Demo%' OR guid LIKE 'dddddddd%')
     ORDER BY CASE WHEN is_active THEN 0 ELSE 1 END, name ASC
     LIMIT 1`,
    [workspaceId]
  );

  if (ws.tally_connection === 'CONNECTED' && !demoRows[0] && !force) {
    // Connected workspace with no demo row — don't invent one next to live books
    return null;
  }

  const companyGuid = demoRows[0]?.guid || demoCompanyGuidForWorkspace(workspaceId);

  // Already seeded → keep data (avoids wipe/race that blanks home KPI cards)
  if (demoRows[0] && !force) {
    const { rows: cnt } = await query(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1`,
      [demoRows[0].id]
    );
    if ((cnt[0]?.n || 0) > 0) {
      await query(
        `UPDATE companies SET is_active = TRUE, synced_at = $2 WHERE id = $1`,
        [demoRows[0].id, now()]
      ).catch(() => {});
      return { guid: companyGuid, name: 'Demo Company', skipped: true };
    }
  }

  return seedFullDemoCompany(userId, workspaceId, companyGuid);
}

/** Reseed every Demo Company in the DB (ops / founder refresh). */
export async function reseedAllDemoCompanies() {
  const { rows } = await query(
    `SELECT guid, workspace_id, name FROM companies
     WHERE name ILIKE 'Demo%' OR guid LIKE 'dddddddd%'
     ORDER BY created_at NULLS LAST`
  );
  const out = [];
  for (const c of rows) {
    if (!c.workspace_id) continue;
    try {
      const r = await seedFullDemoCompany(null, c.workspace_id, c.guid);
      out.push({ guid: c.guid, ok: true, counts: r?.counts });
    } catch (e) {
      console.error('[demo] reseed failed', c.guid, e.message);
      out.push({ guid: c.guid, ok: false, error: e.message });
    }
  }
  return out;
}
