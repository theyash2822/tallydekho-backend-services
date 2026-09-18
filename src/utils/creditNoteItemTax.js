/**
 * Per-item tax geometry for Credit Notes when Tally uses a common GST ledger
 * (and/or VAT) across multiple rates, plus separate packing/transport GST.
 *
 * Priority:
 *   1. voucher_line_taxes table — persisted at Sales create (Phase 3)
 *   2. app_vouchers Sales payload (taxEntries + logistics) — app-created invoices
 *   3. Ledger order walk — Tally-only invoices (tax before charge = goods; after = charge)
 */

const normalizeName = (value) => String(value ?? '').trim().toLowerCase();
const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (value) => Math.round(num(value) * 100) / 100;

export function classifyTaxLedger(name) {
  const n = String(name || '');
  if (/igst/i.test(n)) return 'igst';
  if (/cgst/i.test(n)) return 'cgst';
  if (/sgst|utgst/i.test(n)) return 'sgst';
  if (/cess/i.test(n)) return 'cess';
  if (/vat/i.test(n)) return 'vat';
  if (/^\s*gst\s*$/i.test(n) || /^gst\s*\d/i.test(n) || /\bgst\b/i.test(n)) return 'gst';
  if (/tds|tcs|service tax|excise/i.test(n)) return 'other_tax';
  return 'other';
}

export function isGoodsTaxKind(kind) {
  return kind === 'cgst' || kind === 'sgst' || kind === 'igst' || kind === 'gst'
    || kind === 'vat' || kind === 'cess';
}

export function isChargeLedgerName(name) {
  return /(pack|packing|freight|transport|logistics|courier|shipping|delivery|insurance|round)/i
    .test(String(name || ''));
}

export function isSalesLikeLedger(name, salesKeys = new Set()) {
  const key = normalizeName(name);
  if (!key) return false;
  if (salesKeys.has(key)) return true;
  return /sales|sale a|sale a\/c/i.test(String(name || '')) && !isChargeLedgerName(name);
}

function taxEntryFromRaw(raw) {
  const ledgerName = String(raw?.ledgerName || raw?.ledger || raw?.name || '').trim();
  if (!ledgerName) return null;
  const taxAmount = round2(Math.abs(num(raw?.taxAmount ?? raw?.amount)));
  const taxableValue = round2(Math.abs(num(raw?.taxableValue ?? raw?.taxable_amount ?? raw?.taxable)));
  let taxRate = num(raw?.taxRate ?? raw?.rate ?? raw?.percentage);
  if (!(taxRate > 0) && taxableValue > 0 && taxAmount > 0) {
    taxRate = round2((taxAmount / taxableValue) * 100);
  }
  if (!(taxAmount > 0) && !(taxRate > 0)) return null;
  return {
    ledgerName,
    taxRate: round2(taxRate),
    taxAmount,
    taxableValue,
    kind: classifyTaxLedger(ledgerName),
    source: 'item',
  };
}

function withGstRate(row) {
  const taxEntries = row.taxEntries || [];
  return {
    ...row,
    taxEntries,
    gstRate: round2(taxEntries.reduce((s, t) => s + num(t.taxRate), 0)),
  };
}

/**
 * Build per-item taxEntries from app Sales create payload.
 * taxes[] is typically one goods-tax block per inventory line; logistics[].taxes are charges.
 */
