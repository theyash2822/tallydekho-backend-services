// Processes ingested data from Desktop and saves to DB
// Handles: masters (ledgers, stocks), vouchers, stock transactions

export async function processIngestedData(db, streamName, data, companyGuid, userId, deviceId) {
  if (!data?.length || !companyGuid) return;

  const stream = streamName?.toLowerCase();
  const sample = data[0];

  // Detect by COLLECTION_NAME field (set by syncGuidHelper in desktop xml.js)
  const collectionName = sample?.COLLECTION_NAME?.toLowerCase() || '';

  if (stream === 'master' || stream === 'masters') {
    if (collectionName === 'voucher') {
      processVouchers(db, data, companyGuid);
    } else if (collectionName === 'stockitem' || collectionName === 'stock item') {
      processStocks(db, data, companyGuid);
    } else if (collectionName === 'stocktransaction' || collectionName === 'stock transaction') {
      processStockTransactions(db, data, companyGuid);
    } else {
      processMasters(db, data, companyGuid);
    }
  } else if (stream === 'vouchers' || stream === 'voucher') {
    processVouchers(db, data, companyGuid);
  } else if (stream === 'records') {
    processRecords(db, data, companyGuid, userId, deviceId);
  } else {
    // Auto-detect from data fields
    if (sample?.COLLECTION_NAME === 'Voucher' || sample?.VOUCHERNUMBER || sample?.F02) {
      processVouchers(db, data, companyGuid);
    } else if (sample?.COLLECTION_NAME === 'StockItem' || sample?.BASEUNITS) {
      processStocks(db, data, companyGuid);
    } else if (sample?.GUID && (sample?.PARENT !== undefined || sample?.NAME)) {
      processMasters(db, data, companyGuid);
    }
  }
}

