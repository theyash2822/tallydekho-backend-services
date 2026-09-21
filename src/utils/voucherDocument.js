/**
 * Shared helpers for building the VoucherDocument preview/PDF snapshot.
 *
 * These exist because the Tally print layout (see tallydekho-brain/PDF_LAYOUT_SPEC.md)
 * needs several values that are not stored anywhere: the company PAN (derived from
 * GSTIN), GST state codes, the amount-in-words line, and the cgst/sgst/igst split of
 * a flat `taxes[]` array.
 */

import { query } from '../db/schema.js';

// ── Amount in words (Indian system, matches Tally's wording exactly) ──────────

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  if (n < 20) return ONES[n];
  const t = Math.floor(n / 10);
  const o = n % 10;
  return o ? `${TENS[t]} ${ONES[o]}` : TENS[t];
}

function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(`${ONES[h]} Hundred`);
  if (r) parts.push(below100(r));
  return parts.join(' ');
}

/** 129437 → "One Lakh Twenty Nine Thousand Four Hundred Thirty Seven" */
export function indianWords(value) {
  let n = Math.floor(Math.abs(Number(value) || 0));
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

/**
 * Tally's "Amount Chargeable (in words)" line.
 * 129437.50 → "Indian Rupees One Lakh Twenty Nine Thousand Four Hundred Thirty Seven and Fifty paise Only"
 */
export function amountInWords(value, currency = 'Indian Rupees') {
  const amount = Number(value) || 0;
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);
  let out = `${currency} ${indianWords(rupees)}`;
  if (paise > 0) out += ` and ${indianWords(paise)} paise`;
  if (amount < 0) out = `(-) ${out}`;
  return `${out} Only`;
}

// ── GST identity derivation ──────────────────────────────────────────────────

/** GSTIN 23ACLPP1226E1ZZ → PAN ACLPP1226E. Tally prints this as "Company's PAN". */
export function panFromGstin(gstin) {
  const m = String(gstin || '').toUpperCase().match(/^\d{2}([A-Z]{5}\d{4}[A-Z])/);
  return m ? m[1] : '';
}

export const GST_STATE_CODES = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03', 'chandigarh': '04',
  'uttarakhand': '05', 'haryana': '06', 'delhi': '07', 'rajasthan': '08',
  'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11', 'arunachal pradesh': '12',
  'nagaland': '13', 'manipur': '14', 'mizoram': '15', 'tripura': '16',
  'meghalaya': '17', 'assam': '18', 'west bengal': '19', 'jharkhand': '20',
  'odisha': '21', 'orissa': '21', 'chhattisgarh': '22', 'madhya pradesh': '23',
  'gujarat': '24', 'daman and diu': '25', 'dadra and nagar haveli and daman and diu': '26',
  'maharashtra': '27', 'andhra pradesh': '37', 'karnataka': '29', 'goa': '30',
  'lakshadweep': '31', 'kerala': '32', 'tamil nadu': '33', 'puducherry': '34',
  'andaman and nicobar islands': '35', 'telangana': '36', 'ladakh': '38',
  'other territory': '97',
};

/** Prefer the GSTIN prefix (authoritative), fall back to the state-name lookup. */
export function stateCode(stateName, gstin) {
  const fromGstin = String(gstin || '').trim().slice(0, 2);
  if (/^\d{2}$/.test(fromGstin)) return fromGstin;
  return GST_STATE_CODES[String(stateName || '').trim().toLowerCase()] || '';
}

// ── Tax ledger classification ────────────────────────────────────────────────

/** Maps a tax ledger onto its GST component so the PDF can print the split. */
export function classifyTaxKind(ledgerName, declaredKind) {
  const declared = String(declaredKind || '').toLowerCase();
  if (['cgst', 'sgst', 'igst', 'cess'].includes(declared)) return declared;
  const n = String(ledgerName || '').toLowerCase();
  if (/\bigst\b/.test(n)) return 'igst';
  if (/\bcgst\b/.test(n)) return 'cgst';
  if (/\b(sgst|utgst)\b/.test(n)) return 'sgst';
  if (/cess/.test(n)) return 'cess';
  return 'other';
}

