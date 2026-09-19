/**
 * One authority for "does this master belong to this company?".
 *
 * Voucher bodies name their masters as free text — "Customer X", "Main
 * Location", "Sales Account GST" — and those strings went into Tally XML after
 * nothing more than a company-access check. Two companies routinely hold
 * masters with identical names, so a body could name a ledger the caller's
 * company does not have and the mistake surfaced only as a Tally error after
 * the row was already queued, if at all. Credit and Debit Note were the only
 * paths that rejected anything, and they did it with their own bespoke SQL.
 *
 * Every lookup here is `company_id` plus the name. Never a global name lookup.
 *
 * Names are compared case-insensitively because Tally treats them that way and
 * the existing enrichment lookups (loadDocumentContext) already do.
 *
 * ── Unsynced companies ──────────────────────────────────────────────────────
 * A company that has never completed a master sync has zero rows of that kind.
 * Rejecting there would block every voucher for a legitimate reason unrelated
 * to tenancy, and with no masters at all there is no other company's master to
 * confuse this one with. So a kind with no rows for the company is skipped and
 * the reason is recorded. Once one master of a kind exists, all references of
 * that kind must resolve.
 */
import { query } from '../db/schema.js';

/** kind → [table, name column] */
const MASTER_TABLES = {
  ledger: ['ledgers', 'name'],
  stock: ['stocks', 'name'],
  godown: ['warehouses', 'name'],
  unit: ['units', 'name'],
  costCentre: ['cost_centres', 'name'],
  voucherType: ['voucher_types', 'name'],
};

/** kind → error code, per the documented voucher error contract. */
const ERROR_CODES = {
  ledger: 'LEDGER_NOT_FOUND',
  stock: 'STOCK_ITEM_NOT_FOUND',
  godown: 'GODOWN_NOT_FOUND',
  unit: 'UNIT_NOT_FOUND',
  costCentre: 'COST_CENTRE_NOT_FOUND',
  voucherType: 'VOUCHER_TYPE_NOT_FOUND',
};

/** A party ledger missing is worth its own code — it is the commonest mistake. */
const PARTY_ERROR_CODE = 'PARTY_LEDGER_NOT_FOUND';

export class VoucherReferenceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'VoucherReferenceError';
    this.code = code;
    this.httpStatus = 422;
    this.details = details;
  }
}

/**
 * A reference to check.
 * @typedef {{ kind: keyof MASTER_TABLES, value: unknown, role?: string }} VoucherReference
 */

