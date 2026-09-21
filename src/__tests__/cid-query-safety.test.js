import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { resolveViewCapability } from '../middleware/viewCapability.js';

const api = readFileSync(new URL('../routes/api-v1.js', import.meta.url), 'utf8');

describe('CID query leftovers that blank Mobile/Web after pairing', () => {
  it('GET /ledgers projects groups on company_id, not a subquery missing that column', () => {
    const fn = api.slice(api.indexOf("router.get('/ledgers'"));
    const join = fn.slice(0, fn.indexOf("router.get('/ledgers/fy-balances'"));
    assert.match(
      join,
      /SELECT DISTINCT ON \(company_id, name\) company_id, name, nature/,
      'the groups subquery must select company_id or Postgres raises g.company_id does not exist'
    );
    assert.doesNotMatch(join, /DISTINCT ON \(company_guid/);
  });

  it('dashboard metric helpers bind the company_id argument they declare', () => {
    const fn = api.slice(api.indexOf('async function dashboardMetricAmounts'));
    const body = fn.slice(0, fn.indexOf('\nfunction metricTrendTile'));
    assert.match(body, /async function dashboardMetricAmounts\(companyId,/);
    assert.match(
      api,
      /dashboardMetricAmounts\(companyId, from, to\)/,
      'GET /dashboard/metrics must pass the resolved internal id'
    );
    assert.doesNotMatch(
      api.slice(api.indexOf("router.get('/dashboard/metrics'"), api.indexOf("router.get('/dashboard/chart'")),
      /dashboardMetricAmounts\(companyGuid/
    );
  });

  it('expense / home metric helpers take companyId, not an unbound name', () => {
    for (const name of [
      'sumVoucherAmount',
      'countVouchers',
      'sumNoteAmount',
      'sumLedgerOutstanding',
      'sumExpenseAmount',
      'applyMultiWarehouseStockFilter',
    ]) {
      const start = api.indexOf(`async function ${name}(`);
      assert.ok(start > -1, `${name} must exist`);
      const head = api.slice(start, start + 80);
      assert.match(head, new RegExp(`async function ${name}\\(companyId`));
    }
  });

  it('notifications is a mapped view capability so Demo/paired reads are not CAPABILITY_REQUIRED', () => {
    assert.equal(
      resolveViewCapability({ originalUrl: '/api/notifications?companyGuid=x' }),
      'dashboard.view'
    );
  });

  it('FY stock items fall back to Opening Balance txs when stocks.opening_qty is 0', () => {
    const fn = api.slice(api.indexOf("router.get('/stocks/items'"));
    const fyPath = fn.slice(0, fn.indexOf('// No FY param'));
    assert.match(fyPath, /voucher_type = 'Opening Balance'/);
    assert.match(fyPath, /NULLIF\(s\.opening_qty, 0\)/);
    assert.match(fyPath, /COALESCE\(st\.voucher_type, ''\) NOT IN \('Physical Stock', 'Opening Balance'\)/);
  });

  it('negative-stock warehouse subquery projects company_id, not company_guid', () => {
    const fn = api.slice(api.indexOf("router.get('/stocks/negative-stock'"));
    const body = fn.slice(0, fn.indexOf("router.get('/stocks/expiry-schedule'"));
    assert.match(body, /SELECT stock_guid, company_id,/);
    assert.doesNotMatch(body, /SELECT stock_guid, company_guid,/);
    assert.match(body, /GROUP BY stock_guid, company_id,/);
  });
});

describe('ingest stock closing recompute uses company_id', () => {
  const ingest = readFileSync(new URL('../controllers/ingestProcessor.js', import.meta.url), 'utf8');

  it('does not join stock recompute subqueries on a missing company_id after grouping company_guid', () => {
    assert.doesNotMatch(ingest, /GROUP BY stock_guid, company_guid/);
    assert.doesNotMatch(ingest, /GROUP BY voucher_guid, company_guid/);
    assert.match(ingest, /GROUP BY stock_guid, company_id/);
  });

  it('stock recompute failure records a partial warning instead of failing the sync', () => {
    assert.match(ingest, /recordIngestWarning\('stock_qty_recompute'/);
    assert.match(ingest, /async function recordIngestWarning/);
  });

  it('does not leave a hole before currentCompanyId() in ingest value arrays', () => {
    assert.doesNotMatch(ingest, /,\s*\n\s*,\s*currentCompanyId\(\)/);
    assert.match(ingest, /recordIngestWarning\('voucher_inventory_insert'/);
    assert.match(ingest, /recordIngestWarning\('stock_transaction_insert'/);
  });
});

describe('ingest complete completeness diagnostics', () => {
  const ingestRoute = readFileSync(new URL('../routes/ingest.js', import.meta.url), 'utf8');

  it('flags sales/purchase parents with zero inventory children', () => {
    assert.match(ingestRoute, /inventory_collection_empty/);
    assert.match(ingestRoute, /groups_empty/);
    assert.match(ingestRoute, /warehouses_empty/);
  });
});
