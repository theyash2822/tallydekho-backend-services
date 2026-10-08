/**
 * Inventory tables are keyed by (voucher, item, godown, batch[, direction]), but Tally allows the
 * same item/godown/batch on several lines of one voucher. Upserting each line separately keeps only
 * the last one. Merge such lines first so quantity and value stay complete.
 */

const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/**
 * @param {object[]} lines
 * @param {(line: object) => string} keyOf
 * @param {{ sum: string[], qty: string, value: string, rate: string }} fields
 * @returns {{ lines: object[], merged: number }}
 */
export function aggregateInventoryLines(lines, keyOf, { sum, qty, value, rate }) {
  const byKey = new Map();
  let merged = 0;
  for (const line of lines) {
    const key = keyOf(line);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { line: { ...line }, mixedRate: false });
      continue;
    }
    merged += 1;
    for (const f of sum) prev.line[f] = round6((prev.line[f] || 0) + (line[f] || 0));
    if (prev.line[rate] !== line[rate]) prev.mixedRate = true;
  }
  const out = [];
  for (const { line, mixedRate } of byKey.values()) {
    if (mixedRate && line[qty]) line[rate] = round6(line[value] / line[qty]);
    out.push(line);
  }
  return { lines: out, merged };
}
