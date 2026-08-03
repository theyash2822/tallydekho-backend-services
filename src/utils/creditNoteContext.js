// ── Credit Note (Sales Return) context ────────────────────────────────────────
// Shared between api-v1.js (GET /api/sales/invoices/:id/credit-note-context — the
// screen that lets the user pick what to return) and tally-write.js
// (POST /tally/voucher/credit-note — the writer that must reject over-returns).
//
// Both sides have to agree on how much of each invoice line is still returnable,
// so the resolution lives here instead of being duplicated.
//
// Returned quantity is cumulative over two sources:
//   1. Credit Notes already synced back from Tally, linked to the invoice through
//      vouchers.bill_type = 'Agst Ref' + vouchers.bill_ref_name.
//   2. Credit Notes created in TallyDekho (app_vouchers.voucher_type='credit_note')
//      that are queued/offline/pushed and not yet represented by a synced Tally row.
// A synced app-created Credit Note is counted once, via source 1 only.

import { query } from '../db/schema.js';
import { buildTaxGeometry, filterStockReturnTaxRows, RETURN_TAX_WITH_GST, RETURN_TAX_WITHOUT_GST } from './creditNoteTax.js';
import {
  buildItemTaxesFromSalesPayload,
  buildItemTaxesFromLedgerOrder,
  buildItemTaxesFromLineTaxRows,
  geometryHasAttributedTax,
  mergeItemTaxGeometry,
} from './creditNoteItemTax.js';

export const QTY_EPSILON = 0.0005;
export { RETURN_TAX_WITH_GST, RETURN_TAX_WITHOUT_GST };

export const normalizeName = (value) => String(value ?? '').trim().toLowerCase();

export const num = (value) => {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
};

export const round2 = (value) => Math.round(num(value) * 100) / 100;
export const round3 = (value) => Math.round(num(value) * 1000) / 1000;

const TAX_LEDGER_RE = /(cgst|sgst|utgst|igst|\bgst\b|cess|tds|tcs|vat|service tax)/i;
const TAX_PARENT_RE = /(duties|duty|taxes|tax)/i;

