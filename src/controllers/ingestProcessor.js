// Ingest processor — PostgreSQL version
// Handles: masters (ledgers, stocks), vouchers, stock transactions
import { getClient, query as dbQuery } from '../db/schema.js';

// Normalize Tally date: '20240401' → '2024-04-01'
// Recursively search an object (parsing JSON strings) for any of the target keys
// Returns the found array or empty array if not found
// Recursively search an object (parsing JSON strings) for any of the target array keys
function findNestedArray(obj, keys, depth = 0) {
  if (!obj || depth > 8) return [];
  // If obj is an array, search inside each element
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findNestedArray(item, keys, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }
  if (typeof obj !== 'object') return [];
  // Check if this object has any of the target keys
  for (const k of keys) {
    if (obj[k] !== undefined) {
      const v = obj[k];
      return Array.isArray(v) ? v : (v ? [v] : []);
    }
  }
  // Recurse into values (including JSON strings)
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
      try {
        const parsed = JSON.parse(val);
        const found = findNestedArray(parsed, keys, depth + 1);
        if (found.length > 0) return found;
      } catch {}
    } else if (val && typeof val === 'object') {
      const found = findNestedArray(val, keys, depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

// Extract name from Tally record — handles both plain NAME and LANGUAGENAME.LIST multi-lang wrapper
function tallyName(r) {
  if (r.NAME) return r.NAME;
  if (r.Name) return r.Name;
  if (r.name) return r.name;
  if (r.LEDGERNAME) return r.LEDGERNAME;
  const ll = r['LANGUAGENAME.LIST'];
  if (ll) {
    const nl = Array.isArray(ll) ? ll[0]?.['NAME.LIST'] : ll['NAME.LIST'];
    if (nl) return Array.isArray(nl) ? nl[0]?.NAME || nl[0] : nl.NAME || nl;
  }
  return '';
}

function normalizeDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (s.includes('\xf1') || s === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
  return null;
}

const now = () => Math.floor(Date.now() / 1000);

export async function processIngestedData(streamName, data, companyGuid, userId, deviceId) {
  if (!data?.length || !companyGuid) return;

  const stream = streamName?.toLowerCase();
  const sample = data[0];
  const collectionName = sample?.COLLECTION_NAME?.toLowerCase() || '';

  if (stream === 'vouchers' || stream === 'voucher') {
    await processVouchers(data, companyGuid);
  } else if (stream === 'master' || stream === 'masters') {
    // Master stream contains mixed XML types — group by XML field and route each group properly
    const byXml = {};
    for (const r of data) {
      const xml = r.XML || r.xml || '__unknown__';
      if (!byXml[xml]) byXml[xml] = [];
      byXml[xml].push(r);
    }
    for (const [xml, records] of Object.entries(byXml)) {
      if (records.length === 0) continue;
      const s = records[0];
      const cName = s?.COLLECTION_NAME?.toLowerCase() || '';
      if (xml === 'LedgerFull.xml' || xml === 'FullLedger.xml') {
        await processFullLedger(records, companyGuid);
      } else if (xml === 'StockItemFull.xml' || cName === 'stockitem' || cName === 'stock item' || s?.BASEUNITS) {
        await processStocks(records, companyGuid);
      } else if (cName === 'stocktransaction' || cName === 'stock transaction') {
        await processStockTransactions(records, companyGuid);
      } else if (xml === 'StockGroupFull.xml') {
        await processStockGroups(records, companyGuid);
      } else if (xml === 'GroupMaster.xml') {
        await processGroupMasters(records, companyGuid);
      } else if (xml === 'UnitFull.xml') {
        await processUnits(records, companyGuid);
      } else if (xml === 'VoucherTypeFull.xml') {
        await processVoucherTypes(records, companyGuid);
      } else if (xml === 'BillOutstanding.xml') {
        await processBillOutstanding(records, companyGuid);
      } else if (xml === 'Godown.xml') {
        await processWarehouses(records, companyGuid);
      } else if (xml === 'CurrencyMaster.xml') {
        await processCurrencies(records, companyGuid);
      } else if (xml === 'StockOpeningBalance.xml') {
        await processStockOpeningBalance(records, companyGuid);
      } else {
        await processMasters(records, companyGuid);
      }
    }
  } else if (stream === 'records') {
    await processRecords(data, companyGuid, userId, deviceId);
  } else {
    // Auto-detect
    if (sample?.VOUCHERTYPENAME || sample?.VoucherTypeName || sample?.VOUCHERNUMBER || sample?.F02) {
      await processVouchers(data, companyGuid);
    } else if (sample?.COLLECTION_NAME === 'StockItem' || sample?.BASEUNITS) {
      await processStocks(data, companyGuid);
    } else if (sample?.GUID && (sample?.PARENT !== undefined || sample?.NAME)) {
      await processMasters(data, companyGuid);
    }
  }
}

async function processMasters(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;

    for (const r of data) {
      const name = r.NAME || r.name || r.LEDGERNAME || '';
      const guid = r.GUID || r.guid || name + '_' + companyGuid;
      const parent = r.PARENT || r.parent || '';
      if (!name || name.length === 0) continue;
      if (r.BASEUNITS || r.UNIT || r.COLLECTION_NAME === 'StockItem') continue;
      // Skip LedgerTransaction records — they have LedgerName not NAME
      if (r.LedgerName && !r.NAME) continue;
      // Skip records that look like voucher line items (have Amount but no parent group)
      if (r.Amount !== undefined && !r.PARENT && !r.parent && r.LedgerName) continue;

      const bal = r.CLOSINGBALANCE || r.OPENINGBALANCE || '0';
      const balStr = String(bal);
      const balNum = parseFloat(balStr.replace(/[^0-9.-]/g, '')) || 0;
      const balType = balStr.includes('Cr') ? 'Cr' : 'Dr';

      try {
        await client.query(`
          INSERT INTO ledgers (guid, company_guid, name, parent, alias, gstin, pan, phone, email, address, opening_balance, closing_balance, balance_type, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, alias=EXCLUDED.alias,
            gstin=EXCLUDED.gstin, pan=EXCLUDED.pan, phone=EXCLUDED.phone,
            email=EXCLUDED.email, address=EXCLUDED.address,
            opening_balance=EXCLUDED.opening_balance, closing_balance=EXCLUDED.closing_balance,
            balance_type=EXCLUDED.balance_type, alter_id=EXCLUDED.alter_id,
            synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name, parent,
          r.ALIAS || r.LANGUAGENAME2 || null,
          r.GSTIN || r.PARTYGSTIN || null,
          r.PAN || r.INCOMETAXNUMBER || null,
          r.LEDPHONE || r.PHONE || null,
          r.EMAIL || null,
          r.ADDRESS || null,
          parseFloat(String(r.OPENINGBALANCE || '0').replace(/[^0-9.-]/g, '')) || 0,
          Math.abs(balNum), balType,
          parseInt(r.AlterId || r.ALTERID || 0),
          now(),
        ]);
        saved++;
      } catch (e) {
        console.warn('[DB] Ledger insert failed:', e.message);
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Masters: saved ${saved}/${data.length} ledgers for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Masters transaction failed:', e.message);
  } finally {
    client.release();
  }
}

async function processStocks(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;

    // StockItemFull.xml — same nested pattern. Search for STOCKITEM[].
    let expandedStockData = data;
    if (data.length <= 3) {
      const found = findNestedArray(data[0], ['STOCKITEM', 'StockItem', 'STOCKITEMREPORT']);
      if (found.length > 0) {
        expandedStockData = found;
        console.log('[INGEST] Stocks expanded:', expandedStockData.length, 'items');
      }
    }
    for (const rawItem of expandedStockData) {
      let r = rawItem;
      const stockVal = rawItem.STOCKITEM ?? rawItem.StockItem;
      if (stockVal) {
        try { r = typeof stockVal === 'string' ? JSON.parse(stockVal) : stockVal; } catch { r = rawItem; }
      }
      const name = tallyName(r);
      const guid = r.GUID || r.Guid || r.guid || name + '_' + companyGuid;
      if (!name) continue;

      try {
        await client.query(`
          INSERT INTO stocks (guid, company_guid, name, alias, category, group_name, unit, hsn, tax_rate, closing_qty, closing_rate, closing_value, reorder_level, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, alias=EXCLUDED.alias, category=EXCLUDED.category,
            group_name=EXCLUDED.group_name, unit=EXCLUDED.unit, hsn=EXCLUDED.hsn,
            tax_rate=EXCLUDED.tax_rate, closing_qty=EXCLUDED.closing_qty,
            closing_rate=EXCLUDED.closing_rate, closing_value=EXCLUDED.closing_value,
            reorder_level=EXCLUDED.reorder_level, alter_id=EXCLUDED.alter_id,
            synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name,
          r.OnlyAlias || r.ALIAS || null,
          r.Category || r.CATEGORY || r.STOCKCATEGORY || null,
          r.Parent || r.PARENT || r.GROUP || null,
          r.BaseUnits || r.BASEUNITS || r.UNIT || r.unit || 'Pcs',
          r.Hsncode || r.HSNDETAILS?.[0]?.HSNCODE || r.HSN || null,
          parseFloat(r.IGSTRate || r.GSTRATE || r.TAXRATE || 18),
          // closing_qty/rate/value will be recomputed from StockTransaction stream after processing
          // Store 0 here; transactions will update it correctly
          0, // closing_qty — will be set by stock transaction recompute
          0, // closing_rate
          0, // closing_value
          parseTallyQty(r.REORDERLEVEL || 0),
          parseInt(r.ALTERID || r.AlterId || 0),
          now(),
        ]);
        saved++;
      } catch (e) {
        console.warn('[DB] Stock insert failed:', e.message);
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Stocks: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Stocks transaction failed:', e.message);
  } finally {
    client.release();
  }
}

async function processVouchers(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;

    for (const r of data) {
      const guid = r.GUID || r.Guid || r.guid || '';
      if (!guid) continue;

      const voucherNumber = r.VoucherNumber || r.VOUCHERNUMBER || (r.F02 !== undefined ? String(r.F02) : null) || null;
      // VoucherType is the field name in AllVoucher.xml; VoucherTypeName in SimplifiedVoucher / Voucher.xml
      const voucherType   = r.VoucherTypeName || r.VOUCHERTYPENAME || r.VoucherType || r.voucherType || 'Voucher';
      const date          = normalizeDate(r.Date || r.DATE || r.date);
      const isCancelled   = (r.ISCANCELLED === 'Yes' || r.IsCancelled === 'Yes' || r.ISCANCELLED === true);
      const partyGuid     = r.PARTYLEDGERGUID || r.PARTYGUIDS || r.PartyGuid || r.partyGuid || null;

      // Calculate amount from ledger entries (positive = debit side)
      const ledgerEntries = r.ALLLEDGERENTRIES || r.AllLedgerEntries || r.AllLedgerentries || [];
      let amount = parseFloat(r.Amount || r.AMOUNT || r.amount || 0);
      if (amount === 0 && Array.isArray(ledgerEntries) && ledgerEntries.length > 0) {
        // Sum positive (Dr) entries as the voucher amount
        const drSum = ledgerEntries
          .filter(e => e.ISDEEMEDPOSITIVE === 'Yes' || e.IsDeemedPositive === 'Yes')
          .reduce((s, e) => s + Math.abs(parseFloat(e.AMOUNT || e.Amount || 0)), 0);
        amount = drSum || ledgerEntries
          .reduce((s, e) => s + Math.abs(parseFloat(e.AMOUNT || e.Amount || 0)), 0) / 2;
      }

      try {
        await client.query(`
          INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, date, party_name, party_guid, amount, narration, reference, is_cancelled, alter_id, raw_data, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            -- COALESCE: never overwrite real data with null (prevents SimplifiedVoucher stubs from wiping AllVoucher.xml data)
            voucher_number = COALESCE(EXCLUDED.voucher_number, vouchers.voucher_number),
            voucher_type   = CASE WHEN EXCLUDED.voucher_type = 'Voucher' THEN COALESCE(vouchers.voucher_type, 'Voucher') ELSE EXCLUDED.voucher_type END,
            date           = COALESCE(EXCLUDED.date, vouchers.date),
            party_name     = COALESCE(EXCLUDED.party_name, vouchers.party_name),
            party_guid     = COALESCE(EXCLUDED.party_guid, vouchers.party_guid),
            amount         = CASE WHEN EXCLUDED.amount = 0 AND vouchers.amount != 0 THEN vouchers.amount ELSE EXCLUDED.amount END,
            narration      = COALESCE(EXCLUDED.narration, vouchers.narration),
            reference      = COALESCE(EXCLUDED.reference, vouchers.reference),
            is_cancelled   = EXCLUDED.is_cancelled,
            alter_id       = GREATEST(EXCLUDED.alter_id, vouchers.alter_id),
            raw_data       = CASE WHEN EXCLUDED.raw_data IS NULL OR EXCLUDED.raw_data = 'null' THEN vouchers.raw_data ELSE EXCLUDED.raw_data END,
            synced_at      = EXCLUDED.synced_at
        `, [
          guid, companyGuid, voucherNumber, voucherType, date,
          // PartyName is the field in AllVoucher.xml; PartyLedgerName in Voucher.xml
          r.PartyName || r.PartyLedgerName || r.PARTYLEDGERNAME || r.PARTYNAME || r.partyName || null,
          partyGuid,
          amount,
          r.Narration || r.NARRATION || r.narration || null,
          r.Reference || r.REFERENCE || r.reference || null,
          isCancelled,
          parseInt(r.AlterId || r.ALTERID || 0),
          JSON.stringify(r).slice(0, 10000),
          now(),
        ]);
        saved++;

        // Ledger line items — use parseLedgerEntries with correct Dr/Cr from amount sign
        const parsedLedgerEntries = parseLedgerEntries(r);
        if (parsedLedgerEntries.length > 0) {
          await saveLedgerEntries(client, guid, companyGuid, parsedLedgerEntries);
          }
        }

        // Inventory line items
        const inventoryEntries = r.ALLINVENTORYENTRIES || r.AllInventoryEntries || [];
        if (Array.isArray(inventoryEntries)) {
          // Clear existing inventory items before re-inserting
          await client.query('DELETE FROM voucher_items WHERE voucher_guid = $1 AND company_guid = $2 AND item_name IS NOT NULL', [guid, companyGuid]);
          for (const entry of inventoryEntries) {
            try {
              await client.query(`
                INSERT INTO voucher_items (voucher_guid, company_guid, amount, type, item_name, qty, unit, rate, tax_rate, hsn)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
              `, [
                guid, companyGuid,
                parseFloat(entry.AMOUNT || entry.Amount || 0),
                (entry.ISDEEMEDPOSITIVE === 'Yes') ? 'Dr' : 'Cr',
                entry.STOCKITEMNAME || entry.StockItemName || null,
                parseFloat(entry.ACTUALQTY || entry.ActualQty || 0),
                entry.UNIT || entry.BaseUnits || null,
                parseFloat(entry.RATE || entry.Rate || 0),
                parseFloat(entry.GSTRATE || entry.GstRate || 0),
                entry.HSNCODE || entry.HsnCode || null,
              ]);
            } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
          }
        }
      } catch (e) {
        console.warn('[DB] Voucher insert failed:', e.message, '| guid:', guid);
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Vouchers: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Vouchers transaction failed:', e.message);
  } finally {
    client.release();
  }
}

async function processStockTransactions(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;

    for (const r of data) {
      // StockTransaction.xml: Tally sends ALL keys uppercase
      const stockName = r.STOCKITEMNAME || r.StockItemName || r.stockGuid || '';
      if (!stockName) continue;
      // parseTallyQty handles '(-)20', '-20', '20 nos' formats
      const rawQty = parseTallyQty(r.ACTUALQTY || r.ActualQty || r.qty || '0');
      const qty    = isNaN(rawQty) ? 0 : rawQty;
      const rawAmt = parseFloat(r.AMOUNT ?? r.Amount ?? r.value ?? 0);
      const amount = isNaN(rawAmt) ? 0 : rawAmt;
      // Determine direction: negative qty = outward (sales/issue), positive = inward (purchase/receipt)
      // Also check VOUCHERTYPENAME for explicit direction
      const vtype = (r.VOUCHERTYPENAME || r.VoucherTypeName || '').toLowerCase();
      const isOutward = qty < 0 || vtype.includes('sales') || vtype.includes('issue') || vtype.includes('delivery');
      const type = isOutward ? 'outward' : 'inward';

      try {
        await client.query(`
          INSERT INTO stock_transactions (stock_guid, company_guid, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (stock_guid, company_guid, voucher_guid, warehouse, type) DO NOTHING
        `, [
          stockName,  // stock_guid stores name (join key to stocks.name)
          companyGuid,
          r.GUID || r.Guid || null,
          r.VOUCHERTYPENAME || r.VoucherTypeName || null,
          normalizeDate(r.DATE || r.Date || r.date),
          Math.abs(qty),
          parseTallyRate(r.RATE || r.Rate || '0'),
          Math.abs(amount),
          type,
          r.GODOWNNAME || r.GodownName || null,
          now(),
        ]);
        saved++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
    }

    await client.query('COMMIT');
    console.log(`[DB] StockTx: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockTx transaction failed:', e.message);
  } finally {
    client.release();
  }

  // Recompute closing qty + weighted avg rate from transactions
  // closing_qty  = net (inward - outward)
  // closing_rate = weighted avg of inward purchase costs
  // closing_value = closing_qty * closing_rate
  try {
    const result = await dbQuery(`
      UPDATE stocks s
      SET closing_qty   = GREATEST(sub.net_qty, 0),
          closing_rate  = sub.last_rate,
          closing_value = GREATEST(sub.net_qty, 0) * sub.last_rate
      FROM (
        SELECT
          stock_guid, company_guid,
          SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) as net_qty,
          -- Use latest inward rate as the current rate
          (SELECT rate FROM stock_transactions t2
           WHERE t2.stock_guid = t1.stock_guid AND t2.company_guid = t1.company_guid
             AND t2.type = 'inward' AND t2.rate > 0
           ORDER BY t2.date DESC, t2.id DESC LIMIT 1) as last_rate
        FROM stock_transactions t1
        WHERE company_guid = $1 AND qty IS NOT NULL
        GROUP BY stock_guid, company_guid
      ) sub
      WHERE s.name = sub.stock_guid
        AND s.company_guid = sub.company_guid
    `, [companyGuid]);
    console.log(`[DB] StockTx: updated ${result.rowCount} stock closing_qty for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Stock closing_qty update failed:', e.message);
  }
}

async function processGroupMasters(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.Name || r.NAME || '';
      const guid = r.Guid || r.GUID || name + '_' + companyGuid;
      if (!name) continue;
      try {
        await client.query(`
          INSERT INTO groups (guid, company_guid, name, parent, nature, is_revenue, is_debit_positive, is_primary, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, nature=EXCLUDED.nature,
            is_revenue=EXCLUDED.is_revenue, is_debit_positive=EXCLUDED.is_debit_positive,
            is_primary=EXCLUDED.is_primary, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name,
          r.Parent || r.PARENT || null,
          r.NatureOfGroup || r.NATUREOFGROUP || null,
          !!(r.IsRevenue === 1 || r.IsRevenue === '1'),
          !!(r.IsDebitPositive === 1 || r.IsDebitPositive === '1'),
          !!(r.IsPrimary === 1 || r.IsPrimary === '1'),
          parseInt(r.AlterId || r.ALTERID || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] Group insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] Groups: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] Groups failed:', e.message); }
  finally { client.release(); }
}

async function processFullLedger(data, companyGuid) {
  // Same as processMasters but with extended fields
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    // LedgerFull.xml — Tally NATIVEMETHOD Collection wraps all data in TALLYMESSAGE.
    // The actual ledger items are inside TALLYMESSAGE.LEDGER[] (JSON-stringified by coerce).
    // Expand the TALLYMESSAGE wrapper into individual ledger records.
    // LedgerFull.xml — Collection: normalizeEnvelope returns 1-2 rows wrapping all ledger data.
    // Use recursive search to find LEDGER[] regardless of nesting depth.
    console.log('[INGEST] processFullLedger called, records:', data.length, 'sample keys:', Object.keys(data[0] || {}).join(', '));
    let expandedData = data;
    if (data.length <= 3) {
      const found = findNestedArray(data[0], ['LEDGER', 'Ledger']);
      console.log('[INGEST] FullLedger findNestedArray result:', found.length, 'items');
      if (found.length > 0) {
        expandedData = found;
        console.log('[INGEST] FullLedger expanded:', expandedData.length, 'ledgers');

      } else {
        console.log('[INGEST] FullLedger raw data[0] (no LEDGER found):', JSON.stringify(data[0]).slice(0, 1200));
      }
    }
    for (const raw of expandedData) {
      let r = raw;
      const ledgerVal = raw.LEDGER ?? raw.Ledger;
      if (ledgerVal) {
        try { r = typeof ledgerVal === 'string' ? JSON.parse(ledgerVal) : ledgerVal; } catch { r = raw; }
      }
      const name = tallyName(r);
      const guid = r.GUID || r.Guid || name + '_' + companyGuid;
      if (!name) continue;
      if (r.BASEUNITS || r.COLLECTION_NAME === 'StockItem') continue;
      if (r.LedgerName && !r.Name && !r.NAME) continue;

      // ISDEEMEDPOSITIVE=1 means the ledger's natural balance is Dr (assets/expenses)
      // This is more reliable than the sign of CLOSINGBALANCE
      const isDeemedPositive = r.ISDEEMEDPOSITIVE === 1 || r.ISDEEMEDPOSITIVE === '1' ||
                               r.ISDEEMEDPOSITIVE === 'Yes' || r.IsDeemedPositive === 'Yes' ||
                               r.IsDeemedPositive === 1;
      const bal = r.CLOSINGBALANCE ?? r.ClosingBalance ?? r.OPENINGBALANCE ?? r.OpeningBalance ?? '0';
      const balStr = String(bal).replace('(-)', '-');
      const balNum = parseFloat(balStr.replace(/[^0-9.-]/g, '')) || 0;
      // Primary source: ISDEEMEDPOSITIVE flag. Fallback: negative balance = Dr
      const balType = isDeemedPositive ? 'Dr' : (balNum < 0 ? 'Dr' : 'Cr');

      try {
        await client.query(`
          INSERT INTO ledgers (guid, company_guid, name, parent, alias, gstin, pan, phone, email, address,
            opening_balance, closing_balance, balance_type, is_revenue, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, alias=EXCLUDED.alias,
            gstin=EXCLUDED.gstin, pan=EXCLUDED.pan, phone=EXCLUDED.phone,
            email=EXCLUDED.email, address=EXCLUDED.address,
            opening_balance=EXCLUDED.opening_balance, closing_balance=EXCLUDED.closing_balance,
            balance_type=EXCLUDED.balance_type, is_revenue=EXCLUDED.is_revenue,
            alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name,
          r.Parent || r.PARENT || null,
          r.ALIAS || r.Alias || r.OnlyAlias || null,
          r.GSTIN || r.PartyGSTIN || null,
          r.ITPAN || r.PAN || r.IncomeTaxNumber || null,
          r.PHONE || r.Phone || r.LedPhone || r.LedgerPhone || null,
          r.EMAIL || r.Email || null,
          r.MAILINGADDRESS || r.Address || null,
          Math.abs(parseFloat(String(r.OPENINGBALANCE ?? r.OpeningBalance ?? '0').replace(/[^0-9.-]/g, '')) || 0),
          Math.abs(balNum), balType,
          !!(r.ISREVENUE === 'Yes' || r.IsRevenue === 1 || r.IsRevenue === '1' || r.ISREVENUE === 1 || r.ISREVENUE === '1'),
          parseInt(r.ALTERID || r.AlterId || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] FullLedger insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] FullLedger: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] FullLedger failed:', e.message); }
  finally { client.release(); }
}

// Parse AllLedgerEntries from a voucher record — handles JSON string or array
function parseLedgerEntries(r) {
  const raw = r.ALLLEDGERENTRIES ?? r.AllLedgerEntries ?? r.AllLedgerentries ?? r.Allledgerentries ?? [];
  let entries = raw;
  // normalizeEnvelope coerces nested objects to JSON strings — parse if needed
  if (typeof entries === 'string') {
    try { entries = JSON.parse(entries); } catch { return []; }
  }
  if (!Array.isArray(entries)) {
    // Single entry wrapped in object
    if (entries && typeof entries === 'object') entries = [entries];
    else return [];
  }
  return entries
    .map((e, i) => {
      const name = e.LEDGERNAME || e.Ledgername || e.LedgerName || e.ledgername || null;
      const guid = e.LEDGERGUID || e.LedgerGuid || e.ledgerGuid || null;
      // Amount sign from Tally: negative=Dr, positive=Cr (from company perspective)
      const rawAmt = e.AMOUNT ?? e.Amount ?? e.amount;
      const amount = typeof rawAmt === 'string'
        ? parseFloat(String(rawAmt).replace('(-)', '-').replace(/[^0-9.-]/g, ''))
        : parseFloat(rawAmt || 0);
      if (!name || isNaN(amount)) return null;
      return { name, guid, amount, drCr: amount < 0 ? 'Dr' : 'Cr', index: i };
    })
    .filter(Boolean);
}

// Save AllLedgerEntries for a voucher to voucher_ledger_entries table
async function saveLedgerEntries(client, voucherGuid, companyGuid, entries) {
  if (!entries || entries.length === 0) return;
  // Delete existing entries for this voucher (idempotent re-sync)
  await client.query('DELETE FROM voucher_ledger_entries WHERE voucher_guid=$1 AND company_guid=$2', [voucherGuid, companyGuid]);
  for (const e of entries) {
    try {
      await client.query(
        `INSERT INTO voucher_ledger_entries (voucher_guid, company_guid, ledger_name, ledger_guid, amount, dr_cr, line_index)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [voucherGuid, companyGuid, e.name, e.guid, e.amount, e.drCr, e.index]
      );
    } catch (err) {
      console.warn('[DB] LedgerEntry insert failed:', err.message, e.name);
    }
  }
}

// Parse Tally quantity string: '(-)20', '-20', '20 nos' → number
function parseTallyQty(val) {
  if (!val && val !== 0) return 0;
  const s = String(val).replace('(-)', '-').replace('(', '-').replace(')', '');
  const m = s.match(/^-?[\d.]+/);
  return m ? parseFloat(m[0]) : 0;
}
// Parse Tally rate string: '400.00/nos', '2,700.00/nos' → number
function parseTallyRate(val) {
  if (!val) return 0;
  const s = String(val).split('/')[0].replace(/,/g, '');
  return parseFloat(s) || 0;
}

async function processVoucherInventoryItems(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      // Tally sends ALL keys uppercase
      const voucherGuid = r.VOUCHERGUID || r.VoucherGuid || r.GUID || '';
      const itemName    = r.STOCKITEMNAME || r.StockItemName || '';
      if (!voucherGuid || !itemName) continue;

      const qty       = parseTallyQty(r.ACTUALQTY || r.ActualQty);
      const billedQty = parseTallyQty(r.BILLEDQTY || r.BilledQty);
      const rate      = parseTallyRate(r.RATE || r.Rate);
      const rawAmt    = parseFloat(r.AMOUNT ?? r.Amount ?? 0);
      const amount    = isNaN(rawAmt) ? 0 : rawAmt;

      try {
        await client.query(`
          INSERT INTO voucher_inventory_items
            (voucher_guid, company_guid, stock_item_name, stock_item_guid, actual_qty, billed_qty, rate, amount, discount, godown_name, batch_name, unit, hsn, alter_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (voucher_guid, company_guid, stock_item_name, godown_name, batch_name) DO UPDATE SET
            actual_qty=EXCLUDED.actual_qty, billed_qty=EXCLUDED.billed_qty,
            rate=EXCLUDED.rate, amount=EXCLUDED.amount,
            discount=EXCLUDED.discount, alter_id=EXCLUDED.alter_id
        `, [
          voucherGuid, companyGuid, itemName,
          r.STOCKITEMGUID || r.StockItemGuid || null,
          Math.abs(qty), Math.abs(billedQty), rate, Math.abs(amount),
          parseFloat(r.DISCOUNT ?? r.Discount ?? 0),
          r.GODOWNNAME || r.GodownName || null,
          r.BATCHNAME  || r.BatchName  || null,
          r.UNIT       || r.Unit       || null,
          r.HSN        || null,
          parseInt(r.ALTERID ?? r.AlterId ?? 0),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] VoucherInvItem insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] VoucherInventoryItems: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] VoucherInventoryItems failed:', e.message); }
  finally { client.release(); }
}

async function processGSTDetails(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    const n = (f) => { const v = parseFloat(f || 0); return isNaN(v) ? 0 : v; };
    for (const r of data) {
      // Tally sends ALL keys uppercase
      const voucherGuid = r.VOUCHERGUID || r.VoucherGuid || r.GUID || '';
      if (!voucherGuid) continue;
      try {
        await client.query(`
          INSERT INTO gst_voucher_details
            (voucher_guid, company_guid, voucher_number, voucher_type, date, party_name, gst_reg_type, place_of_supply, taxable_amount, cgst_amount, sgst_amount, igst_amount, irn, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          ON CONFLICT (voucher_guid, company_guid) DO UPDATE SET
            voucher_number=EXCLUDED.voucher_number, voucher_type=EXCLUDED.voucher_type,
            taxable_amount=EXCLUDED.taxable_amount, cgst_amount=EXCLUDED.cgst_amount,
            sgst_amount=EXCLUDED.sgst_amount, igst_amount=EXCLUDED.igst_amount,
            irn=EXCLUDED.irn, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          voucherGuid, companyGuid,
          r.VOUCHERNUMBER  || r.VoucherNumber  || null,
          r.VOUCHERTYPENAME|| r.VoucherTypeName|| null,
          normalizeDate(r.DATE || r.Date),
          r.PARTYLEDGERNAME|| r.PartyLedgerName|| null,
          r.GSTREGTYPE     || r.GSTRegType     || null,
          r.PLACEOFSUPPLY  || r.PlaceOfSupply  || null,
          n(r.TAXABLEAMOUNT ?? r.TaxableAmount),
          n(r.CGSTAMOUNT    ?? r.CGSTAmount),
          n(r.SGSTAMOUNT    ?? r.SGSTAmount),
          n(r.IGSTAMOUNT    ?? r.IGSTAmount),
          r.IRN || null,
          parseInt(r.ALTERID ?? r.AlterId ?? 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] GSTDetail insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] GSTDetails: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] GSTDetails failed:', e.message); }
  finally { client.release(); }
}

async function processBillOutstanding(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const ledgerName = r.LedgerName || r.LEDGERNAME || '';
      const billName = r.BillName || r.BILLNAME || '';
      if (!ledgerName) continue;
      try {
        await client.query(`
          INSERT INTO bill_outstanding
            (voucher_guid, company_guid, ledger_name, bill_name, bill_date, due_date, amount, pending_amount, bill_type, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          r.VoucherGuid || null, companyGuid, ledgerName, billName,
          normalizeDate(r.BillDate), normalizeDate(r.DueDate),
          parseFloat(r.Amount || 0), parseFloat(r.PendingAmount || 0),
          r.BillType || null, parseInt(r.AlterId || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
    }
    await client.query('COMMIT');
    console.log(`[DB] BillOutstanding: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] BillOutstanding failed:', e.message); }
  finally { client.release(); }
}

async function processStockOpeningBalance(data, companyGuid) {
  // StockOpeningBalance.xml: Name, OpeningBalance (numeric), OpeningRate, OpeningValue
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let updated = 0;

    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;

      const openQty  = parseFloat(r.OpeningBalance || r.OPENINGBALANCE || 0);
      const openRate = parseFloat(r.OpeningRate    || r.OPENINGRATE    || 0);
      const openVal  = parseFloat(r.OpeningValue   || r.OPENINGVALUE   || 0);

      if (isNaN(openQty)) continue;

      try {
        const result = await client.query(
          `UPDATE stocks SET opening_qty = $1, opening_rate = $2
           WHERE name = $3 AND company_guid = $4`,
          [openQty, openRate, name, companyGuid]
        );
        if (result.rowCount > 0) updated++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
    }

    await client.query('COMMIT');
    console.log(`[DB] StockOpening: updated ${updated}/${data.length} for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockOpening failed:', e.message);
  } finally {
    client.release();
  }

  // Recompute closing_qty = opening_qty + net transactions
  try {
    await dbQuery(`
      UPDATE stocks s
      SET closing_qty = s.opening_qty + COALESCE(sub.net_qty, 0),
          closing_value = (s.opening_qty + COALESCE(sub.net_qty, 0)) * NULLIF(s.opening_rate, 0)
      FROM (
        SELECT stock_guid, company_guid,
               SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) as net_qty
        FROM stock_transactions
        WHERE company_guid = $1 AND qty IS NOT NULL AND qty::text != 'NaN'
        GROUP BY stock_guid, company_guid
      ) sub
      WHERE s.name = sub.stock_guid AND s.company_guid = sub.company_guid AND s.company_guid = $1
    `, [companyGuid]);

    // Stocks with opening but no transactions: closing = opening
    await dbQuery(
      `UPDATE stocks SET closing_qty = opening_qty
       WHERE company_guid = $1 AND closing_qty = 0 AND opening_qty > 0`,
      [companyGuid]
    );

    // Stocks with transactions but no opening: closing = net transactions only
    await dbQuery(
      `UPDATE stocks s
       SET closing_qty = sub.net_qty
       FROM (
         SELECT stock_guid, company_guid,
                SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) as net_qty
         FROM stock_transactions
         WHERE company_guid = $1 AND qty IS NOT NULL AND qty::text != 'NaN'
         GROUP BY stock_guid, company_guid
       ) sub
       WHERE s.name = sub.stock_guid
         AND s.company_guid = sub.company_guid
         AND s.opening_qty = 0
         AND sub.net_qty > 0`,
      [companyGuid]
    );

    console.log(`[DB] StockOpening: closing_qty recomputed for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Stock closing_qty recompute failed:', e.message);
  }
}

async function processLedgerTransactions(data, companyGuid) {
  // LedgerTransaction.xml: each record is a ledger line item for a voucher
  // Fields: Guid (voucher GUID), LedgerName, LedgerGuid, Amount, Date, AlterId
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Group by voucher GUID to compute totals
    const voucherAmounts = {}; // guid → total amount
    let itemsSaved = 0;

    for (const r of data) {
      const voucherGuid = r.Guid || r.GUID || '';
      if (!voucherGuid) continue;

      const rawAmt = parseFloat(r.Amount || r.AMOUNT || 0);
      const amount = isNaN(rawAmt) ? 0 : rawAmt;
      const ledgerName = r.LedgerName || r.LEDGERNAME || null;

      // Insert into voucher_items
      try {
        await client.query(`
          INSERT INTO voucher_items (voucher_guid, company_guid, ledger_name, ledger_guid, amount, type)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, [
          voucherGuid, companyGuid,
          ledgerName,
          r.LedgerGuid || r.LEDGERGUID || null,
          Math.abs(amount),
          amount >= 0 ? 'Cr' : 'Dr',
        ]);
        itemsSaved++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }

      // Accumulate Cr (positive/credit) amounts per voucher for total
      const absAmount = isNaN(amount) ? 0 : Math.abs(parseFloat(r.Amount || 0));
      if (absAmount > 0) {
        if (!voucherAmounts[voucherGuid]) voucherAmounts[voucherGuid] = { cr: 0, dr: 0 };
        if (amount >= 0) voucherAmounts[voucherGuid].cr += absAmount;
        else voucherAmounts[voucherGuid].dr += absAmount;
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] LedgerTx: ${itemsSaved} items saved for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] LedgerTx transaction failed:', e.message);
  } finally {
    client.release();
  }

  // Update voucher amounts AFTER items are committed — separate query
  try {
    const result = await dbQuery(`
      UPDATE vouchers v
      SET amount = sub.total
      FROM (
        SELECT voucher_guid, company_guid,
               SUM(CASE WHEN type = 'Cr' THEN amount ELSE 0 END) as total
        FROM voucher_items
        WHERE company_guid = $1
          AND amount IS NOT NULL
          AND amount::text != 'NaN'
          AND amount > 0
        GROUP BY voucher_guid, company_guid
      ) sub
      WHERE v.guid = sub.voucher_guid
        AND v.company_guid = sub.company_guid
        AND sub.total > 0
    `, [companyGuid]);
    console.log(`[DB] LedgerTx: updated ${result.rowCount} voucher amounts for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Voucher amount update failed:', e.message);
  }
}

async function processRecords(data, companyGuid, userId, deviceId) {
  // Records stream is a mixed bag from desktop — group by XML type and process each
  const byXml = {};
  for (const r of data) {
    const xml = r.XML || r.xml || 'unknown';
    if (!byXml[xml]) byXml[xml] = [];
    byXml[xml].push(r);
  }

  for (const [xml, records] of Object.entries(byXml)) {
    if (records.length === 0) continue;
    const sample = records[0];

    if (xml === 'Voucher.xml') {
      // Full voucher data — has VoucherTypeName, Date, PartyLedgerName etc.
      await processVouchers(records, companyGuid);
    } else if (xml === 'SimplifiedVoucher.xml') {
      // GUID-only voucher stubs — skip, full data comes from Voucher.xml
      console.log(`[INGEST] Skipping ${records.length} SimplifiedVoucher stubs`);
    } else if (xml === 'StockItem.xml' || sample?.BASEUNITS) {
      await processStocks(records, companyGuid);
    } else if (xml === 'StockTransaction.xml') {
      await processStockTransactions(records, companyGuid);
    } else if (xml === 'LedgerTransaction.xml') {
      await processLedgerTransactions(records, companyGuid);
    } else if (xml === 'StockOpeningBalance.xml') {
      await processStockOpeningBalance(records, companyGuid);
    } else if (xml === 'VoucherInventoryDetail.xml') {
      await processVoucherInventoryItems(records, companyGuid);
    } else if (xml === 'GSTDetails.xml') {
      await processGSTDetails(records, companyGuid);
    } else if (xml === 'GroupMaster.xml') {
      await processGroupMasters(records, companyGuid);
    } else if (xml === 'FullLedger.xml') {
      await processFullLedger(records, companyGuid);
    } else if (xml === 'BillOutstanding.xml') {
      await processBillOutstanding(records, companyGuid);
    } else if (xml === 'LedgerOpeningBalance.xml') {
      // Opening balances captured in ledger master sync
      console.log(`[INGEST] Skipping ${records.length} LedgerOpeningBalance records`);
    } else if (xml === 'AllVoucher.xml') {
      // AllVoucher has header + inventory + ledger entries + bill allocations
      await processAllVoucher(records, companyGuid);
    } else if (xml === 'StockItemFull.xml') {
      await processStocks(records, companyGuid);
    } else if (xml === 'UnitFull.xml') {
      await processUnits(records, companyGuid);
    } else if (xml === 'VoucherTypeFull.xml') {
      await processVoucherTypes(records, companyGuid);
    } else if (xml === 'StockGroupFull.xml') {
      await processStockGroups(records, companyGuid);
    } else if (xml === 'LedgerFull.xml') {
      await processFullLedger(records, companyGuid);
    } else if (xml === 'CurrencyMaster.xml') {
      await processCurrencies(records, companyGuid);
    } else if (xml === 'Godown.xml') {
      await processWarehouses(records, companyGuid);
    } else if (xml === 'GroupMaster.xml') {
      await processGroupMasters(records, companyGuid);
    } else if (xml === 'Ledger.xml' || xml === 'Master.xml' || (sample?.GUID && sample?.NAME && !sample?.LedgerName)) {
      await processMasters(records, companyGuid);
    } else {
      console.log(`[INGEST] Skipping ${records.length} records from unknown XML: ${xml}`);
    }
  }
}


async function processAllVoucher(data, companyGuid) {
  // AllVoucher.xml — full voucher with inventory entries, ledger entries, bill allocations
  // Each record has: guid, Date, VoucherType, VoucherNumber, PartyName, AllInventoryentries, AllLedgerEntries, Billallocations
  // NOTE: AllVoucher.xml LINE has <XMLTAG>Voucher</XMLTAG> so Tally wraps each row in <Voucher>
  // normalizeEnvelope returns { Voucher: { guid, Date, ... } } — we must unwrap it
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const raw of data) {
      // AllVoucher.xml has <XMLTAG>Voucher</XMLTAG> but Tally returns it as uppercase VOUCHER.
      // normalizeEnvelope's coerce() also JSON.stringifies the nested object.
      // So raw = { VOUCHER: '{"GUID":"...","DATE":"...","VOUCHERTYPE":"...", ...}', ... }
      // We parse the VOUCHER string to get the real data with uppercase keys.
      let r;
      const voucherVal = raw.VOUCHER ?? raw.Voucher;
      if (voucherVal) {
        try { r = typeof voucherVal === 'string' ? JSON.parse(voucherVal) : voucherVal; }
        catch { r = raw; }
      } else {
        r = raw;
      }
      const guid = r.GUID || r.guid || r.Guid || '';
      if (!guid) continue;
      // Tally returns uppercase field names: VOUCHERTYPE, DATE, PARTYNAME, etc.
      const voucherType = r.VOUCHERTYPE || r.VoucherType || r.VOUCHERTYPENAME || r.VoucherTypeName || 'Voucher';
      const date = normalizeDate(r.DATE || r.Date || r.date);
      // Skip junk records: no date + no meaningful type + no number = header/metadata rows
      if (!date && voucherType === 'Voucher' && !(r.VOUCHERNUMBER || r.VoucherNumber)) continue;
      const isCancelled = r.ISCANCELLED === 'Yes' || r.CANCELLED === 'Yes' || false;
      const partyGuid = r._VOUCHERTYPE || r._PartyName || r.PartyGuid || null;
      let amount = parseFloat(r.AMOUNT || r.Amount || 0);
      // Compute from ledger entries if amount is 0
      const ledgerEntries = r.ALLLEDGERENTRIES || r.AllLedgerEntries || r.AllLedgerentries || [];
      if ((!amount || amount === 0) && Array.isArray(ledgerEntries)) {
        amount = ledgerEntries
          .filter(e => parseFloat(e.AMOUNT || e.Amount || 0) > 0)
          .reduce((s, e) => s + parseFloat(e.AMOUNT || e.Amount || 0), 0);
      }
      try {
        await client.query(`
          INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, date, party_name, party_guid, amount, narration, reference, is_cancelled, alter_id, raw_data, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            voucher_number = COALESCE(EXCLUDED.voucher_number, vouchers.voucher_number),
            voucher_type   = CASE WHEN EXCLUDED.voucher_type = 'Voucher' THEN COALESCE(vouchers.voucher_type, 'Voucher') ELSE EXCLUDED.voucher_type END,
            date           = COALESCE(EXCLUDED.date, vouchers.date),
            party_name     = COALESCE(EXCLUDED.party_name, vouchers.party_name),
            party_guid     = COALESCE(EXCLUDED.party_guid, vouchers.party_guid),
            amount         = CASE WHEN EXCLUDED.amount = 0 AND vouchers.amount != 0 THEN vouchers.amount ELSE EXCLUDED.amount END,
            narration      = COALESCE(EXCLUDED.narration, vouchers.narration),
            reference      = COALESCE(EXCLUDED.reference, vouchers.reference),
            is_cancelled   = EXCLUDED.is_cancelled,
            alter_id       = GREATEST(EXCLUDED.alter_id, vouchers.alter_id),
            raw_data       = CASE WHEN EXCLUDED.raw_data IS NULL OR EXCLUDED.raw_data = 'null' THEN vouchers.raw_data ELSE EXCLUDED.raw_data END,
            synced_at      = EXCLUDED.synced_at
        `, [
          guid, companyGuid,
          r.VOUCHERNUMBER || r.VoucherNumber || null,
          voucherType, date,
          r.PARTYNAME || r.PartyName || r.PARTYLEDGERNAME || null,
          partyGuid,
          amount,
          r.NARRATION || r.Narration || null,
          r.REFERENCE || r.Reference || null,
          isCancelled,
          parseInt(r.ALTERID || r.AlterId || 0),
          JSON.stringify(r).slice(0, 5000),
          now(),
        ]);
        saved++;
        // Save AllLedgerEntries to voucher_ledger_entries (proper Dr/Cr from amount sign)
        const parsedEntries = parseLedgerEntries(r);
        if (parsedEntries.length > 0) {
          await saveLedgerEntries(client, guid, companyGuid, parsedEntries);
        }
      } catch (e) { console.warn('[DB] AllVoucher insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] AllVoucher: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] AllVoucher failed:', e.message); }
  finally { client.release(); }
}

async function processWarehouses(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;
      try {
        await client.query(`
          INSERT INTO warehouses (guid, company_guid, name, parent, parent_guid, address, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (name, company_guid) DO UPDATE SET
            guid=EXCLUDED.guid, parent=EXCLUDED.parent, parent_guid=EXCLUDED.parent_guid,
            address=EXCLUDED.address, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          r.Guid || r.GUID || null, companyGuid, name,
          r.Parent || r.PARENT || null,
          r.ParentGuid || null,
          r.Address || null,
          parseInt(r.AlterId || r.ALTERID || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] Warehouse insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] Warehouses: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] Warehouses failed:', e.message); }
  finally { client.release(); }
}

async function processUnits(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;
      try {
        await client.query(`
          INSERT INTO units (guid, company_guid, name, formal_name, is_simple_unit, base_units, additional_units, conversion, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (name, company_guid) DO UPDATE SET
            formal_name=EXCLUDED.formal_name, is_simple_unit=EXCLUDED.is_simple_unit,
            base_units=EXCLUDED.base_units, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          r.Guid || null, companyGuid, name,
          r.FORMAL_NAME || r.FormalName || name,
          !!(r.IS_SIMPLE_UNIT === '1' || r.IS_SIMPLE_UNIT === true),
          r.BASE_UNITS || r.BaseUnits || null,
          r.ADDITIONAL_UNITS || null,
          r.CONVERSION || null,
          parseInt(r.ALTERID || r.AlterId || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] Unit insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] Units: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] Units failed:', e.message); }
  finally { client.release(); }
}

async function processVoucherTypes(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;
      try {
        await client.query(`
          INSERT INTO voucher_types (guid, company_guid, name, parent, parent_guid, numbering_method, is_deemed_positive, affects_stock, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (name, company_guid) DO UPDATE SET
            guid=EXCLUDED.guid, parent=EXCLUDED.parent, parent_guid=EXCLUDED.parent_guid,
            numbering_method=EXCLUDED.numbering_method, is_deemed_positive=EXCLUDED.is_deemed_positive,
            affects_stock=EXCLUDED.affects_stock, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          r.Guid || null, companyGuid, name,
          r.PARENT || r.Parent || null,
          r.PARENTGuid || null,
          r.NUMBERINGMETHOD || null,
          !!(r.ISDEEMEDPOSITIVE === 'Yes' || r.ISDEEMEDPOSITIVE === '1'),
          !!(r.AFFECTSSTOCK === 'Yes' || r.AFFECTSSTOCK === '1'),
          parseInt(r.ALTERID || r.AlterId || 0), now(),
        ]);
        saved++;
      } catch (e) { console.warn('[DB] VoucherType insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] VoucherTypes: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] VoucherTypes failed:', e.message); }
  finally { client.release(); }
}

async function processStockGroups(data, companyGuid) {
  // Uses the groups table (same as group masters)
  await processGroupMasters(data, companyGuid);
}

async function processCurrencies(data, companyGuid) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;
      try {
        await client.query(`
          INSERT INTO currencies (guid, company_guid, name, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5)
          ON CONFLICT (name, company_guid) DO UPDATE SET guid=EXCLUDED.guid, synced_at=EXCLUDED.synced_at
        `, [r.Guid || null, companyGuid, name, parseInt(r.ALTERID || 0), now()]);
        saved++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
    }
    await client.query('COMMIT');
    console.log(`[DB] Currencies: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] Currencies failed:', e.message); }
  finally { client.release(); }
}
