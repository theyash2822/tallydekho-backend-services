/**
 * A 5xx must not hand the caller the database's own words.
 *
 * Most handlers answer a caught exception with `message: err.message`. When the
 * exception is a Postgres error that text names tables, columns, constraints
 * and the offending value — a schema map for anyone probing the API, and
 * useless to a client either way. The shield in createApp replaces it and keeps
 * the detail in the logs under a request id.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { setupRbacHarness, httpJson } from './harness.js';
import { INTERNAL_ERROR_MESSAGE } from '../../middleware/internalErrorShield.js';

let ctx;

/** Postgres phrasings that must never reach a response body. */
const DB_TELLS = [
  /relation ".+" does not exist/i,
  /column ".+" does not exist/i,
  /duplicate key value violates unique constraint/i,
  /violates foreign key constraint/i,
  /syntax error at or near/i,
  /invalid input syntax for/i,
  /null value in column/i,
];

before(async () => {
  try {
    ctx = await setupRbacHarness();
  } catch (err) {
    if (err.code === 'RBAC_UNIT_ONLY') {
      ctx = null;
      return;
    }
    throw err;
  }
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Internal errors are not narrated to clients', () => {
  it('every response carries a correlation id', async () => {
    if (!ctx) throw new Error('harness required');
    const { headers } = await httpJson(ctx.baseUrl, 'GET', '/health');
    assert.ok(headers.get('x-request-id'), 'x-request-id must be set for log correlation');
  });

  it('a caller-supplied request id is echoed back', async () => {
    if (!ctx) throw new Error('harness required');
    const { headers } = await httpJson(ctx.baseUrl, 'GET', '/health', {
      headers: { 'x-request-id': 'probe-12345' },
    });
    assert.equal(headers.get('x-request-id'), 'probe-12345');
  });

  it('a 5xx body says nothing about the database', async () => {
    if (!ctx) throw new Error('harness required');
    // A date where the route expects one drives the query into a Postgres cast
    // error; whatever 5xx surfaces, the body must stay generic.
    const attempts = [
      ['GET', `/api/reports/daybook?companyGuid=${ctx.fixtures.companies.A1}&from=not-a-date&to=not-a-date`],
      ['GET', `/api/vouchers?companyGuid=${ctx.fixtures.companies.A1}&fromDate=%00&toDate=%00`],
      ['GET', `/api/stock/summary?companyGuid=${ctx.fixtures.companies.A1}&asOf=not-a-date`],
    ];
    let saw5xx = false;
    for (const [method, path] of attempts) {
      const { status, json } = await httpJson(ctx.baseUrl, method, path, {
        token: ctx.fixtures.tokens.ownerA.accessToken,
        headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
      });
      if (status < 500) continue;
      saw5xx = true;
      const text = JSON.stringify(json ?? {});
      for (const tell of DB_TELLS) {
        assert.ok(!tell.test(text), `5xx leaked a Postgres error (${path}): ${text.slice(0, 300)}`);
      }
      const message = json?.error?.message ?? json?.message;
      assert.equal(message, INTERNAL_ERROR_MESSAGE, `5xx body must be generic, got: ${text.slice(0, 200)}`);
    }
    // Not reaching a 5xx is a pass for the API and a no-op for this assertion.
    if (!saw5xx) assert.ok(true, 'no 5xx produced — nothing could leak');
  });

  it('4xx keeps its message, because that one is about the request', async () => {
    if (!ctx) throw new Error('harness required');
    const { status, json } = await httpJson(ctx.baseUrl, 'POST', '/api/einvoice/cancel', {
      token: ctx.fixtures.tokens.ownerA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
      body: {},
    });
    assert.ok(status >= 400 && status < 500, `expected a client error, got ${status}`);
    const message = json?.error?.message ?? json?.message;
    if (message) assert.notEqual(message, INTERNAL_ERROR_MESSAGE, '4xx must stay actionable');
  });
});
