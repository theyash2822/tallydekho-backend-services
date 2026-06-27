// Ingest processor — PostgreSQL version
// Handles: masters (ledgers, stocks), vouchers, stock transactions
import { getClient, query as dbQuery } from '../db/schema.js';
import { classifyTaxLedger, inferTransactionNature } from '../utils/taxClassifier.js';
// Lazy import to avoid circular-dep at startup; emitVoucherRegularized is set after server init
import { emitVoucherRegularized, emitVoucherSynced } from '../socket/socketHandler.js';

// ── Dispatch / EWB Extraction ────────────────────────────────────────────────
// Extracts dispatch + transport details from a TallyPrime voucher record.
// Field names validated against real TallyPrime XML export (2026-06-24).
function extractDispatchDetails(r) {
  // EWAYBILLDETAILS.LIST comes in as EWAYBILLDETAILS or EwayBillDetails etc.
  const ewbRaw = r.EWAYBILLDETAILS || r['EWAYBILLDETAILS.LIST'] || r.EwayBillDetails || r.ewayBillDetails;
  const ewb = ewbRaw ? (Array.isArray(ewbRaw) ? ewbRaw[0] : ewbRaw) : null;

  // TRANSPORTDETAILS.LIST nested inside EWAYBILLDETAILS
  const tdRaw = ewb ? (ewb.TRANSPORTDETAILS || ewb['TRANSPORTDETAILS.LIST'] || ewb.TransportDetails) : null;
  const td = tdRaw ? (Array.isArray(tdRaw) ? tdRaw[0] : tdRaw) : null;

  // Consignor address list
  const consignorAddrRaw = ewb ? (ewb['CONSIGNORADDRESS.LIST'] || ewb.CONSIGNORADDRESS_LIST) : null;
  const consignorAddr = consignorAddrRaw
    ? (Array.isArray(consignorAddrRaw) ? consignorAddrRaw[0] : consignorAddrRaw)
    : null;

  // Consignee address list
  const consigneeAddrRaw = ewb ? (ewb['CONSIGNEEADDRESS.LIST'] || ewb.CONSIGNEEADDRESS_LIST) : null;
  const consigneeAddr = consigneeAddrRaw
    ? (Array.isArray(consigneeAddrRaw) ? consigneeAddrRaw[0] : consigneeAddrRaw)
    : null;

  const details = {
    // Dispatch From
    dispatch_from_address : consignorAddr?.CONSIGNORADDRESS || null,
    dispatch_from_place   : ewb?.CONSIGNORPLACE   || null,
    dispatch_from_state   : ewb?.SHIPPEDFROMSTATE  || null,
    dispatch_from_pincode : ewb?.CONSIGNORPINCODE  || null,
    // Ship To
    ship_to_address       : consigneeAddr?.CONSIGNEEADDRESS || null,
    ship_to_place         : ewb?.CONSIGNEEPLACE    || null,
    ship_to_state         : ewb?.SHIPPEDTOSTATE    || null,
    // Document
    document_type         : ewb?.DOCUMENTTYPE      || null,
    // Transport (from TRANSPORTDETAILS.LIST)
    transport_mode        : td?.TRANSPORTMODE      || null,
    transporter_name      : td?.TRANSPORTERNAME    || null,
    transporter_id        : td?.TRANSPORTERID      || null,
    vehicle_number        : td?.VEHICLENUMBER      || r.BASICSHIPVESSELNO || null,
    vehicle_type          : td?.VEHICLETYPE        || null,
    transport_doc_date    : td?.DOCUMENTDATE       || r.BILLOFLADINGDATE  || null,
    // Top-level dispatch fields
    transport_doc_no      : r.BASICSHIPDOCUMENTNO  || null,
    transport_mode_simple : r.BASICSHIPPEDBY       || null,
    ship_to_destination   : r.BASICFINALDESTINATION || null,
  };

  // Return null if nothing found (avoid storing empty objects)
  return Object.values(details).some(v => v !== null) ? details : null;
}

// ── Tax Extraction ────────────────────────────────────────────────────────────
// Extract and save tax transactions from voucher ledger entries.
// Called after voucher + ledger entries are committed. Never throws — isolates
// tax extraction failures from the main sync.
async function extractAndSaveTaxTransactions(voucherGuid, companyGuid, voucherRow) {
  try {
    const { rows: lines } = await dbQuery(
      `SELECT vle.ledger_name, vle.amount, vle.dr_cr, l.parent, l.nature
       FROM voucher_ledger_entries vle
       LEFT JOIN ledgers l ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
       WHERE vle.voucher_guid = $1 AND vle.company_guid = $2`,
      [voucherGuid, companyGuid]
    );

    for (const line of lines) {
      const taxType = classifyTaxLedger({
        ledgerName:   line.ledger_name,
        ledgerParent: line.parent || '',
        ledgerGroup:  line.nature || '',
      });
      if (!taxType) continue;

      const nature = inferTransactionNature(voucherRow.voucher_type || '', line.ledger_name);

      await dbQuery(`
        INSERT INTO tax_transactions (
          company_guid, voucher_guid, voucher_alter_id,
          voucher_number, voucher_type, voucher_date,
          party_ledger_name, tax_type, tax_ledger_name,
          tax_ledger_parent, tax_amount, transaction_nature,
          financial_year, narration
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (company_guid, voucher_guid, tax_type, tax_ledger_name, voucher_alter_id)
        DO UPDATE SET
          tax_amount   = EXCLUDED.tax_amount,
          -- Never overwrite a real date with null (use COALESCE to keep existing date if new value is null)
          voucher_date = COALESCE(EXCLUDED.voucher_date, tax_transactions.voucher_date),
          synced_at    = NOW()
      `, [
        companyGuid, voucherGuid, 0,
        voucherRow.voucher_number, voucherRow.voucher_type, voucherRow.date,
        voucherRow.party_name, taxType, line.ledger_name,
        line.parent || null, Math.abs(parseFloat(line.amount) || 0),
        nature, voucherRow.financial_year, voucherRow.narration,
      ]);
    }
  } catch (e) {
    // Never break sync on tax extraction failure
    console.warn('[TaxExtract] error for', voucherGuid, e.message);
  }
}

// Backfill all existing vouchers for a company → extract tax transactions.
// Call once per company after deploying this feature.
export async function backfillTaxTransactions(companyGuid) {
  const { rows: vouchers } = await dbQuery(
    'SELECT guid, voucher_number, voucher_type, date, party_name, financial_year, narration FROM vouchers WHERE company_guid=$1 AND is_cancelled=FALSE',
    [companyGuid]
  );
  for (const v of vouchers) {
    await extractAndSaveTaxTransactions(v.guid, companyGuid, {
      voucher_number: v.voucher_number,
      voucher_type:   v.voucher_type,
      date:           v.date,
      party_name:     v.party_name,
      financial_year: v.financial_year,
      narration:      v.narration,
    });
  }
  console.log(`[TaxBackfill] Processed ${vouchers.length} vouchers for ${companyGuid}`);
  return vouchers.length;
}

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

// Like findNestedArray but only returns arrays/items that are objects (not primitives like counts)
// Searches through JSON strings too. Collects from ALL items in the input array.
function findNestedArrayOfObjects(dataArr, keys, depth = 0) {
  const results = [];
  for (const item of (Array.isArray(dataArr) ? dataArr : [dataArr])) {
    _collectObjects(item, keys, results, 0);
  }
  return results;
}
function _collectObjects(obj, keys, results, depth) {
  if (!obj || depth > 10) return;
  // Parse JSON strings
  if (typeof obj === 'string' && (obj.startsWith('{') || obj.startsWith('['))) {
    try { obj = JSON.parse(obj); } catch { return; }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) _collectObjects(item, keys, results, depth + 1);
    return;
  }
  if (typeof obj !== 'object') return;
  for (const k of keys) {
    if (obj[k] !== undefined) {
      const v = obj[k];
      if (Array.isArray(v)) {
        const objs = v.filter(x => x && typeof x === 'object');
        if (objs.length > 0) { results.push(...objs); return; } // found real records
      } else if (v && typeof v === 'object') {
        results.push(v); return;
      }
      // v is a primitive (e.g. count 71) — skip and keep searching
    }
  }
  // Recurse into all values
  for (const key of Object.keys(obj)) {
    _collectObjects(obj[key], keys, results, depth + 1);
  }
}

// Extract name from Tally record — handles plain NAME, NAME.LIST (NATIVEMETHOD), and LANGUAGENAME.LIST multi-lang wrapper
function tallyName(r) {
  // Guard: xml2js returns arrays when duplicate <Name> tags exist (e.g. item has alias in same field)
  const pickFirst = (v) => Array.isArray(v) ? (v[0] || '') : v;
  if (r.NAME) return pickFirst(r.NAME);
  if (r.Name) return pickFirst(r.Name);
  if (r.name) return pickFirst(r.name);
  if (r.LEDGERNAME) return r.LEDGERNAME;
  // NATIVEMETHOD format: Name field comes as <NAME.LIST><NAME>...</NAME></NAME.LIST>
  const nl = r['NAME.LIST'];
  if (nl) {
    const nameVal = Array.isArray(nl) ? nl[0]?.NAME : nl?.NAME;
    if (nameVal) return typeof nameVal === 'string' ? nameVal : String(nameVal);
  }
  const ll = r['LANGUAGENAME.LIST'];
  if (ll) {
    const nll = Array.isArray(ll) ? ll[0]?.['NAME.LIST'] : ll['NAME.LIST'];
    if (nll) {
      // Guard: always coerce to string — nll or nll[0] could be an object
      const raw = Array.isArray(nll) ? nll[0]?.NAME || nll[0] : nll.NAME || nll;
      if (raw != null) return typeof raw === 'string' ? raw : (typeof raw === 'object' ? JSON.stringify(raw) : String(raw));
    }
  }
  return '';
}

// ── NATIVEMETHOD field extractors ─────────────────────────────────────────
// In Tally NATIVEMETHOD (LedgerFull.xml), GSTIN/address/state come in nested
// LIST structures rather than as direct fields.  These helpers check both
// the flat (old COLLECTION) path and the nested NATIVEMETHOD path.

function extractNativeGstin(r) {
  // Flat path (COLLECTION format / direct field)
  if (r.GSTIN && typeof r.GSTIN === 'string') return r.GSTIN;
  if (r.PARTYGSTIN && typeof r.PARTYGSTIN === 'string') return r.PARTYGSTIN;
  if (r.PartyGSTIN && typeof r.PartyGSTIN === 'string') return r.PartyGSTIN;
  if (r.GSTREGNO && typeof r.GSTREGNO === 'string') return r.GSTREGNO;
  if (r.GSTRegNo && typeof r.GSTRegNo === 'string') return r.GSTRegNo;
  if (r.GSTREGNUMBER && typeof r.GSTREGNUMBER === 'string') return r.GSTREGNUMBER;
  if (r.GSTREGISTRATIONNO && typeof r.GSTREGISTRATIONNO === 'string') return r.GSTREGISTRATIONNO;
  // NATIVEMETHOD: GSTREGISTRATIONDETAILS.LIST → GSTREGISTRATIONDETAILS → GSTIN/GSTINNo/GSTRegNo
  for (const listKey of ['GSTREGISTRATIONDETAILS.LIST', 'GSTRegistrationDetails.LIST', 'GSTREGISTRATIONDETAILS']) {
    const raw = r[listKey];
    if (!raw) continue;
    const item = Array.isArray(raw) ? raw[0] : raw;
    const det = item?.GSTREGISTRATIONDETAILS || item?.GSTRegistrationDetails || item;
    if (!det) continue;
    const d = Array.isArray(det) ? det[0] : det;
    const gstin = d?.GSTIN || d?.GSTINNo || d?.GSTINNO || d?.GSTRegNo || d?.GSTREGNO || d?.GSTREGNUMBER || d?.REGISTRATIONNO;
    if (gstin && typeof gstin === 'string' && gstin.trim()) return gstin.trim();
  }
  return null;
}

