import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { getClient } from '../db/schema.js';
import {
  effectiveWatermark,
  parseVoucherWatermarks,
  applyVoucherWatermarks,
  readVoucherWatermarks,
  clearVoucherWatermarks,
  findRenamedMasters,
  FAILURE_ONLY_COLLECTIONS,
  RESET_MARKER,
} from '../services/voucherWatermarks.js';

const ROUTE = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');
const PROC = readFileSync(new URL('../controllers/ingestProcessor.js', import.meta.url), 'utf8');
const CO = 999000123;
const GUID = 'wm-test-guid';
const body = (over = {}) => ({
  voucherWatermarks: [{
    companyGuid: GUID,
    years: [{ finYear: '2026-2027', alterId: 9777 }, { finYear: '2025-2026', alterId: 9565 }],
    sent: { 'AllVoucher.xml': 183, 'StockTransaction.xml': 61 },
    ...over,
  }],
});
const counts = (av = { saved: 183, rejected: 0 }, st = { saved: 61, rejected: 0 }) => ({
  'AllVoucher.xml': { saved: 1, received: 1 },
  _cumulative: { 'AllVoucher.xml': av, 'StockTransaction.xml': st },
});

describe('voucher watermarks — pure rules', () => {
  it('effective watermark is 0 without a row, else never above what we hold', () => {
    assert.equal(effectiveWatermark(undefined, 9777), 0);
    assert.equal(effectiveWatermark(9000, 9777), 9000, 'single-voucher ingest pushed MAX above the watermark');
    assert.equal(effectiveWatermark(9777, 9500), 9500, 'top voucher deleted');
    assert.equal(effectiveWatermark(9777, null), 0, 'purged / empty FY');
  });

  it('parses only well-formed summaries', () => {
    assert.equal(parseVoucherWatermarks(body()).get(GUID).years.length, 2);
    assert.equal(parseVoucherWatermarks(body({ years: [{ finYear: '26-27', alterId: 1 }] })).size, 0);
    assert.equal(parseVoucherWatermarks(body({ years: [{ finYear: '2026-2027', alterId: -1 }] })).size, 0);
    assert.equal(parseVoucherWatermarks(body({ sent: { 'AllVoucher.xml': 1 } })).size, 0);
    assert.equal(parseVoucherWatermarks({}).size, 0);
  });

  it('a rename is a GUID whose stored name differs from the incoming one', async () => {
    let seen;
    const db = { query: async (sql, params) => {
      seen = { sql, params };
      return { rows: [{ guid: 'g1', name: 'Old Party' }, { guid: 'g2', name: 'Same' }, { guid: 'g3', name: null }] };
    } };
    const renamed = await findRenamedMasters(db, {
      table: 'ledgers', companyId: CO,
      rows: [{ guid: 'g1', name: 'New Party' }, { guid: 'g2', name: 'Same' }, { guid: 'g3', name: 'X' }, { guid: '', name: 'skip' }],
    });
    assert.deepEqual(renamed, ['g1']);
    assert.match(seen.sql, /FROM ledgers WHERE company_id = \$1 AND guid = ANY/);
    assert.deepEqual(seen.params, [CO, ['g1', 'g2', 'g3']]);
    assert.deepEqual(await findRenamedMasters({ query: () => assert.fail('no query for empty input') }, { table: 'ledgers', companyId: CO, rows: [] }), []);
  });
});