/** Tally posts round-off through a dedicated ledger; we ship it inside `logistics`. */
export function isRoundOffLedger(ledgerName) {
  return /round\s*(ed)?\s*off/i.test(String(ledgerName || ''));
}

// ── Numeric helpers ──────────────────────────────────────────────────────────

export function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round2(v) {
  return Math.round((num(v) + Number.EPSILON) * 100) / 100;
}

// ── Document context loading ─────────────────────────────────────────────────

/**
 * Loads the company, party and stock-item masters a document snapshot needs.
 *
 * `companies` has no pan/phone/email columns and `ledgers` has no mailing_address,
 * so the previous inline queries silently returned nothing and every preview
 * rendered an empty seller and buyer block. Column lists here are checked against
 * the live schema; PAN is derived from the GSTIN.
 */
export async function loadDocumentContext(companyId, partyName, itemNames = []) {
  const [companyRes, profileRes, partyRes, stockRes] = await Promise.all([
    query(
      `SELECT name, formal_name, gstin, pan, phone, mobile, email, website,
              address, state, pincode, country, currency
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId]
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT * FROM company_print_profile WHERE company_id=$1 LIMIT 1`,
      [companyId]
    ).catch(() => ({ rows: [] })),
    partyName
      ? query(
        `SELECT name, gstin, pan, phone, mobile, email, address, state_name, pincode,
                gst_registration_type
           FROM ledgers
          WHERE company_id=$1 AND LOWER(name) = LOWER($2)
          LIMIT 1`,
        [companyId, partyName]
      ).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
    itemNames.length
      ? query(
        `SELECT name, unit, hsn, tax_rate, type_of_supply FROM stocks
          WHERE company_id=$1 AND LOWER(name) = ANY($2::text[])`,
        [companyId, itemNames.map((n) => String(n || '').toLowerCase())]
      ).catch(() => ({ rows: [] }))
      : Promise.resolve({ rows: [] }),
  ]);

  const itemMasters = new Map();
  for (const row of stockRes.rows) {
    itemMasters.set(String(row.name || '').toLowerCase(), row);
  }

  return {
    companyRow: companyRes.rows[0] || null,
    printProfile: profileRes.rows[0] || null,
    partyRow: partyRes.rows[0] || null,
    itemMasters,
  };
}

export const DEFAULT_DECLARATION =
  'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct.';

/**
 * Seller block for the PDF header.
 *
 * The synced `companies` row wins; the print profile only fills fields Tally's
 * company export never delivers. PAN falls back to the GSTIN's embedded PAN.
 */
export function buildCompanyBlock(companyRow, payload = {}, printProfile = null) {
  const gstin = companyRow?.gstin || printProfile?.gstin || '';
  const state = companyRow?.state || '';
  return {
    name: companyRow?.name || payload.companyName || '',
    formalName: companyRow?.formal_name || companyRow?.name || payload.companyName || '',
    address: companyRow?.address || '',
    gstin,
    pan: companyRow?.pan || printProfile?.pan || panFromGstin(gstin),
    phone: companyRow?.phone || companyRow?.mobile || printProfile?.phone || '',
    email: companyRow?.email || printProfile?.email || '',
    website: companyRow?.website || '',
    state,
    stateCode: stateCode(state, gstin),
    pincode: companyRow?.pincode || '',
    country: companyRow?.country || 'India',
    currency: companyRow?.currency || 'INR',
    jurisdiction: printProfile?.jurisdiction || '',
    declarationText: printProfile?.declaration_text || DEFAULT_DECLARATION,
    bank: printProfile?.bank_name ? {
      name: printProfile.bank_name,
      accountNo: printProfile.bank_account_no || '',
      ifsc: printProfile.bank_ifsc || '',
      branch: printProfile.bank_branch || '',
    } : null,
  };
}

