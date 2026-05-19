// Tax classifier — Phase 1: hardcoded patterns, Phase 3: DB rules
// Classifies ledger lines into tax types using keyword matching

const DEFAULT_TAX_PATTERNS = [
  { taxType: 'TDS',             keywords: ['tds', 'tax deducted', 'tds payable', 'tds receivable'] },
  { taxType: 'TCS',             keywords: ['tcs', 'tax collected', 'tcs payable', 'tcs receivable'] },
  { taxType: 'VAT',             keywords: ['vat', 'value added tax', 'prepaid vat', 'output vat', 'input vat', 'vat payable', 'vat receivable', 'vat tax'] },
  { taxType: 'EXCISE_DUTY',     keywords: ['excise duty', 'excise'] },
  { taxType: 'SERVICE_TAX',     keywords: ['service tax', 'swachh bharat', 'krishi kalyan'] },
  { taxType: 'CESS',            keywords: ['cess', 'education cess', 'compensation cess'] },
  { taxType: 'IMPORT_DUTY',     keywords: ['import duty', 'custom duty', 'customs duty', 'basic customs duty', 'bcd', 'igst on import'] },
  { taxType: 'EXPORT_DUTY',     keywords: ['export duty'] },
  { taxType: 'WITHHOLDING_TAX', keywords: ['withholding tax', 'withholding', 'wht'] },
];

function normalizeName(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function classifyTaxLedger({ ledgerName, ledgerParent = '', ledgerGroup = '' }) {
  const haystack = normalizeName([ledgerName, ledgerParent, ledgerGroup].filter(Boolean).join(' '));
  for (const pattern of DEFAULT_TAX_PATTERNS) {
    if (pattern.keywords.some(k => haystack.includes(k))) {
      return pattern.taxType;
    }
  }
  return null;
}

export function inferTransactionNature(voucherType = '', ledgerName = '') {
  const vt = voucherType.toLowerCase();
  const ln = ledgerName.toLowerCase();
  if (ln.includes('payable') || ln.includes('output') || vt.includes('payment')) return 'settlement';
  if (ln.includes('receivable') || ln.includes('input') || vt.includes('receipt')) return 'input';
  if (vt.includes('sales') || ln.includes('output')) return 'output';
  if (vt.includes('purchase') || ln.includes('input')) return 'input';
  if (vt.includes('journal')) return 'adjustment';
  return 'other';
}
