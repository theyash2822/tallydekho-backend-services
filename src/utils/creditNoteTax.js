/**
 * Credit Note (Sales Return) tax math — server source of truth.
 *
 * Reverses original invoice taxable value + original GST/cess geometry.
 * Never invents GST on exempt invoices. Never uses today's stock master rate.
 *
 * Allocation:
 *   1. item_rate — every returned line has a positive original gstRate → per-line GST
 *   2. proportional — scale original tax ledgers by returnTaxable / invoiceTaxable
 *   3. none — SALES_RETURN_WITHOUT_GST
 */

const normalizeName = (value) => String(value ?? '').trim().toLowerCase();
const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (value) => Math.round(num(value) * 100) / 100;
const round3 = (value) => Math.round(num(value) * 1000) / 1000;

export const RETURN_TAX_WITH_GST = 'SALES_RETURN_WITH_GST';
export const RETURN_TAX_WITHOUT_GST = 'SALES_RETURN_WITHOUT_GST';

export function classifyTaxLedger(name) {
  const n = String(name || '');
  if (/igst/i.test(n)) return 'igst';
  if (/cgst/i.test(n)) return 'cgst';
  if (/sgst|utgst/i.test(n)) return 'sgst';
  if (/cess/i.test(n)) return 'cess';
  // Bare "GST" (common for logistics/expense GST in Tally) — not CGST/SGST/IGST.
  if (/^\s*gst\s*$/i.test(n) || /^gst\s*\d/i.test(n)) return 'gst';
  return 'other';
}

/**
 * Stock-return GST reverse should only touch inventory GST ledgers.
 * When the invoice already has CGST/SGST (or IGST), a bare "GST" ledger is almost
 * always tax on Transportation / packing / other charges — do not reverse it on a
 * goods-only Credit Note.
 */
export function isStockReturnTaxLedger(name, siblingKinds = []) {
  const kind = classifyTaxLedger(name);
  if (kind === 'cgst' || kind === 'sgst' || kind === 'igst' || kind === 'cess') return true;
  if (kind !== 'gst') return false;
  const hasSplit = siblingKinds.some(k => k === 'cgst' || k === 'sgst' || k === 'igst');
  // Keep bare GST only when it is the sole GST style on the invoice (old single-ledger books).
  return !hasSplit;
}

export function filterStockReturnTaxRows(taxRows = []) {
  const kinds = taxRows.map(t => classifyTaxLedger(t.ledgerName || t.ledger || t.name));
  return taxRows.filter((t, i) => isStockReturnTaxLedger(t.ledgerName || t.ledger || t.name, kinds));
}

/**
 * Build GST geometry from invoice context taxes + gst_voucher_details.
 */
