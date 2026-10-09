// R3 / 01: Tally counters are exact; malformed ones fail instead of being guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tallyCounter, compareCounters, TallyCounterError } from '../utils/tallyCounters.js';
import { ingestCompanyCtx } from '../utils/ingestCompanyDualWrite.js';

test('plain decimal counters are kept exactly, including past 2^53 and with leading zeros', () => {
  assert.equal(tallyCounter('12345'), '12345');
  assert.equal(tallyCounter('0012'), '12');
  assert.equal(tallyCounter('9007199254740993'), '9007199254740993');
  assert.equal(tallyCounter(42), '42');
  assert.equal(tallyCounter(undefined), '0');
  assert.equal(tallyCounter(''), '0');
});

test('exponent, hex, decimal and negative forms are rejected, not misread', () => {
  for (const bad of ['2E5', '0x1A', '12.10', '-3', ' 1 2 ', 1.5, -1, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => tallyCounter(bad), TallyCounterError, String(bad));
  }
});

test('ordering is exact beyond the safe-integer range', () => {
  assert.equal(compareCounters('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareCounters('10', '9'), 1);
  assert.equal(compareCounters('007', '7'), 0);
});

test('a malformed counter inside an ingest unit is recorded as a failure even if caught', () => {
  const ctx = { failures: [] };
  ingestCompanyCtx.run(ctx, () => {
    try { tallyCounter('2E5'); } catch (_) { /* a per-row catch */ }
  });
  assert.equal(ctx.failures.length, 1);
});
