/**
 * GST Voucher Classifier
 * Determines which GSTR tabs a voucher belongs to based on company type and voucher data.
 * Used for classification, gst_tabs_json storage, and cross-tab impact analysis.
 */

export function getGstTabsForVoucher(voucher, gstTaxpayerType = 'Regular') {
  const tabs = [];
  if (!voucher || voucher.is_cancelled) return tabs;

  const parent = (voucher.voucher_type_parent || '').toLowerCase();
  const isOutward  = ['sales', 'credit note', 'debit note'].includes(parent);
  const isPurchase = parent === 'purchase';
  const hasGst     = !!(voucher.cgst_amount > 0 || voucher.sgst_amount > 0 || voucher.igst_amount > 0);
  const hasGstin   = !!(voucher.party_gstin);

  // ── Regular taxpayer tabs ─────────────────────────────────────────────────
  if (gstTaxpayerType === 'Regular' || !gstTaxpayerType) {
    if (isOutward)                           tabs.push('GSTR-1');
    if (isPurchase && hasGstin)              { tabs.push('GSTR-2A'); tabs.push('GSTR-2B'); }
    if (isOutward || (isPurchase && hasGst)) tabs.push('GSTR-3B');
    if (isOutward || isPurchase)             tabs.push('GSTR-9');
  }

  // ── Special tabs (role-gated) ─────────────────────────────────────────────
  if (gstTaxpayerType === 'Composition') {
    if (isOutward || isPurchase) tabs.push('GSTR-4');
  }
  if (gstTaxpayerType === 'NonResident') {
    tabs.push('GSTR-5');
  }
  if (gstTaxpayerType === 'OIDAR' && isOutward) {
    tabs.push('GSTR-5A');
  }
  if (gstTaxpayerType === 'ISD') {
    tabs.push('GSTR-6');
  }
  if (gstTaxpayerType === 'TDS_Deductor' && voucher.has_gst_tds) {
    tabs.push('GSTR-7');
  }
  if (gstTaxpayerType === 'Ecommerce_Operator' && voucher.has_gst_tcs) {
    tabs.push('GSTR-8');
  }
  if (gstTaxpayerType === 'Cancelled') {
    tabs.push('GSTR-10');
  }
  if (gstTaxpayerType === 'UIN' && isPurchase) {
    tabs.push('GSTR-11');
  }

  return [...new Set(tabs)]; // deduplicate
}

export function getVouchersForGstTab(vouchers, gstTaxpayerType, selectedTab) {
  return vouchers.filter(v => getGstTabsForVoucher(v, gstTaxpayerType).includes(selectedTab));
}

export function getClassificationReason(voucher, gstrType) {
  const vt      = voucher.voucher_type || '';
  const section = voucher.gst_section || '';
  const s3b     = voucher.gstr3b_section || '';

  switch (gstrType) {
    case 'GSTR-1':
      if (section === 'B2B')            return `Outward supply to registered party (${vt})`;
      if (section === 'B2B Interstate') return `Interstate outward to registered party (${vt})`;
      if (section === 'B2C')            return `Outward supply to unregistered party (${vt})`;
      if (section === 'Export')         return `Export/zero-rated supply (${vt})`;
      if (section === 'SEZ')            return `SEZ supply (${vt})`;
      return `Outward supply (${vt})`;
    case 'GSTR-2A':
    case 'GSTR-2B':
      return `Purchase from registered GSTIN supplier (${vt})`;
    case 'GSTR-3B':
      if (s3b === '3.1(a)') return `Regular outward taxable supply (${vt})`;
      if (s3b === '3.1(b)') return `Zero-rated / export supply (${vt})`;
      if (s3b === '3.1(c)') return `Nil-rated / exempt supply (${vt})`;
      if (s3b === '3.1(d)') return `Reverse charge inward supply (${vt})`;
      if (s3b === '4A ITC') return `Eligible ITC from inward supply (${vt})`;
      return `GST-relevant entry for 3B (${vt})`;
    case 'GSTR-9':
      return `Annual GST return — ${voucher.voucher_type_parent || vt}`;
    default:
      return `${gstrType} relevant voucher (${vt})`;
  }
}