export function buildTaxGeometry(context = {}) {
  const taxRows = Array.isArray(context.taxes) ? context.taxes : [];
  const gst = context.gst || null;
  const items = Array.isArray(context.items) ? context.items : [];

  const originalTaxable = round2(
    num(gst?.taxableAmount)
    || num(context.totals?.salesLedgerTotal)
    || num(context.totals?.itemsTotal)
    || items.reduce((s, i) => s + num(i.soldAmount), 0)
  );

  const legs = [];
  for (const t of filterStockReturnTaxRows(taxRows)) {
    const ledgerName = String(t.ledgerName || t.ledger || '').trim();
    if (!ledgerName) continue;
    const originalAmount = round2(Math.abs(num(t.taxAmount ?? t.amount)));
    if (!(originalAmount > 0) && !(num(t.taxRate) > 0)) continue;
    const kind = classifyTaxLedger(ledgerName);
    const taxRate = t.taxRate != null && t.taxRate !== ''
      ? round2(num(t.taxRate))
      : (originalTaxable > 0 ? round2((originalAmount / originalTaxable) * 100) : 0);
    legs.push({
      ledgerName,
      kind,
      originalAmount,
      taxRate,
    });
  }

  const taxTotal = round2(legs.reduce((s, l) => s + l.originalAmount, 0));
  const hasGstDetails = gst && (
    num(gst.cgstAmount) > 0 || num(gst.sgstAmount) > 0 || num(gst.igstAmount) > 0
  );
  const returnTaxMode = (legs.length > 0 || hasGstDetails)
    ? RETURN_TAX_WITH_GST
    : RETURN_TAX_WITHOUT_GST;

  const hasIgst = legs.some(l => l.kind === 'igst') || num(gst?.igstAmount) > 0;
  const hasLocal = legs.some(l => l.kind === 'cgst' || l.kind === 'sgst')
    || num(gst?.cgstAmount) > 0 || num(gst?.sgstAmount) > 0;
  const isInterstate = hasIgst && !hasLocal;

  const itemRates = items.map(i => num(i.gstRate)).filter(r => r > 0);
  const allItemsHaveRate = items.length > 0 && items.every(i => num(i.gstRate) > 0);
  const uniqueItemRates = [...new Set(itemRates.map(r => round2(r)))];
  const singleSlabRate = uniqueItemRates.length === 1 ? uniqueItemRates[0] : null;

  // Prefer item rates when every invoice line has one, or invoice is single-slab.
  // item_rate needs original tax ledger legs to allocate CGST/SGST/IGST; without
  // legs fall through to proportional (gst_voucher_details) so GST is not dropped.
  let allocationMode = 'none';
  if (returnTaxMode === RETURN_TAX_WITH_GST) {
    if ((allItemsHaveRate || singleSlabRate != null) && legs.length > 0) allocationMode = 'item_rate';
    else if (legs.length > 0 && originalTaxable > 0) allocationMode = 'proportional';
    else if (hasGstDetails && originalTaxable > 0) allocationMode = 'proportional';
  }

  return {
    returnTaxMode,
    allocationMode,
    originalTaxable,
    originalTaxTotal: taxTotal,
    isInterstate,
    placeOfSupply: gst?.placeOfSupply || null,
    legs,
    singleSlabRate,
    fallbackUsed: allocationMode === 'proportional',
  };
}

function netTaxablePerUnit(ctxItem) {
  const soldQty = num(ctxItem.soldQty);
  if (soldQty > 0 && num(ctxItem.netTaxablePerUnit) > 0) {
    return round2(num(ctxItem.netTaxablePerUnit));
  }
  if (soldQty > 0 && num(ctxItem.soldAmount) > 0) {
    return round2(num(ctxItem.soldAmount) / soldQty);
  }
  return round2(num(ctxItem.rate));
}

function lineGstRate(ctxItem, geometry) {
  const explicit = num(ctxItem.gstRate);
  if (explicit > 0) return round2(explicit);
  if (geometry.singleSlabRate != null) return geometry.singleSlabRate;
  // Infer combined rate from original tax legs when single blended rate.
  const combined = round2(geometry.legs.reduce((s, l) => s + num(l.taxRate), 0));
  return combined > 0 ? combined : 0;
}

/**
 * Split a line's GST into ledger legs matching the original invoice geometry.
 */