function extractNativeGstRegType(r) {
  // Flat path
  if (r.GSTREGISTRATIONTYPE) return r.GSTREGISTRATIONTYPE;
  if (r.Gstregistrationtype) return r.Gstregistrationtype;
  if (r.GSTRegistrationType) return r.GSTRegistrationType;
  // NATIVEMETHOD nested path — same list as GSTIN
  const raw = r['GSTREGISTRATIONDETAILS.LIST'];
  if (raw) {
    const item = Array.isArray(raw) ? raw[0] : raw;
    const det = item?.GSTREGISTRATIONDETAILS;
    if (det) {
      const d = Array.isArray(det) ? det[0] : det;
      if (d?.REGISTRATIONTYPE) return d.REGISTRATIONTYPE;
      if (d?.GSTREGISTRATIONTYPE) return d.GSTREGISTRATIONTYPE;
    }
  }
  return null;
}

function extractNativeAddress(r) {
  // Flat path (COLLECTION format)
  if (r.MAILINGADDRESS && typeof r.MAILINGADDRESS === 'string') return r.MAILINGADDRESS;
  if (r.Address && typeof r.Address === 'string') return r.Address;
  // NATIVEMETHOD: MAILINGADDRESS.LIST → MAILINGADDRESS (string or array)
  const mal = r['MAILINGADDRESS.LIST'];
  if (mal) {
    const item = Array.isArray(mal) ? mal[0] : mal;
    const ma = item?.MAILINGADDRESS;
    if (ma) return Array.isArray(ma) ? ma.filter(Boolean).join(', ') : String(ma);
  }
  // Fallback: ADDRESS.LIST
  const al = r['ADDRESS.LIST'];
  if (al) {
    const item = Array.isArray(al) ? al[0] : al;
    const a = item?.ADDRESS;
    if (a) return Array.isArray(a) ? a.filter(Boolean).join(', ') : String(a);
  }
  return null;
}