export function buildItemTaxesFromSalesPayload(payload = {}, inventoryItems = []) {
  const items = Array.isArray(payload.items) ? payload.items : [];
  const flatTaxes = Array.isArray(payload.taxes) ? payload.taxes : [];
  const logistics = Array.isArray(payload.logistics) ? payload.logistics : [];
  const itemCount = inventoryItems.length || items.length;

  const chargeTaxes = [];
  for (const lg of logistics) {
    for (const t of (lg.taxes || [])) {
      const entry = taxEntryFromRaw(t);
      if (!entry) continue;
      chargeTaxes.push({
        ...entry,
        source: 'logistics',
        chargeLedger: String(lg.ledgerName || lg.ledger || '').trim(),
      });
    }
  }

  const itemLabel = (i) => String(
    inventoryItems[i]?.itemName
    || items[i]?.itemName
    || items[i]?.name
    || items[i]?.product
    || `item-${i}`
  ).trim();

  // Prefer nested taxEntries on each payload item when present.
  if (items.length && items.every(it => Array.isArray(it?.taxEntries) && it.taxEntries.length > 0)) {
    return {
      source: 'sales_payload_nested',
      items: items.map((item, index) => withGstRate({
        itemName: itemLabel(index),
        taxEntries: item.taxEntries.map(taxEntryFromRaw).filter(Boolean),
      })),
      chargeTaxes,
    };
  }

  // Flat taxes[]: one tax ledger per inventory line (TD1031 / common TallyDekho flatten).
  const goodsTaxes = [];
  if (flatTaxes.length && itemCount > 0 && flatTaxes.length === itemCount) {
    for (let i = 0; i < itemCount; i += 1) {
      const entry = taxEntryFromRaw(flatTaxes[i]);
      goodsTaxes.push(withGstRate({
        itemName: itemLabel(i),
        taxEntries: entry ? [entry] : [],
      }));
    }
  } else if (flatTaxes.length && itemCount > 0) {
    // Group by taxableValue matching each line's sold amount.
    const amounts = (inventoryItems.length ? inventoryItems : items).map((it, i) => round2(Math.abs(num(
      it.soldAmount ?? it.amount ?? items[i]?.amount
    ))));
    let taxIdx = 0;
    for (let i = 0; i < itemCount; i += 1) {
      const target = amounts[i];
      const entries = [];
      while (taxIdx < flatTaxes.length) {
        const entry = taxEntryFromRaw(flatTaxes[taxIdx]);
        taxIdx += 1;
        if (!entry) continue;
        const tv = entry.taxableValue || 0;
        if (entries.length && tv > 0 && target > 0 && Math.abs(tv - target) > 0.05) {
          taxIdx -= 1;
          break;
        }
        entries.push(entry);
        if (tv > 0 && target > 0 && Math.abs(tv - target) <= 0.05) break;
        if (flatTaxes.length <= itemCount) break;
      }
      goodsTaxes.push(withGstRate({ itemName: itemLabel(i), taxEntries: entries }));
    }
  }

  return {
    source: goodsTaxes.length ? 'sales_payload_flat' : 'sales_payload_empty',
    items: goodsTaxes,
    chargeTaxes,
  };
}

/**
 * Walk synced ledger legs: goods tax = tax/VAT after sales, before first charge ledger.
 * Charge tax = tax after packing/transport/etc.
 * Zip goods tax legs to inventory lines in order when counts match.
 */
export function buildItemTaxesFromLedgerOrder({
  ledgerRows = [],
  inventoryItems = [],
  partyName = '',
  salesLedgerNames = [],
} = {}) {
  const partyKey = normalizeName(partyName);
  const salesKeys = new Set(salesLedgerNames.map(normalizeName).filter(Boolean));
  const chargeTaxes = [];
  const goodsTaxLegs = [];

  let seenSales = false;
  let inChargeSection = false;

  for (const row of ledgerRows) {
    const name = String(row.ledger_name || row.ledgerName || '').trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (key === partyKey) continue;
    const amount = round2(Math.abs(num(row.amount)));
    if (!(amount > 0)) continue;

    if (isSalesLikeLedger(name, salesKeys)) {
      seenSales = true;
      inChargeSection = false;
      continue;
    }

    if (isChargeLedgerName(name)) {
      inChargeSection = true;
      continue;
    }

    const kind = classifyTaxLedger(name);
    if (!isGoodsTaxKind(kind)) {
      if (seenSales && /round/i.test(name)) inChargeSection = true;
      continue;
    }
    if (!seenSales) continue;

    const entry = {
      ledgerName: name,
      taxAmount: amount,
      taxRate: 0,
      taxableValue: 0,
      kind,
      source: inChargeSection ? 'logistics' : 'item',
    };

    if (inChargeSection) chargeTaxes.push({ ...entry, source: 'logistics' });
    else goodsTaxLegs.push(entry);
  }

  const items = inventoryItems.map((it) => ({
    itemName: it.itemName,
    soldQty: num(it.soldQty),
    soldAmount: num(it.soldAmount),
    taxEntries: [],
  }));

  if (items.length && goodsTaxLegs.length === items.length) {
    for (let i = 0; i < items.length; i += 1) {
      const leg = goodsTaxLegs[i];
      const soldAmount = num(items[i].soldAmount);
      const taxRate = soldAmount > 0 ? round2((leg.taxAmount / soldAmount) * 100) : 0;
      items[i].taxEntries = [{
        ...leg,
        taxRate,
        taxableValue: soldAmount,
        source: 'item',
      }];
    }
  } else if (items.length && goodsTaxLegs.length) {
    const n = Math.min(items.length, goodsTaxLegs.length);
    for (let i = 0; i < n; i += 1) {
      const soldAmount = num(items[i].soldAmount);
      const leg = goodsTaxLegs[i];
      const taxRate = soldAmount > 0 ? round2((leg.taxAmount / soldAmount) * 100) : 0;
      items[i].taxEntries.push({
        ...leg,
        taxRate,
        taxableValue: soldAmount,
        source: 'item',
      });
    }
  }

  return {
    source: 'ledger_order',
    items: items.map(withGstRate),
    chargeTaxes,
  };
}

