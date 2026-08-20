/**
 * Shared Sales-shaped voucher XML (Sales Invoice + Proforma).
 * Shape aligned to TallyPrime optional Sales exports
 * (Sales_TD1531-3-2026.xml + native optional→regular pair, Yash Ki Company):
 *   OBJVIEW + PERSISTEDVIEW = Invoice Voucher View
 *   VCHENTRYMODE = Item Invoice
 *   ISOPTIONAL + VCHSTATUSISOPTIONAL
 *   DIFFACTUALQTY = Yes
 *   GUID / MASTERID / REMOTEID for Alter (same voucher, no duplicate)
 * Native convert (2026-08-18) only flips optional flags; GUID/MASTERID/VOUCHERNUMBER stay.
 * Do NOT send ALTERID — Tally owns that counter (9653 → 9654 on convert).
 * Proforma create: ACTION=Create, ISOPTIONAL=Yes.
 * Convert Alter MUST identify by DATE + TAGNAME=MasterID (TallyHelp).
 * GUID-only Alter in the same company Creates a duplicate (Tally import overwrite=No).
 */

/** Tally voucher GUID = `{companyGuid}-{MASTERID as 8-char hex}`. MASTERID 8559 → …-0000216f */
export function tallyVoucherGuidFromMasterId(companyGuid, masterId) {
  const n = parseInt(String(masterId ?? '').trim(), 10);
  if (!companyGuid || !Number.isFinite(n) || n <= 0) return '';
  return `${companyGuid}-${n.toString(16).padStart(8, '0')}`;
}

