/**
 * Compliance paths against a real duplicate Tally GUID.
 *
 * Two workspaces restore the same Tally backup, so both own a voucher whose
 * GUID is byte-identical. Everything downstream of that — IRN generation, IRN
 * cancellation, the app_vouchers mirror — has to resolve through company_id.
 * When it resolves through the GUID instead, workspace A cancels workspace B's
 * IRN, and in production that reaches the IRP under B's GSTIN.
 *
 * The companion unit suite pins the SQL shape; this one proves the behaviour on
 * live rows, including over HTTP.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { query } from '../../db/schema.js';
import { setupRbacHarness, httpJson } from './harness.js';

let ctx;
let sharedVoucherGuid;
let sharedCompanyGuid;
let companyA;
let companyB;

const ts = () => Math.floor(Date.now() / 1000);

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

  sharedCompanyGuid = `cmpl-co-${ctx.fixtures.suffix}`;
  sharedVoucherGuid = `cmpl-vch-${ctx.fixtures.suffix}`;

  const ins = async (workspaceId, name) => {
    const { rows } = await query(
      `INSERT INTO companies (guid, workspace_id, name, formal_name, gstin, is_active, synced_at, created_at)
       VALUES ($1,$2,$3,$3,$4,TRUE,$5,$5)
       ON CONFLICT (workspace_id, guid) DO UPDATE SET is_active = TRUE
       RETURNING id, guid, workspace_id, gstin`,
      [sharedCompanyGuid, workspaceId, name, `27AAAAA0000A1Z${name.slice(-1)}`, ts()]
    );
    return rows[0];
  };
  companyA = await ins(ctx.fixtures.workspaces.A, 'Compliance A');
  companyB = await ins(ctx.fixtures.workspaces.B, 'Compliance B');
  assert.notEqual(Number(companyA.id), Number(companyB.id));

  // Same voucher GUID in both companies, each with its own IRN.
  const insVoucher = async (companyId, number, irn) => {
    await query(
      `INSERT INTO vouchers (guid, company_guid, company_id, voucher_number, voucher_type, date, irn, irn_cancelled, synced_at)
       VALUES ($1,$2,$3,$4,'Sales',CURRENT_DATE,$5,FALSE,$6)
       ON CONFLICT (company_id, guid) DO UPDATE SET irn = EXCLUDED.irn, irn_cancelled = FALSE`,
      [sharedVoucherGuid, sharedCompanyGuid, companyId, number, irn, ts()]
    );
  };
  await insVoucher(companyA.id, 'CA-1', 'IRN-A-0001');
  await insVoucher(companyB.id, 'CB-1', 'IRN-B-0001');
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Compliance duplicate-GUID isolation', () => {
  it('both companies really hold the same voucher GUID', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows } = await query(
      `SELECT company_id, voucher_number, irn FROM vouchers WHERE guid = $1 ORDER BY company_id`,
      [sharedVoucherGuid]
    );
    assert.equal(rows.length, 2, 'fixture must produce a genuine GUID collision');
    assert.notEqual(rows[0].irn, rows[1].irn);
  });

  it('the auto-IRN reload returns only the queue entry’s own voucher', async () => {
    if (!ctx) throw new Error('harness required');
    // Exactly the query updateWriteQueue() runs before handing a voucher to
    // generateIRN(). Dropping the company_id term here is the P1 we fixed.
    const reload = async (companyId) => {
      const { rows } = await query(
        `SELECT * FROM vouchers WHERE guid = $1 AND company_id = $2`,
        [sharedVoucherGuid, companyId]
      );
      return rows;
    };
    const a = await reload(companyA.id);
    const b = await reload(companyB.id);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0].voucher_number, 'CA-1');
    assert.equal(b[0].voucher_number, 'CB-1');
    assert.equal(a[0].irn, 'IRN-A-0001');
    assert.equal(b[0].irn, 'IRN-B-0001');

    // The unscoped form would have handed two candidates to the IRP payload.
    const { rows: unscoped } = await query(`SELECT * FROM vouchers WHERE guid = $1`, [sharedVoucherGuid]);
    assert.equal(unscoped.length, 2, 'GUID alone is ambiguous — that is the whole point');
  });

  it('cancelling in workspace A leaves workspace B’s IRN live', async () => {
    if (!ctx) throw new Error('harness required');
    const { status, json } = await httpJson(ctx.baseUrl, 'POST', '/api/einvoice/cancel', {
      token: ctx.fixtures.tokens.ownerA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
      body: { companyGuid: sharedCompanyGuid, voucherGuid: sharedVoucherGuid, cancelReason: 1 },
    });
    assert.equal(status, 200, JSON.stringify(json));

    const { rows } = await query(
      `SELECT company_id, irn_cancelled FROM vouchers WHERE guid = $1 ORDER BY company_id`,
      [sharedVoucherGuid]
    );
    const a = rows.find((r) => Number(r.company_id) === Number(companyA.id));
    const b = rows.find((r) => Number(r.company_id) === Number(companyB.id));
    assert.equal(a.irn_cancelled, true, 'A must be cancelled');
    assert.equal(b.irn_cancelled, false, "B's IRN must survive A's cancel");
  });

  it('workspace B cannot cancel through workspace A’s company row', async () => {
    if (!ctx) throw new Error('harness required');
    const { status } = await httpJson(ctx.baseUrl, 'POST', '/api/einvoice/cancel', {
      token: ctx.fixtures.tokens.memberB.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
      body: { companyGuid: sharedCompanyGuid, voucherGuid: sharedVoucherGuid },
    });
    assert.ok(
      [401, 403, 404].includes(status),
      `cross-workspace cancel must be refused, got ${status}`
    );
  });
});