function allocateLineTax(lineTaxable, gstRate, geometry) {
  if (!(lineTaxable > 0) || !(gstRate > 0)) return [];
  const legs = geometry.legs.filter(l => l.kind !== 'other');
  if (!legs.length) return [];

  const cgst = legs.filter(l => l.kind === 'cgst');
  const sgst = legs.filter(l => l.kind === 'sgst');
  const igst = legs.filter(l => l.kind === 'igst');
  const gst = legs.filter(l => l.kind === 'gst');
  const cess = legs.filter(l => l.kind === 'cess');

  const out = [];

  if (igst.length && geometry.isInterstate) {
    const share = 1 / igst.length;
    for (const leg of igst) {
      out.push({
        ledgerName: leg.ledgerName,
        taxRate: round2(gstRate * share),
        taxAmount: round2(lineTaxable * gstRate * share / 100),
        kind: 'igst',
      });
    }
  } else if (cgst.length || sgst.length) {
    const half = gstRate / 2;
    for (const leg of cgst) {
      out.push({
        ledgerName: leg.ledgerName,
        taxRate: round2(half / Math.max(1, cgst.length)),
        taxAmount: round2(lineTaxable * half / Math.max(1, cgst.length) / 100),
        kind: 'cgst',
      });
    }
    for (const leg of sgst) {
      out.push({
        ledgerName: leg.ledgerName,
        taxRate: round2(half / Math.max(1, sgst.length)),
        taxAmount: round2(lineTaxable * half / Math.max(1, sgst.length) / 100),
        kind: 'sgst',
      });
    }
  } else if (gst.length) {
    for (const leg of gst) {
      out.push({
        ledgerName: leg.ledgerName,
        taxRate: round2(gstRate / gst.length),
        taxAmount: round2(lineTaxable * gstRate / gst.length / 100),
        kind: 'gst',
      });
    }
  }

  // Cess: keep original rate relative to taxable (from geometry), not folded into gstRate.
  for (const leg of cess) {
    const rate = num(leg.taxRate);
    if (!(rate > 0)) continue;
    out.push({
      ledgerName: leg.ledgerName,
      taxRate: rate,
      taxAmount: round2(lineTaxable * rate / 100),
      kind: 'cess',
    });
  }

  return out.filter(t => t.taxAmount > 0);
}

function collapseTaxes(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = normalizeName(row.ledgerName);
    const current = map.get(key);
    if (current) {
      current.taxAmount = round2(current.taxAmount + row.taxAmount);
      current.taxableValue = round2(Math.max(current.taxableValue, row.taxableValue || 0));
      if (current.taxRate == null && row.taxRate != null) current.taxRate = row.taxRate;
      continue;
    }
    map.set(key, {
      ledgerName: row.ledgerName,
      taxAmount: round2(row.taxAmount),
      taxRate: row.taxRate != null ? round2(num(row.taxRate)) : null,
      taxableValue: round2(num(row.taxableValue)),
      kind: row.kind || classifyTaxLedger(row.ledgerName),
    });
  }
  return [...map.values()];
}

/**
 * Calculate return taxable + GST reversal from original invoice context.
 *
 * @param {object} args
 * @param {object} args.context  loadCreditNoteContext result (enriched)
 * @param {Array<{itemName, qty, amount?, rate?}>} args.returnLines
 * @returns {{
 *   returnTaxMode, allocationMode, fallbackUsed,
 *   items: Array, taxes: Array, itemsTotal, taxTotal, totalAmount,
 *   gstReversal, summary
 * }}
 */
