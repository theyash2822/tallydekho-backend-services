/**
 * Shared KPI trend helpers. Null when prior denominator is 0 / missing.
 * Trend % = (current - prior) / |prior| * 100, one decimal.
 */

export function money(n) {
  return Math.round((Math.abs(parseFloat(n) || 0)) * 100) / 100;
}

export function isoDay(d) {
  if (!d) return null;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s : null;
}

export function addDays(iso, delta) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** @returns {number|null} */
export function computeTrendPct(current, prior) {
  const cur = Number(current) || 0;
  const prv = Number(prior) || 0;
  if (prv === 0) return null;
  return Math.round(((cur - prv) / Math.abs(prv)) * 1000) / 10;
}

export function trendFields(pct) {
  if (pct == null || !Number.isFinite(pct)) {
    return { trend_pct: null, trend_positive: null };
  }
  return { trend_pct: pct, trend_positive: pct >= 0 };
}

/**
 * Prefer exact as_of; else nearest row within ±toleranceDays of target.
 * @param {Array<{as_of:string}>} rows sorted by as_of DESC
 */
export function pickPriorSnapshot(rows, targetIso, toleranceDays = 3) {
  if (!rows?.length || !targetIso) return null;
  const exact = rows.find((r) => isoDay(r.as_of) === targetIso);
  if (exact) return exact;
  const target = new Date(`${targetIso}T12:00:00`).getTime();
  let best = null;
  let bestDist = Infinity;
  for (const r of rows) {
    const day = isoDay(r.as_of);
    if (!day) continue;
    const dist = Math.abs(new Date(`${day}T12:00:00`).getTime() - target) / 86400000;
    if (dist <= toleranceDays && dist < bestDist) {
      best = r;
      bestDist = dist;
    }
  }
  return best;
}
