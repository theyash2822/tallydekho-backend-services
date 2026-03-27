// Processes ingested data from Desktop and saves to DB
// Handles: masters (ledgers, stocks), vouchers, stock transactions

export async function processIngestedData(db, streamName, data, companyGuid, userId, deviceId) {
  if (!data?.length || !companyGuid) return;

  const stream = streamName?.toLowerCase();

  if (stream === 'master' || stream === 'masters') {
    processMasters(db, data, companyGuid);
  } else if (stream === 'vouchers' || stream === 'voucher') {
    processVouchers(db, data, companyGuid);
  } else if (stream === 'records') {
    // records can be companies or mixed
    processRecords(db, data, companyGuid, userId, deviceId);
  } else {
    // Try to detect type from data
    const sample = data[0];
    if (sample?.MASTERID || sample?.NAME || sample?.LEDGERNAME) processMasters(db, data, companyGuid);
    else if (sample?.VOUCHERNUMBER || sample?.VOUCHERTYPENAME) processVouchers(db, data, companyGuid);
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
    for (const r of records) {
      const name = r.NAME || r.name || r.LEDGERNAME || '';
      const guid = r.GUID || r.guid || name + '_' + companyGuid;
      const parent = r.PARENT || r.parent || '';

      if (!name) continue;

      // Determine if it's a ledger or stock item
      if (parent?.toLowerCase().includes('stock') || r.BASEUNITS || r.UNIT) {
        // Stock item
        try {
          insertStock.run(
            guid, companyGuid, name,
            r.ALIAS || r.alias || null,
            r.CATEGORY || r.category || null,
            parent || null,
            r.BASEUNITS || r.UNIT || r.unit || 'Pcs',
            r.HSNDETAILS?.[0]?.HSNCODE || r.HSN || null,
            parseFloat(r.GSTRATE || r.TAXRATE || 18),
            parseFloat(r.CLOSINGBALANCE || r.CLOSINGQTY || 0),
            parseFloat(r.CLOSINGRATE || r.RATE || 0),
            parseFloat(r.CLOSINGVALUE || r.VALUE || 0),
            parseFloat(r.REORDERLEVEL || 0),
            parseInt(r.ALTERID || r.alter_id || 0),
          );
        } catch {}
      } else {
        // Ledger
        const bal = r.CLOSINGBALANCE || r.OPENINGBALANCE || '0';
        const balNum = parseFloat(String(bal).replace(/[^0-9.-]/g, '')) || 0;
        const balType = String(bal).includes('Cr') ? 'Cr' : 'Dr';
        try {
          insertLedger.run(
            guid, companyGuid, name, parent,
            r.ALIAS || null,
            r.GSTIN || r.PARTYGSTIN || null,
            r.PAN || r.INCOMETAXNUMBER || null,
            r.LEDPHONE || r.PHONE || null,
            r.EMAIL || null,
            r.ADDRESS || null,
            parseFloat(String(r.OPENINGBALANCE || '0').replace(/[^0-9.-]/g, '')) || 0,
            Math.abs(balNum), balType,
            parseInt(r.ALTERID || 0),
          );
        } catch {}
      }
    }
  });

  try { insertMany(data); console.log(`[DB] Masters: saved ${data.length} records for ${companyGuid}`); }
  catch (e) { console.error('[DB] Masters error:', e.message); }
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
    for (const r of records) {
      const guid = r.GUID || r.guid || '';
      if (!guid) continue;
      try {
        insert.run(
          guid, companyGuid,
          r.VOUCHERNUMBER || r.voucherNumber || null,
          r.VOUCHERTYPENAME || r.voucherType || 'Unknown',
          r.DATE || r.date || null,
          r.PARTYNAME || r.partyName || null,
          parseFloat(r.AMOUNT || r.amount || 0),
          r.NARRATION || r.narration || null,
          r.REFERENCE || r.reference || null,
          parseInt(r.ALTERID || 0),
          JSON.stringify(r),
        );
      } catch {}
    }
  });

  try { insertMany(data); console.log(`[DB] Vouchers: saved ${data.length} records for ${companyGuid}`); }
  catch (e) { console.error('[DB] Vouchers error:', e.message); }
}

function processRecords(db, data, companyGuid, userId, deviceId) {
  // Try to detect type
  const sample = data[0];
  if (sample?.GUID && (sample?.PARENT || sample?.NAME)) processMasters(db, data, companyGuid);
  else if (sample?.VOUCHERNUMBER) processVouchers(db, data, companyGuid);
}