describe('voucher watermarks — database', () => {
  let client;
  before(async () => { client = await getClient(); });
  after(() => client?.release());

  const SCHEMA = readFileSync(new URL('../db/schema.js', import.meta.url), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS voucher_sync_watermarks \([\s\S]*?\);/)[0];
  // DDL is transactional: the table (normally created by initSchema at boot) lives only in this tx.
  const inTx = async (fn) => {
    await client.query('BEGIN');
    try { await client.query(SCHEMA); await fn(); } finally { await client.query('ROLLBACK'); }
  };
  const apply = (over = {}) => applyVoucherWatermarks(client, {
    uploadId: 'u1', companyId: CO, summary: parseVoucherWatermarks(body()).get(GUID),
    collectionCounts: counts(), outcome: 'complete', nowSec: 1, ...over,
  });

  it('advances on a clean complete upload', () => inTx(async () => {
    assert.deepEqual(await apply(), { action: 'advanced', reason: null, years: 2 });
    const m = await readVoucherWatermarks(client, CO);
    assert.equal(m.get('2026-2027'), 9777);
    assert.equal(m.get('2025-2026'), 9565);
  }));

  it('keeps the old watermark on partial, rejected, rolled-back or unsummarised uploads', () => inTx(async () => {
    assert.equal((await apply({ outcome: 'partial' })).reason, 'outcome_partial');
    assert.equal((await apply({ collectionCounts: counts({ saved: 182, rejected: 1 }) })).reason, 'rejected:AllVoucher.xml');
    assert.equal((await apply({ collectionCounts: counts({ saved: 100, rejected: 0 }) })).reason, 'unsaved:AllVoucher.xml');
    assert.equal((await apply({ collectionCounts: counts(undefined, { saved: 0, rejected: 61 }) })).reason, 'rejected:StockTransaction.xml');
    assert.equal((await apply({ collectionCounts: {} })).reason, 'unsaved:AllVoucher.xml');
    assert.equal((await apply({ summary: undefined })).reason, 'no_watermarks');
    for (const xml of FAILURE_ONLY_COLLECTIONS) {
      const c = counts();
      c._cumulative[xml] = { saved: 0, rejected: 4 };
      assert.equal((await apply({ collectionCounts: c })).reason, `rejected:${xml}`);
    }
    const renamed = counts();
    renamed._cumulative[RESET_MARKER] = { saved: 1, rejected: 0 };
    assert.equal((await apply({ collectionCounts: renamed })).reason, 'master_renamed');
    assert.equal((await readVoucherWatermarks(client, CO)).size, 0);
  }));

  it('addCollectionTotals SQL sums across chunks and keeps the per-chunk stats', () => inTx(async () => {
    const src = readFileSync(new URL('../utils/ingestPostReconcile.js', import.meta.url), 'utf8');
    const sql = src.match(/export async function addCollectionTotals[\s\S]*?await query\(\s*`([\s\S]*?)`/)[1];
    await client.query(
      `INSERT INTO ingest_uploads (id, device_id, collection_counts) VALUES ('wm-totals', 'wm-dev', '{"AllVoucher.xml":{"received":5}}'::jsonb)`
    );
    await client.query(sql, ['wm-totals', 'AllVoucher.xml', 100, 0]);
    await client.query(sql, ['wm-totals', 'AllVoucher.xml', 83, 2]);
    await client.query(sql, ['wm-totals', 'StockTransaction.xml', 61, 0]);
    const { rows } = await client.query(`SELECT collection_counts FROM ingest_uploads WHERE id = 'wm-totals'`);
    assert.deepEqual(rows[0].collection_counts, {
      'AllVoucher.xml': { received: 5 },
      _cumulative: { 'AllVoucher.xml': { saved: 183, rejected: 2 }, 'StockTransaction.xml': { saved: 61, rejected: 0 } },
    });
  }));

  it('nothing sent for a collection needs no saved rows; clear removes all', () => inTx(async () => {
    const summary = parseVoucherWatermarks(body({ sent: { 'AllVoucher.xml': 0, 'StockTransaction.xml': 0 } })).get(GUID);
    assert.equal((await apply({ summary, collectionCounts: {} })).action, 'advanced');
    await clearVoucherWatermarks(client, CO);
    assert.equal((await readVoucherWatermarks(client, CO)).size, 0);
  }));
});

describe('voucher watermarks — wiring', () => {
  it('init-sync uses the watermark when present, legacy value otherwise, and hard sync clears', () => {
    assert.match(ROUTE, /if \(isHardSync === true\) await clearVoucherWatermarks\(\{ query \}, companyId\);/);
    assert.match(ROUTE, /const watermarkSync = req\.body\?\.watermarkSync === true;/);
    assert.match(ROUTE, /if \(watermarkSync\) \{\s*voucherByYear\[finYear\] = effectiveWatermark\(watermarks\.get\(finYear\), yvRows\[0\]\?\.max\);\s*continue;\s*\}/);
    assert.match(ROUTE, /\[companyId, y\.begin \|\| y\.beginDate \|\| '2000-01-01', y\.end \|\| y\.endDate \|\| '2099-12-31'\]/);
  });
  it('purge and restore drop watermarks; master renames reset them', () => {
    const purge = readFileSync(new URL('../services/companyPurge.js', import.meta.url), 'utf8');
    const restore = readFileSync(new URL('../services/restoreService.js', import.meta.url), 'utf8');
    assert.match(purge, /'voucher_sync_watermarks'/);
    assert.match(restore, /DELETE FROM voucher_sync_watermarks WHERE company_id IN \(SELECT id FROM companies WHERE workspace_id = \$1\)/);
    for (const t of ['stocks', 'ledgers', 'warehouses', 'voucher_types']) {
      assert.match(PROC, new RegExp(`await noteMasterRenames\\('${t}',`), t);
    }
    assert.match(PROC, /addCollectionTotals\(RESET_MARKER, \{ saved: renamed \}\)/);
    assert.match(PROC, /await clearVoucherWatermarks\(\{ query: rawDbQuery \}, companyId\);\s*await addCollectionTotals\(RESET_MARKER, \{ saved: renamed \}\);\s*\} catch \(e\) \{\s*throw new WatermarkResetError\(e\);/);
    for (const label of ['Stocks transaction failed', 'FullLedger failed', 'Warehouses failed', 'VoucherTypes failed']) {
      assert.match(PROC, new RegExp(`'\\[DB\\] ${label}:', e\\.message\\);\\s*if \\(e instanceof WatermarkResetError\\) throw e;`), label);
    }
  });
  it('a lost rejection or reset marker fails the chunk instead of being swallowed', () => {
    const src = readFileSync(new URL('../utils/ingestPostReconcile.js', import.meta.url), 'utf8');
    assert.match(src, /if \(Number\(rejected\) > 0 \|\| xml === RESET_MARKER\) throw e;/);
  });
  it('the other voucher collections record rolled-back batches', () => {
    for (const [flag, xml] of [['viiCommitted', 'VoucherInventoryDetail'], ['gstCommitted', 'GSTDetails'], ['ltCommitted', 'LedgerTransaction']]) {
      assert.match(PROC, new RegExp(`if \\(!${flag}\\) await addCollectionTotals\\('${xml}\\.xml', \\{ rejected: data\\.length \\}\\)`), xml);
    }
  });
  it('complete applies watermarks after the collection counts are read', () => {
    const iCounts = ROUTE.indexOf("SELECT collection_counts FROM ingest_uploads WHERE id = $1");
    const iApply = ROUTE.indexOf('applyVoucherWatermarks({ query }');
    assert.ok(iCounts > 0 && iApply > iCounts);
  });
  it('AllVoucher and StockTransaction add totals only for a committed batch', () => {
    assert.match(PROC, /avCommitted = \(await client\.query\('COMMIT'\)\)\?\.command !== 'ROLLBACK'/);
    assert.match(PROC, /stCommitted = \(await client\.query\('COMMIT'\)\)\?\.command !== 'ROLLBACK'/);
    assert.match(PROC, /addCollectionTotals\('AllVoucher\.xml', \{ saved: 0, rejected: data\.length \}\)/);
  });
});
