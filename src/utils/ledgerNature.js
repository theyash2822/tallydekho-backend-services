/**
 * Infer Tally ledger nature (Assets / Liabilities / Income / Expense)
 * when groups.nature / ledgers.nature are not populated from sync.
 *
 * Walks the group parent chain using a name→parent map, matching
 * reserved primary / secondary group names.
 */

const ASSET_GROUPS = [
  'current assets',
  'fixed assets',
  'investments',
  'misc. expenses (asset)',
  'miscellaneous expenses (asset)',
  'stock-in-hand',
  'stock in hand',
  'cash-in-hand',
  'cash in hand',
  'bank accounts',
  'bank account',
  'deposits (asset)',
  'loans & advances (asset)',
  'loans and advances (asset)',
  'sundry debtors',
  'branch / divisions',
  'branch/divisions',
];

const LIABILITY_GROUPS = [
  'current liabilities',
  'loans (liability)',
  'capital account',
  'reserves & surplus',
  'reserves and surplus',
  'duties & taxes',
  'duties and taxes',
  'provisions',
  'sundry creditors',
  'bank od a/c',
  'bank od',
  'secured loans',
  'unsecured loans',
  'suspense a/c',
];

const INCOME_GROUPS = [
  'sales accounts',
  'sales account',
  'direct incomes',
  'direct income',
  'indirect incomes',
  'indirect income',
];

const EXPENSE_GROUPS = [
  'purchase accounts',
  'purchase account',
  'direct expenses',
  'direct expense',
  'indirect expenses',
  'indirect expense',
];

function norm(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchBucket(name) {
  const n = norm(name);
  if (!n) return null;
  if (ASSET_GROUPS.some(g => n === g || n.includes(g))) return 'Assets';
  if (LIABILITY_GROUPS.some(g => n === g || n.includes(g))) return 'Liabilities';
  if (INCOME_GROUPS.some(g => n === g || n.includes(g))) return 'Income';
  if (EXPENSE_GROUPS.some(g => n === g || n.includes(g))) return 'Expense';
  // Soft keyword fallbacks
  if (/\basset\b/.test(n) || /\bdebtor\b/.test(n)) return 'Assets';
  if (/\bliabilit/.test(n) || /\bcreditor\b/.test(n) || /\bloan\b/.test(n) || /\bcapital\b/.test(n)) return 'Liabilities';
  if (/\bincome\b/.test(n) || /\bsales\b/.test(n) || /\brevenue\b/.test(n)) return 'Income';
  if (/\bexpense\b/.test(n) || /\bpurchase\b/.test(n)) return 'Expense';
  return null;
}

/**
 * @param {string} startGroup - ledger.parent (or group name)
 * @param {Record<string, string|null>} parentByName - groups.name → groups.parent
 * @param {string|null|undefined} storedNature - COALESCE(l.nature, g.nature)
 */
export function inferLedgerNature(startGroup, parentByName = {}, storedNature) {
  const stored = String(storedNature || '').trim();
  if (stored) {
    const n = stored.toLowerCase();
    if (n.startsWith('asset')) return 'Assets';
    if (n.startsWith('liab')) return 'Liabilities';
    if (n.startsWith('income')) return 'Income';
    if (n.startsWith('expense')) return 'Expense';
    return stored;
  }

  let current = String(startGroup || '').trim();
  const seen = new Set();
  for (let i = 0; i < 12 && current; i++) {
    const key = norm(current);
    if (!key || seen.has(key)) break;
    seen.add(key);
    const hit = matchBucket(current);
    if (hit) return hit;
    // Resolve next parent (case-insensitive lookup)
    const next =
      parentByName[current] ??
      parentByName[Object.keys(parentByName).find(k => norm(k) === key)] ??
      null;
    current = next ? String(next).trim() : '';
  }
  return '';
}

/**
 * Build name→parent map from groups rows.
 */
export function buildGroupParentMap(groupRows = []) {
  const map = {};
  for (const g of groupRows) {
    if (!g?.name) continue;
    map[String(g.name).trim()] = g.parent ? String(g.parent).trim() : null;
  }
  return map;
}