/** Buyer / supplier block for the PDF header. */
export function buildPartyBlock(partyRow, fallbackName = '') {
  const gstin = partyRow?.gstin || '';
  const state = partyRow?.state_name || '';
  return {
    name: partyRow?.name || fallbackName || '',
    address: partyRow?.address || '',
    gstin,
    pan: partyRow?.pan || panFromGstin(gstin),
    phone: partyRow?.phone || partyRow?.mobile || '',
    email: partyRow?.email || '',
    state,
    stateCode: stateCode(state, gstin),
    pincode: partyRow?.pincode || '',
    gstRegistrationType: partyRow?.gst_registration_type || '',
  };
}

/**
 * Normalises `payload.items[]` into the shape the Tally items table needs,
 * filling HSN and unit from the stock master when the entry screen omitted them.
 */
export function buildItemLines(payload = {}, itemMasters = new Map()) {
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  return rawItems.map((item, idx) => {
    const name = item.itemName || item.name || 'Item';
    const master = itemMasters.get(String(name).toLowerCase()) || null;
    const qty = num(item.billedQty ?? item.actualQty ?? item.qty, 1);
    const rate = num(item.rate);
    const amount = num(item.amount, round2(qty * rate));
    const lineTaxes = Array.isArray(item.lineTaxes) ? item.lineTaxes
      : (Array.isArray(item.taxEntries) ? item.taxEntries : []);
    const taxPct = lineTaxes.length
      ? round2(lineTaxes.reduce((s, t) => s + num(t.taxRate), 0))
      : num(item.gstRate ?? item.taxRate ?? master?.tax_rate);
    const taxAmount = lineTaxes.length
      ? round2(lineTaxes.reduce((s, t) => s + num(t.taxAmount), 0))
      : num(item.taxAmount);
    const discount = num(item.discount);
    // The entry screens send discountType, but older payloads omit it. Assuming
    // '%' there reads a flat rupee discount as a percentage, so infer it from the
    // line's own arithmetic instead — `amount` is already net of the discount.
    let discountType = item.discountType || '';
    if (!discountType && discount) {
      const gross = round2(qty * rate);
      const implied = round2(gross - amount);
      const asPct = round2((gross * discount) / 100);
      discountType = Math.abs(implied - discount) < Math.abs(implied - asPct) ? 'flat' : '%';
    }

    return {
      id: String(idx),
      name,
      description: item.description || '',
      hsn: item.hsn || master?.hsn || '',
      qty,
      actualQty: num(item.actualQty ?? qty, qty),
      unit: item.unit || master?.unit || 'Nos',
      rate,
      discount,
      discountType,
      taxPct,
      taxAmount,
      taxableAmount: num(item.taxableValue, amount),
      amount,
      godown: item.godown || '',
      batch: item.batch || '',
      ledgerName: item.salesLedger || item.purchaseLedger || '',
      lineTaxes: lineTaxes.map((t) => ({
        description: t.ledgerName || 'Tax',
        kind: classifyTaxKind(t.ledgerName, t.kind),
        rate: num(t.taxRate),
        amount: num(t.taxAmount),
      })),
    };
  });
}

/**
 * Splits the flat `payload.taxes[]` into per-ledger lines carrying their GST
 * component, so the renderer can print both the inline tax rows and the
 * HSN/SAC tax summary table.
 */
export function buildTaxLines(payload = {}) {
  const raw = Array.isArray(payload.taxes) ? payload.taxes : [];
  return raw.map((t) => {
    const kind = classifyTaxKind(t.ledgerName, t.kind);
    const total = num(t.taxAmount);
    return {
      description: t.ledgerName || 'Tax',
      kind,
      rate: num(t.taxRate),
      taxableAmount: num(t.taxableValue),
      total,
      cgst: kind === 'cgst' ? total : 0,
      sgst: kind === 'sgst' ? total : 0,
      igst: kind === 'igst' ? total : 0,
      cess: kind === 'cess' ? total : 0,
    };
  });
}

/**
 * Charge lines from `payload.logistics[]`. Round-off is pulled out because Tally
 * shows it as its own row rather than as a freight-style charge.
 */
