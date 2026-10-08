/**
 * Desktop parsers deliver every Tally value as exact text ("Yes", "1", "true"); older desktops sent
 * coerced numbers/booleans. Accept both so a mixed fleet ingests flags identically.
 */
export function isTallyTrue(v) {
  if (v === true || v === 1) return true;
  if (typeof v !== 'string') return false;
  const s = v.trim().toLowerCase();
  return s === 'yes' || s === 'true' || s === '1';
}
