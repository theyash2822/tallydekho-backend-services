/**
 * R3 / 01 — Tally change counters (AlterID / MasterID) are exact integers. parseInt reads
 * '2E5' as 2 and '0x1A' as 0, and Number loses digits past 2^53, so counters are kept as
 * decimal strings (bound to SQL as text, compared as BigInt). Anything that is not a plain
 * non-negative decimal integer is reported as invalid instead of being guessed.
 */
import { ingestCompanyCtx } from './ingestCompanyDualWrite.js';

export class TallyCounterError extends Error {
  constructor(raw) {
    super('Tally counter is not a plain decimal integer');
    this.code = 'TALLY_COUNTER_INVALID';
    this.raw = typeof raw === 'string' ? raw.slice(0, 40) : typeof raw;
  }
}

// Recorded in the ingest context too: a per-row catch must not turn a bad counter into a
// silently skipped row — the chunk then fails explicitly (R2 / X3).
function invalid(raw) {
  const err = new TallyCounterError(raw);
  ingestCompanyCtx.getStore()?.failures?.push({ pgCode: null, message: err.message });
  return err;
}

/** Exact decimal string ('0' when absent). Throws TallyCounterError for malformed values. */
export function tallyCounter(value) {
  if (value === undefined || value === null || value === '') return '0';
  if (typeof value === 'number') {
    if (Number.isSafeInteger(value) && value >= 0) return String(value);
    throw invalid(String(value));
  }
  if (typeof value === 'bigint') {
    if (value >= 0n) return value.toString();
    throw invalid(value.toString());
  }
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw invalid(s);
  return s.replace(/^0+(?=\d)/, '');
}

export const compareCounters = (a, b) => {
  const x = BigInt(tallyCounter(a));
  const y = BigInt(tallyCounter(b));
  return x < y ? -1 : x > y ? 1 : 0;
};