export function buildChargeLines(payload = {}) {
  const raw = Array.isArray(payload.logistics) ? payload.logistics : [];
  const charges = [];
  let roundOff = 0;
  let roundOffLabel = '';
  for (const l of raw) {
    if (!l?.ledgerName) continue;
    if (isRoundOffLedger(l.ledgerName)) {
      roundOff += num(l.amount);
      roundOffLabel = l.ledgerName;
      continue;
    }
    charges.push({
      description: l.ledgerName,
      amount: num(l.amount),
      taxes: (Array.isArray(l.taxes) ? l.taxes : []).map((t) => ({
        description: t.ledgerName || 'Tax',
        kind: classifyTaxKind(t.ledgerName, t.kind),
        rate: num(t.taxRate),
        amount: num(t.taxAmount),
      })),
    });
  }
  return { charges, roundOff: round2(roundOff), roundOffLabel };
}

/**
 * The HSN/SAC summary table Tally prints under the amount-in-words block:
 * one row per HSN with its taxable value and GST split.
 */
export function buildHsnSummary(items = [], taxLines = []) {
  const taxableTotal = items.reduce((s, i) => s + num(i.taxableAmount || i.amount), 0);
  const byKind = taxLines.reduce((acc, t) => {
    acc[t.kind] = round2((acc[t.kind] || 0) + t.total);
    return acc;
  }, {});

  const groups = new Map();
  for (const item of items) {
    const key = item.hsn || '';
    const taxable = num(item.taxableAmount || item.amount);
    const existing = groups.get(key) || { hsn: key, taxableAmount: 0, taxPct: item.taxPct || 0 };
    existing.taxableAmount = round2(existing.taxableAmount + taxable);
    groups.set(key, existing);
  }

  // Apportion the voucher-level tax across HSN groups by taxable share.
  return Array.from(groups.values()).map((g) => {
    const share = taxableTotal > 0 ? g.taxableAmount / taxableTotal : 0;
    const cgst = round2((byKind.cgst || 0) * share);
    const sgst = round2((byKind.sgst || 0) * share);
    const igst = round2((byKind.igst || 0) * share);
    const cess = round2((byKind.cess || 0) * share);
    return {
      ...g,
      cgst,
      sgst,
      igst,
      cess,
      totalTax: round2(cgst + sgst + igst + cess),
    };
  });
}

/** Totals block, including the GST split and taxable value Tally prints. */
export function buildTotals(payload, av, items, taxLines, charges, roundOff) {
  const subtotal = round2(items.reduce((s, i) => s + i.amount, 0));
  const taxableAmount = round2(items.reduce((s, i) => s + num(i.taxableAmount || i.amount), 0));
  const discount = round2(items.reduce((s, i) => {
    if (!i.discount) return s;
    const gross = i.qty * i.rate;
    return s + (i.discountType === '%' ? (gross * i.discount) / 100 : i.discount);
  }, 0));
  const chargeTotal = round2(charges.reduce((s, c) => s + c.amount, 0));
  const chargeTaxTotal = round2(charges.reduce(
    (s, c) => s + c.taxes.reduce((ts, t) => ts + t.amount, 0), 0
  ));
  const voucherTaxTotal = round2(taxLines.reduce((s, t) => s + t.total, 0));
  const sumBy = (kind) => round2(
    taxLines.filter((t) => t.kind === kind).reduce((s, t) => s + t.total, 0)
    + charges.reduce((s, c) => s + c.taxes.filter((t) => t.kind === kind)
      .reduce((ts, t) => ts + t.amount, 0), 0)
  );
  const grandTotal = round2(num(av?.total_amount, num(payload?.totalAmount)));

  return {
    subtotal,
    taxableAmount,
    discount,
    chargeTotal,
    taxTotal: round2(voucherTaxTotal + chargeTaxTotal),
    cgstTotal: sumBy('cgst'),
    sgstTotal: sumBy('sgst'),
    igstTotal: sumBy('igst'),
    cessTotal: sumBy('cess'),
    roundOff: round2(roundOff || num(payload?.roundOffAmount)),
    grandTotal,
    totalQty: round2(items.reduce((s, i) => s + i.qty, 0)),
  };
}