/** Drop blanks and duplicates, keeping the first spelling seen for the error text. */
function distinctNames(refs) {
  const byKey = new Map();
  for (const ref of refs) {
    const name = String(ref?.value ?? '').trim();
    if (!name) continue;
    if (!MASTER_TABLES[ref.kind]) continue;
    const key = `${ref.kind}::${name.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { ...ref, value: name });
  }
  return [...byKey.values()];
}

/**
 * Throw unless every reference resolves inside `companyId`.
 *
 * @param {number|string} companyId companies.id — never a Tally GUID
 * @param {VoucherReference[]} references
 * @returns {Promise<{ checked: number, skippedKinds: string[] }>}
 */
export async function assertVoucherReferences(companyId, references) {
  const numericCompanyId = Number(companyId);
  if (!Number.isFinite(numericCompanyId)) {
    throw new VoucherReferenceError(
      'COMPANY_NOT_RESOLVED',
      'Company could not be resolved for this voucher'
    );
  }

  const wanted = distinctNames(references || []);
  if (!wanted.length) return { checked: 0, skippedKinds: [] };

  const byKind = new Map();
  for (const ref of wanted) {
    if (!byKind.has(ref.kind)) byKind.set(ref.kind, []);
    byKind.get(ref.kind).push(ref);
  }

  const skippedKinds = [];
  let checked = 0;

  for (const [kind, refs] of byKind) {
    const [table, nameColumn] = MASTER_TABLES[kind];
    const lowered = refs.map((r) => r.value.toLowerCase());

    const { rows } = await query(
      `SELECT LOWER(${nameColumn}) AS name FROM ${table}
        WHERE company_id = $1 AND LOWER(${nameColumn}) = ANY($2::text[])`,
      [numericCompanyId, lowered]
    );
    const present = new Set(rows.map((r) => r.name));
    const missing = refs.filter((r) => !present.has(r.value.toLowerCase()));
    if (!missing.length) {
      checked += refs.length;
      continue;
    }

    const { rows: anyRows } = await query(
      `SELECT 1 FROM ${table} WHERE company_id = $1 LIMIT 1`,
      [numericCompanyId]
    );
    if (!anyRows.length) {
      skippedKinds.push(kind);
      continue;
    }

    const party = missing.find((m) => m.role === 'party');
    const first = party || missing[0];
    const code = party ? PARTY_ERROR_CODE : ERROR_CODES[kind];
    const names = missing.map((m) => m.value);
    throw new VoucherReferenceError(
      code,
      `${labelFor(first)} not found in this company: ${names.join(', ')}`,
      { kind, role: first.role || null, missing: names }
    );
  }

  return { checked, skippedKinds };
}

function labelFor(ref) {
  if (ref.role === 'party') return 'Party ledger';
  switch (ref.kind) {
    case 'ledger': return 'Ledger';
    case 'stock': return 'Stock item';
    case 'godown': return 'Godown';
    case 'unit': return 'Unit';
    case 'costCentre': return 'Cost centre';
    case 'voucherType': return 'Voucher type';
    default: return 'Master';
  }
}

/**
 * Express helper: run the check and answer with the documented error shape.
 * Returns true when the caller may continue.
 *
 * Validation runs before any XML is built or queued, so an invalid reference
 * never becomes a write_queue row that Tally later rejects.
 */
export async function validateVoucherReferences(res, companyId, references, context = {}) {
  try {
    await assertVoucherReferences(companyId, references);
    return true;
  } catch (err) {
    if (!(err instanceof VoucherReferenceError)) throw err;
    // Names are customer data; the log keeps the tenancy and the field, and the
    // name only because an operator cannot diagnose "a ledger" without it.
    console.warn(
      `[voucher-refs] ${err.code} workspace=${context.workspaceId || '-'} company=${companyId} ` +
        `kind=${err.details.kind || '-'} missing=${(err.details.missing || []).length}`
    );
    res.status(err.httpStatus).json({
      status: false,
      success: false,
      code: err.code,
      error: { code: err.code, message: err.message, details: err.details },
      message: err.message,
    });
    return false;
  }
}

/**
 * Collect references from a sales/purchase-shaped body.
 *
 * `defaults` are the strings the XML builders substitute when a field is
 * absent ("Main Location", "Sales Account GST"). They are not checked: the
 * caller did not name them, so rejecting would fail a voucher over a default
 * this backend chose. What the caller *did* name is checked.
 */
export function collectLineReferences(items = [], { ledgerField, includeUnit = true } = {}) {
  const refs = [];
  for (const item of items || []) {
    if (!item) continue;
    refs.push({ kind: 'stock', value: item.itemName ?? item.stockItem ?? item.name });
    if (ledgerField) refs.push({ kind: 'ledger', value: item[ledgerField] });
    refs.push({ kind: 'godown', value: item.godown ?? item.warehouse });
    if (includeUnit) refs.push({ kind: 'unit', value: item.unit });
    refs.push({ kind: 'costCentre', value: item.costCentre });
  }
  return refs;
}

/** Tax and logistics legs both carry a `ledgerName`. */
export function collectLedgerNameReferences(rows = []) {
  const refs = [];
  for (const row of rows || []) {
    if (!row) continue;
    refs.push({ kind: 'ledger', value: row.ledgerName });
    for (const tax of row.taxes || []) {
      refs.push({ kind: 'ledger', value: tax?.ledgerName });
    }
  }
  return refs;
}