export function tallyMasterIdFromVoucherGuid(companyGuid, guid) {
  if (!companyGuid || !guid) return '';
  const prefix = `${companyGuid}-`;
  if (!String(guid).startsWith(prefix)) return '';
  const n = parseInt(String(guid).slice(prefix.length), 16);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

function xmlEsc(s) {
  return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function dispatchToTallyDate(d) {
  if (!d) return '';
  const s = String(d);
  if (/^\d{8}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10).replace(/-/g, '');
  return s.replace(/-/g, '').slice(0, 8);
}

/**
 * Dispatch / e-way fields for Sales Alter (same tags as create-invoice). Empty string if nothing filled.
 *
 * `ewbOnly` returns just the EWAYBILLDETAILS block, for voucher types such as
 * Delivery Note that already build their own BASICSHIP* tags.
 */
export function buildDispatchXml(dispatch_details, invoiceDate, { ewbOnly = false } = {}) {
  if (!dispatch_details || typeof dispatch_details !== 'object') return '';
  const dd = dispatch_details;
  const filled = Object.values(dd).some((v) => v != null && String(v).trim() !== '');
  if (!filled) return '';

  const modeSimpleMap = { road: 'Road', rail: 'Rail', air: 'Air', ship: 'Ship', not_applicable: '', 'not applicable': '' };
  const modeCodeMap = { road: '1 - Road', rail: '2 - Rail', air: '3 - Air', ship: '4 - Ship' };
  const modeKey = String(dd.transport_mode || '').toLowerCase().replace(/\s+/g, '_');
  const tallySimpleMode = modeSimpleMap[modeKey] ?? dd.transport_mode ?? '';
  const tallyCodedMode = modeCodeMap[modeKey] ?? '';
  const vtKey = String(dd.vehicle_type || '').toLowerCase();
  const tallyVehicleType = vtKey.includes('over') ? 'O - Over Dimensional Cargo (ODC)'
    : vtKey === 'regular' ? 'R - Regular'
    : (dd.vehicle_type || '');
  const dispatchDate = dispatchToTallyDate(dd.transport_doc_date || invoiceDate);

  const topLevel = [
    dispatchDate ? `  <BILLOFLADINGDATE>${dispatchDate}</BILLOFLADINGDATE>` : '',
    tallySimpleMode ? `  <BASICSHIPPEDBY>${xmlEsc(tallySimpleMode)}</BASICSHIPPEDBY>` : '',
    dd.transport_doc_no ? `  <BASICSHIPDOCUMENTNO>${xmlEsc(dd.transport_doc_no)}</BASICSHIPDOCUMENTNO>` : '',
    dd.ship_to ? `  <BASICFINALDESTINATION>${xmlEsc(dd.ship_to)}</BASICFINALDESTINATION>` : '',
    dd.vehicle_number ? `  <BASICSHIPVESSELNO>${xmlEsc(dd.vehicle_number)}</BASICSHIPVESSELNO>` : '',
  ].filter(Boolean).join('\n');

  const hasTransport = dd.vehicle_number || tallyCodedMode || dd.transporter_name || dd.transporter_id;
  const consignorLines = [dd.dispatch_from_address1, dd.dispatch_from_address2].map((l) => String(l || '').trim()).filter(Boolean);
  const consigneeLines = [dd.ship_to_address1, dd.ship_to_address2].map((l) => String(l || '').trim()).filter(Boolean);
  const consignorAddrXml = consignorLines.length
    ? consignorLines.map((l) => `      <CONSIGNORADDRESS>${xmlEsc(l)}</CONSIGNORADDRESS>`).join('\n')
    : `      <CONSIGNORADDRESS>${xmlEsc(dd.dispatch_from || '')}</CONSIGNORADDRESS>`;
  const consigneeAddrXml = consigneeLines.length
    ? consigneeLines.map((l) => `      <CONSIGNEEADDRESS>${xmlEsc(l)}</CONSIGNEEADDRESS>`).join('\n')
    : `      <CONSIGNEEADDRESS>${xmlEsc(dd.ship_to || '')}</CONSIGNEEADDRESS>`;

  const ewb = `
  <EWAYBILLDETAILS.LIST>
    <CONSIGNORADDRESS.LIST TYPE="String">
${consignorAddrXml}
    </CONSIGNORADDRESS.LIST>
    <CONSIGNEEADDRESS.LIST TYPE="String">
${consigneeAddrXml}
    </CONSIGNEEADDRESS.LIST>
    <DOCUMENTTYPE>Tax Invoice</DOCUMENTTYPE>
    <SUBTYPE>Supply</SUBTYPE>
    <CONSIGNORPLACE>${xmlEsc(dd.dispatch_from || '')}</CONSIGNORPLACE>
    <CONSIGNEEPLACE>${xmlEsc(dd.ship_to || '')}</CONSIGNEEPLACE>
    <CONSIGNORPINCODE>${xmlEsc(dd.dispatch_from_pincode || '')}</CONSIGNORPINCODE>
    <CONSIGNEEPINCODE>${xmlEsc(dd.ship_to_pincode || '')}</CONSIGNEEPINCODE>
    <SHIPPEDFROMSTATE>${xmlEsc(dd.dispatch_from_state || '')}</SHIPPEDFROMSTATE>
    <SHIPPEDTOSTATE>${xmlEsc(dd.ship_to_state || '')}</SHIPPEDTOSTATE>
    <ISCANCELLED>No</ISCANCELLED>${hasTransport ? `
    <TRANSPORTDETAILS.LIST>
      <DOCUMENTDATE>${dispatchDate}</DOCUMENTDATE>
      <TRANSPORTERID>${xmlEsc(dd.transporter_id || '')}</TRANSPORTERID>
      <TRANSPORTERNAME>${xmlEsc(dd.transporter_name || '')}</TRANSPORTERNAME>
      <TRANSPORTMODE>${xmlEsc(tallyCodedMode)}</TRANSPORTMODE>
      <VEHICLENUMBER>${xmlEsc(dd.vehicle_number || '')}</VEHICLENUMBER>
      <OLDVEHICLETYPE>${xmlEsc(tallyVehicleType)}</OLDVEHICLETYPE>
      <VEHICLETYPE>${xmlEsc(tallyVehicleType)}</VEHICLETYPE>
    </TRANSPORTDETAILS.LIST>` : ''}
  </EWAYBILLDETAILS.LIST>`;

  return ewbOnly ? ewb : [topLevel, ewb].filter(Boolean).join('\n');
}

/**
 * Voucher-level GST / reference / terms tags.
 *
 * None of these were sent by any voucher type before, which is why our PDFs were
 * missing Place of Supply, party GSTIN, reference date and the terms block that
 * native Tally entries carry.
 */
export function buildVoucherHeaderExtrasXml({
  placeOfSupply = '',
  partyGstin = '',
  consigneeGstin = '',
  referenceDate = '',
  paymentTerms = '',
  termsText = '',
} = {}) {
  const termsLines = String(termsText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const termsXml = termsLines.length
    ? [
      '  <BASICORDERTERMS.LIST TYPE="String">',
      ...termsLines.map((l) => `    <BASICORDERTERMS>${xmlEsc(l)}</BASICORDERTERMS>`),
      '  </BASICORDERTERMS.LIST>',
    ].join('\n')
    : '';

  return [
    referenceDate ? `  <REFERENCEDATE>${dispatchToTallyDate(referenceDate)}</REFERENCEDATE>` : '',
    placeOfSupply ? `  <PLACEOFSUPPLY>${xmlEsc(placeOfSupply)}</PLACEOFSUPPLY>` : '',
    partyGstin ? `  <PARTYGSTIN>${xmlEsc(partyGstin)}</PARTYGSTIN>` : '',
    consigneeGstin ? `  <CONSIGNEEGSTIN>${xmlEsc(consigneeGstin)}</CONSIGNEEGSTIN>` : '',
    paymentTerms ? `  <BASICDUEDATEOFPYMT>${xmlEsc(paymentTerms)}</BASICDUEDATEOFPYMT>` : '',
    termsXml,
  ].filter(Boolean).join('\n');
}

/** Tally posts round-off as its own ledger line, so it must be sent explicitly. */
export function buildRoundOffXml({ ledgerName = '', amount = 0 } = {}) {
  const amt = parseFloat(amount) || 0;
  if (!ledgerName || Math.abs(amt) < 0.005) return '';
  return `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>${amt < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(ledgerName)}</LEDGERNAME>
    <AMOUNT>${amt}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
}

function qtyWithUnit(qty, unit) {
  const n = parseFloat(qty);
  const q = Number.isFinite(n) ? n : 1;
  const u = String(unit || '').trim();
  return u ? ` ${q} ${u}` : String(q);
}

function rateWithUnit(rate, unit) {
  const raw = String(rate ?? 0);
  if (raw.includes('/')) return raw;
  const u = String(unit || '').trim();
  return u ? `${raw}/${u}` : raw;
}

/**
 * Per-line HSN and discount.
 *
 * Tally reads HSN from the stock item master, but only if the master has it. We
 * send the line value so a voucher stays correct even when the master is blank,
 * which is what our PDFs were missing against native entries.
 */
function itemHsnDiscountXml(item) {
  const hsn = String(item.hsn || item.hsnCode || '').trim();
  const disc = parseFloat(item.discount);
  return [
    hsn ? `\n    <HSNCODE>${xmlEsc(hsn)}</HSNCODE>` : '',
    Number.isFinite(disc) && disc !== 0 ? `\n    <DISCOUNT>${disc}</DISCOUNT>` : '',
  ].join('');
}

/**
 * Goods vs Services for a line, from the stock master's GSTTYPEOFSUPPLY.
 * Defaults to Goods because that is what Tally itself assumes for a stock item,
 * but a service item must not be forced to Goods or its GST return is wrong.
 */
export function typeOfSupplyFor(item = {}) {
  const raw = String(item.typeOfSupply || item.type_of_supply || '').trim();
  return /serv/i.test(raw) ? 'Services' : 'Goods';
}

/** Party + inventory + tax + logistics lines (no VOUCHER wrapper). Used by convert Alter. */
export function buildSalesVoucherLinesXml({
  partyLedger,
  partyAmt = 0,
  tdkRef = '',
  items = [],
  taxes = [],
  logistics = [],
  againstOrderNo = '',
}) {
  const amt = parseFloat(partyAmt) || 0;
  let xml = `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(partyLedger)}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>${tdkRef ? `
    <BILLALLOCATIONS.LIST>
      <NAME>${xmlEsc(tdkRef)}</NAME>
      <BILLTYPE>New Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${-amt}</AMOUNT>
    </BILLALLOCATIONS.LIST>` : ''}
  </LEDGERENTRIES.LIST>`;

  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    const unit = item.unit || '';
    const qtyXml = qtyWithUnit(item.actualQty || item.billedQty || 1, unit);
    const billedXml = qtyWithUnit(item.billedQty || item.actualQty || 1, unit);
    const lineGstRate = Array.isArray(item.taxEntries) && item.taxEntries.length
      ? item.taxEntries.reduce((s, t) => s + (parseFloat(t.taxRate) || 0), 0)
      : (parseFloat(item.gstRate) || parseFloat(item.taxRate) || 0);
    const gstRateXml = lineGstRate > 0
      ? `
    <GSTOVERRIDDEN>Yes</GSTOVERRIDDEN>
    <IGSTAPPLICABLERATE>${lineGstRate}</IGSTAPPLICABLERATE>`
      : '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${xmlEsc(item.itemName)}</STOCKITEMNAME>
    <GSTOVRDNTYPEOFSUPPLY>${typeOfSupplyFor(item)}</GSTOVRDNTYPEOFSUPPLY>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${qtyXml}</ACTUALQTY>
    <BILLEDQTY>${billedXml}</BILLEDQTY>
    <RATE>${rateWithUnit(item.rate || 0, unit)}</RATE>${itemHsnDiscountXml(item)}${gstRateXml}
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${xmlEsc(item.salesLedger || 'Sales Account GST')}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${xmlEsc(item.godown || 'Main Location')}</GODOWNNAME>
      ${againstOrderNo ? `<ORDERNO>${xmlEsc(againstOrderNo)}</ORDERNO>` : '<ORDERNO/>'}
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${qtyXml}</ACTUALQTY>
      <BILLEDQTY>${billedXml}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  for (const tax of taxes) {
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(tax.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(tax.taxAmount)}</AMOUNT>
    <VATASSESSABLEVALUE>${parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(lg.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(lt.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }
  return xml;
}

export function buildSalesLikeVoucherXml({
  companyName,
  vchType = 'Sales',
  action = 'Create',
  dt,
  voucherNumber = '',
  tdkRef = '',
  isOptional = true,
  narration = '',
  partyLedger,
  partyAmt = 0,
  items = [],
  taxes = [],
  logistics = [],
  againstOrderNo = '',
  topLevelDispatchXml = '',
  ewbDetailsXml = '',
  guid = '',
  masterId = '',
  placeOfSupply = '',
  partyGstin = '',
  consigneeGstin = '',
  referenceDate = '',
  paymentTerms = '',
  termsText = '',
  roundOff = null,
}) {
  const isOpt = isOptional ? 'Yes' : 'No';
  const headerExtrasXml = buildVoucherHeaderExtrasXml({
    placeOfSupply, partyGstin, consigneeGstin, referenceDate, paymentTerms, termsText,
  });
  const amt = parseFloat(partyAmt) || 0;
  const vn = voucherNumber || '';
  const isAlter = String(action).toLowerCase() === 'alter';
  const remoteAttr = guid ? ` REMOTEID="${guid}"` : '';
  const dateAttr = dt ? ` DATE="${dt}"` : '';
  // TallyHelp: Alter identity = Master ID + voucher type + date (not GUID re-import).
  const tagAttr = (isAlter && masterId) ? ` TAGNAME="MasterID" TAGVALUE="${masterId}"` : '';
  const guidXml = guid ? `\n  <GUID>${guid}</GUID>` : '';
  const masterXml = masterId ? `\n  <MASTERID>${masterId}</MASTERID>` : '';

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER${remoteAttr}${dateAttr}${tagAttr} VCHTYPE="${vchType}" ACTION="${action}" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${xmlEsc(vn)}</VOUCHERNUMBER>
  <REFERENCE>${xmlEsc(tdkRef || '')}</REFERENCE>${guidXml}${masterXml}
  <PARTYNAME>${xmlEsc(partyLedger)}</PARTYNAME>
  <PARTYLEDGERNAME>${xmlEsc(partyLedger)}</PARTYLEDGERNAME>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <VCHSTATUSISOPTIONAL>${isOpt}</VCHSTATUSISOPTIONAL>
  <NARRATION>${xmlEsc(narration || '')}</NARRATION>
${[headerExtrasXml, topLevelDispatchXml].filter(Boolean).join('\n')}

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(partyLedger)}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>${tdkRef ? `
    <BILLALLOCATIONS.LIST>
      <NAME>${xmlEsc(tdkRef)}</NAME>
      <BILLTYPE>New Ref</BILLTYPE>
      <TDSDEDUCTEEISSPECIALRATE>No</TDSDEDUCTEEISSPECIALRATE>
      <AMOUNT>${-amt}</AMOUNT>
    </BILLALLOCATIONS.LIST>` : ''}
  </LEDGERENTRIES.LIST>`;

  for (const item of items) {
    const itemAmt = parseFloat(item.amount) || 0;
    const unit = item.unit || '';
    const qtyXml = qtyWithUnit(item.actualQty || item.billedQty || 1, unit);
    const billedXml = qtyWithUnit(item.billedQty || item.actualQty || 1, unit);
    const lineGstRate = Array.isArray(item.taxEntries) && item.taxEntries.length
      ? item.taxEntries.reduce((s, t) => s + (parseFloat(t.taxRate) || 0), 0)
      : (parseFloat(item.gstRate) || parseFloat(item.taxRate) || 0);
    const gstRateXml = lineGstRate > 0
      ? `
    <GSTOVERRIDDEN>Yes</GSTOVERRIDDEN>
    <IGSTAPPLICABLERATE>${lineGstRate}</IGSTAPPLICABLERATE>`
      : '';
    xml += `
  <ALLINVENTORYENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <STOCKITEMNAME>${xmlEsc(item.itemName)}</STOCKITEMNAME>
    <GSTOVRDNTYPEOFSUPPLY>${typeOfSupplyFor(item)}</GSTOVRDNTYPEOFSUPPLY>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${qtyXml}</ACTUALQTY>
    <BILLEDQTY>${billedXml}</BILLEDQTY>
    <RATE>${rateWithUnit(item.rate || 0, unit)}</RATE>${itemHsnDiscountXml(item)}${gstRateXml}
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${xmlEsc(item.salesLedger || 'Sales Account GST')}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${xmlEsc(item.godown || 'Main Location')}</GODOWNNAME>
      ${againstOrderNo ? `<ORDERNO>${xmlEsc(againstOrderNo)}</ORDERNO>` : '<ORDERNO/>'}
      <AMOUNT>${itemAmt}</AMOUNT>
      <ACTUALQTY>${qtyXml}</ACTUALQTY>
      <BILLEDQTY>${billedXml}</BILLEDQTY>
    </BATCHALLOCATIONS.LIST>
  </ALLINVENTORYENTRIES.LIST>`;
  }

  for (const tax of taxes) {
    xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(tax.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(tax.taxAmount)}</AMOUNT>
    <VATASSESSABLEVALUE>${parseFloat(tax.taxableValue)}</VATASSESSABLEVALUE>
  </LEDGERENTRIES.LIST>`;
  }

  for (const lg of logistics) {
    if (!lg.ledgerName) continue;
    xml += `
  <LEDGERENTRIES.LIST>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(lg.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${xmlEsc(lt.ledgerName)}</LEDGERNAME>
    <AMOUNT>${parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }

  if (roundOff) xml += buildRoundOffXml(roundOff);
  if (ewbDetailsXml) xml += ewbDetailsXml;

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;
  return xml;
}

/** Minimal Alter by DATE + TAGNAME=MASTER ID (proven 2026-08-18 on voucher 8560). */
export function buildMinimalVoucherAlterXml({
  companyName,
  vchType = 'Sales',
  dt,
  masterId,
  tagName = 'MASTER ID',
  narration,
  isOptional,
  extraInnerXml = '',
}) {
  let inner = '';
  if (narration != null && narration !== '') {
    inner += `\n  <NARRATION>${xmlEsc(narration)}</NARRATION>`;
  }
  if (typeof isOptional === 'boolean') {
    const isOpt = isOptional ? 'Yes' : 'No';
    inner += `\n  <ISOPTIONAL>${isOpt}</ISOPTIONAL>\n  <VCHSTATUSISOPTIONAL>${isOpt}</VCHSTATUSISOPTIONAL>`;
  }
  if (extraInnerXml) inner += `\n${extraInnerXml}`;
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER DATE="${dt}" TAGNAME="${tagName}" TAGVALUE="${masterId}" ACTION="Alter" VCHTYPE="${vchType}">${inner}
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;
}

/** Cancel a voucher Tally just created by mistake (Alter that became Create). */
export function buildVoucherCancelXml({ companyName, vchType = 'Sales', dt, masterId, guid = '', voucherNumber = '' }) {
  const remoteAttr = guid ? ` REMOTEID="${guid}"` : '';
  const dateAttr = dt ? ` DATE="${dt}"` : '';
  const tagAttr = masterId ? ` TAGNAME="MasterID" TAGVALUE="${masterId}"` : '';
  return `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER${remoteAttr}${dateAttr}${tagAttr} VCHTYPE="${vchType}" ACTION="Cancel">
  <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  ${voucherNumber ? `<VOUCHERNUMBER>${voucherNumber}</VOUCHERNUMBER>` : ''}
  <ISCANCELLED>Yes</ISCANCELLED>
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;
}
