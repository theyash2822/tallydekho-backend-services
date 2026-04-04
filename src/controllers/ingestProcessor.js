// Ingest processor — PostgreSQL version
// Handles: masters (ledgers, stocks), vouchers, stock transactions
import { getClient } from '../db/schema.js';

// Normalize Tally date: '20240401' → '2024-04-01'
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
    if (collectionName === 'stockitem' || collectionName === 'stock item') {
      await processStocks(data, companyGuid);
    } else if (collectionName === 'stocktransaction' || collectionName === 'stock transaction') {
      await processStockTransactions(data, companyGuid);
    } else {
      await processMasters(data, companyGuid);
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

    for (const r of data) {
      const name = r.NAME || r.name || '';
      const guid = r.GUID || r.guid || name + '_' + companyGuid;
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
      const voucherType   = r.VoucherTypeName || r.VOUCHERTYPENAME || r.voucherType || 'Voucher';
      const date          = normalizeDate(r.Date || r.DATE || r.date);
      const isCancelled   = (r.ISCANCELLED === 'Yes' || r.IsCancelled === 'Yes');
      const partyGuid     = r.PARTYGUIDS || r.PartyGuid || r.partyGuid || null;

      try {
        await client.query(`
          INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, date, party_name, party_guid, amount, narration, reference, is_cancelled, alter_id, raw_data, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            voucher_number=EXCLUDED.voucher_number, voucher_type=EXCLUDED.voucher_type,
            date=EXCLUDED.date, party_name=EXCLUDED.party_name, party_guid=EXCLUDED.party_guid,
            amount=EXCLUDED.amount, narration=EXCLUDED.narration, reference=EXCLUDED.reference,
            is_cancelled=EXCLUDED.is_cancelled, alter_id=EXCLUDED.alter_id,
            raw_data=EXCLUDED.raw_data, synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, voucherNumber, voucherType, date,
          r.PartyLedgerName || r.PARTYNAME || r.partyName || null,
          partyGuid,
          parseFloat(r.Amount || r.AMOUNT || r.amount || 0),
          r.Narration || r.NARRATION || r.narration || null,
          r.Reference || r.REFERENCE || r.reference || null,
          isCancelled,
          parseInt(r.AlterId || r.ALTERID || 0),
          JSON.stringify(r).slice(0, 10000),
          now(),
        ]);
        saved++;

        // Ledger line items
        const ledgerEntries = r.ALLLEDGERENTRIES || r.AllLedgerEntries || [];
        if (Array.isArray(ledgerEntries)) {
          for (const entry of ledgerEntries) {
            try {
              await client.query(`
                INSERT INTO voucher_items (voucher_guid, company_guid, ledger_name, ledger_guid, amount, type)
                VALUES ($1,$2,$3,$4,$5,$6)
              `, [
                guid, companyGuid,
                entry.LEDGERNAME || entry.LedgerName || null,
                entry.LEDGERGUID || entry.LedgerGuid || null,
                parseFloat(entry.AMOUNT || entry.Amount || 0),
                (entry.ISDEEMEDPOSITIVE === 'Yes' || entry.IsDeemedPositive === 'Yes') ? 'Dr' : 'Cr',
              ]);
            } catch {}
          }
        }

        // Inventory line items
        const inventoryEntries = r.ALLINVENTORYENTRIES || r.AllInventoryEntries || [];
        if (Array.isArray(inventoryEntries)) {
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
            } catch {}
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
      try {
        await client.query(`
          INSERT INTO stock_transactions (stock_guid, company_guid, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        `, [
          r.STOCKITEMNAME || r.stockGuid || '',
          companyGuid,
          r.VCHGUID || r.voucherGuid || null,
          r.VOUCHERTYPENAME || null,
          normalizeDate(r.Date || r.DATE || r.date),
          parseFloat(r.ACTUALQTY || r.qty || 0),
          parseFloat(r.RATE || r.rate || 0),
          parseFloat(r.AMOUNT || r.value || 0),
          r.ISDEEMEDPOSITIVE === 'Yes' ? 'inward' : 'outward',
          r.GODOWNNAME || r.warehouse || null,
          now(),
        ]);
        saved++;
      } catch {}
    }

    await client.query('COMMIT');
    console.log(`[DB] StockTx: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockTx transaction failed:', e.message);
  } finally {
    client.release();
  }
}

async function processRecords(data, companyGuid, userId, deviceId) {
  const sample = data[0];
  if (sample?.COLLECTION_NAME === 'Voucher' || sample?.Guid || sample?.F02) {
    await processVouchers(data, companyGuid);
  } else if (sample?.COLLECTION_NAME === 'StockItem' || sample?.BASEUNITS) {
    await processStocks(data, companyGuid);
  } else if (sample?.GUID && (sample?.PARENT !== undefined || sample?.NAME)) {
    await processMasters(data, companyGuid);
  } else {
    await processMasters(data, companyGuid);
  }
}
