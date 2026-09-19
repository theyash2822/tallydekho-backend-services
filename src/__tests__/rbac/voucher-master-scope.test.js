/**
 * Voucher master references against real cross-company data.
 *
 * Voucher bodies name their masters as free text. Two companies routinely hold
 * a ledger, item or godown with the same name, so "Customer X" is only an
 * answer once you say which company is asking. Before the resolver, every
 * create path except Credit and Debit Note passed those strings into Tally XML
 * after a company-access check and nothing else.
 *
 * These are live-row assertions, not source patterns: the fixtures build two
 * companies that share a Tally GUID and share master names, then prove the
 * resolver answers for exactly one of them.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import { query } from '../../db/schema.js';
import { setupRbacHarness } from './harness.js';
import {
  assertVoucherReferences,
  VoucherReferenceError,
} from '../../services/voucherReferenceResolver.js';

let ctx;
let companyA;
let companyB;
let sharedCompanyGuid;

const ts = () => Math.floor(Date.now() / 1000);

/** Same name in both companies — the collision the resolver has to survive. */
const SHARED_LEDGER = 'Customer X';
const SHARED_STOCK = 'Widget';
const SHARED_GODOWN = 'Main Location';
const SHARED_UNIT = 'Nos';
/** Present only in B. A must never accept it. */
const ONLY_IN_B_LEDGER = 'Supplier Y';

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

  sharedCompanyGuid = `vms-co-${ctx.fixtures.suffix}`;

  const insCompany = async (workspaceId, name) => {
    const { rows } = await query(
      `INSERT INTO companies (guid, workspace_id, name, formal_name, is_active, synced_at, created_at)
       VALUES ($1,$2,$3,$3,TRUE,$4,$4)
       ON CONFLICT (workspace_id, guid) DO UPDATE SET is_active = TRUE
       RETURNING id, guid, workspace_id`,
      [sharedCompanyGuid, workspaceId, name, ts()]
    );
    return rows[0];
  };
  companyA = await insCompany(ctx.fixtures.workspaces.A, 'Masters A');
  companyB = await insCompany(ctx.fixtures.workspaces.B, 'Masters B');
  assert.notEqual(Number(companyA.id), Number(companyB.id));

  const addLedger = (companyId, name) =>
    query(
      `INSERT INTO ledgers (guid, company_guid, company_id, name, parent, synced_at)
       VALUES ($1,$2,$3,$4,'Sundry Debtors',$5)
       ON CONFLICT DO NOTHING`,
      [`vms-led-${companyId}-${name}`, sharedCompanyGuid, companyId, name, ts()]
    );
  const addStock = (companyId, name) =>
    query(
      `INSERT INTO stocks (guid, company_guid, company_id, name, unit, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING`,
      [`vms-stk-${companyId}-${name}`, sharedCompanyGuid, companyId, name, SHARED_UNIT, ts()]
    );
  const addGodown = (companyId, name) =>
    query(
      `INSERT INTO warehouses (guid, company_guid, company_id, name, synced_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [`vms-gdn-${companyId}-${name}`, sharedCompanyGuid, companyId, name, ts()]
    );
  const addUnit = (companyId, name) =>
    query(
      `INSERT INTO units (guid, company_guid, company_id, name, synced_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT DO NOTHING`,
      [`vms-unt-${companyId}-${name}`, sharedCompanyGuid, companyId, name, ts()]
    );

  for (const company of [companyA, companyB]) {
    await addLedger(company.id, SHARED_LEDGER);
    await addStock(company.id, SHARED_STOCK);
    await addGodown(company.id, SHARED_GODOWN);
    await addUnit(company.id, SHARED_UNIT);
  }
  // B alone carries this one.
  await addLedger(companyB.id, ONLY_IN_B_LEDGER);
});

after(async () => {
  if (ctx?.teardown) await ctx.teardown();
});

describe('Voucher master references are company scoped', () => {
  it('the fixture really is a collision: same guid, same names, two company ids', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows: cos } = await query(
      `SELECT id, workspace_id FROM companies WHERE guid = $1 ORDER BY id`,
      [sharedCompanyGuid]
    );
    assert.equal(cos.length, 2, 'both workspaces must hold the same company GUID');
    assert.notEqual(cos[0].workspace_id, cos[1].workspace_id);

    const { rows: leds } = await query(
      `SELECT company_id FROM ledgers WHERE LOWER(name) = LOWER($1) AND company_id = ANY($2::bigint[])`,
      [SHARED_LEDGER, [companyA.id, companyB.id]]
    );
    assert.equal(leds.length, 2, 'both companies must hold a ledger with the same name');
  });

  it('a shared name resolves inside each company on its own', async () => {
    if (!ctx) throw new Error('harness required');
    for (const company of [companyA, companyB]) {
      const result = await assertVoucherReferences(company.id, [
        { kind: 'ledger', role: 'party', value: SHARED_LEDGER },
        { kind: 'stock', value: SHARED_STOCK },
        { kind: 'godown', value: SHARED_GODOWN },
        { kind: 'unit', value: SHARED_UNIT },
      ]);
      assert.equal(result.skippedKinds.length, 0, 'these companies have masters, nothing may be skipped');
      assert.equal(result.checked, 4);
    }
  });

  it("company A cannot use a party ledger that exists only in company B", async () => {
    if (!ctx) throw new Error('harness required');
    await assert.rejects(
      () => assertVoucherReferences(companyA.id, [
        { kind: 'ledger', role: 'party', value: ONLY_IN_B_LEDGER },
      ]),
      (err) => {
        assert.ok(err instanceof VoucherReferenceError);
        assert.equal(err.code, 'PARTY_LEDGER_NOT_FOUND');
        assert.equal(err.httpStatus, 422);
        assert.deepEqual(err.details.missing, [ONLY_IN_B_LEDGER]);
        return true;
      }
    );
    // …and it is genuinely B's, not a name nobody has.
    await assertVoucherReferences(companyB.id, [
      { kind: 'ledger', role: 'party', value: ONLY_IN_B_LEDGER },
    ]);
  });

  it('a non-party ledger miss reports LEDGER_NOT_FOUND', async () => {
    if (!ctx) throw new Error('harness required');
    await assert.rejects(
      () => assertVoucherReferences(companyA.id, [{ kind: 'ledger', value: ONLY_IN_B_LEDGER }]),
      (err) => err.code === 'LEDGER_NOT_FOUND' && err.httpStatus === 422
    );
  });

  it('stock, godown and unit each report their own error code', async () => {
    if (!ctx) throw new Error('harness required');
    const cases = [
      ['stock', 'STOCK_ITEM_NOT_FOUND'],
      ['godown', 'GODOWN_NOT_FOUND'],
      ['unit', 'UNIT_NOT_FOUND'],
    ];
    for (const [kind, code] of cases) {
      await assert.rejects(
        () => assertVoucherReferences(companyA.id, [{ kind, value: 'nothing-by-this-name' }]),
        (err) => {
          assert.equal(err.code, code, `${kind} should report ${code}`);
          return true;
        }
      );
    }
  });

  it('names match case-insensitively, the way Tally treats them', async () => {
    if (!ctx) throw new Error('harness required');
    await assertVoucherReferences(companyA.id, [
      { kind: 'ledger', value: SHARED_LEDGER.toUpperCase() },
      { kind: 'stock', value: SHARED_STOCK.toLowerCase() },
    ]);
  });

  it('blank and absent references are not checked', async () => {
    if (!ctx) throw new Error('harness required');
    const result = await assertVoucherReferences(companyA.id, [
      { kind: 'ledger', value: '' },
      { kind: 'godown', value: null },
      { kind: 'unit', value: undefined },
      { kind: 'stock', value: '   ' },
    ]);
    assert.equal(result.checked, 0);
  });

  it('a company with no masters of that kind is skipped rather than blocked', async () => {
    if (!ctx) throw new Error('harness required');
    // Nothing has ever written a cost centre for these companies.
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM cost_centres WHERE company_id = $1`,
      [companyA.id]
    );
    assert.equal(rows[0].n, 0, 'fixture expects no cost centres for company A');

    const result = await assertVoucherReferences(companyA.id, [
      { kind: 'costCentre', value: 'Some Cost Centre' },
    ]);
    assert.deepEqual(result.skippedKinds, ['costCentre']);
  });

  it('an unresolved company is refused outright', async () => {
    await assert.rejects(
      () => assertVoucherReferences(undefined, [{ kind: 'ledger', value: SHARED_LEDGER }]),
      (err) => err.code === 'COMPANY_NOT_RESOLVED'
    );
  });
});