/**
 * Metadata for the right-hand header grid of the Tally invoice layout.
 * Every key is always present — Tally renders the label even when blank.
 */
export function buildDocumentMetadata(payload = {}, av = {}) {
  const dd = payload.dispatch_details || {};
  const linked = payload.linked_invoice || payload.linkedInvoice || null;
  return {
    referenceNo: payload.reference || av.tdk_reference_no || '',
    referenceDate: payload.referenceDate || payload.date || '',
    buyersOrderNo: payload.againstOrderNo || payload.buyersOrderNo || '',
    buyersOrderDate: payload.againstOrderDate || '',
    otherReferences: payload.otherReferences || '',
    supplierInvoiceNo: payload.vendorInvoiceNo || '',
    supplierInvoiceDate: payload.vendorInvoiceDate || '',
    originalInvoiceNo: linked?.voucherNumber || linked?.billRefName || '',
    originalInvoiceDate: linked?.date || '',
    deliveryNoteNo: dd.delivery_note_no || '',
    deliveryNoteDate: dd.delivery_note_date || '',
    dispatchDocNo: dd.transport_doc_no || '',
    dispatchDocDate: dd.transport_doc_date || '',
    dispatchedThrough: dd.dispatched_through || dd.carrier_name || '',
    destination: dd.ship_to || '',
    billOfLadingNo: dd.bill_of_lading_no || '',
    billOfLadingDate: dd.bill_of_lading_date || '',
    motorVehicleNo: dd.vehicle_number || '',
    transportMode: dd.transport_mode || '',
    termsOfDelivery: dd.terms_of_delivery || '',
    paymentTerms: dd.mode_of_payment || payload.paymentTerms || '',
    dueDate: payload.dueDate || '',
    placeOfSupply: dd.ship_to_state || payload.placeOfSupply || '',
    ewayBillNo: payload.ewayBillNo || av.ewb_number || '',
    ewayBillDate: payload.ewayBillDate || '',
    irn: payload.irn || av.irn || '',
    ackNo: payload.ackNo || av.ack_no || '',
    ackDate: payload.ackDate || av.ack_date || '',
  };
}

/** Consignee (Ship to) block. */
export function buildShippingBlock(payload = {}, partyBlock = {}) {
  const dd = payload.dispatch_details || {};
  const hasShipTo = !!(dd.ship_to || dd.ship_to_address1 || dd.ship_to_state);
  if (!hasShipTo) return null;
  return {
    name: dd.ship_to_name || partyBlock.name || '',
    address: [dd.ship_to_address1, dd.ship_to_address2, dd.ship_to]
      .map((l) => String(l || '').trim()).filter(Boolean).join(', '),
    state: dd.ship_to_state || partyBlock.state || '',
    stateCode: stateCode(dd.ship_to_state || partyBlock.state, dd.ship_to_gstin || partyBlock.gstin),
    gstin: dd.ship_to_gstin || partyBlock.gstin || '',
    pincode: dd.ship_to_pincode || '',
  };
}

/** Dispatch-from block, used as the consignor on e-way bill style prints. */
export function buildDispatchFromBlock(payload = {}, companyBlock = {}) {
  const dd = payload.dispatch_details || {};
  const hasFrom = !!(dd.dispatch_from || dd.dispatch_from_address1 || dd.dispatch_from_state);
  if (!hasFrom) return null;
  return {
    name: companyBlock.name || '',
    address: [dd.dispatch_from_address1, dd.dispatch_from_address2, dd.dispatch_from]
      .map((l) => String(l || '').trim()).filter(Boolean).join(', '),
    state: dd.dispatch_from_state || companyBlock.state || '',
    stateCode: stateCode(dd.dispatch_from_state || companyBlock.state, companyBlock.gstin),
    pincode: dd.dispatch_from_pincode || companyBlock.pincode || '',
  };
}