export function calcCreditNoteReturn({ context, returnLines = [] }) {
  const geometry = buildTaxGeometry(context);
  const itemIndex = new Map(
    (context.items || []).map(i => [normalizeName(i.itemName), i])
  );

  const items = [];
  for (const raw of returnLines) {
    const name = String(raw.itemName || raw.name || '').trim();
    const ctxItem = itemIndex.get(normalizeName(name));
    if (!ctxItem) continue;
    const qty = round3(Math.abs(num(raw.qty ?? raw.billedQty ?? raw.actualQty)));
    if (!(qty > 0)) continue;

    const unitNet = netTaxablePerUnit(ctxItem);
    const hasExplicitAmount = raw.amount !== undefined && raw.amount !== null && raw.amount !== '';
    // Server default: qty × original net taxable/unit (discount-safe).
    // Explicit amount is allowed for commercial edits but tax base follows that amount.
    const taxable = hasExplicitAmount
      ? round2(Math.abs(num(raw.amount)))
      : round2(qty * unitNet);
    const rate = qty > 0 ? round2(taxable / qty) : unitNet;
    const gstRate = lineGstRate(ctxItem, geometry);

    let lineTaxes = [];
    if (geometry.returnTaxMode === RETURN_TAX_WITH_GST && geometry.allocationMode === 'item_rate') {
      lineTaxes = allocateLineTax(taxable, gstRate, geometry).map(t => ({
        ...t,
        taxableValue: taxable,
      }));
    }

    items.push({
      itemName: ctxItem.itemName,
      qty,
      rate,
      amount: taxable,
      taxableValue: taxable,
      netTaxablePerUnit: unitNet,
      originalRate: round2(num(ctxItem.rate)),
      discount: round2(num(ctxItem.discount)),
      gstRate,
      lineTaxes,
      unit: ctxItem.unit || '',
      hsn: ctxItem.hsn || '',
      godown: ctxItem.godown || 'Main Location',
      batch: ctxItem.batch || 'Primary Batch',
    });
  }

  const itemsTotal = round2(items.reduce((s, i) => s + i.amount, 0));
  let taxes = [];

  if (geometry.returnTaxMode === RETURN_TAX_WITHOUT_GST || geometry.allocationMode === 'none') {
    taxes = [];
  } else if (geometry.allocationMode === 'item_rate') {
    taxes = collapseTaxes(
      items.flatMap(i => i.lineTaxes.map(t => ({
        ...t,
        taxableValue: itemsTotal,
      })))
    ).map(t => ({ ...t, taxableValue: itemsTotal }));
  } else {
    // Proportional: scale each original tax ledger by return taxable / invoice taxable.
    const base = geometry.originalTaxable > 0 ? geometry.originalTaxable : 0;
    const ratio = base > 0 ? itemsTotal / base : 0;
    if (geometry.legs.length) {
      taxes = geometry.legs.map(leg => ({
        ledgerName: leg.ledgerName,
        taxAmount: round2(leg.originalAmount * ratio),
        taxRate: leg.taxRate,
        taxableValue: itemsTotal,
        kind: leg.kind,
      })).filter(t => t.taxAmount > 0);
    } else if (context.gst) {
      // Reconstruct from gst_voucher_details when ledger legs were empty.
      const g = context.gst;
      const synth = [];
      if (num(g.cgstAmount) > 0) {
        synth.push({
          ledgerName: 'CGST',
          taxAmount: round2(num(g.cgstAmount) * ratio),
          taxRate: base > 0 ? round2((num(g.cgstAmount) / base) * 100) : null,
          taxableValue: itemsTotal,
          kind: 'cgst',
        });
      }
      if (num(g.sgstAmount) > 0) {
        synth.push({
          ledgerName: 'SGST',
          taxAmount: round2(num(g.sgstAmount) * ratio),
          taxRate: base > 0 ? round2((num(g.sgstAmount) / base) * 100) : null,
          taxableValue: itemsTotal,
          kind: 'sgst',
        });
      }
      if (num(g.igstAmount) > 0) {
        synth.push({
          ledgerName: 'IGST',
          taxAmount: round2(num(g.igstAmount) * ratio),
          taxRate: base > 0 ? round2((num(g.igstAmount) / base) * 100) : null,
          taxableValue: itemsTotal,
          kind: 'igst',
        });
      }
      taxes = synth.filter(t => t.taxAmount > 0);
    }

    // Attach proportional share per line for UI (by taxable share).
    if (itemsTotal > 0 && taxes.length) {
      for (const item of items) {
        const share = item.amount / itemsTotal;
        item.lineTaxes = taxes.map(t => ({
          ledgerName: t.ledgerName,
          taxRate: t.taxRate,
          taxAmount: round2(t.taxAmount * share),
          taxableValue: item.amount,
          kind: t.kind,
        })).filter(t => t.taxAmount > 0);
      }
    }
  }

  const taxTotal = round2(taxes.reduce((s, t) => s + t.taxAmount, 0));
  const totalAmount = round2(itemsTotal + taxTotal);

  return {
    returnTaxMode: geometry.returnTaxMode,
    allocationMode: geometry.allocationMode,
    fallbackUsed: geometry.fallbackUsed,
    isInterstate: geometry.isInterstate,
    placeOfSupply: geometry.placeOfSupply,
    items,
    taxes,
    itemsTotal,
    taxTotal,
    gstReversal: taxTotal,
    totalAmount,
    summary: {
      returnedItemValue: itemsTotal,
      gstReversal: taxTotal,
      totalCustomerCredit: totalAmount,
    },
  };
}