const uniqueStrings = (values) => {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const key = normalizeName(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
};

/**
 * A voucher qualifies as a Sales invoice when Tally's parent voucher type is
 * 'Sales', or — when the parent is missing or carries the 'Voucher' placeholder
 * that SimplifiedVoucher.xml leaves behind — when the type reads like Sales
 * without being an order.
 */
export function isSalesInvoiceRow(voucher) {
  if (!voucher) return false;
  const parent = String(voucher.voucher_type_parent || '').trim().toLowerCase();
  if (parent && parent !== 'voucher') return parent === 'sales';
  const vt = String(voucher.voucher_type || '');
  return /sales/i.test(vt) && !/order/i.test(vt);
}

/** Resolve a Sales invoice by GUID (preferred) or voucher number, company-scoped. */
export async function resolveInvoiceForReturn(companyGuid, ref) {
  const key = String(ref ?? '').trim();
  if (!companyGuid || !key) return null;
  const { rows } = await query(
    `SELECT * FROM vouchers
      WHERE company_guid = $2
        AND (guid = $1 OR voucher_number = $1)
        AND COALESCE(is_cancelled, FALSE) = FALSE
      ORDER BY (guid = $1)::int DESC, date DESC NULLS LAST, id DESC
      LIMIT 1`,
    [key, companyGuid]
  );
  return rows[0] || null;
}

/** Quantity a Credit Note payload line returns (app-created, not yet in Tally). */
function payloadLineQty(line) {
  const raw = line?.billedQty ?? line?.actualQty ?? line?.qty ?? line?.quantity ?? 0;
  return Math.abs(num(raw));
}

function appVoucherTargetsInvoice(payload, invoice, refKeys) {
  const linked = payload?.linked_invoice || payload?.linkedInvoice || null;
  if (!linked) return false;
  if (linked.invoiceGuid && String(linked.invoiceGuid).trim() === String(invoice.guid || '').trim()) return true;
  return [linked.billRefName, linked.voucherNumber, linked.tdkRef, linked.reference]
    .map(normalizeName)
    .filter(Boolean)
    .some(k => refKeys.has(k));
}

/**
 * Build the full Sales Return context for one Sales invoice.
 *
 * @param {string} companyGuid
 * @param {object} invoice  row from `vouchers` (already verified as Sales + owned)
 * @returns {Promise<object>} { linkedInvoice, party, items, invoiceSalesLedgers,
 *   companySalesLedgers, taxes, gst, otherLedgers, priorReturns }
 */
export async function loadCreditNoteContext(companyGuid, invoice) {
  const invoiceGuid = invoice.guid;

  // ── TDK reference + Sales payload (app-created invoices — best tax geometry) ──
  const { rows: invAvRows } = await query(
    `SELECT tdk_reference_no, payload, tally_guid
       FROM app_vouchers
      WHERE company_guid = $1
        AND voucher_type IN ('sales_invoice', 'sales')
        AND (
          tally_voucher_no = $2
          OR ($3::text <> '' AND tdk_reference_no = $3)
          OR ($3::text <> '' AND COALESCE(payload->>'reference', '') = $3)
        )
      ORDER BY
        (tally_voucher_no = $2)::int DESC,
        id DESC
      LIMIT 1`,
    [
      companyGuid,
      invoice.voucher_number || '',
      invoice.reference || '',
    ]
  ).catch(() => ({ rows: [] }));
  const invoiceTdkRef = invAvRows[0]?.tdk_reference_no || null;
  const salesPayload = invAvRows[0]?.payload || null;

  // Bill references Tally could have stamped on the original invoice's bill.
  const billRefCandidates = uniqueStrings([
    invoice.bill_ref_name,
    invoice.reference,
    invoice.voucher_number,
    invoiceTdkRef,
  ]);
  const billRefName = billRefCandidates[0] || null;
  const refKeys = new Set(billRefCandidates.map(normalizeName));
  if (invoiceGuid) refKeys.add(normalizeName(invoiceGuid));

  const [
    { rows: invItemRows },
    { rows: ledgerRows },
    { rows: companySalesRows },
    { rows: gstRows },
    { rows: partyRows },
    { rows: voucherItemTaxRows },
  ] = await Promise.all([
    query(
      `SELECT vi.id,
              vi.stock_item_name,
              vi.stock_item_guid,
              COALESCE(NULLIF(vi.godown_name, ''), '')          AS godown_name,
              COALESCE(NULLIF(vi.batch_name, ''), '')           AS batch_name,
              COALESCE(NULLIF(vi.unit, ''), s.unit, '')         AS unit,
              COALESCE(NULLIF(vi.hsn, ''), s.hsn, '')           AS hsn,
              ABS(COALESCE(vi.billed_qty, 0))                   AS billed_qty,
              ABS(COALESCE(vi.actual_qty, 0))                   AS actual_qty,
              ABS(COALESCE(vi.amount, 0))                       AS amount,
              ABS(COALESCE(vi.rate, 0))                         AS rate,
              ABS(COALESCE(vi.discount, 0))                     AS discount
         FROM voucher_inventory_items vi
         LEFT JOIN stocks s
           ON s.name = vi.stock_item_name AND s.company_guid = vi.company_guid
        WHERE vi.voucher_guid = $1 AND vi.company_guid = $2
        ORDER BY vi.stock_item_name ASC, vi.id ASC`,
      [invoiceGuid, companyGuid]
    ),
    query(
      `SELECT vle.ledger_name, vle.amount, vle.dr_cr, vle.line_index,
              l.guid AS ledger_guid, l.parent AS ledger_parent
         FROM voucher_ledger_entries vle
         LEFT JOIN ledgers l
           ON l.name = vle.ledger_name AND l.company_guid = vle.company_guid
        WHERE vle.voucher_guid = $1 AND vle.company_guid = $2
        ORDER BY vle.line_index ASC, vle.id ASC`,
      [invoiceGuid, companyGuid]
    ),
    // Every ledger under Sales Accounts (walked recursively, so sub-groups count).
    query(
      `WITH RECURSIVE sales_groups AS (
         SELECT name FROM groups
          WHERE company_guid = $1 AND name ILIKE 'Sales Account%'
         UNION ALL
         SELECT g.name FROM groups g
           JOIN sales_groups sg ON g.parent = sg.name
          WHERE g.company_guid = $1
       )
       SELECT DISTINCT l.name, l.guid, l.parent
         FROM ledgers l
        WHERE l.company_guid = $1
          AND (l.parent IN (SELECT name FROM sales_groups) OR l.parent ILIKE '%Sales Account%')
        ORDER BY l.name ASC`,
      [companyGuid]
    ),
    query(
      `SELECT taxable_amount, cgst_amount, sgst_amount, igst_amount, gst_reg_type, place_of_supply
         FROM gst_voucher_details
        WHERE voucher_guid = $1 AND company_guid = $2 LIMIT 1`,
      [invoiceGuid, companyGuid]
    ).catch(() => ({ rows: [] })),
    query(
      `SELECT name, guid, gstin, pan, phone, email, address, parent
         FROM ledgers WHERE company_guid = $1 AND name = $2 LIMIT 1`,
      [companyGuid, invoice.party_name || '']
    ).catch(() => ({ rows: [] })),
    // Original invoice GSTRATE when AllVoucher ingest stored it on voucher_items.
    // Never fall back to stocks.tax_rate (today's master).
    query(
      `SELECT item_name, MAX(ABS(COALESCE(tax_rate, 0))) AS tax_rate
         FROM voucher_items
        WHERE voucher_guid = $1 AND company_guid = $2
          AND ABS(COALESCE(tax_rate, 0)) > 0
        GROUP BY item_name`,
      [invoiceGuid, companyGuid]
    ).catch(() => ({ rows: [] })),
  ]);

  const gstRateByItem = new Map();
  for (const row of voucherItemTaxRows) {
    const key = normalizeName(row.item_name);
    if (!key) continue;
    gstRateByItem.set(key, round2(row.tax_rate));
  }

  const companySalesLedgers = companySalesRows.map(r => ({
    ledgerName: r.name, guid: r.guid || null, parentGroup: r.parent || null,
  }));
  const companySalesKeys = new Set(companySalesLedgers.map(l => normalizeName(l.ledgerName)));
  const partyKey = normalizeName(invoice.party_name);

  // ── Split the invoice's ledger legs into party / sales / tax / other ────────
  const invoiceSalesLedgers = [];
  const taxes = [];
  const otherLedgers = [];
  for (const row of ledgerRows) {
    const name = String(row.ledger_name || '').trim();
    if (!name) continue;
    const key = normalizeName(name);
    if (key === partyKey) continue;
    const entry = {
      ledgerName: name,
      guid: row.ledger_guid || null,
      parentGroup: row.ledger_parent || null,
      amount: round2(Math.abs(num(row.amount))),
      drCr: row.dr_cr || null,
    };
    if (companySalesKeys.has(key)) { invoiceSalesLedgers.push(entry); continue; }
    if (TAX_LEDGER_RE.test(name) || TAX_PARENT_RE.test(String(row.ledger_parent || ''))) {
      taxes.push(entry); continue;
    }
    otherLedgers.push(entry);
  }
  invoiceSalesLedgers.sort((a, b) => b.amount - a.amount);

  // ── Invoice lines, collapsed to one row per stock item ─────────────────────
  const itemMap = new Map();
  for (const row of invItemRows) {
    const itemName = String(row.stock_item_name || '').trim();
    if (!itemName) continue;
    const key = normalizeName(itemName);
    let entry = itemMap.get(key);
    if (!entry) {
      entry = {
        itemName,
        itemGuid: row.stock_item_guid || null,
        unit: row.unit || '',
        hsn: row.hsn || '',
        godown: row.godown_name || '',
        batch: row.batch_name || '',
        rate: 0,
        soldQty: 0,
        soldAmount: 0,
        discount: 0,
        gstRate: gstRateByItem.get(key) || 0,
        lines: [],
      };
      itemMap.set(key, entry);
    }
    const qty = num(row.billed_qty) || num(row.actual_qty);
    entry.soldQty += qty;
    entry.soldAmount += num(row.amount);
    entry.discount += num(row.discount);
    if (!entry.rate) entry.rate = num(row.rate);
    if (!entry.gstRate && gstRateByItem.has(key)) entry.gstRate = gstRateByItem.get(key);
    if (!entry.unit) entry.unit = row.unit || '';
    if (!entry.godown) entry.godown = row.godown_name || '';
    if (!entry.batch) entry.batch = row.batch_name || '';
    entry.lines.push({
      godown: row.godown_name || '',
      batch: row.batch_name || '',
      billedQty: round3(row.billed_qty),
      actualQty: round3(row.actual_qty),
      rate: round2(row.rate),
      amount: round2(row.amount),
      discount: round2(row.discount),
    });
  }

  // ── Prior returns, source 1: Credit Notes already synced from Tally ────────
  const { rows: syncedCnRows } = billRefCandidates.length
    ? await query(
        `SELECT cn.guid, cn.voucher_number, cn.reference, cn.narration, cn.date,
                ABS(COALESCE(cn.amount, 0)) AS amount,
                cn.bill_ref_name, cn.bill_type
           FROM vouchers cn
          WHERE cn.company_guid = $1
            AND COALESCE(cn.is_cancelled, FALSE) = FALSE
            AND (cn.voucher_type ILIKE '%Credit Note%' OR COALESCE(cn.voucher_type_parent, '') = 'Credit Note')
            AND COALESCE(cn.bill_type, '') = 'Agst Ref'
            AND LOWER(TRIM(COALESCE(cn.bill_ref_name, ''))) = ANY($2::text[])
          ORDER BY cn.date ASC NULLS LAST, cn.id ASC`,
        [companyGuid, billRefCandidates.map(normalizeName)]
      )
    : { rows: [] };

  const syncedGuids = syncedCnRows.map(r => r.guid).filter(Boolean);
  const syncedQtyByItem = new Map();
  if (syncedGuids.length) {
    const { rows: syncedItemRows } = await query(
      `SELECT stock_item_name,
              SUM(ABS(COALESCE(NULLIF(billed_qty, 0), actual_qty, 0))) AS qty
         FROM voucher_inventory_items
        WHERE company_guid = $1 AND voucher_guid = ANY($2::text[])
        GROUP BY stock_item_name`,
      [companyGuid, syncedGuids]
    );
    for (const row of syncedItemRows) {
      syncedQtyByItem.set(normalizeName(row.stock_item_name), num(row.qty));
    }
  }

  // ── Prior returns, source 2: app-created Credit Notes not yet synced ───────
  const syncedNumbers = new Set(syncedCnRows.map(r => normalizeName(r.voucher_number)).filter(Boolean));
  const syncedRefs = new Set(syncedCnRows.map(r => normalizeName(r.reference)).filter(Boolean));
  const syncedNarrations = syncedCnRows.map(r => normalizeName(r.narration)).filter(Boolean);

  // Narrow to Credit Notes pointing at THIS invoice in Postgres — the payload is a
  // full request body, so loading every app Credit Note would be wasteful.
  const { rows: appCnRows } = await query(
    `SELECT invoice_uuid, tdk_reference_no, tally_voucher_no, tally_sync_status,
            books_impact_status, original_entry_type, current_entry_type,
            voucher_date, total_amount, payload, created_at
       FROM app_vouchers av
      WHERE av.company_guid = $1
        AND av.voucher_type = 'credit_note'
        AND av.tally_sync_status <> 'failed'
        AND (
          COALESCE(av.payload->'linked_invoice'->>'invoiceGuid',
                   av.payload->'linkedInvoice'->>'invoiceGuid', '') = $2
          OR LOWER(TRIM(COALESCE(av.payload->'linked_invoice'->>'billRefName',
                                 av.payload->'linkedInvoice'->>'billRefName', ''))) = ANY($3::text[])
          OR LOWER(TRIM(COALESCE(av.payload->'linked_invoice'->>'voucherNumber',
                                 av.payload->'linkedInvoice'->>'voucherNumber', ''))) = ANY($3::text[])
          OR LOWER(TRIM(COALESCE(av.payload->'linked_invoice'->>'tdkRef',
                                 av.payload->'linkedInvoice'->>'tdkRef', ''))) = ANY($3::text[])
        )
      ORDER BY av.id ASC`,
    // Never swallow a failure here: an empty result would silently allow an
    // over-return past a Credit Note that is queued but not yet in Tally.
    [companyGuid, String(invoiceGuid || ''), [...refKeys]]
  );

  const pendingQtyByItem = new Map();
  const pendingReturns = [];
  for (const av of appCnRows) {
    const payload = av.payload || {};
    if (!appVoucherTargetsInvoice(payload, invoice, refKeys)) continue;
    // Already represented by a synced Tally row → counted by source 1, skip here.
    const tdkKey = normalizeName(av.tdk_reference_no);
    const alreadySynced =
      (av.tally_voucher_no && syncedNumbers.has(normalizeName(av.tally_voucher_no)))
      || (tdkKey && syncedRefs.has(tdkKey))
      || (tdkKey && syncedNarrations.some(n => n.includes(tdkKey)));
    if (alreadySynced) continue;

    const lines = Array.isArray(payload.items) ? payload.items : [];
    let lineCount = 0;
    for (const line of lines) {
      const name = String(line?.itemName || line?.name || '').trim();
      const qty = payloadLineQty(line);
      if (!name || !(qty > 0)) continue;
      const key = normalizeName(name);
      pendingQtyByItem.set(key, (pendingQtyByItem.get(key) || 0) + qty);
      lineCount += 1;
    }
    pendingReturns.push({
      invoiceUuid: av.invoice_uuid,
      tdkRef: av.tdk_reference_no,
      tallyVoucherNo: av.tally_voucher_no || null,
      tallySyncStatus: av.tally_sync_status,
      booksImpactStatus: av.books_impact_status,
      entryType: av.current_entry_type || av.original_entry_type || 'regular',
      date: av.voucher_date ? new Date(av.voucher_date).toISOString().slice(0, 10) : null,
      amount: round2(av.total_amount),
      itemCount: lineCount,
    });
  }

  // ── Finalise per-item sold / returned / remaining ──────────────────────────
  let items = [...itemMap.entries()].map(([key, entry]) => {
    const soldQty = round3(entry.soldQty);
    const returnedSyncedQty = round3(syncedQtyByItem.get(key) || 0);
    const returnedPendingQty = round3(pendingQtyByItem.get(key) || 0);
    const previouslyReturnedQty = round3(returnedSyncedQty + returnedPendingQty);
    const remainingQty = Math.max(0, round3(soldQty - previouslyReturnedQty));
    const soldAmount = round2(entry.soldAmount);
    const rate = entry.rate || (soldQty > 0 ? round2(soldAmount / soldQty) : 0);
    const netTaxablePerUnit = soldQty > 0 ? round2(soldAmount / soldQty) : round2(rate);
    return {
      itemName: entry.itemName,
      itemGuid: entry.itemGuid,
      unit: entry.unit,
      hsn: entry.hsn,
      godown: entry.godown || 'Main Location',
      batch: entry.batch || 'Primary Batch',
      rate: round2(rate),
      discount: round2(entry.discount),
      soldQty,
      soldAmount,
      netTaxablePerUnit,
      gstRate: round2(entry.gstRate) || null,
      taxEntries: [],
      returnedSyncedQty,
      returnedPendingQty,
      previouslyReturnedQty,
      remainingQty,
      isFullyReturned: remainingQty <= QTY_EPSILON,
      // Client shows every invoice line unselected; the app decides the default qty.
      selected: false,
      lines: entry.lines,
    };
  });

  // ── Per-item tax geometry (common GST ledger / VAT / packing GST) ───────────
  // Priority: voucher_line_taxes → Sales app payload → ledger order walk.
  const { rows: lineTaxRows } = await query(
    `SELECT stock_item_name, line_index, ledger_name, tax_rate, tax_amount,
            taxable_value, source
       FROM voucher_line_taxes
      WHERE company_guid = $1
        AND (
          ($2::text IS NOT NULL AND voucher_guid = $2)
          OR ($3::text IS NOT NULL AND tdk_reference_no = $3)
        )
      ORDER BY line_index ASC, id ASC`,
    [companyGuid, invoiceGuid || null, invoiceTdkRef || null]
  ).catch(() => ({ rows: [] }));

  let itemTaxGeometry = null;
  if (lineTaxRows.length) {
    itemTaxGeometry = buildItemTaxesFromLineTaxRows(lineTaxRows, items);
  }
  if (!geometryHasAttributedTax(itemTaxGeometry) && salesPayload) {
    itemTaxGeometry = buildItemTaxesFromSalesPayload(salesPayload, items);
  }
  if (!geometryHasAttributedTax(itemTaxGeometry)) {
    itemTaxGeometry = buildItemTaxesFromLedgerOrder({
      ledgerRows,
      inventoryItems: items,
      partyName: invoice.party_name || '',
      salesLedgerNames: [
        ...invoiceSalesLedgers.map(l => l.ledgerName),
        ...companySalesLedgers.map(l => l.ledgerName),
      ],
    });
  }

  if (geometryHasAttributedTax(itemTaxGeometry)) {
    items = mergeItemTaxGeometry(items, itemTaxGeometry);
  }

  // ── Tax rows collapsed to one per ledger (Tally often emits CGST/SGST once
  // per inventory or logistics line). Duplicate ledger names must not reach the
  // client as separate list keys.
  const salesTotal = round2(invoiceSalesLedgers.reduce((s, l) => s + l.amount, 0));
  const itemsTotal = round2(items.reduce((s, i) => s + i.soldAmount, 0));
  const gst = gstRows[0] || null;
  const taxableBase = round2(num(gst?.taxable_amount) || salesTotal || itemsTotal);
  const taxByLedger = new Map();
  for (const t of taxes) {
    const key = normalizeName(t.ledgerName);
    const current = taxByLedger.get(key);
    if (current) {
      current.amount = round2(current.amount + t.amount);
      continue;
    }
    taxByLedger.set(key, { ...t });
  }
  const taxRowsAll = [...taxByLedger.values()].map(t => ({
    ...t,
    taxAmount: t.amount,
    taxableValue: taxableBase,
    taxRate: taxableBase > 0 ? round2((t.amount / taxableBase) * 100) : null,
  }));

  let taxRows = filterStockReturnTaxRows(taxRowsAll);
  let excludedTaxes = taxRowsAll.filter(
    t => !taxRows.some(k => normalizeName(k.ledgerName) === normalizeName(t.ledgerName))
  );

  // Attributed geometry: rebuild goods tax rows from per-item entries (correct rates),
  // and move packing/transport GST into excludedTaxes.
  if (geometryHasAttributedTax(itemTaxGeometry)) {
    const goodsByLedger = new Map();
    for (const item of items) {
      for (const te of item.taxEntries || []) {
        const ledgerName = String(te.ledgerName || '').trim();
        if (!ledgerName) continue;
        const key = normalizeName(ledgerName);
        const cur = goodsByLedger.get(key);
        const taxAmount = round2(Math.abs(num(te.taxAmount)));
        const taxRate = round2(num(te.taxRate));
        if (cur) {
          cur.taxAmount = round2(cur.taxAmount + taxAmount);
          cur.amount = cur.taxAmount;
          // Mixed rates on same ledger (common GST) — leave blended rate null.
          if (cur.taxRate != null && taxRate > 0 && Math.abs(cur.taxRate - taxRate) > 0.05) {
            cur.taxRate = null;
          }
          continue;
        }
        goodsByLedger.set(key, {
          ledgerName,
          guid: null,
          parentGroup: null,
          amount: taxAmount,
          taxAmount,
          taxableValue: taxableBase,
          taxRate: taxRate || null,
          kind: te.kind || null,
          drCr: null,
        });
      }
    }
    taxRows = [...goodsByLedger.values()];
    excludedTaxes = (itemTaxGeometry.chargeTaxes || []).map(te => ({
      ledgerName: te.ledgerName,
      amount: round2(te.taxAmount),
      taxAmount: round2(te.taxAmount),
      taxableValue: round2(te.taxableValue || 0),
      taxRate: round2(te.taxRate) || null,
      kind: te.kind || null,
      source: 'logistics',
      chargeLedger: te.chargeLedger || null,
    }));
  }

  const gstPayload = gst
    ? {
        taxableAmount: round2(gst.taxable_amount),
        cgstAmount: round2(gst.cgst_amount),
        sgstAmount: round2(gst.sgst_amount),
        igstAmount: round2(gst.igst_amount),
        gstRegType: gst.gst_reg_type || null,
        placeOfSupply: gst.place_of_supply || null,
      }
    : null;

  // Infer single-slab gstRate onto lines that lack rates when invoice is uniform.
  const prelimGeometry = buildTaxGeometry({
    items,
    taxes: taxRows,
    gst: gstPayload,
    totals: { itemsTotal, salesLedgerTotal: salesTotal },
  });
  if (prelimGeometry.singleSlabRate != null) {
    for (const item of items) {
      if (!item.gstRate) item.gstRate = prelimGeometry.singleSlabRate;
    }
  }
  const taxGeometry = buildTaxGeometry({
    items,
    taxes: taxRows,
    gst: gstPayload,
    totals: { itemsTotal, salesLedgerTotal: salesTotal },
  });

  return {
    linkedInvoice: {
      invoiceGuid,
      voucherNumber: invoice.voucher_number || null,
      voucherType: invoice.voucher_type || null,
      voucherTypeParent: invoice.voucher_type_parent || null,
      date: invoice.date || null,
      partyLedger: invoice.party_name || null,
      reference: invoice.reference || null,
      billRefName,
      billRefCandidates,
      tdkRef: invoiceTdkRef,
      amount: round2(Math.abs(num(invoice.amount))),
      financialYear: invoice.financial_year || null,
    },
    party: partyRows[0]
      ? {
          name: partyRows[0].name,
          guid: partyRows[0].guid || null,
          gstin: partyRows[0].gstin || null,
          pan: partyRows[0].pan || null,
          phone: partyRows[0].phone || null,
          email: partyRows[0].email || null,
          address: partyRows[0].address || null,
          parentGroup: partyRows[0].parent || null,
        }
      : { name: invoice.party_name || null },
    items,
    invoiceSalesLedgers,
    companySalesLedgers,
    defaultSalesLedger: invoiceSalesLedgers[0]?.ledgerName || null,
    taxes: taxRows,
    excludedTaxes,
    otherLedgers,
    gst: gstPayload,
    returnTaxMode: taxGeometry.returnTaxMode,
    taxGeometry: {
      allocationMode: taxGeometry.allocationMode,
      fallbackUsed: taxGeometry.fallbackUsed,
      isInterstate: taxGeometry.isInterstate,
      placeOfSupply: taxGeometry.placeOfSupply,
      originalTaxable: taxGeometry.originalTaxable,
      originalTaxTotal: taxGeometry.originalTaxTotal,
      singleSlabRate: taxGeometry.singleSlabRate,
      attributed: taxGeometry.attributed,
      itemTaxSource: itemTaxGeometry?.source || null,
      legs: taxGeometry.legs,
    },
    totals: {
      itemsTotal,
      salesLedgerTotal: salesTotal,
      taxTotal: round2(taxRows.reduce((s, t) => s + t.taxAmount, 0)),
      invoiceAmount: round2(Math.abs(num(invoice.amount))),
    },
    priorReturns: {
      synced: syncedCnRows.map(r => ({
        voucherGuid: r.guid,
        voucherNumber: r.voucher_number || null,
        reference: r.reference || null,
        date: r.date || null,
        amount: round2(r.amount),
        billRefName: r.bill_ref_name || null,
        billType: r.bill_type || null,
      })),
      pending: pendingReturns,
      hasAny: syncedCnRows.length > 0 || pendingReturns.length > 0,
    },
  };
}

/**
 * Resolve the invoice + context in one step, returning a uniform failure shape so
 * both the read endpoint and the writer emit identical error messages.
 */
export async function resolveCreditNoteContext(companyGuid, invoiceRef) {
  const invoice = await resolveInvoiceForReturn(companyGuid, invoiceRef);
  if (!invoice) {
    return { ok: false, status: 404, code: 'INVOICE_NOT_FOUND', message: `Sales invoice not found for "${invoiceRef}"` };
  }
  if (!isSalesInvoiceRow(invoice)) {
    return {
      ok: false, status: 400, code: 'NOT_A_SALES_INVOICE',
      message: `Voucher ${invoice.voucher_number || invoiceRef} is a ${invoice.voucher_type || 'non-Sales'} voucher — a Sales Return must be raised against a Sales invoice`,
    };
  }
  const context = await loadCreditNoteContext(companyGuid, invoice);
  return { ok: true, invoice, context };
}
