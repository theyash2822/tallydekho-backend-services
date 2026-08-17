/**
 * Shared Sales-shaped voucher XML (Sales Invoice + Proforma).
 * Shape aligned to a real TallyPrime optional Sales export
 * (Sales_TD1531-3-2026.xml, Yash Ki Company, 2026-08-17):
 *   OBJVIEW + PERSISTEDVIEW = Invoice Voucher View
 *   VCHENTRYMODE = Item Invoice
 *   ISOPTIONAL + VCHSTATUSISOPTIONAL
 *   DIFFACTUALQTY = Yes
 *   GUID / MASTERID / ALTERID / REMOTEID for Alter (same voucher, no duplicate)
 * Proforma create: ACTION=Create, ISOPTIONAL=Yes.
 * Convert: ACTION=Alter, ISOPTIONAL=No.
 */

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
  alterId = '',
}) {
  const isOpt = isOptional ? 'Yes' : 'No';
  const amt = parseFloat(partyAmt) || 0;
  const vn = voucherNumber || '';
  const remoteAttr = guid ? ` REMOTEID="${guid}"` : '';
  const guidXml = guid ? `\n  <GUID>${guid}</GUID>` : '';
  const masterXml = masterId ? `\n  <MASTERID>${masterId}</MASTERID>` : '';
  const alterXml = alterId ? `\n  <ALTERID>${alterId}</ALTERID>` : '';

  let xml = `<ENVELOPE>
<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
<BODY><IMPORTDATA>
<REQUESTDESC>
  <REPORTNAME>Vouchers</REPORTNAME>
  <STATICVARIABLES><SVCURRENTCOMPANY>${companyName}</SVCURRENTCOMPANY></STATICVARIABLES>
</REQUESTDESC>
<REQUESTDATA>
<TALLYMESSAGE xmlns:UDF="TallyUDF">
<VOUCHER${remoteAttr} VCHTYPE="${vchType}" ACTION="${action}" OBJVIEW="Invoice Voucher View">
  <VOUCHERTYPENAME>${vchType}</VOUCHERTYPENAME>
  <DATE>${dt}</DATE>
  <EFFECTIVEDATE>${dt}</EFFECTIVEDATE>
  <VOUCHERNUMBER>${vn}</VOUCHERNUMBER>
  <REFERENCE>${tdkRef || ''}</REFERENCE>${guidXml}${masterXml}${alterXml}
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
