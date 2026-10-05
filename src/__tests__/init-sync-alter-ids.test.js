import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { isoYearDate } from '../routes/ingest.js';

const SRC = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');

describe('init-sync per-year voucher alterIds', () => {
  it('normalises Tally FY bounds to the TEXT date format stored in vouchers.date', () => {
    assert.equal(isoYearDate('20260401', 'x'), '2026-04-01');
    assert.equal(isoYearDate('2027-03-31', 'x'), '2027-03-31');
    assert.equal(isoYearDate(20270331, 'x'), '2027-03-31');
    assert.equal(isoYearDate(undefined, '2000-01-01'), '2000-01-01');
    assert.equal(isoYearDate('', '2099-12-31'), '2099-12-31');
    assert.equal(isoYearDate('1 Apr 2026', '2000-01-01'), '2000-01-01');
  });

  it('dashless bounds would miss the current FY as text; normalised bounds include it', () => {
    const stored = '2026-05-01';
    assert.equal(stored >= '20260401' && stored <= '20270331', false, 'the old bug');
    assert.equal(stored >= isoYearDate('20260401') && stored <= isoYearDate('20270331'), true);
    assert.equal('2023-01-15' >= isoYearDate('20220401') && '2023-01-15' <= isoYearDate('20230331'), true);
    assert.equal('2023-05-15' >= isoYearDate('20220401') && '2023-05-15' <= isoYearDate('20230331'), false);
  });

  it('the alterId query uses the normalised bounds', () => {
    assert.match(
      SRC,
      /SELECT MAX\(alter_id\) as max FROM vouchers WHERE company_id = \$1 AND date >= \$2 AND date <= \$3`,\s*\[companyId, isoYearDate\(y\.begin \|\| y\.beginDate, '2000-01-01'\), isoYearDate\(y\.end \|\| y\.endDate, '2099-12-31'\)\]/
    );
  });
});