export function buildItemTaxesFromLineTaxRows(lineTaxRows = [], inventoryItems = []) {
  const byItem = new Map();
  for (const row of lineTaxRows) {
    if (String(row.source || 'item') === 'logistics') continue;
    const key = normalizeName(row.stock_item_name || row.itemName);
    if (!key) continue;
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push({
      ledgerName: row.ledger_name || row.ledgerName,
      taxRate: round2(num(row.tax_rate ?? row.taxRate)),
      taxAmount: round2(Math.abs(num(row.tax_amount ?? row.taxAmount))),
      taxableValue: round2(Math.abs(num(row.taxable_value ?? row.taxableValue))),
      kind: classifyTaxLedger(row.ledger_name || row.ledgerName),
      source: 'item',
    });
  }
  return {
    source: 'voucher_line_taxes',
    items: inventoryItems.map(it => withGstRate({
      itemName: it.itemName,
      taxEntries: byItem.get(normalizeName(it.itemName)) || [],
    })),
    chargeTaxes: lineTaxRows
      .filter(r => String(r.source || '') === 'logistics')
      .map(r => ({
        ledgerName: r.ledger_name || r.ledgerName,
        taxRate: round2(num(r.tax_rate ?? r.taxRate)),
        taxAmount: round2(Math.abs(num(r.tax_amount ?? r.taxAmount))),
        taxableValue: round2(Math.abs(num(r.taxable_value ?? r.taxableValue))),
        kind: classifyTaxLedger(r.ledger_name || r.ledgerName),
        source: 'logistics',
      })),
  };
}

/** Apply geometry onto context items (returns new array). */
export function mergeItemTaxGeometry(inventoryItems = [], geometry = null) {
  if (!geometry?.items?.length) {
    return inventoryItems.map(it => ({
      ...it,
      taxEntries: it.taxEntries || [],
      gstRate: it.gstRate || null,
    }));
  }
  const byName = new Map(geometry.items.map(g => [normalizeName(g.itemName), g]));
  return inventoryItems.map((it, index) => {
    const geo = byName.get(normalizeName(it.itemName)) || geometry.items[index];
    if (!geo) {
      return { ...it, taxEntries: it.taxEntries || [], gstRate: it.gstRate || null };
    }
    const taxEntries = geo.taxEntries || [];
    const gstRate = geo.gstRate > 0
      ? geo.gstRate
      : round2(taxEntries.reduce((s, t) => s + num(t.taxRate), 0)) || null;
    return {
      ...it,
      taxEntries,
      gstRate: gstRate || it.gstRate || null,
      taxGeometrySource: geometry.source,
    };
  });
}

export function geometryHasAttributedTax(geometry) {
  return Boolean(geometry?.items?.length
    && geometry.items.every(i => Array.isArray(i.taxEntries) && i.taxEntries.length > 0));
}

/**
 * Persist per-line tax geometry at Sales create (Phase 3).
 * Call after app_vouchers insert with the same payload shape as /tally/voucher/sales.
 */
export async function persistVoucherLineTaxes(queryFn, {
  companyId,
  tdkReferenceNo,
  voucherGuid = null,
  items = [],
  taxes = [],
  logistics = [],
} = {}) {
  if (!companyId || !tdkReferenceNo) return { inserted: 0 };
  await queryFn(
    `DELETE FROM voucher_line_taxes WHERE company_id=$1 AND tdk_reference_no = $2`,
    [companyId, tdkReferenceNo]
  ).catch(() => {});

  const rows = [];
  const geometry = buildItemTaxesFromSalesPayload({ items, taxes, logistics }, items.map(it => ({
    itemName: it.itemName || it.name,
    soldAmount: it.amount,
    soldQty: it.billedQty ?? it.actualQty ?? it.qty,
  })));

  geometry.items.forEach((item, lineIndex) => {
    for (const te of item.taxEntries || []) {
      rows.push({
        stockItemName: item.itemName,
        lineIndex,
        ledgerName: te.ledgerName,
        taxRate: te.taxRate,
        taxAmount: te.taxAmount,
        taxableValue: te.taxableValue,
        source: 'item',
      });
    }
  });
  for (const te of geometry.chargeTaxes || []) {
    rows.push({
      stockItemName: te.chargeLedger || null,
      lineIndex: 0,
      ledgerName: te.ledgerName,
      taxRate: te.taxRate,
      taxAmount: te.taxAmount,
      taxableValue: te.taxableValue,
      source: 'logistics',
    });
  }

  let inserted = 0;
  for (const row of rows) {
    await queryFn(
      `INSERT INTO voucher_line_taxes
         (company_guid, tdk_reference_no, voucher_guid, stock_item_name, line_index,
          ledger_name, tax_rate, tax_amount, taxable_value, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        companyId,
        tdkReferenceNo,
        voucherGuid,
        row.stockItemName,
        row.lineIndex,
        row.ledgerName,
        row.taxRate,
        row.taxAmount,
        row.taxableValue,
        row.source,
      ]
    );
    inserted += 1;
  }
  return { inserted, source: geometry.source };
}