function processMasters(db, data, companyGuid) {
  const insertLedger = db.prepare(`
    INSERT INTO ledgers (guid, company_guid, name, parent, alias, gstin, pan, phone, email, address, opening_balance, closing_balance, balance_type, alter_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guid, company_guid) DO UPDATE SET
      name=excluded.name, parent=excluded.parent, alias=excluded.alias,
      gstin=excluded.gstin, pan=excluded.pan, phone=excluded.phone,
      email=excluded.email, address=excluded.address,
      opening_balance=excluded.opening_balance, closing_balance=excluded.closing_balance,
      balance_type=excluded.balance_type, alter_id=excluded.alter_id,
      synced_at=unixepoch()
  `);

  const insertMany = db.transaction((records) => {
    let saved = 0;
    for (const r of records) {
      const name = r.NAME || r.name || r.LEDGERNAME || '';
      const guid = r.GUID || r.guid || name + '_' + companyGuid;
      const parent = r.PARENT || r.parent || '';

      if (!name || name.length === 0) continue;

      // Skip if it looks like a stock item
      if (r.BASEUNITS || r.UNIT || r.COLLECTION_NAME === 'StockItem') continue;

      const bal = r.CLOSINGBALANCE || r.OPENINGBALANCE || '0';
      const balStr = String(bal);
      const balNum = parseFloat(balStr.replace(/[^0-9.-]/g, '')) || 0;
      const balType = balStr.includes('Cr') ? 'Cr' : 'Dr';

      try {
        insertLedger.run(
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
        );
        saved++;
      } catch {}
    }
    return saved;
  });

  try {
    const saved = insertMany(data);
    console.log(`[DB] Masters: saved ${saved}/${data.length} ledgers for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Masters error:', e.message);
  }
}

function processStocks(db, data, companyGuid) {
  const insertStock = db.prepare(`
    INSERT INTO stocks (guid, company_guid, name, alias, category, group_name, unit, hsn, tax_rate, closing_qty, closing_rate, closing_value, reorder_level, alter_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guid, company_guid) DO UPDATE SET
      name=excluded.name, alias=excluded.alias, category=excluded.category,
      group_name=excluded.group_name, unit=excluded.unit, hsn=excluded.hsn,
      tax_rate=excluded.tax_rate, closing_qty=excluded.closing_qty,
      closing_rate=excluded.closing_rate, closing_value=excluded.closing_value,
      reorder_level=excluded.reorder_level, alter_id=excluded.alter_id,
      synced_at=unixepoch()
  `);

  const insertMany = db.transaction((records) => {
    let saved = 0;
    for (const r of records) {
      const name = r.NAME || r.name || '';
      const guid = r.GUID || r.guid || name + '_' + companyGuid;
      if (!name) continue;
      try {
        insertStock.run(
          guid, companyGuid, name,
          r.ALIAS || null,
          r.CATEGORY || r.STOCKCATEGORY || null,
          r.PARENT || r.GROUP || null,
          r.BASEUNITS || r.UNIT || r.unit || 'Pcs',
          r.HSNDETAILS?.[0]?.HSNCODE || r.HSN || null,
          parseFloat(r.GSTRATE || r.TAXRATE || 18),
          parseFloat(r.CLOSINGBALANCE || r.CLOSINGQTY || 0),
          parseFloat(r.CLOSINGRATE || r.RATE || 0),
          parseFloat(r.CLOSINGVALUE || r.VALUE || 0),
          parseFloat(r.REORDERLEVEL || 0),
          parseInt(r.AlterId || r.ALTERID || 0),
        );
        saved++;
      } catch {}
    }
    return saved;
  });

  try {
    const saved = insertMany(data);
    console.log(`[DB] Stocks: saved ${saved}/${data.length} items for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Stocks error:', e.message);
  }
}

function processVouchers(db, data, companyGuid) {
  const insert = db.prepare(`
    INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, date, party_name, amount, narration, reference, alter_id, raw_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guid, company_guid) DO UPDATE SET
      voucher_number=excluded.voucher_number, voucher_type=excluded.voucher_type,
      date=excluded.date, party_name=excluded.party_name, amount=excluded.amount,
      narration=excluded.narration, reference=excluded.reference,
      alter_id=excluded.alter_id, raw_data=excluded.raw_data,
      synced_at=unixepoch()
  `);

  const insertMany = db.transaction((records) => {
    let saved = 0;
    for (const r of records) {
      // GUID is all caps from Tally
      const guid = r.GUID || r.Guid || r.guid || '';
      if (!guid) continue;

      // F02 = VoucherNumber (can be number or string)
      const voucherNumber = r.F02 !== undefined ? String(r.F02) : (r.VOUCHERNUMBER || r.voucherNumber || null);

      const voucherType = r.VoucherTypeName || r.VOUCHERTYPENAME || r.voucherType || 'Voucher';

      try {
        insert.run(
          guid, companyGuid,
          r.VoucherNumber || r.VOUCHERNUMBER || voucherNumber || null,
          voucherType,
          (r.Date && !r.Date.includes('\xf1') && r.Date.trim() !== '' ? r.Date : null) || (r.DATE && !r.DATE.includes('\xf1') ? r.DATE : null) || r.date || null,
          r.PartyLedgerName || r.PARTYNAME || r.partyName || null,
          parseFloat(r.Amount || r.AMOUNT || r.amount || 0),
          r.Narration || r.NARRATION || r.narration || null,
          r.Reference || r.REFERENCE || r.reference || null,
          parseInt(r.AlterId || r.ALTERID || 0),
          JSON.stringify(r).slice(0, 2000),
        );
        saved++;
      } catch(e) {
        console.warn('[DB] Voucher insert failed:', e.message, '| guid:', guid);
      }
    }
    return saved;
  });

  try {
    const saved = insertMany(data);
    console.log(`[DB] Vouchers: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Vouchers error:', e.message);
  }
}

function processStockTransactions(db, data, companyGuid) {
  const insert = db.prepare(`
    INSERT INTO stock_transactions (stock_guid, company_guid, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((records) => {
    let saved = 0;
    for (const r of records) {
      try {
        insert.run(
          r.STOCKITEMNAME || r.stockGuid || '',
          companyGuid,
          r.VCHGUID || r.voucherGuid || null,
          r.VOUCHERTYPENAME || null,
          (r.Date && !r.Date.includes('\xf1') && r.Date.trim() !== '' ? r.Date : null) || (r.DATE && !r.DATE.includes('\xf1') ? r.DATE : null) || r.date || null,
          parseFloat(r.ACTUALQTY || r.qty || 0),
          parseFloat(r.RATE || r.rate || 0),
          parseFloat(r.AMOUNT || r.value || 0),
          r.ISDEEMEDPOSITIVE === 'Yes' ? 'inward' : 'outward',
          r.GODOWNNAME || r.warehouse || null
        );
        saved++;
      } catch {}
    }
    return saved;
  });

  try {
    const saved = insertMany(data);
    console.log(`[DB] StockTx: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] StockTx error:', e.message);
  }
}

function processRecords(db, data, companyGuid, userId, deviceId) {
  const sample = data[0];
  // Auto-detect type
  if (sample?.COLLECTION_NAME === 'Voucher' || sample?.Guid || sample?.F02) {
    processVouchers(db, data, companyGuid);
  } else if (sample?.COLLECTION_NAME === 'StockItem' || sample?.BASEUNITS) {
    processStocks(db, data, companyGuid);
  } else if (sample?.GUID && (sample?.PARENT !== undefined || sample?.NAME)) {
    processMasters(db, data, companyGuid);
  } else {
    // Try masters as fallback
    processMasters(db, data, companyGuid);
  }
}
