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
}) {
  const isOpt = isOptional ? 'Yes' : 'No';
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
  <VOUCHERNUMBER>${vn}</VOUCHERNUMBER>
  <REFERENCE>${tdkRef || ''}</REFERENCE>${guidXml}${masterXml}
  <PARTYNAME>${partyLedger}</PARTYNAME>
  <PARTYLEDGERNAME>${partyLedger}</PARTYLEDGERNAME>
  <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
  <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
  <ISINVOICE>Yes</ISINVOICE>
  <ISCANCELLED>No</ISCANCELLED>
  <ISPOSTDATED>No</ISPOSTDATED>
  <DIFFACTUALQTY>Yes</DIFFACTUALQTY>
  <ISOPTIONAL>${isOpt}</ISOPTIONAL>
  <VCHSTATUSISOPTIONAL>${isOpt}</VCHSTATUSISOPTIONAL>
  <NARRATION>${narration || ''}</NARRATION>
${topLevelDispatchXml || ''}

  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <ISPARTYLEDGER>Yes</ISPARTYLEDGER>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${partyLedger}</LEDGERNAME>
    <AMOUNT>${-amt}</AMOUNT>${tdkRef ? `
    <BILLALLOCATIONS.LIST>
      <NAME>${tdkRef}</NAME>
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
    <STOCKITEMNAME>${item.itemName}</STOCKITEMNAME>
    <GSTOVRDNTYPEOFSUPPLY>Goods</GSTOVRDNTYPEOFSUPPLY>
    <AMOUNT>${itemAmt}</AMOUNT>
    <ACTUALQTY>${qtyXml}</ACTUALQTY>
    <BILLEDQTY>${billedXml}</BILLEDQTY>
    <RATE>${rateWithUnit(item.rate || 0, unit)}</RATE>${gstRateXml}
    <ACCOUNTINGALLOCATIONS.LIST>
      <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <LEDGERFROMITEM>No</LEDGERFROMITEM>
      <LEDGERNAME>${item.salesLedger || 'Sales Account GST'}</LEDGERNAME>
      <AMOUNT>${itemAmt}</AMOUNT>
    </ACCOUNTINGALLOCATIONS.LIST>
    <BATCHALLOCATIONS.LIST>
      <BATCHNAME>Primary Batch</BATCHNAME>
      <GODOWNNAME>${item.godown || 'Main Location'}</GODOWNNAME>
      ${againstOrderNo ? `<ORDERNO>${againstOrderNo}</ORDERNO>` : '<ORDERNO/>'}
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
    <LEDGERNAME>${tax.ledgerName}</LEDGERNAME>
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
    <LEDGERNAME>${lg.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lg.amount) || 0}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    for (const lt of (lg.taxes || [])) {
      if (!lt.ledgerName || !(parseFloat(lt.taxAmount) > 0)) continue;
      xml += `
  <LEDGERENTRIES.LIST>
    <REMOVEZEROENTRIES>No</REMOVEZEROENTRIES>
    <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
    <LEDGERFROMITEM>No</LEDGERFROMITEM>
    <LEDGERNAME>${lt.ledgerName}</LEDGERNAME>
    <AMOUNT>${parseFloat(lt.taxAmount)}</AMOUNT>
  </LEDGERENTRIES.LIST>`;
    }
  }

  if (ewbDetailsXml) xml += ewbDetailsXml;

  xml += `
</VOUCHER>
</TALLYMESSAGE>
</REQUESTDATA>
</IMPORTDATA></BODY></ENVELOPE>`;
  return xml;
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