function extractNativeStateName(r) {
  if (r.LEDSTATENAME) return r.LEDSTATENAME;
  if (r.LedStateName) return r.LedStateName;
  if (r.StateName) return r.StateName;
  // NATIVEMETHOD flat fields for mailing state
  if (r.MAILINGSTATE) return r.MAILINGSTATE;
  if (r.MailingState) return r.MailingState;
  // NATIVEMETHOD: LEDSTATEDETAILS.LIST → LEDSTATEDETAILS → STATENAME
  const raw = r['LEDSTATEDETAILS.LIST'];
  if (raw) {
    const item = Array.isArray(raw) ? raw[0] : raw;
    const det = item?.LEDSTATEDETAILS;
    if (det) {
      const d = Array.isArray(det) ? det[0] : det;
      if (d?.STATENAME) return d.STATENAME;
      if (d?.NAME) return d.NAME;
    }
  }
  return null;
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

// V2: Optionally store raw records before processing (TALLY_STORE_RAW=true env var)
const STORE_RAW = process.env.TALLY_STORE_RAW === 'true';

// Detect if a Tally alias/part-number value looks like a barcode
// Rules: 8-32 chars, no spaces, mostly numeric (>=70%) or TDK-prefixed internal codes
function _tallyAliasMayBeBarcode(val) {
  if (!val) return false;
  const v = String(val).trim();
  if (v.length < 8 || v.length > 32) return false;
  if (/\s/.test(v)) return false;
  if (!/^[A-Za-z0-9\-\.]+$/.test(v)) return false;
  const numRatio = (v.match(/[0-9]/g) || []).length / v.length;
  return numRatio >= 0.7 || v.startsWith('TDK');
}

// Derive parent voucher type from custom Tally voucher type name
function deriveVoucherTypeParent(voucherType) {
  if (!voucherType) return voucherType;
  const vt = voucherType.toLowerCase();
  if (vt.includes('credit note') || vt.includes('sales return')) return 'Credit Note';
  if (vt.includes('debit note') || vt.includes('purchase return')) return 'Debit Note';
  if (vt.includes('sales') || vt.includes('invoice') || vt.includes('retail')) return 'Sales';
  if (vt.includes('purchase')) return 'Purchase';
  if (vt.includes('journal') || vt.includes('adjustment')) return 'Journal';
  if (vt.includes('payment')) return 'Payment';
  if (vt.includes('receipt')) return 'Receipt';
  if (vt.includes('contra')) return 'Contra';
  return voucherType;
}
async function maybeStoreRaw(records, companyGuid, streamName) {
  if (!STORE_RAW || !records?.length) return;
  const client = await getClient();
  try {
    for (const r of records.slice(0, 1000)) { // cap at 1000 per call to avoid overload
      await client.query(
        `INSERT INTO raw_tally_records (upload_id, company_guid, financial_year, record_type, source_xml, payload, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        [r.UPLOAD_ID || null, companyGuid, r._FINANCIAL_YEAR || null, r._RECORD_TYPE || streamName, r.XML || null, JSON.stringify(r)]
      );
    }
  } catch (err) {
    console.warn('[RAW] store failed (non-fatal):', err.message);
  } finally {
    client.release();
  }
}

export async function processIngestedData(streamName, data, companyGuid, userId, deviceId) {
  if (!data?.length || !companyGuid) return;
  // V2: optionally persist raw records for debugging/reprocessing
  await maybeStoreRaw(data, companyGuid, streamName);

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
      } else if (xml === 'StockValuation.xml') {
        await processStockFyValuation(records, companyGuid);
      } else if (xml === 'OpeningBalanceDiff.xml') {
        await processOpeningBalanceDiff(records, companyGuid);
      } else if (xml === 'StockFYBalance.xml') {
        await processStockFyBalance(records, companyGuid);
        // After saving FY balance, apply current FY closing_qty to stocks table
        await applyCurrentFyClosingQty(companyGuid);
      } else if (xml === 'LedgerOpeningBalance.xml') {
        await processLedgerFyBalances(records, companyGuid);
      } else if (xml === 'StockCategory.xml') {
        // CTO Spec: dedicated stock_categories table
        await processStockCategories(records, companyGuid);
      } else if (xml === 'VoucherInventoryDetail.xml') {
        // Also extract batch allocations from inventory detail
        const withBatch = records.filter(r => r.BATCHNAME || r.BatchName || r.BATCHALLOCNAME);
        if (withBatch.length > 0) await processBatchAllocations(withBatch, companyGuid);
        await processVoucherInventoryItems(records, companyGuid);
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
      // Tally convention: positive balance = Cr, negative = Dr (same as LFB parsing)
      const balType = balStr.includes('Cr') ? 'Cr' : (balStr.includes('Dr') ? 'Dr' : (balNum >= 0 ? 'Cr' : 'Dr'));

      // Skip inserting from processMasters if a company-prefixed GUID row already exists for this name
      // (prevents ghost duplicates from Master.xml overwriting or duplicating LedgerFull.xml rows)
      const isCompanyPrefixedGuid = guid.startsWith(companyGuid);
      if (!isCompanyPrefixedGuid) {
        const existing = await client.query(
          `SELECT 1 FROM ledgers WHERE company_guid=$1 AND name=$2 AND guid LIKE $3 LIMIT 1`,
          [companyGuid, name, companyGuid + '%']
        );
        if (existing.rows.length > 0) { continue; } // proper row exists — skip ghost
      }
      try {
        // Remove any placeholder row (random UUID from immediate tally-write insert) before inserting real Tally row
        await client.query(
          `DELETE FROM ledgers WHERE company_guid = $1 AND LOWER(name) = LOWER($2) AND guid != $3`,
          [companyGuid, name, guid]
        );
        await client.query(`
          INSERT INTO ledgers (guid, company_guid, name, parent, alias, gstin, pan, phone, email, address, opening_balance, closing_balance, balance_type, alter_id, synced_at, gst_registration_type, state_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, alias=EXCLUDED.alias,
            gstin=EXCLUDED.gstin, pan=EXCLUDED.pan, phone=EXCLUDED.phone,
            email=EXCLUDED.email, address=EXCLUDED.address,
            opening_balance=EXCLUDED.opening_balance, closing_balance=EXCLUDED.closing_balance,
            balance_type=EXCLUDED.balance_type, alter_id=EXCLUDED.alter_id,
            synced_at=EXCLUDED.synced_at,
            gst_registration_type=EXCLUDED.gst_registration_type, state_name=EXCLUDED.state_name
        `, [
          guid, companyGuid, name, parent,
          r.ALIAS || r.LANGUAGENAME2 || null,
          extractNativeGstin(r),
          r.PAN || r.INCOMETAXNUMBER || null,
          r.LEDGERMOBILE || r.LedgerMobile || r.LEDPHONE || r.PHONE || null,
          r.LEDGEREMAIL || r.LedgerEmail || r.EMAIL || r.Email || null,
          extractNativeAddress(r),
          parseFloat(String(r.OPENINGBALANCE || '0').replace(/[^0-9.-]/g, '')) || 0,
          Math.abs(balNum), balType,
          parseInt(r.AlterId || r.ALTERID || 0),
          now(),
          extractNativeGstRegType(r),
          r.LEDSTATENAME || r.LedStateName || r.STATENAME || r.MAILINGSTATE || null,
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

    // StockItemFull.xml — Tally Collection format wraps items in BODY.DATA.TALLYMESSAGE.STOCKITEM[]
    // CMPINFO also has STOCKITEM as a numeric count — we must skip primitives and find the real array of objects.
    let expandedStockData = data;
    if (data.length <= 5) {
      const found = findNestedArrayOfObjects(data, ['STOCKITEM', 'StockItem', 'STOCKITEMREPORT']);
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
          INSERT INTO stocks (guid, company_guid, name, alias, sku, description, category, group_name, unit, hsn, tax_rate, closing_qty, closing_rate, closing_value, reorder_level, minimum_order_qty, alter_id, batch_enabled, expiry_enabled, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, alias=EXCLUDED.alias, sku=EXCLUDED.sku, description=EXCLUDED.description,
            category=EXCLUDED.category,
            group_name=EXCLUDED.group_name, unit=EXCLUDED.unit, hsn=EXCLUDED.hsn,
            tax_rate=EXCLUDED.tax_rate, closing_qty=EXCLUDED.closing_qty,
            closing_rate=EXCLUDED.closing_rate, closing_value=EXCLUDED.closing_value,
            reorder_level=EXCLUDED.reorder_level, minimum_order_qty=EXCLUDED.minimum_order_qty,
            alter_id=EXCLUDED.alter_id,
            batch_enabled=EXCLUDED.batch_enabled, expiry_enabled=EXCLUDED.expiry_enabled,
            synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name,
          r.OnlyAlias || r.ALIAS || null,                                        // alias
          r.PartNumber || r.PARTNUMBER || r.OnlyAlias || r.ALIAS || null,        // sku (PartNumber from XML, fallback to alias)
          r.Description || r.DESCRIPTION || null,                               // description
          r.Category || r.CATEGORY || r.STOCKCATEGORY || null,
          r.Parent || r.PARENT || r.GROUP || null,
          r.BaseUnits || r.BASEUNITS || r.UNIT || r.unit || 'Pcs',
          r.Hsncode || r.HSNDETAILS?.[0]?.HSNCODE || r.HSN || null,
          parseFloat(r.IGSTRate || r.GSTRATE || r.TAXRATE || 18),
          0, // closing_qty — will be set by stock transaction recompute
          0, // closing_rate
          0, // closing_value
          parseTallyQty(r.REORDERLEVEL || r.ReorderLevel || r.reorderlevel || 0),
          parseTallyQty(r.MINIMUMORDERQTY || r.MinimumOrderQty || r.MINIMUMORDERQUANTITY || r.MinimumOrderQuantity || 0),
          parseInt(r.ALTERID || r.AlterId || 0),
          // Gap 4: batch & expiry flags from StockItem.xml (IsBatchWise / IsExpDtMaint)
          (r.MAINTAININBATCHES === 'Yes' || r.MaintainInBatches === 'Yes'),
          (r.USEEXPIRYDATES    === 'Yes' || r.UseExpirydates    === 'Yes'),
          now(),
        ]);
        saved++;

        // Auto-detect barcode-like aliases from Tally and seed stock_barcodes
        const aliasVal = r.OnlyAlias || r.ALIAS || r.PartNumber || r.PARTNUMBER || null;
        if (aliasVal && _tallyAliasMayBeBarcode(String(aliasVal))) {
          try {
            await client.query(`
              INSERT INTO stock_barcodes (company_guid, stock_guid, stock_name, barcode, barcode_type, source, status, is_primary, sync_target, tally_sync_status)
              VALUES ($1, $2, $3, $4, 'CODE128', 'tally', 'active', TRUE, 'app_only', 'not_required')
              ON CONFLICT (company_guid, barcode) DO NOTHING`,
              [companyGuid, guid, name, String(aliasVal).trim()]);
          } catch (_) { /* non-critical — skip silently */ }
        }
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
    const voucherRowsForTax    = []; // Collect for post-commit tax extraction
    const allBatchFlatRecords  = []; // Gap 1: collect nested batch allocs from AllVoucher.xml → Batchallocations

    for (const r of data) {
      const guid = r.GUID || r.Guid || r.guid || '';
      if (!guid) continue;

      const voucherNumber = r.VoucherNumber || r.VOUCHERNUMBER || (r.F02 !== undefined ? String(r.F02) : null) || null;
      // VoucherType is the field name in AllVoucher.xml; VoucherTypeName in SimplifiedVoucher / Voucher.xml
      const voucherType   = r.VoucherTypeName || r.VOUCHERTYPENAME || r.VoucherType || r.voucherType || 'Voucher';
      const date          = normalizeDate(r.Date || r.DATE || r.date);
      const isCancelled   = (r.ISCANCELLED === 'Yes' || r.IsCancelled === 'Yes' || r.ISCANCELLED === true);
      const isOptional    = !!(r.ISOPTIONAL === 1 || r.ISOPTIONAL === '1' || r.isOptional === 1 || r.isOptional === '1' || r.IsOptional === 'Yes' || r.ISOPTIONAL === 'Yes');
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
        // Extract dispatch / EWB details from TallyPrime XML
        const dispatchDetails = extractDispatchDetails(r);

        await client.query(`
          INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, voucher_type_parent, date, party_name, party_guid, amount, narration, reference, is_cancelled, is_optional, alter_id, raw_data, synced_at, financial_year, dispatch_details)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            -- COALESCE: never overwrite real data with null (prevents SimplifiedVoucher stubs from wiping AllVoucher.xml data)
            voucher_number      = COALESCE(EXCLUDED.voucher_number, vouchers.voucher_number),
            voucher_type        = CASE WHEN EXCLUDED.voucher_type = 'Voucher' THEN COALESCE(vouchers.voucher_type, 'Voucher') ELSE EXCLUDED.voucher_type END,
            voucher_type_parent = COALESCE(EXCLUDED.voucher_type_parent, vouchers.voucher_type_parent),
            date                = COALESCE(EXCLUDED.date, vouchers.date),
            party_name          = COALESCE(EXCLUDED.party_name, vouchers.party_name),
            party_guid          = COALESCE(EXCLUDED.party_guid, vouchers.party_guid),
            amount              = CASE WHEN EXCLUDED.amount = 0 AND vouchers.amount != 0 THEN vouchers.amount ELSE EXCLUDED.amount END,
            narration           = COALESCE(EXCLUDED.narration, vouchers.narration),
            reference           = COALESCE(EXCLUDED.reference, vouchers.reference),
            is_cancelled        = EXCLUDED.is_cancelled,
            is_optional         = EXCLUDED.is_optional OR vouchers.is_optional,
            alter_id            = GREATEST(EXCLUDED.alter_id, vouchers.alter_id),
            raw_data            = CASE WHEN EXCLUDED.raw_data IS NULL OR EXCLUDED.raw_data = 'null' THEN vouchers.raw_data ELSE EXCLUDED.raw_data END,
            financial_year      = COALESCE(EXCLUDED.financial_year, vouchers.financial_year),
            dispatch_details    = COALESCE(EXCLUDED.dispatch_details, vouchers.dispatch_details),
            synced_at           = EXCLUDED.synced_at
        `, [
          guid, companyGuid, voucherNumber, voucherType, deriveVoucherTypeParent(voucherType), date,
          // PartyName is the field in AllVoucher.xml; PartyLedgerName in Voucher.xml
          r.PartyName || r.PartyLedgerName || r.PARTYLEDGERNAME || r.PARTYNAME || r.partyName || null,
          partyGuid,
          amount,
          r.Narration || r.NARRATION || r.narration || null,
          r.Reference || r.REFERENCE || r.reference || null,
          isCancelled,
          isOptional,
          parseInt(r.AlterId || r.ALTERID || 0),
          JSON.stringify(r).slice(0, 10000),
          now(),
          r._FINANCIAL_YEAR || null,
          dispatchDetails ? JSON.stringify(dispatchDetails) : null,
        ]);
        saved++;
        voucherRowsForTax.push({
          guid,
          row: {
            voucher_number: voucherNumber,
            voucher_type:   voucherType,
            date,
            party_name:     r.PartyName || r.PartyLedgerName || r.PARTYLEDGERNAME || r.PARTYNAME || r.partyName || null,
            financial_year: r._FINANCIAL_YEAR || null,
            narration:      r.Narration || r.NARRATION || r.narration || null,
          },
        });

        // Ledger line items — use parseLedgerEntries with correct Dr/Cr from amount sign
        const parsedLedgerEntries = parseLedgerEntries(r);
        if (parsedLedgerEntries.length > 0) {
          await saveLedgerEntries(client, guid, companyGuid, parsedLedgerEntries, r._FINANCIAL_YEAR || null);
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

            // Gap 1: Extract nested Batchallocations from AllVoucher.xml inventory entries
            const batchAllocs = entry.BATCHALLOCATIONS || entry.Batchallocations || entry.BatchAllocations || [];
            if (Array.isArray(batchAllocs) && batchAllocs.length > 0) {
              const itemName = entry.STOCKITEMNAME || entry.Stockitemname || entry.StockItemName || '';
              for (const ba of batchAllocs) {
                allBatchFlatRecords.push({
                  VoucherGuid:       guid,
                  StockItemName:     itemName,
                  BatchName:         ba.BATCHNAME  || ba.Batchname  || ba.BatchName  || '',
                  GodownName:        ba.GODOWNNAME || ba.Godownname || ba.GodownName || '',
                  // Gap 2: prefer ActualQty (physical), fallback to BilledQty
                  ActualQty:         ba.ACTUALQTY  || ba.ActualQty  || ba.BILLEDQTY  || ba.BilledQty  || 0,
                  Rate:              ba.RATE        || ba.Rate        || 0,
                  // Gap 3: ExpiryDate (formatted YYYY-MM-DD from XML), ExpiryPeriod (text fallback)
                  ExpiryDate:        ba.EXPIRYDATE  || ba.ExpiryDate  || '',
                  ExpiryPeriod:      ba.EXPIRYPERIOD || ba.ExpiryPeriod || '',
                  ManufacturingDate: ba.MANUFACTURINGDATE || ba.ManufacturingDate || ba.MFGDATE || ba.MfgDate || '',
                  _FINANCIAL_YEAR:   r._FINANCIAL_YEAR || null,
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn('[DB] Voucher insert failed:', e.message, '| guid:', guid);
      }

      // ── Optional → Regular reconciliation ────────────────────────────────────────────
      // When Tally syncs back a voucher whose reference starts with TDK-OPT- but
      // is now regular (ISOPTIONAL not set), update app_vouchers + emit WS event.
      try {
        const ref = r.Reference || r.REFERENCE || r.reference || '';
        if (!isOptional && ref && ref.startsWith('TDK-OPT-')) {
          const { rows: avRows } = await dbQuery(
            `SELECT id, current_entry_type FROM app_vouchers
             WHERE tdk_reference_no = $1 AND company_guid = $2`,
            [ref, companyGuid]
          );
          if (avRows.length > 0 && avRows[0].current_entry_type === 'optional') {
            await dbQuery(`
              UPDATE app_vouchers
              SET current_entry_type  = 'regular',
                  books_impact_status = 'posted',
                  conversion_status   = 'converted',
                  tally_voucher_no    = COALESCE($1, tally_voucher_no),
                  tally_sync_status   = 'synced',
                  updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
              WHERE id = $2
            `, [voucherNumber, avRows[0].id]);
            console.log(`[reconcile] Optional→Regular: ${ref} → ${voucherNumber}`);
            emitVoucherRegularized(companyGuid, ref, voucherNumber);
          }
        }
      } catch (reconcileErr) {
        console.error('[reconcile] optional→regular error:', reconcileErr.message);
      }

      // ── Regular TDK reconciliation ─────────────────────────────────────────────────────
      // When a TDK- (non-optional) voucher syncs back from Tally, update app_vouchers
      // with the assigned Tally voucher number if it hasn't been set yet.
      // This fixes the bug where the Tally voucher number never came back to the app.
      try {
        const ref2 = r.Reference || r.REFERENCE || r.reference || '';
        if (voucherNumber && ref2 && ref2.startsWith('TDK-') && !ref2.startsWith('TDK-OPT-')) {
          const { rows: avRegRows } = await dbQuery(
            `UPDATE app_vouchers
             SET tally_voucher_no    = $1,
                 tally_sync_status   = 'synced',
                 books_impact_status = 'posted',
                 updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
             WHERE tdk_reference_no = $2
               AND company_guid     = $3
               AND (tally_voucher_no IS NULL OR tally_sync_status != 'synced')
             RETURNING company_guid, tdk_reference_no`,
            [voucherNumber, ref2, companyGuid]
          );
          if (avRegRows.length > 0) {
            const { company_guid: cg, tdk_reference_no: tRef } = avRegRows[0];
            emitVoucherSynced(cg, tRef, voucherNumber);
            console.log(`[reconcile] Regular TDK voucher synced: ${tRef} → ${voucherNumber}`);
          }
        }
      } catch (regRecErr) {
        console.error('[reconcile] regular TDK error:', regRecErr.message);
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] Vouchers: saved ${saved}/${data.length} for ${companyGuid}`);

    // Gap 1: Persist batch allocations extracted from nested AllVoucher.xml → Batchallocations
    // Runs post-commit with its own transaction; never blocks or rolls back voucher ingestion
    if (allBatchFlatRecords.length > 0) {
      await processBatchAllocations(allBatchFlatRecords, companyGuid);
    }

    // Batch JOIN reconciliation — handles SimplifiedVoucher.xml which omits REFERENCE field.
    // When Tally sends incremental sync data without REFERENCE, the per-record reconciliation
    // above cannot match TDK refs. This JOIN-based sweep catches any remaining gaps.
    // Safe & idempotent — only updates rows where tally_voucher_no IS NULL.
    try {
      const { rows: reconRows } = await dbQuery(`
        UPDATE app_vouchers av
        SET tally_voucher_no    = v.voucher_number,
            tally_sync_status   = 'synced',
            books_impact_status = 'posted',
            updated_at          = EXTRACT(EPOCH FROM NOW())::BIGINT
        FROM vouchers v
        WHERE v.reference      = av.tdk_reference_no
          AND v.company_guid   = av.company_guid
          AND av.company_guid  = $1
          AND av.tally_voucher_no IS NULL
          AND v.voucher_number IS NOT NULL
          AND v.voucher_number != ''
        RETURNING av.company_guid, av.tdk_reference_no, v.voucher_number
      `, [companyGuid]);
      for (const row of reconRows) {
        emitVoucherSynced(row.company_guid, row.tdk_reference_no, row.voucher_number);
        console.log(`[reconcile] Batch JOIN reconciled: ${row.tdk_reference_no} → ${row.voucher_number}`);
      }
    } catch (batchReconErr) {
      console.warn('[reconcile] Batch JOIN reconciliation error (non-fatal):', batchReconErr.message);
    }

    // Tax extraction — runs after COMMIT so ledger entries are visible
    // Never blocks or throws; failures are logged only
    for (const { guid: vGuid, row } of voucherRowsForTax) {
      await extractAndSaveTaxTransactions(vGuid, companyGuid, row);
    }
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

    // Clear existing entries for all vouchers in this batch (idempotent re-sync)
    // Prevents duplicate rows from batch allocations / multiple sync runs
    const uniqueVoucherGuids = [...new Set(data.map(r => r.GUID || r.Guid).filter(Boolean))];
    if (uniqueVoucherGuids.length > 0) {
      await client.query(
        `DELETE FROM stock_transactions WHERE company_guid=$1 AND voucher_guid = ANY($2::text[])`,
        [companyGuid, uniqueVoucherGuids]
      );
    }

    // ── Stock Journal transfer detection ──────────────────────────────────
    // When SimplifiedVoucher.xml omits DestinationGodownName, both source and
    // destination entries of a godown transfer are received with positive qty
    // and rate=0/value=0, making them indistinguishable without extra context.
    // Fix: group entries by (voucher, stockItem) and if all entries for that
    // item within a Stock Journal have rate=0 AND count >= 2 across different
    // godowns → it's a pure transfer (net=0). Mark the FIRST entry as outward.
    const stockJournalTransferKeys = new Set();
    const sjGroups = {};
    for (const r of data) {
      const vtype = (r.VOUCHERTYPENAME || r.VoucherTypeName || '').toLowerCase();
      // Include both explicit Stock Journal type AND entries with no voucher type
      // (SimplifiedVoucher.xml omits VOUCHERTYPENAME — detect by zero-cost signature)
      const stockName = r.STOCKITEMNAME || r.StockItemName || r.stockGuid || '';
      if (!stockName) continue;
      const rate = parseTallyRate(r.RATE || r.Rate || '0');
      const rawAmt = parseFloat(r.AMOUNT ?? r.Amount ?? r.value ?? 0);
      if (rate !== 0 || Math.abs(rawAmt || 0) !== 0) continue; // not zero-cost — skip
      const key = `${r.GUID || r.Guid}|${stockName}`;
      if (!sjGroups[key]) sjGroups[key] = [];
      sjGroups[key].push({ r, rate, amount: Math.abs(rawAmt || 0) });
    }
    for (const [key, entries] of Object.entries(sjGroups)) {
      // Transfer signature: same item in 2+ different godowns, all zero-cost
      const godowns = new Set(entries.map(e => e.r.GODOWNNAME || e.r.GodownName || ''));
      if (godowns.size >= 2) {
        // Tally SimplifiedVoucher.xml sends DESTINATION entry first, SOURCE entry last.
        // Mark the LAST entry (highest index = source godown) as outward.
        const srcEntry = entries[entries.length - 1];
        stockJournalTransferKeys.add(`${key}|${srcEntry.r.GODOWNNAME || srcEntry.r.GodownName || ''}`);
      }
    }

    for (const r of data) {
      // StockTransaction.xml: Tally sends ALL keys uppercase
      const stockName = r.STOCKITEMNAME || r.StockItemName || r.stockGuid || '';
      if (!stockName) continue;
      // parseTallyQty handles '(-)20', '-20', '20 nos' formats
      const rawQty = parseTallyQty(r.ACTUALQTY || r.ActualQty || r.qty || '0');
      const qty    = isNaN(rawQty) ? 0 : rawQty;
      const rawAmt = parseFloat(r.AMOUNT ?? r.Amount ?? r.value ?? 0);
      const amount = isNaN(rawAmt) ? 0 : rawAmt;
      const rate   = parseTallyRate(r.RATE || r.Rate || '0');
      // Value = Tally's computed amount. If 0 or missing, fallback to qty * rate
      const value  = Math.abs(amount) > 0 ? Math.abs(amount) : Math.abs(qty) * rate;
      // Determine direction: negative qty = outward (sales/issue), positive = inward (purchase/receipt)
      // For Stock Journal transfers: DestinationGodownName is set ONLY on the source (outward) entry.
      // If SimplifiedVoucher.xml omits it, fall back to transfer detection above.
      const vtype = (r.VOUCHERTYPENAME || r.VoucherTypeName || '').toLowerCase();
      const destGodown = (r.DestinationGodownName || r.DESTINATIONGODOWNNAME || '').trim();
      const sjTransferKey = `${r.GUID || r.Guid}|${stockName}|${r.GODOWNNAME || r.GodownName || ''}`;
      // purchase / receipt = always inward (stock coming IN from supplier)
      // debit note = purchase return = outward (stock going BACK to supplier) — correct as-is
      // sales / delivery note = always outward
      // credit note = sales return = inward (stock coming BACK from customer)
      const isForceInward  = vtype.includes('purchase') || vtype.includes('receipt') || vtype.includes('credit note');
      const isForceOutward = vtype.includes('sales') || vtype.includes('delivery note') || vtype.includes('debit note');
      const isOutward = isForceOutward || (!isForceInward && (
        qty < 0 || !!destGodown || vtype.includes('issue') ||
        stockJournalTransferKeys.has(sjTransferKey)
      ));
      const type = isOutward ? 'outward' : 'inward';
      // Normalize warehouse — treat empty string same as NULL to avoid duplicate key issues
      const warehouse = r.GODOWNNAME || r.GodownName || null;

      try {
        await client.query(`
          INSERT INTO stock_transactions (stock_guid, company_guid, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (stock_guid, company_guid, voucher_guid, warehouse, type) DO UPDATE SET
            qty=EXCLUDED.qty, rate=EXCLUDED.rate, value=EXCLUDED.value, synced_at=EXCLUDED.synced_at
        `, [
          stockName,
          companyGuid,
          r.GUID || r.Guid || null,
          r.VOUCHERTYPENAME || r.VoucherTypeName || null,
          normalizeDate(r.DATE || r.Date || r.date),
          Math.abs(qty),
          rate,
          value,
          type,
          warehouse,
          now(),
        ]);
        saved++;
      } catch (e) { console.warn("[DB] Insert failed:", e.message, JSON.stringify(r).slice(0,200)); }
    }

    await client.query('COMMIT');
    // Post-insert direction correction: join with vouchers table to fix
    // Purchase/Receipt vouchers stored as 'outward' (SimplifiedVoucher.xml sends
    // negative qty for purchase batch allocations, tripping the qty<0 check).
    // This is the safety net for cases where VOUCHERTYPENAME is missing in the XML.
    if (uniqueVoucherGuids.length > 0) {
      await client.query(`
        UPDATE stock_transactions st
        SET type = CASE
          WHEN v.voucher_type IN ('Purchase','Receipt','Credit Note') THEN 'inward'
          WHEN v.voucher_type IN ('Sales','Delivery Note','Debit Note') THEN 'outward'
          ELSE st.type
        END
        FROM vouchers v
        WHERE st.voucher_guid = v.guid
          AND st.company_guid = v.company_guid
          AND st.company_guid = $1
          AND st.voucher_guid = ANY($2::text[])
          AND v.voucher_type IN ('Purchase','Receipt','Credit Note','Sales','Delivery Note','Debit Note')
          AND (
            (v.voucher_type IN ('Purchase','Receipt','Credit Note') AND st.type = 'outward') OR
            (v.voucher_type IN ('Sales','Delivery Note','Debit Note') AND st.type = 'inward')
          )
      `, [companyGuid, uniqueVoucherGuids]);
    }
    // Backfill voucher_type from vouchers table where NULL.
    // SimplifiedVoucher.xml omits VOUCHERTYPENAME, leaving stock_transactions.voucher_type = NULL.
    // This causes the transaction type filter to return no results.
    if (uniqueVoucherGuids.length > 0) {
      await client.query(`
        UPDATE stock_transactions st
        SET voucher_type = v.voucher_type
        FROM vouchers v
        WHERE st.voucher_guid = v.guid
          AND st.company_guid = v.company_guid
          AND st.company_guid = $1
          AND st.voucher_guid = ANY($2::text[])
          AND (st.voucher_type IS NULL OR st.voucher_type = '')
          AND v.voucher_type IS NOT NULL AND v.voucher_type != ''
      `, [companyGuid, uniqueVoucherGuids]);
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
      SET closing_qty   = sub.net_qty,
          closing_rate  = sub.last_rate,
          closing_value = sub.net_qty * sub.last_rate
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

  // After transaction recompute, apply FY valuation as authoritative override.
  // stock_fy_valuation contains Tally's own closing balance (includes opening+movements)
  // and must win over our all-time-transaction net (which ignores opening balance).
  await applyCurrentFyClosingQty(companyGuid);
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
          INSERT INTO groups (guid, company_guid, name, parent, nature, is_revenue, is_debit_positive, is_primary, reorder_level, minimum_order_qty, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, nature=EXCLUDED.nature,
            is_revenue=EXCLUDED.is_revenue, is_debit_positive=EXCLUDED.is_debit_positive,
            is_primary=EXCLUDED.is_primary, reorder_level=EXCLUDED.reorder_level,
            minimum_order_qty=EXCLUDED.minimum_order_qty,
            alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at
        `, [
          guid, companyGuid, name,
          r.Parent || r.PARENT || null,
          r.NatureOfGroup || r.NATUREOFGROUP || null,
          !!(r.IsRevenue === 1 || r.IsRevenue === '1'),
          !!(r.IsDebitPositive === 1 || r.IsDebitPositive === '1'),
          !!(r.IsPrimary === 1 || r.IsPrimary === '1'),
          parseTallyQty(r.REORDERLEVEL || r.ReorderLevel || r.reorderlevel || 0),
          parseTallyQty(r.MINIMUMORDERQTY || r.MinimumOrderQty || r.MINIMUMORDERQUANTITY || r.MinimumOrderQuantity || 0),
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
      let found = [];

      // Parse BODY JSON string (normalizeEnvelope coerces objects to JSON strings)
      const bodyStr = data[0]?.BODY;
      let bodyObj = null;
      if (typeof bodyStr === 'string' && bodyStr.startsWith('{')) {
        try { bodyObj = JSON.parse(bodyStr); } catch {}
      }

      if (bodyObj) {
        // Case 1: NATIVEMETHOD format — DATA.TALLYMESSAGE is an array, each item wraps one LEDGER
        // Tally Prime returns each master in its own <TALLYMESSAGE> block with NATIVEMETHOD
        const tallymsg = bodyObj?.DATA?.TALLYMESSAGE;
        if (Array.isArray(tallymsg) && tallymsg.length > 0) {
          for (const msg of tallymsg) {
            const ledger = msg?.LEDGER || msg?.Ledger;
            if (ledger && typeof ledger === 'object') found.push(ledger);
          }
          console.log('[INGEST] FullLedger TALLYMESSAGE array expanded:', found.length, 'ledgers');
        }
        // Case 2: Regular COLLECTION format — DATA.COLLECTION.LEDGER is an array
        if (found.length === 0) {
          const collection = bodyObj?.DATA?.COLLECTION;
          if (collection) {
            const ledgers = collection?.LEDGER || collection?.Ledger;
            if (Array.isArray(ledgers)) found = ledgers;
            else if (ledgers && typeof ledgers === 'object') found = [ledgers];
          }
        }
      }

      // Case 3: Fallback to recursive findNestedArray (old behaviour)
      if (found.length === 0) {
        found = findNestedArray(data[0], ['LEDGER', 'Ledger']);
        console.log('[INGEST] FullLedger findNestedArray fallback result:', found.length, 'items');
      }

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
        // Remove any placeholder row (random UUID from immediate tally-write insert) before inserting real Tally row
        await client.query(
          `DELETE FROM ledgers WHERE company_guid = $1 AND LOWER(name) = LOWER($2) AND guid != $3`,
          [companyGuid, name, guid]
        );
        await client.query(`
          INSERT INTO ledgers (guid, company_guid, name, parent, alias, gstin, pan, phone, email, address,
            opening_balance, closing_balance, balance_type, is_revenue, alter_id, synced_at, gst_registration_type, state_name)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            name=EXCLUDED.name, parent=EXCLUDED.parent, alias=EXCLUDED.alias,
            gstin=EXCLUDED.gstin, pan=EXCLUDED.pan, phone=EXCLUDED.phone,
            email=EXCLUDED.email, address=EXCLUDED.address,
            opening_balance=EXCLUDED.opening_balance, closing_balance=EXCLUDED.closing_balance,
            balance_type=EXCLUDED.balance_type, is_revenue=EXCLUDED.is_revenue,
            alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at,
            gst_registration_type=EXCLUDED.gst_registration_type, state_name=EXCLUDED.state_name
        `, [
          guid, companyGuid, name,
          r.Parent || r.PARENT || null,
          r.ALIAS || r.Alias || r.OnlyAlias || null,
          extractNativeGstin(r),
          r.ITPAN || r.PAN || r.IncomeTaxNumber || null,
          // DEBUG: log raw GST fields for any ledger with null GSTIN (helps diagnose missing GSTINs)
          r.LEDGERMOBILE || r.LedgerMobile || r.PHONE || r.Phone || r.LedPhone || r.LedgerPhone || null,
          r.LEDGEREMAIL || r.LedgerEmail || r.EMAIL || r.Email || null,
          extractNativeAddress(r),
          Math.abs(parseFloat(String(r.OPENINGBALANCE ?? r.OpeningBalance ?? '0').replace(/[^0-9.-]/g, '')) || 0),
          Math.abs(balNum), balType,
          !!(r.ISREVENUE === 'Yes' || r.IsRevenue === 1 || r.IsRevenue === '1' || r.ISREVENUE === 1 || r.ISREVENUE === '1'),
          parseInt(r.ALTERID || r.AlterId || 0), now(),
          extractNativeGstRegType(r),
          extractNativeStateName(r),
        ]);
        saved++;
        // DEBUG: log raw GST-related fields for ledgers that still have no GSTIN after extraction
        if (!extractNativeGstin(r)) {
          const gstKeys = Object.entries(r).filter(([k]) =>
            k.toLowerCase().includes('gst') || k.toLowerCase().includes('gstin') ||
            k.toLowerCase().includes('registration') || k.toLowerCase().includes('statutory')
          );
          if (gstKeys.length > 0) {
            console.log(`[GST-DEBUG] ${name} — raw GST fields:`, JSON.stringify(Object.fromEntries(gstKeys)).slice(0, 500));
          }
        }
      } catch (e) { console.warn('[DB] FullLedger insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] FullLedger: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] FullLedger failed:', e.message); }
  finally { client.release(); }
}

// Parse AllLedgerEntries from a voucher record — handles JSON string or array
function parseLedgerEntries(r) {
  // Parse both AllLedgerEntries AND LedgerEntries — merge and deduplicate
  // AllLedgerEntries = main P&L entries; LedgerEntries = sub-entries some Tally versions use
  const parseList = (raw) => {
    let entries = raw;
    if (typeof entries === 'string') {
      try { entries = JSON.parse(entries); } catch { return []; }
    }
    if (!Array.isArray(entries)) {
      if (entries && typeof entries === 'object') entries = [entries];
      else return [];
    }
    return entries
      .map((e, i) => {
        const name = e.LEDGERNAME || e.Ledgername || e.LedgerName || e.ledgername || null;
        const guid = e.LEDGERGUID || e.LedgerGuid || e.ledgerGuid || null;
        const rawAmt = e.AMOUNT ?? e.Amount ?? e.amount;
        const amount = typeof rawAmt === 'string'
          ? parseFloat(String(rawAmt).replace('(-)', '-').replace(/[^0-9.-]/g, ''))
          : parseFloat(rawAmt || 0);
        if (!name || isNaN(amount)) return null;
        return { name, guid, amount, drCr: amount < 0 ? 'Dr' : 'Cr', index: i };
      })
      .filter(Boolean);
  };

  const allEntries = parseList(r.ALLLEDGERENTRIES ?? r.AllLedgerEntries ?? r.AllLedgerentries ?? r.Allledgerentries ?? []);
  const ledgerEntries = parseList(r.LEDGERENTRIES ?? r.LedgerEntries ?? r.Ledgerentries ?? []);

  // Merge: add ledgerEntries items that aren't already in allEntries (by ledger name)
  const seen = new Set(allEntries.map(e => e.name));
  const extra = ledgerEntries.filter(e => !seen.has(e.name));

  return [...allEntries, ...extra.map((e, i) => ({ ...e, index: allEntries.length + i }))];
}

// Save AllLedgerEntries for a voucher to voucher_ledger_entries table
// V2: includes financial_year from record metadata
async function saveLedgerEntries(client, voucherGuid, companyGuid, entries, financialYear) {
  if (!entries || entries.length === 0) return;
  // Delete existing entries for this voucher (idempotent re-sync)
  await client.query('DELETE FROM voucher_ledger_entries WHERE voucher_guid=$1 AND company_guid=$2', [voucherGuid, companyGuid]);
  for (const e of entries) {
    try {
      await client.query(
        `INSERT INTO voucher_ledger_entries (voucher_guid, company_guid, ledger_name, ledger_guid, amount, dr_cr, line_index, financial_year)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT DO NOTHING`,
        [voucherGuid, companyGuid, e.name, e.guid, e.amount, e.drCr, e.index, financialYear || null]
      );
    } catch (err) {
      console.warn('[DB] LedgerEntry insert failed:', err.message, e.name);
    }
  }
}

// V2: Process LedgerOpeningBalance.xml — stores per-FY opening balance per ledger
// Previously this was skipped. Now it populates ledger_fy_balances table.
async function processLedgerFyBalances(data, companyGuid) {
  if (!data || data.length === 0) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name  = r.NAME || r.Name || r.LEDGERNAME || r.LedgerName || '';
      const guid  = r.GUID || r.Guid || null;
      const fy    = r._FINANCIAL_YEAR || null;
      if (!name || !fy) continue;

      const balRaw  = String(r.OPENINGBALANCE || r.OpeningBalance || r.CLOSINGBALANCE || '0').replace('(-)', '-');
      const balNum  = parseFloat(balRaw.replace(/[^0-9.-]/g, '')) || 0;
      // Tally exports Dr as negative, Cr as positive (numeric). Also handle string 'Cr'/'Dr' suffixes.
      const balType = balRaw.includes('Cr') ? 'Cr' : (balRaw.includes('Dr') ? 'Dr' : (balNum >= 0 ? 'Cr' : 'Dr'));
      const balAbs  = Math.abs(balNum);

      try {
        await client.query(`
          INSERT INTO ledger_fy_balances (ledger_guid, ledger_name, company_guid, financial_year, opening_balance, balance_type, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,NOW())
          ON CONFLICT (company_guid, ledger_name, financial_year) DO UPDATE SET
            opening_balance = EXCLUDED.opening_balance,
            balance_type    = EXCLUDED.balance_type,
            ledger_guid     = COALESCE(EXCLUDED.ledger_guid, ledger_fy_balances.ledger_guid),
            synced_at       = NOW()
        `, [guid, name, companyGuid, fy, balAbs, balType]);
        saved++;
      } catch (err) {
        console.warn('[DB] LedgerFyBalance insert failed:', err.message, name, fy);
      }
    }
    await client.query('COMMIT');
    console.log(`[DB] LedgerFyBalances: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[DB] LedgerFyBalances failed:', err.message);
  } finally {
    client.release();
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

// Gap 3: Parse ExpiryPeriod text (e.g. "31-Dec-2026") to ISO date string "2026-12-31"
// Returns null if unparseable; used as fallback when ExpiryDate field is empty
function parseExpiryPeriod(period) {
  if (!period || typeof period !== 'string') return null;
  const p = period.trim();
  if (!p) return null;
  const months = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };
  // Handle "31-Dec-2026" or "31 Dec 2026"
  const m = p.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/);
  if (m) {
    const monthIdx = months[m[2].toLowerCase()];
    if (monthIdx === undefined) return null;
    const d = new Date(parseInt(m[3]), monthIdx, parseInt(m[1]));
    return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
  }
  // Fallback: native Date parsing (handles YYYYMMDD, ISO, etc.)
  const d = new Date(p);
  return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
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

      // Normalize godown/batch: use '' instead of null so UNIQUE constraint works correctly
      // PostgreSQL treats NULL != NULL in UNIQUE, causing duplicate inserts on every sync
      const godownName = r.GODOWNNAME || r.GodownName || '';
      const batchName  = r.BATCHNAME  || r.BatchName  || '';
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
          godownName,
          batchName,
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
        const isInterstate  = r.IsInterState === 'Yes' || r.ISINTERSTATE === 'Yes' || r.ISINTERSTATE === 'YES';
        const isRcm          = r.IsRCMApplicable === 'Yes' || r.ISRCMAPPLICABLE === 'Yes' || r.ISRCMAPPLICABLE === 'YES';
        const exportType     = r.ExportType || r.EXPORTTYPE || null;
        const isSez          = r.IsSEZParty === 'Yes' || r.ISSEZPARTY === 'Yes' || r.ISSEZPARTY === 'YES';
        const partyGstin     = r.PartyGSTIN || r.PARTYGSTIN || null;
        const isNilRated     = r.IsNilRated === 'Yes' || r.ISNILRATED === 'Yes';
        const isExempt       = r.IsExempt === 'Yes' || r.ISEXEMPT === 'Yes';
        const itcEligibility = r.ITCEligibility || r.ITCELIGIBILITY || r.ItcEligibility || null;
        const cessAmount     = n(r.CessAmount ?? r.CESSAMOUNT ?? r.CESS_AMOUNT);
        const isNonGst       = r.IsNonGST === 'Yes' || r.ISNONGST === 'Yes';
        const gstReturnDate  = r.GSTReturnDate || r.GSTRETURNDATE || null;
        await client.query(`
          INSERT INTO gst_voucher_details
            (voucher_guid, company_guid, voucher_number, voucher_type, date, party_name, gst_reg_type, place_of_supply, taxable_amount, cgst_amount, sgst_amount, igst_amount, irn, alter_id, synced_at, is_interstate, is_rcm, export_type, is_sez, party_gstin, is_nil_rated, is_exempt, itc_eligibility, cess_amount, is_non_gst, gst_return_effective_date)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
          ON CONFLICT (voucher_guid, company_guid) DO UPDATE SET
            voucher_number=EXCLUDED.voucher_number, voucher_type=EXCLUDED.voucher_type,
            taxable_amount=EXCLUDED.taxable_amount, cgst_amount=EXCLUDED.cgst_amount,
            sgst_amount=EXCLUDED.sgst_amount, igst_amount=EXCLUDED.igst_amount,
            irn=EXCLUDED.irn, alter_id=EXCLUDED.alter_id, synced_at=EXCLUDED.synced_at,
            is_interstate=EXCLUDED.is_interstate, is_rcm=EXCLUDED.is_rcm,
            export_type=EXCLUDED.export_type, is_sez=EXCLUDED.is_sez,
            party_gstin=EXCLUDED.party_gstin, is_nil_rated=EXCLUDED.is_nil_rated, is_exempt=EXCLUDED.is_exempt,
            itc_eligibility=EXCLUDED.itc_eligibility,
            cess_amount=EXCLUDED.cess_amount, is_non_gst=EXCLUDED.is_non_gst,
            gst_return_effective_date=EXCLUDED.gst_return_effective_date
        `, [
          voucherGuid, companyGuid,
          r.VOUCHERNUMBER  || r.VoucherNumber  || null,
          r.VOUCHERTYPENAME|| r.VoucherTypeName|| null,
          normalizeDate(r.DATE || r.Date),
          r.PARTYLEDGERNAME|| r.PartyLedgerName|| null,
          r.GSTREGTYPE     || r.GSTRegType     || null,
          r.PLACEOFSUPPLY  || r.PlaceOfSupply  || null,
          n(r.TAXABLEAMOUNT ?? r.TaxableAmount),
          n(r.CGSTAMOUNT    ?? r.CGSTAmount    ?? r.CGST_AMOUNT),
          n(r.SGSTAMOUNT    ?? r.SGSTAmount    ?? r.SGST_AMOUNT),
          n(r.IGSTAMOUNT    ?? r.IGSTAmount    ?? r.IGST_AMOUNT),
          r.IRN || null,
          parseInt(r.ALTERID ?? r.AlterId ?? 0), now(),
          isInterstate, isRcm, exportType, isSez,
          partyGstin, isNilRated, isExempt,
          itcEligibility, cessAmount, isNonGst,
          gstReturnDate ? new Date(gstReturnDate) : null,
        ]);
        saved++;
      } catch (e) { console.warn('[DB] GSTDetail insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] GSTDetails: saved ${saved}/${data.length} for ${companyGuid}`);
    // Post-process: update vouchers classification from gst_voucher_details
    try {
      // Mark is_interstate on gst_voucher_details (IGST only = interstate)
      await dbQuery(`UPDATE gst_voucher_details SET is_interstate = true WHERE company_guid = $1 AND igst_amount > 0 AND cgst_amount = 0 AND is_interstate = false`, [companyGuid]);
      // Mark is_rcm on gst_voucher_details from Tally data
      // (already set during insert from r.IsRCMApplicable)
      // Populate vouchers.is_export
      await dbQuery(`UPDATE vouchers v SET is_export = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.igst_amount > 0 AND v.voucher_type_parent = 'Sales' AND v.company_guid = $1
        AND NOT EXISTS (
          SELECT 1 FROM ledgers l WHERE l.name = v.party_name AND l.company_guid = v.company_guid
          AND l.gstin IS NOT NULL AND l.gstin != ''
        )`, [companyGuid]);
      // Populate vouchers.is_sez from gst_voucher_details.is_sez
      await dbQuery(`UPDATE vouchers v SET is_sez = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.is_sez = true AND v.company_guid = $1`, [companyGuid]);
      // Populate vouchers.is_reverse_charge from gst_voucher_details.is_rcm
      await dbQuery(`UPDATE vouchers v SET is_reverse_charge = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.is_rcm = true AND v.company_guid = $1`, [companyGuid]);
      // Update gst_section for sales
      await dbQuery(`UPDATE vouchers v SET gst_section =
        CASE
          WHEN v.is_export THEN 'Export'
          WHEN v.is_sez THEN 'SEZ'
          WHEN EXISTS (SELECT 1 FROM ledgers l WHERE l.name = v.party_name AND l.company_guid = v.company_guid AND l.gstin IS NOT NULL AND l.gstin != '') THEN
            CASE WHEN EXISTS (SELECT 1 FROM gst_voucher_details g WHERE g.voucher_guid = v.guid AND g.igst_amount > 0 AND g.cgst_amount = 0) THEN 'B2B Interstate' ELSE 'B2B' END
          ELSE 'B2C'
        END
        WHERE v.company_guid = $1 AND v.voucher_type_parent IN ('Sales', 'Credit Note', 'Debit Note') AND v.is_cancelled = false`, [companyGuid]);
      // Update gst_section for purchases
      await dbQuery(`UPDATE vouchers v SET gst_section =
        CASE
          WHEN v.is_reverse_charge THEN 'RCM'
          WHEN EXISTS (SELECT 1 FROM gst_voucher_details g WHERE g.voucher_guid = v.guid AND g.igst_amount > 0 AND g.cgst_amount = 0) THEN 'ITC Interstate'
          WHEN EXISTS (SELECT 1 FROM gst_voucher_details g WHERE g.voucher_guid = v.guid AND g.cgst_amount > 0) THEN 'ITC'
          ELSE 'ITC'
        END
        WHERE v.company_guid = $1 AND v.voucher_type_parent = 'Purchase' AND v.is_cancelled = false`, [companyGuid]);
      console.log(`[DB] GSTDetails: voucher gst_section updated for ${companyGuid}`);
      // Populate vouchers.party_gstin from gst_voucher_details
      await dbQuery(`
        UPDATE vouchers v SET party_gstin = g.party_gstin
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.party_gstin IS NOT NULL AND g.party_gstin != ''
        AND (v.party_gstin IS NULL OR v.party_gstin = '')
        AND v.company_guid = $1
      `, [companyGuid]);
      // Update gstr3b_section on vouchers
      await dbQuery(`
        UPDATE vouchers v SET gstr3b_section =
          CASE
            WHEN v.voucher_type_parent IN ('Sales','Credit Note','Debit Note') THEN
              CASE
                WHEN v.is_export OR v.is_sez THEN '3.1(b)'
                WHEN g.is_nil_rated THEN '3.1(c)'
                WHEN v.is_reverse_charge THEN '3.1(d)'
                ELSE '3.1(a)'
              END
            WHEN v.voucher_type_parent = 'Purchase' THEN
              CASE WHEN v.is_reverse_charge THEN '3.1(d) RCM' ELSE '4A ITC' END
            ELSE NULL
          END
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND v.company_guid = $1 AND v.is_cancelled = false
      `, [companyGuid]);
      console.log(`[DB] GSTDetails: party_gstin + gstr3b_section updated for ${companyGuid}`);
      // Derive is_import from place_of_supply
      await dbQuery(`
        UPDATE vouchers v SET is_import = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND (g.place_of_supply = 'Outside India' OR g.place_of_supply = 'Other')
        AND v.voucher_type_parent = 'Purchase' AND v.is_cancelled = false
        AND v.company_guid = $1
      `, [companyGuid]);
      // Also: Purchase with IGST and no party GSTIN = likely import from unregistered foreign supplier
      await dbQuery(`
        UPDATE vouchers v SET is_import = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.igst_amount > 0 AND g.cgst_amount = 0
        AND NOT EXISTS (
          SELECT 1 FROM ledgers l
          WHERE l.name = v.party_name AND l.company_guid = v.company_guid
          AND l.gstin IS NOT NULL AND l.gstin != ''
        )
        AND v.voucher_type_parent = 'Purchase'
        AND v.is_import = false AND v.is_cancelled = false
        AND v.company_guid = $1
      `, [companyGuid]);
      // Populate vouchers.itc_eligibility from gst_voucher_details
      await dbQuery(`
        UPDATE vouchers v SET itc_eligibility = g.itc_eligibility
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND g.itc_eligibility IS NOT NULL AND g.itc_eligibility != ''
        AND v.company_guid = $1
      `, [companyGuid]);
      // Populate cess_amount + is_non_gst from gst_voucher_details
      await dbQuery(`
        UPDATE vouchers v SET
          cess_amount = g.cess_amount,
          is_non_gst  = g.is_non_gst
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND v.company_guid = $1
      `, [companyGuid]);
      // Populate is_gst_relevant
      await dbQuery(`
        UPDATE vouchers v SET is_gst_relevant = true
        FROM gst_voucher_details g
        WHERE g.voucher_guid = v.guid AND g.company_guid = v.company_guid
        AND (g.cgst_amount > 0 OR g.sgst_amount > 0 OR g.igst_amount > 0 OR g.cess_amount > 0
          OR g.is_nil_rated OR g.is_exempt OR g.gst_reg_type IS NOT NULL)
        AND v.company_guid = $1
      `, [companyGuid]);
      await dbQuery(`UPDATE vouchers SET is_gst_relevant = true WHERE party_gstin IS NOT NULL AND party_gstin != '' AND company_guid = $1`, [companyGuid]);
      // Populate gst_transaction_nature
      await dbQuery(`
        UPDATE vouchers SET gst_transaction_nature =
          CASE
            WHEN is_export THEN 'Export'
            WHEN is_sez    THEN 'SEZ'
            WHEN is_reverse_charge THEN 'RCM'
            WHEN is_non_gst THEN 'Non-GST'
            WHEN gst_section = 'B2B' THEN 'B2B'
            WHEN gst_section = 'B2B Interstate' THEN 'B2B Interstate'
            WHEN gst_section = 'B2C' THEN 'B2C'
            WHEN gst_section = 'ITC' THEN 'ITC'
            WHEN gst_section = 'ITC Interstate' THEN 'ITC Interstate'
            ELSE gst_section
          END
        WHERE company_guid = $1 AND (gst_section IS NOT NULL OR is_export OR is_sez OR is_reverse_charge OR is_non_gst)
      `, [companyGuid]);
      // Populate gst_tabs_json using classifier logic (stored for performance)
      await dbQuery(`
        UPDATE vouchers SET gst_tabs_json =
          CASE
            WHEN voucher_type_parent IN ('Sales','Credit Note','Debit Note') THEN '["GSTR-1","GSTR-3B","GSTR-9"]'::jsonb
            WHEN voucher_type_parent = 'Purchase' AND party_gstin IS NOT NULL AND party_gstin != '' THEN '["GSTR-2A","GSTR-2B","GSTR-3B","GSTR-9"]'::jsonb
            WHEN voucher_type_parent = 'Purchase' THEN '["GSTR-3B","GSTR-9"]'::jsonb
            ELSE '[]'::jsonb
          END
        WHERE company_guid = $1 AND is_cancelled = false
      `, [companyGuid]);
      // Populate gst_sections_json
      await dbQuery(`
        UPDATE vouchers SET gst_sections_json =
          jsonb_build_object(
            'GSTR-1', COALESCE(gst_section, 'Other'),
            'GSTR-3B', COALESCE(gstr3b_section, '')
          )
        WHERE company_guid = $1 AND (gst_section IS NOT NULL OR gstr3b_section IS NOT NULL)
      `, [companyGuid]);
      console.log(`[DB] GSTDetails: is_import + itc_eligibility + all derived fields propagated for ${companyGuid}`);
    } catch (pe) { console.warn('[DB] GSTDetails post-process voucher update failed:', pe.message); }
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
  // StockOpeningBalance.xml: per-warehouse opening balance per stock item
  // Fields: Name (stock), GodownName (warehouse), OpeningBalance (qty), OpeningRate, OpeningValue
  // Strategy:
  //   1. Aggregate total opening_qty per stock → UPDATE stocks
  //   2. Insert per-warehouse rows into stock_transactions (type=inward, voucher_guid='opening_balance')
  //      so warehouse breakdown works for items with no voucher movements
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let updated = 0;
    let txInserted = 0;

    // Aggregate: total opening per stock (sum across all warehouses)
    const totals = {}; // name → { qty, rate, val }
    for (const r of data) {
      const name = tallyName(r);  // use tallyName() to handle array values from xml2js
      if (!name) continue;
      const qty = parseFloat(r.OpeningBalance || r.OPENINGBALANCE || 0);
      if (isNaN(qty)) continue;
      if (!totals[name]) totals[name] = { qty: 0, rate: 0, val: 0 };
      totals[name].qty += qty;
      totals[name].rate = parseFloat(r.OpeningRate || r.OPENINGRATE || 0);
      totals[name].val += parseFloat(r.OpeningValue || r.OPENINGVALUE || 0);
    }

    // Step 1: Update stocks.opening_qty with totals
    for (const [name, { qty, rate }] of Object.entries(totals)) {
      try {
        const result = await client.query(
          `UPDATE stocks SET opening_qty = $1, opening_rate = $2 WHERE name = $3 AND company_guid = $4`,
          [qty, rate, name, companyGuid]
        );
        if (result.rowCount > 0) updated++;
      } catch (e) { console.warn('[DB] StockOpening stocks update failed:', e.message); }
    }

    // Step 2: Insert per-warehouse stock_transactions for opening balance
    // Uses synthetic voucher_guid='opening_balance' + warehouse to satisfy unique constraint
    // ON CONFLICT DO UPDATE = re-sync safe (idempotent)
    for (const r of data) {
      const name      = tallyName(r);  // handles array Name values
      const warehouse = r.GodownName || r.GODOWNNAME || r.GODOWN || 'Main Location';
      const qty       = parseFloat(r.OpeningBalance || r.OPENINGBALANCE || 0);
      const rate      = parseFloat(r.OpeningRate    || r.OPENINGRATE    || 0);
      const value     = parseFloat(r.OpeningValue   || r.OPENINGVALUE   || 0);
      if (!name || isNaN(qty) || qty === 0) continue;

      // synthetic voucher_guid unique per stock+warehouse for ON CONFLICT
      const syntheticGuid = `opening_balance_${warehouse}`;
      try {
        await client.query(`
          INSERT INTO stock_transactions
            (stock_guid, company_guid, voucher_guid, voucher_type, date, qty, rate, value, type, warehouse, financial_year, synced_at)
          VALUES ($1,$2,$3,'Opening Balance','2000-01-01',$4,$5,$6,'inward',$7,NULL,${now()})
          ON CONFLICT (stock_guid, company_guid, voucher_guid, warehouse, type) DO UPDATE SET
            qty=EXCLUDED.qty, rate=EXCLUDED.rate, value=EXCLUDED.value, synced_at=EXCLUDED.synced_at
        `, [name, companyGuid, syntheticGuid, Math.abs(qty), rate, Math.abs(value), warehouse]);
        txInserted++;
      } catch (e) { console.warn('[DB] StockOpening tx insert failed:', e.message, name, warehouse); }
    }

    await client.query('COMMIT');
    console.log(`[DB] StockOpening: updated ${updated} stocks, ${txInserted} warehouse tx rows for ${companyGuid}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockOpening failed:', e.message);
  } finally {
    client.release();
  }

  // Recompute closing_qty = opening_qty + net real movements
  // IMPORTANT: exclude 'Opening Balance' rows — those are synthetic rows created by
  // processStockOpeningBalance for warehouse breakdown. Including them would double-count
  // since opening_qty is already set from the same source.
  const OB_EXCL = `qty IS NOT NULL AND qty::text != 'NaN' AND COALESCE(voucher_type,'') != 'Opening Balance' AND COALESCE(voucher_type,'') != 'Physical Stock'`;
  try {
    await dbQuery(`
      UPDATE stocks s
      SET closing_qty = s.opening_qty + COALESCE(sub.net_qty, 0),
          closing_value = (s.opening_qty + COALESCE(sub.net_qty, 0)) * NULLIF(s.opening_rate, 0)
      FROM (
        SELECT stock_guid, company_guid,
               SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) as net_qty
        FROM stock_transactions
        WHERE company_guid = $1 AND ${OB_EXCL}
        GROUP BY stock_guid, company_guid
      ) sub
      WHERE s.name = sub.stock_guid AND s.company_guid = sub.company_guid AND s.company_guid = $1
    `, [companyGuid]);

    // Stocks with opening but no real transactions: closing = opening
    await dbQuery(
      `UPDATE stocks SET closing_qty = opening_qty
       WHERE company_guid = $1 AND closing_qty = 0 AND opening_qty > 0`,
      [companyGuid]
    );

    // Stocks with real transactions but no opening: closing = net movements only
    await dbQuery(
      `UPDATE stocks s
       SET closing_qty = sub.net_qty
       FROM (
         SELECT stock_guid, company_guid,
                SUM(CASE WHEN type = 'inward' THEN qty ELSE -qty END) as net_qty
         FROM stock_transactions
         WHERE company_guid = $1 AND ${OB_EXCL}
         GROUP BY stock_guid, company_guid
       ) sub
       WHERE s.name = sub.stock_guid
         AND s.company_guid = sub.company_guid
         AND s.opening_qty = 0
         AND sub.net_qty != 0`,
      [companyGuid]
    );

    console.log(`[DB] StockOpening: closing_qty recomputed for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] Stock closing_qty recompute failed:', e.message);
  }
}

// processStockFyBalance — stores stock value AT A SPECIFIC DATE (from=to=single date)
// Used for FY opening (date = FY_start - 1) and FY closing (date = FY_end)
// Maps to stock_fy_valuation: if date is FY_end → update closing_value; if date is FY_start-1 → update opening_value
// Apply the CURRENT FY closing_qty from stock_fy_valuation → stocks.closing_qty
// Uses the most recent FY that has closing data (highest fin_year)
async function applyCurrentFyClosingQty(companyGuid) {
  try {
    // Find current FY (closest to today that has data)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const result = await dbQuery(`
      UPDATE stocks s
      SET closing_qty   = fv.closing_qty,
          closing_rate  = COALESCE(NULLIF(fv.closing_rate, 0), s.closing_rate),
          closing_value = fv.closing_qty * COALESCE(NULLIF(fv.closing_rate, 0), s.closing_rate, 0)
      FROM (
        SELECT DISTINCT ON (stock_name)
          stock_name, closing_qty, closing_rate, closing_value
        FROM stock_fy_valuation
        WHERE company_guid = $1
          AND closing_qty IS NOT NULL
        ORDER BY stock_name, financial_year DESC
      ) fv
      WHERE s.name = fv.stock_name
        AND s.company_guid = $1
    `, [companyGuid]);
    console.log(`[DB] applyCurrentFyClosingQty: updated ${result.rowCount} stocks for ${companyGuid}`);
  } catch (e) {
    console.error('[DB] applyCurrentFyClosingQty failed:', e.message);
  }
}

async function processStockFyBalance(data, companyGuid) {
  if (!data || data.length === 0) return;

  const financialYear = data[0]?._FINANCIAL_YEAR;
  if (!financialYear) {
    console.warn('[DB] StockFyBalance: no financial_year on records — skipping');
    return;
  }

  // Determine if this is an OPENING query (date = FY_start - 1) or CLOSING query (date = FY_end)
  // We detect by comparing FROM_DATE to FY boundaries
  const fromDate = data[0]?.FROM_DATE || data[0]?.from_date || '';
  const fyYear   = financialYear; // e.g. '2025-2026'
  const fyStart  = fyYear.split('-')[0] + '0401'; // e.g. '20250401'
  const fyEnd    = (parseInt(fyYear.split('-')[0]) + 1) + '0331'; // e.g. '20260331'
  const isClosingQuery = (fromDate === fyEnd);
  const isOpeningQuery = (fromDate !== fyEnd); // any date before FY start

  const now = Math.floor(Date.now() / 1000);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;

    for (const r of data) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;

      const closeQty = parseFloat(String(r.ClosingQty  || r.CLOSINGQTY  || 0).replace(/[^0-9.-]/g, '')) || 0;
      const closeRate= parseFloat(String(r.ClosingRate || r.CLOSINGRATE || 0).replace(/[^0-9.-]/g, '')) || 0;
      const rawVal   = String(r.ClosingValue || r.CLOSINGVALUE || 0).replace('(-)', '-');
      const closeVal = parseFloat(rawVal.replace(/[^0-9.-]/g, '')) * (rawVal.includes('-') ? -1 : 1) || 0;
      const guid     = r.Guid || r.GUID || null;

      try {
        if (isClosingQuery) {
          // Update or insert closing_value for this FY
          await client.query(`
            INSERT INTO stock_fy_valuation
              (company_guid, financial_year, stock_name, stock_guid, closing_qty, closing_rate, closing_value, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (company_guid, financial_year, stock_name)
            DO UPDATE SET
              closing_qty   = EXCLUDED.closing_qty,
              closing_rate  = EXCLUDED.closing_rate,
              closing_value = EXCLUDED.closing_value,
              synced_at     = EXCLUDED.synced_at`,
            [companyGuid, financialYear, name, guid, closeQty, closeRate, closeVal, now]
          );
        } else {
          // Opening query: store as NEXT FY's opening
          // date = FY_start - 1 day → this is the opening of financialYear
          await client.query(`
            INSERT INTO stock_fy_valuation
              (company_guid, financial_year, stock_name, stock_guid, opening_qty, opening_rate, opening_value, synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (company_guid, financial_year, stock_name)
            DO UPDATE SET
              opening_qty   = EXCLUDED.opening_qty,
              opening_rate  = EXCLUDED.opening_rate,
              opening_value = EXCLUDED.opening_value,
              synced_at     = EXCLUDED.synced_at`,
            [companyGuid, financialYear, name, guid, closeQty, closeRate, closeVal, now]
          );
        }
        saved++;
      } catch (e) {
        console.warn('[DB] StockFyBalance upsert failed:', e.message, name);
      }
    }

    await client.query('COMMIT');
    console.log(`[DB] StockFyBalance: saved ${saved}/${data.length} for ${companyGuid} FY ${financialYear} type=${isClosingQuery?'closing':'opening'}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockFyBalance failed:', e.message);
  } finally {
    client.release();
  }
}

// processOpeningBalanceDiff — computes and stores the company-level "Difference in Opening Balances"
// Source: OpeningBalanceDiff.xml (called ONCE per company with FROM_DATE = BOOKSFROM date)
// Returns per-ledger signed opening balances at the company's first accounting date.
// SUM of all signed values = Tally's "Difference in Opening Balances" (fixed, never changes across FYs).
async function processOpeningBalanceDiff(data, companyGuid) {
  if (!data || data.length === 0) return;
  let netSigned = 0;
  for (const r of data) {
    // TDL returns signed values: negative = Dr, positive = Cr
    // parseFloat preserves the sign directly from the numeric string
    const val = parseFloat(String(r.SignedOpeningBalance || r.SIGNEDOPENINGBALANCE || '0').replace(/[^0-9.-]/g, '')) || 0;
    netSigned += val;
  }
  // netSigned: positive = Cr dominates, negative = Dr dominates
  const diffAmount = Math.abs(netSigned);
  const diffType   = netSigned < 0 ? 'Dr' : 'Cr';
  try {
    await dbQuery(
      `UPDATE companies SET ob_diff_amount=$1, ob_diff_type=$2 WHERE guid=$3`,
      [diffAmount, diffType, companyGuid]
    );
    console.log(`[DB] OpeningBalanceDiff: \u20b9${diffAmount.toLocaleString('en-IN')} ${diffType} (${data.length} ledgers summed)`);
  } catch (err) {
    console.error('[DB] OpeningBalanceDiff error:', err.message);
  }
}

// processStockFyValuation — stores FY-specific opening/closing stock VALUES from Tally
// Source: StockValuation.xml (per FY, uses Tally's own costing method: FIFO/weighted avg)
// These are the exact values Tally shows in its P&L — no computation needed on our side
async function processStockFyValuation(data, companyGuid) {
  if (!data || data.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const client = await getClient();
  // Group by financial_year so each FY is handled correctly
  // (multiple FYs may arrive in one batch when several years are synced together)
  const fyGroups = {};
  for (const r of data) {
    const fy = r._FINANCIAL_YEAR;
    if (!fy) continue;
    if (!fyGroups[fy]) fyGroups[fy] = [];
    fyGroups[fy].push(r);
  }
  if (Object.keys(fyGroups).length === 0) {
    console.warn('[DB] StockFyValuation: no financial_year on records — skipping');
    return;
  }
  try {
    await client.query('BEGIN');
    let saved = 0;

    for (const [financialYear, records] of Object.entries(fyGroups)) {
    for (const r of records) {
      const name = r.Name || r.NAME || '';
      if (!name) continue;

      const openQty   = parseFloat(String(r.OpeningQty   || r.OPENINGQTY   || 0).replace(/[^0-9.-]/g, '')) || 0;
      const openRate  = parseFloat(String(r.OpeningRate  || r.OPENINGRATE  || 0).replace(/[^0-9.-]/g, '')) || 0;
      const openVal   = parseFloat(String(r.OpeningValue || r.OPENINGVALUE || 0).replace(/[^0-9.-]/g, '')) || 0;
      const closeQty  = parseFloat(String(r.ClosingQty   || r.CLOSINGQTY   || 0).replace(/[^0-9.-]/g, '')) || 0;
      const closeRate = parseFloat(String(r.ClosingRate  || r.CLOSINGRATE  || 0).replace(/[^0-9.-]/g, '')) || 0;
      const closeVal  = parseFloat(String(r.ClosingValue || r.CLOSINGVALUE || 0).replace(/[^0-9.-]/g, '')) || 0;
      const guid      = r.Guid || r.GUID || null;

      try {
        await client.query(
          `INSERT INTO stock_fy_valuation
            (company_guid, financial_year, stock_name, stock_guid,
             opening_qty, opening_rate, opening_value,
             closing_qty, closing_rate, closing_value, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (company_guid, financial_year, stock_name)
           DO UPDATE SET
             stock_guid    = EXCLUDED.stock_guid,
             opening_qty   = EXCLUDED.opening_qty,
             opening_rate  = EXCLUDED.opening_rate,
             opening_value = EXCLUDED.opening_value,
             closing_qty   = EXCLUDED.closing_qty,
             closing_rate  = EXCLUDED.closing_rate,
             closing_value = EXCLUDED.closing_value,
             synced_at     = EXCLUDED.synced_at`,
          [companyGuid, financialYear, name, guid,
           openQty, openRate, openVal,
           closeQty, closeRate, closeVal, now]
        );
        saved++;
      } catch (e) {
        console.warn('[DB] StockFyValuation upsert failed:', e.message, name);
      }
    }
    } // end for fyGroups

    await client.query('COMMIT');
    const fyList = Object.keys(fyGroups).join(', ');
    console.log(`[DB] StockFyValuation: saved ${saved}/${data.length} for ${companyGuid} FYs: ${fyList}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] StockFyValuation failed:', e.message);
  } finally {
    client.release();
  }
}

async function processLedgerTransactions(data, companyGuid) {
  // LedgerTransaction.xml: each record is a ledger line item for a voucher
  // Fields: Guid (voucher GUID), LedgerName, LedgerGuid, Amount, Date, AlterId
  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Clear existing items for all vouchers in this batch (idempotent re-sync)
    const uniqueGuids = [...new Set(data.map(r => r.Guid || r.GUID).filter(Boolean))];
    if (uniqueGuids.length > 0) {
      await client.query(
        `DELETE FROM voucher_items WHERE company_guid=$1 AND voucher_guid = ANY($2::text[])`,
        [companyGuid, uniqueGuids]
      );
    }

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
    } else if (xml === 'StockValuation.xml') {
      await processStockFyValuation(records, companyGuid);
    } else if (xml === 'StockFYBalance.xml') {
      await processStockFyBalance(records, companyGuid);
      await applyCurrentFyClosingQty(companyGuid);
    } else if (xml === 'VoucherInventoryDetail.xml') {
      // VoucherInventoryDetail.xml: flat inventory items (qty/rate/batch name at entry level)
      // Batch allocations are now primarily sourced from AllVoucher.xml → nested Batchallocations
      // Keep VID path as a secondary source for batch records that have BatchName at flat level
      await processVoucherInventoryItems(records, companyGuid);
      const withBatch = records.filter(r => r.BATCHNAME || r.BatchName || r.Batchname || r.BATCHALLOCNAME);
      if (withBatch.length > 0) await processBatchAllocations(withBatch, companyGuid);
    } else if (xml === 'GSTDetails.xml') {
      await processGSTDetails(records, companyGuid);
    } else if (xml === 'GroupMaster.xml') {
      await processGroupMasters(records, companyGuid);
    } else if (xml === 'FullLedger.xml') {
      await processFullLedger(records, companyGuid);
    } else if (xml === 'BillOutstanding.xml') {
      await processBillOutstanding(records, companyGuid);
    } else if (xml === 'LedgerOpeningBalance.xml') {
      // V2: Now actively processed into ledger_fy_balances table
      await processLedgerFyBalances(records, companyGuid);
    } else if (xml === 'OpeningBalanceDiff.xml') {
      await processOpeningBalanceDiff(records, companyGuid);
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
        // _FINANCIAL_YEAR is on the outer raw record (added by syncHelperWithDate),
        // not inside the inner VOUCHER JSON — propagate it to r so it's not lost
        if (!r._FINANCIAL_YEAR && raw._FINANCIAL_YEAR) r._FINANCIAL_YEAR = raw._FINANCIAL_YEAR;
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
        const dispatchDetails2 = extractDispatchDetails(r);
        await client.query(`
          INSERT INTO vouchers (guid, company_guid, voucher_number, voucher_type, voucher_type_parent, date, party_name, party_guid, amount, narration, reference, is_cancelled, alter_id, raw_data, synced_at, financial_year, dispatch_details)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
          ON CONFLICT (guid, company_guid) DO UPDATE SET
            voucher_number      = COALESCE(EXCLUDED.voucher_number, vouchers.voucher_number),
            voucher_type        = CASE WHEN EXCLUDED.voucher_type = 'Voucher' THEN COALESCE(vouchers.voucher_type, 'Voucher') ELSE EXCLUDED.voucher_type END,
            voucher_type_parent = COALESCE(EXCLUDED.voucher_type_parent, vouchers.voucher_type_parent),
            date                = COALESCE(EXCLUDED.date, vouchers.date),
            party_name          = COALESCE(EXCLUDED.party_name, vouchers.party_name),
            party_guid          = COALESCE(EXCLUDED.party_guid, vouchers.party_guid),
            amount              = CASE WHEN EXCLUDED.amount = 0 AND vouchers.amount != 0 THEN vouchers.amount ELSE EXCLUDED.amount END,
            narration           = COALESCE(EXCLUDED.narration, vouchers.narration),
            reference           = COALESCE(EXCLUDED.reference, vouchers.reference),
            is_cancelled        = EXCLUDED.is_cancelled,
            alter_id            = GREATEST(EXCLUDED.alter_id, vouchers.alter_id),
            raw_data            = CASE WHEN EXCLUDED.raw_data IS NULL OR EXCLUDED.raw_data = 'null' THEN vouchers.raw_data ELSE EXCLUDED.raw_data END,
            financial_year      = COALESCE(EXCLUDED.financial_year, vouchers.financial_year),
            dispatch_details    = COALESCE(EXCLUDED.dispatch_details, vouchers.dispatch_details),
            synced_at           = EXCLUDED.synced_at
        `, [
          guid, companyGuid,
          r.VOUCHERNUMBER || r.VoucherNumber || null,
          voucherType, deriveVoucherTypeParent(voucherType), date,
          r.PARTYNAME || r.PartyName || r.PARTYLEDGERNAME || null,
          partyGuid,
          amount,
          r.NARRATION || r.Narration || null,
          r.REFERENCE || r.Reference || null,
          isCancelled,
          parseInt(r.ALTERID || r.AlterId || 0),
          JSON.stringify(r).slice(0, 5000),
          now(),
          r._FINANCIAL_YEAR || null,
          dispatchDetails2 ? JSON.stringify(dispatchDetails2) : null,
        ]);
        saved++;
        // Save AllLedgerEntries to voucher_ledger_entries (proper Dr/Cr from amount sign)
        // V2: pass financial_year from record metadata
        const parsedEntries = parseLedgerEntries(r);
        if (parsedEntries.length > 0) {
          await saveLedgerEntries(client, guid, companyGuid, parsedEntries, r._FINANCIAL_YEAR || null);
        }
      } catch (e) { console.warn('[DB] AllVoucher insert failed:', e.message); }
    }
    await client.query('COMMIT');
    console.log(`[DB] AllVoucher: saved ${saved}/${data.length} for ${companyGuid}`);
    // Post-process: backfill gst_voucher_details from CGST/SGST ledger entries
    // This fixes cases where Tally's $$GSTTaxableValue returns 0 but ledger entries have real amounts
    await dbQuery(`
      UPDATE gst_voucher_details gvd
      SET cgst_amount=sub.cgst, sgst_amount=sub.sgst, igst_amount=sub.igst, taxable_amount=sub.taxable
      FROM (
        SELECT v.guid as vg, v.company_guid as cg,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' THEN ABS(vle.amount) ELSE 0 END),0) as cgst,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%UTGST%' THEN ABS(vle.amount) ELSE 0 END),0) as sgst,
          COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0) as igst,
          GREATEST(0, COALESCE(SUM(CASE WHEN vle.dr_cr='Dr' THEN ABS(vle.amount) ELSE 0 END),0) -
            COALESCE(SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END),0)) as taxable
        FROM vouchers v JOIN voucher_ledger_entries vle ON vle.voucher_guid=v.guid AND vle.company_guid=v.company_guid
        WHERE v.company_guid=$1
        GROUP BY v.guid, v.company_guid
        HAVING SUM(CASE WHEN vle.ledger_name ILIKE '%CGST%' OR vle.ledger_name ILIKE '%SGST%' OR vle.ledger_name ILIKE '%IGST%' THEN ABS(vle.amount) ELSE 0 END) > 0
      ) sub
      WHERE gvd.voucher_guid=sub.vg AND gvd.company_guid=sub.cg AND gvd.cgst_amount=0
    `, [companyGuid]).catch(e => console.warn('[DB] GST backfill warning:', e.message));

    // Backfill VLE financial_year from parent voucher where NULL (handles legacy + re-sync gaps)
    await client.query(`
      UPDATE voucher_ledger_entries vle
      SET financial_year = v.financial_year
      FROM vouchers v
      WHERE vle.voucher_guid = v.guid
        AND vle.company_guid = v.company_guid
        AND vle.company_guid = $1
        AND vle.financial_year IS NULL
        AND v.financial_year IS NOT NULL
    `, [companyGuid]).catch(e => console.warn('[DB] VLE FY backfill warning:', e.message));

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

// CTO Spec: stock_categories table — dedicated stock category master from StockCategory.xml
async function processStockCategories(data, companyGuid) {
  if (!data?.length) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const name = r.NAME || r.Name || r.CATEGORYNAME || r.CategoryName || '';
      if (!name) continue;
      const guid   = r.GUID || r.Guid || null;
      const parent = r.PARENT || r.Parent || null;
      try {
        await client.query(`
          INSERT INTO stock_categories (guid, company_guid, name, parent, alter_id, synced_at)
          VALUES ($1,$2,$3,$4,$5,NOW())
          ON CONFLICT (company_guid, name) DO UPDATE SET
            guid=COALESCE(EXCLUDED.guid, stock_categories.guid),
            parent=EXCLUDED.parent, alter_id=EXCLUDED.alter_id, synced_at=NOW()
        `, [guid, companyGuid, name, parent, parseInt(r.ALTERID || r.AlterId || 0)]);
        saved++;
      } catch (e) { console.warn('[DB] StockCategory insert failed:', e.message, name); }
    }
    await client.query('COMMIT');
    console.log(`[DB] StockCategories: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] StockCategories failed:', e.message); }
  finally { client.release(); }
}

// CTO Spec: batch_allocations table — batch/expiry tracking per voucher line item
async function processBatchAllocations(data, companyGuid) {
  if (!data?.length) return;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    let saved = 0;
    for (const r of data) {
      const voucherGuid = r.VOUCHERGUID || r.VoucherGuid || r.GUID || '';
      const itemName    = r.STOCKITEMNAME || r.StockItemName || r.ItemName || '';
      // Gap 1 fix: add Batchname (AllVoucher.xml lowercase field name) to lookup chain
      const batchName   = r.BATCHNAME || r.BatchName || r.Batchname || r.BATCHALLOCNAME || '';
      if (!voucherGuid || !batchName) continue;
      // Gap 2 fix: prefer ActualQty, fallback to BilledQty
      const qty         = parseTallyQty(r.ACTUALQTY || r.ActualQty || r.BILLEDQTY || r.BilledQty || r.QTY || 0);
      const rate        = parseTallyRate(r.RATE || r.Rate || 0);
      const fy          = r._FINANCIAL_YEAR || null;
      // Gap 1 fix: add Godownname (AllVoucher.xml lowercase field name) to lookup chain
      const godownName  = r.GODOWNNAME || r.GodownName || r.Godownname || null;
      // Gap 3: resolve expiry — formatted date first, ExpiryPeriod text as fallback
      const rawExpiry   = r.EXPIRYDATE || r.ExpiryDate || '';
      const rawPeriod   = r.EXPIRYPERIOD || r.ExpiryPeriod || '';
      const expiryDate  = rawExpiry || parseExpiryPeriod(rawPeriod) || null;
      try {
        await client.query(`
          INSERT INTO batch_allocations
            (voucher_guid, company_guid, stock_item_name, stock_item_guid, batch_name,
             expiry_date, mfg_date, qty, rate, godown_name, financial_year, synced_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
          ON CONFLICT (voucher_guid, company_guid, stock_item_name, batch_name, godown_name) DO UPDATE SET
            qty=EXCLUDED.qty, rate=EXCLUDED.rate, expiry_date=EXCLUDED.expiry_date,
            mfg_date=EXCLUDED.mfg_date, financial_year=EXCLUDED.financial_year, synced_at=NOW()
        `, [
          voucherGuid, companyGuid, itemName,
          r.STOCKITEMGUID || r.StockItemGuid || null,
          batchName,
          expiryDate,
          r.MANUFACTURINGDATE || r.ManufacturingDate || r.MFGDATE || r.MfgDate || null,
          qty, rate,
          godownName,
          fy,
        ]);
        saved++;
      } catch (e) { console.warn('[DB] BatchAllocation insert failed:', e.message, batchName); }
    }
    await client.query('COMMIT');
    console.log(`[DB] BatchAllocations: saved ${saved}/${data.length} for ${companyGuid}`);
  } catch (e) { await client.query('ROLLBACK'); console.error('[DB] BatchAllocations failed:', e.message); }
  finally { client.release(); }
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
