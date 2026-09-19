/**
 * Billing / credits — the active workspace owner's wallet pays.
 * Actor, invited-admin wallet, and other workspaces are never the payer.
 */
import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';
import crypto from 'crypto';
import { setupRbacHarness, httpJson } from './harness.js';
import { query } from '../../db/schema.js';
import {
  ensureBillingAccount,
  deductCredits,
  creditWallet,
  fulfillRechargePayment,
  verifyRazorpayCheckoutSignature,
  verifyRazorpayWebhookSignature,
  normalizeCredits,
  createPaymentOrder,
  completePaymentOrder,
  spendForWorkspaceAction,
  resolveWorkspacePayer,
  getBillingOverview,
  getServiceRate,
} from '../../services/billingService.js';
import { createDemoEntry } from '../../services/demoSimulatedEntryService.js';
import { completeOwnershipTransfer, createAdditionalWorkspace } from '../../services/workspaceService.js';
import { unpairDevice } from '../../services/workspacePairingService.js';
import { seedBuiltinRoles } from '../../services/roleService.js';

let ctx;

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

async function debitCount(walletId, reference) {
  const { rows } = await query(
    `SELECT count(*)::int AS n, coalesce(sum(amount),0)::text AS sum
       FROM wallet_transactions WHERE wallet_id = $1 AND reference = $2 AND amount < 0`,
    [walletId, reference]
  );
  return rows[0];
}

describe('Billing credits behaviour', () => {
  it('normalizeCredits rejects float leftovers and accepts integer recharge', () => {
    assert.equal(normalizeCredits(10, { integer: true }), '10');
    assert.equal(normalizeCredits('99', { integer: true }), '99');
    assert.equal(normalizeCredits(100.5, { integer: true }), null);
    assert.equal(normalizeCredits(0.1 + 0.2), '0.30');
    assert.equal(normalizeCredits(0.001), null);
    assert.equal(normalizeCredits(0.1), '0.10');
    assert.equal(normalizeCredits(-1), null);
  });

  it('owner global credits spend once and attribute the workspace', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    await ensureBillingAccount(userId);
    await creditWallet({
      userId,
      amount: 50,
      kind: 'TOPUP',
      reference: `test-fund-${ws}`,
      workspaceId: null,
    });
    const before = await query(
      `SELECT w.balance_credits, w.id FROM wallets w
         JOIN billing_accounts ba ON ba.id = w.billing_account_id
        WHERE ba.owner_user_id = $1`,
      [userId]
    );
    const ref = `op-abc-${Date.now()}`;
    const result = await deductCredits({
      userId,
      amount: 5,
      kind: 'DEBIT',
      reference: ref,
      workspaceId: ws,
      meta: { rateKey: 'TEST' },
    });
    assert.equal(result.alreadyCharged, false);
    const after = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [before.rows[0].id]);
    assert.equal(Number(after.rows[0].balance_credits), Number(before.rows[0].balance_credits) - 5);
    const txn = await query(
      `SELECT workspace_id, amount, kind FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [ref]
    );
    assert.equal(txn.rows[0].workspace_id, ws);
    assert.equal(Number(txn.rows[0].amount), -5);
  });

  it('replaying the same business reference charges once', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    await creditWallet({ userId, amount: 20, kind: 'TOPUP', reference: `idemp-fund-${ws}`, workspaceId: null });
    const ref = `idemp-op-${Date.now()}`;
    const first = await deductCredits({ userId, amount: 3, kind: 'DEBIT', reference: ref, workspaceId: ws });
    const second = await deductCredits({ userId, amount: 3, kind: 'DEBIT', reference: ref, workspaceId: ws });
    const fifth = await deductCredits({ userId, amount: 3, kind: 'DEBIT', reference: ref, workspaceId: ws });
    assert.equal(first.alreadyCharged, false);
    assert.equal(second.alreadyCharged, true);
    assert.equal(fifth.alreadyCharged, true);
    const wallet = await query(
      `SELECT w.id FROM wallets w JOIN billing_accounts ba ON ba.id = w.billing_account_id WHERE ba.owner_user_id = $1`,
      [userId]
    );
    const counts = await debitCount(wallet.rows[0].id, ref);
    assert.equal(counts.n, 1);
  });

  it('20 concurrent spends against a balance of 5 succeed only five times', async () => {
    if (!ctx) throw new Error('harness required');
    const ts = Math.floor(Date.now() / 1000);
    const mobile = `91${String(Date.now()).slice(-10)}`;
    const { rows: u } = await query(
      `INSERT INTO users (mobile, name, created_at, updated_at) VALUES ($1,'Conc Owner',$2,$2) RETURNING id`,
      [mobile, ts]
    );
    const userId = u[0].id;
    const ws = ctx.fixtures.workspaces.A;
    await query(
      `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
       VALUES ($1,$2,$3,'OWNER',NULL,'ACTIVE',$4)`,
      [crypto.randomUUID(), ws, userId, ts]
    ).catch(() => {});
    const billing = await ensureBillingAccount(userId);
    await deductCredits({
      userId,
      amount: 5,
      kind: 'DEBIT',
      reference: `conc-setup-${userId}`,
      workspaceId: ws,
    });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        deductCredits({
          userId,
          amount: 1,
          kind: 'DEBIT',
          reference: `conc-${Date.now()}-${i}`,
          workspaceId: ws,
        })
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.filter((r) => r.status === 'rejected').length;
    assert.equal(ok, 5);
    assert.equal(fail, 15);
    const { rows: after } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(Number(after[0].balance_credits), 0);
  });

  it('workspace B usage does not appear in workspace A history', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const wsA = ctx.fixtures.workspaces.A;
    const wsX = crypto.randomUUID();
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status,
         tally_connection, setup_generation, is_base, created_at, updated_at)
       VALUES ($1,$2,$3,'PERSONAL','ACTIVE','ACTIVE','UNPAIRED',1,FALSE,$4,$4)`,
      [wsX, 'OwnerA XYZ', userId, ts]
    );
    await creditWallet({ userId, amount: 4, kind: 'TOPUP', reference: `hist-${Date.now()}`, workspaceId: null });
    await deductCredits({ userId, amount: 1, kind: 'DEBIT', reference: `use-a-${Date.now()}`, workspaceId: wsA });
    await deductCredits({ userId, amount: 1, kind: 'DEBIT', reference: `use-x-${Date.now()}`, workspaceId: wsX });
    const { listWalletTransactions } = await import('../../services/billingService.js');
    const aRows = await listWalletTransactions(userId, { workspaceId: wsA, limit: 200 });
    assert.ok(aRows.every((r) => r.workspace_id === wsA || r.workspace_id == null));
    assert.ok(!aRows.some((r) => r.workspace_id === wsX && Number(r.amount) < 0));
  });

  it('same company GUID across workspaces does not mix billing attribution', async () => {
    if (!ctx) throw new Error('harness required');
    const guid = ctx.fixtures.companies.A1;
    const userId = ctx.fixtures.users.ownerA.id;
    const wsA = ctx.fixtures.workspaces.A;
    await creditWallet({ userId, amount: 2, kind: 'TOPUP', reference: `guid-${Date.now()}`, workspaceId: null });
    const ref = `guid-op-${Date.now()}`;
    await deductCredits({
      userId,
      amount: 1,
      kind: 'DEBIT',
      reference: ref,
      workspaceId: wsA,
      meta: { companyGuid: guid },
    });
    const { rows } = await query(
      `SELECT workspace_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [ref]
    );
    assert.equal(rows[0].workspace_id, wsA);
    assert.notEqual(rows[0].workspace_id, guid);
  });

  it('Razorpay fulfill is idempotent across five calls and verify/webhook race', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const billing = await ensureBillingAccount(userId);
    const orderId = crypto.randomUUID();
    const providerOrderId = `rzp_order_${orderId.slice(0, 8)}`;
    const providerPaymentId = `rzp_pay_${orderId.slice(0, 8)}`;
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO billing_payment_orders
         (id, billing_account_id, owner_user_id, credits, amount_inr, status, provider, provider_order_id, created_at)
       VALUES ($1,$2,$3,7,7,'PENDING','RAZORPAY',$4,$5)`,
      [orderId, billing.billingAccountId, userId, providerOrderId, ts]
    );
    const { rows: before } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    const runs = await Promise.all([
      fulfillRechargePayment({ providerOrderId, providerPaymentId: `${providerPaymentId}-a` }),
      fulfillRechargePayment({ providerOrderId, providerPaymentId: `${providerPaymentId}-b` }),
      fulfillRechargePayment({ providerOrderId, providerPaymentId }),
      fulfillRechargePayment({ providerOrderId, providerPaymentId }),
      fulfillRechargePayment({ providerOrderId, providerPaymentId }),
    ]);
    const granted = runs.filter((r) => !r.alreadyFulfilled);
    assert.equal(granted.length, 1);
    const { rows: after } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(Number(after[0].balance_credits), Number(before[0].balance_credits) + 7);
    const { rows: txns } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE reference = $1 AND amount > 0`,
      [orderId]
    );
    assert.equal(txns[0].n, 1);
  });

  it('invalid signatures and failed payments grant zero credits', async () => {
    process.env.RAZORPAY_KEY_SECRET = 'test-secret';
    process.env.RAZORPAY_WEBHOOK_SECRET = 'wh-secret';
    assert.equal(
      verifyRazorpayCheckoutSignature({ orderId: 'o', paymentId: 'p', signature: 'nope' }),
      false
    );
    const raw = Buffer.from('{"event":"payment.captured"}');
    assert.equal(verifyRazorpayWebhookSignature(raw, 'nope'), false);
    const good = crypto.createHmac('sha256', 'wh-secret').update(raw).digest('hex');
    assert.equal(verifyRazorpayWebhookSignature(raw, good), true);
    const userId = ctx.fixtures.users.ownerA.id;
    const billing = await ensureBillingAccount(userId);
    const { rows: before } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    await assert.rejects(
      () => fulfillRechargePayment({ providerOrderId: 'does-not-exist', providerPaymentId: 'x' }),
      (e) => e.code === 'ORDER_NOT_FOUND'
    );
    const { rows: after } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(String(after[0].balance_credits), String(before[0].balance_credits));
  });

  it('manual complete is claimed once; client amountInr is ignored', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const order = await createPaymentOrder({
      userId,
      credits: 3,
      amountInr: 99999,
    });
    assert.equal(Number(order.amount_inr), 3);
    const a = await completePaymentOrder(userId, order.id);
    const b = await completePaymentOrder(userId, order.id);
    assert.equal(b.alreadyFulfilled, true);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE reference = $1 AND amount > 0`,
      [order.id]
    );
    assert.equal(rows[0].n, 1);
    void a;
  });

  it('Demo simulated entries do not write wallet_transactions', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    const { rows: before } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    await createDemoEntry({
      userId,
      workspaceId: ws,
      companyId: null,
      entryType: 'sales_invoice',
      payload: { test: true },
    }).catch(() => {});
    const { rows: after } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    assert.equal(after[0].n, before[0].n);
  });

  it('member cannot recharge (403, no credit change)', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const billing = await ensureBillingAccount(userId);
    const { rows: before } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    const res = await httpJson(ctx.baseUrl, 'POST', '/api/billing/recharge/create', {
      token: ctx.fixtures.tokens.memberA.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
      body: { credits: 10 },
    });
    assert.ok(res.status === 403 || res.status === 401);
    const { rows: after } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(String(after[0].balance_credits), String(before[0].balance_credits));
  });

  it('usage deduct without workspace_id is refused', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    await assert.rejects(
      () => deductCredits({ userId, amount: 1, kind: 'DEBIT', reference: `nows-${Date.now()}` }),
      (e) => e.code === 'BILLING_WORKSPACE_REQUIRED'
    );
  });
});

async function insertFreshUser(name) {
  const ts = Math.floor(Date.now() / 1000);
  const mobile = `91${String(Date.now()).slice(-10)}${Math.floor(Math.random() * 90 + 10)}`;
  const { rows } = await query(
    `INSERT INTO users (mobile, name, created_at, updated_at) VALUES ($1,$2,$3,$3) RETURNING id`,
    [mobile, name, ts]
  );
  return rows[0].id;
}

async function insertWorkspace(ownerUserId, name, { isBase = false } = {}) {
  const id = crypto.randomUUID();
  const ts = Math.floor(Date.now() / 1000);
  await query(
    `INSERT INTO workspaces (id, name, owner_user_id, workspace_type, lifecycle_status, commercial_status,
       tally_connection, setup_generation, is_base, created_at, updated_at)
     VALUES ($1,$2,$3,'PERSONAL','ACTIVE','ACTIVE','UNPAIRED',1,$4,$5,$5)`,
    [id, name, ownerUserId, isBase, ts]
  );
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,'OWNER',NULL,'ACTIVE',$4)`,
    [crypto.randomUUID(), id, ownerUserId, ts]
  );
  await seedBuiltinRoles(id).catch(() => {});
  return id;
}

async function addMember(workspaceId, userId, systemKey) {
  const ts = Math.floor(Date.now() / 1000);
  const { rows: roles } = await query(
    `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = $2 LIMIT 1`,
    [workspaceId, systemKey]
  );
  await query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
     VALUES ($1,$2,$3,'MEMBER',$4,'ACTIVE',$5)`,
    [crypto.randomUUID(), workspaceId, userId, roles[0]?.id || null, ts]
  );
}

async function walletState(userId) {
  const billing = await ensureBillingAccount(userId);
  const { rows } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
  return { walletId: billing.walletId, balance: Number(rows[0].balance_credits) };
}

async function topUpBy(userId, amount) {
  await creditWallet({
    userId,
    amount,
    kind: 'TOPUP',
    reference: `top-${userId}-${amount}-${crypto.randomUUID()}`,
    workspaceId: null,
  });
}

describe('Billing payer authority', () => {
  it('A. owner acting in own workspace charges that owner wallet', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Owner ABC');
    const abc = await insertWorkspace(owner, 'ABC own');
    await topUpBy(owner, 90);
    const before = await walletState(owner);
    const result = await spendForWorkspaceAction({
      workspaceId: abc,
      actorUserId: owner,
      operationId: `own-${abc}`,
      amount: 5,
      kind: 'DEBIT',
    });
    assert.equal(result.alreadyCharged, false);
    assert.equal(result.payerUserId, owner);
    const after = await walletState(owner);
    assert.equal(after.balance, before.balance - 5);
    const { rows } = await query(
      `SELECT wallet_id, workspace_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [`own-${abc}`]
    );
    assert.equal(rows[0].wallet_id, before.walletId);
    assert.equal(rows[0].workspace_id, abc);
  });

  it('B. invited Admin in XYZ charges XYZ owner, not the Admin wallet', async () => {
    if (!ctx) throw new Error('harness required');
    const ownerX = await insertFreshUser('Owner X');
    const ownerA = await insertFreshUser('Owner A');
    const xyz = await insertWorkspace(ownerX, 'XYZ');
    const abc = await insertWorkspace(ownerA, 'ABC');
    await topUpBy(ownerX, 90);
    await addMember(xyz, ownerA, 'ADMIN');
    const xBefore = await walletState(ownerX);
    const aBefore = await walletState(ownerA);
    assert.equal(xBefore.balance, 100);
    assert.equal(aBefore.balance, 10);
    const result = await spendForWorkspaceAction({
      workspaceId: xyz,
      actorUserId: ownerA,
      ownerUserId: ownerA,
      operationId: `invited-${xyz}`,
      amount: 5,
      kind: 'DEBIT',
      meta: { companyGuid: abc },
    });
    assert.equal(result.payerUserId, ownerX);
    const xAfter = await walletState(ownerX);
    const aAfter = await walletState(ownerA);
    assert.equal(xAfter.balance, 95);
    assert.equal(aAfter.balance, 10);
    const { rows } = await query(
      `SELECT wallet_id, workspace_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [`invited-${xyz}`]
    );
    assert.equal(rows[0].wallet_id, xBefore.walletId);
    assert.equal(rows[0].workspace_id, xyz);
    void abc;
  });

  it('C. invited Admin cannot rescue an insufficient workspace owner', async () => {
    if (!ctx) throw new Error('harness required');
    const ownerX = await insertFreshUser('Poor X');
    const ownerA = await insertFreshUser('Rich A');
    const xyz = await insertWorkspace(ownerX, 'XYZ poor');
    await insertWorkspace(ownerA, 'ABC rich');
    await deductCredits({
      userId: ownerX,
      amount: 8,
      kind: 'DEBIT',
      reference: `down-x-${xyz}`,
      workspaceId: xyz,
    });
    await topUpBy(ownerA, 90);
    await addMember(xyz, ownerA, 'ADMIN');
    const xBefore = await walletState(ownerX);
    const aBefore = await walletState(ownerA);
    assert.equal(xBefore.balance, 2);
    assert.equal(aBefore.balance, 100);
    await assert.rejects(
      () => spendForWorkspaceAction({
        workspaceId: xyz,
        actorUserId: ownerA,
        ownerUserId: ownerA,
        operationId: `rescue-${xyz}`,
        amount: 5,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'INSUFFICIENT_CREDITS'
    );
    assert.equal((await walletState(ownerX)).balance, 2);
    assert.equal((await walletState(ownerA)).balance, 100);
  });

  it('D. same owner ABC+XYZ share one wallet with correct workspace_id', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Multi Owner');
    const abc = await insertWorkspace(owner, 'ABC multi');
    const xyz = await insertWorkspace(owner, 'XYZ multi');
    const before = await walletState(owner);
    assert.equal(before.balance, 10);
    await spendForWorkspaceAction({
      workspaceId: abc, actorUserId: owner, operationId: `multi-abc-${abc}`, amount: 3, kind: 'DEBIT',
    });
    await spendForWorkspaceAction({
      workspaceId: xyz, actorUserId: owner, operationId: `multi-xyz-${xyz}`, amount: 4, kind: 'DEBIT',
    });
    assert.equal((await walletState(owner)).balance, 3);
    const abcTxn = await query(
      `SELECT wallet_id, workspace_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [`multi-abc-${abc}`]
    );
    const xyzTxn = await query(
      `SELECT wallet_id, workspace_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [`multi-xyz-${xyz}`]
    );
    assert.equal(abcTxn.rows[0].wallet_id, before.walletId);
    assert.equal(xyzTxn.rows[0].wallet_id, before.walletId);
    assert.equal(abcTxn.rows[0].workspace_id, abc);
    assert.equal(xyzTxn.rows[0].workspace_id, xyz);
  });

  it('E. different owners stay isolated under concurrency', async () => {
    if (!ctx) throw new Error('harness required');
    const ownerA = await insertFreshUser('Iso A');
    const ownerX = await insertFreshUser('Iso X');
    const abc = await insertWorkspace(ownerA, 'ABC iso');
    const xyz = await insertWorkspace(ownerX, 'XYZ iso');
    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => spendForWorkspaceAction({
        workspaceId: abc, actorUserId: ownerA, operationId: `iso-a-${abc}-${i}`, amount: 1, kind: 'DEBIT',
      })),
      ...Array.from({ length: 10 }, (_, i) => spendForWorkspaceAction({
        workspaceId: xyz, actorUserId: ownerX, operationId: `iso-x-${xyz}-${i}`, amount: 1, kind: 'DEBIT',
      })),
    ]);
    const aOk = results.slice(0, 10).filter((r) => r.status === 'fulfilled').length;
    const xOk = results.slice(10).filter((r) => r.status === 'fulfilled').length;
    assert.equal(aOk, 10);
    assert.equal(xOk, 10);
    assert.equal((await walletState(ownerA)).balance, 0);
    assert.equal((await walletState(ownerX)).balance, 0);
  });

  it('F. same company GUID does not change payer', async () => {
    if (!ctx) throw new Error('harness required');
    const ownerA = await insertFreshUser('GUID A');
    const ownerZ = await insertFreshUser('GUID Z');
    const abc = await insertWorkspace(ownerA, 'ABC guid');
    const xyz = await insertWorkspace(ownerZ, 'XYZ guid');
    const guid = `same-guid-${abc.slice(0, 8)}`;
    await spendForWorkspaceAction({
      workspaceId: abc, actorUserId: ownerA, operationId: `g-abc-${abc}`, amount: 2, kind: 'DEBIT', meta: { companyGuid: guid },
    });
    await spendForWorkspaceAction({
      workspaceId: xyz, actorUserId: ownerZ, operationId: `g-xyz-${xyz}`, amount: 2, kind: 'DEBIT', meta: { companyGuid: guid },
    });
    const payerA = await resolveWorkspacePayer(abc);
    const payerZ = await resolveWorkspacePayer(xyz);
    assert.equal(payerA.ownerUserId, ownerA);
    assert.equal(payerZ.ownerUserId, ownerZ);
    const { rows: aTxn } = await query(
      `SELECT wallet_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`, [`g-abc-${abc}`]
    );
    const { rows: zTxn } = await query(
      `SELECT wallet_id FROM wallet_transactions WHERE reference = $1 AND amount < 0`, [`g-xyz-${xyz}`]
    );
    assert.equal(aTxn[0].wallet_id, payerA.wallet.id);
    assert.equal(zTxn[0].wallet_id, payerZ.wallet.id);
  });

  it('G. role authorizes only — viewer cannot spend via seat purchase', async () => {
    if (!ctx) throw new Error('harness required');
    const ws = ctx.fixtures.workspaces.A;
    const billing = await ensureBillingAccount(ctx.fixtures.users.ownerA.id);
    const { rows: before } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    const res = await httpJson(ctx.baseUrl, 'POST', `/api/workspaces/${ws}/seats`, {
      token: ctx.fixtures.tokens.memberA.accessToken,
      headers: { 'X-Workspace-Id': ws },
      body: {},
    });
    assert.ok(res.status === 403 || res.status === 401);
    const { rows: after } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(String(after[0].balance_credits), String(before[0].balance_credits));
  });

  it('H/I. transfer changes future payer; replay does not charge the new owner', async () => {
    if (!ctx) throw new Error('harness required');
    const fromId = await insertFreshUser('From Payer');
    const toId = await insertFreshUser('To Payer');
    const abc = await insertWorkspace(fromId, 'ABC xfer', { isBase: false });
    await addMember(abc, toId, 'ADMIN');
    await topUpBy(fromId, 90);
    await topUpBy(toId, 90);
    const op = `xfer-op-${abc}`;
    const first = await spendForWorkspaceAction({
      workspaceId: abc, actorUserId: fromId, operationId: op, amount: 5, kind: 'DEBIT',
    });
    assert.equal(first.alreadyCharged, false);
    const fromBefore = await walletState(fromId);
    const toBefore = await walletState(toId);
    const ts = Math.floor(Date.now() / 1000);
    const { rows: viewer } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'VIEWER' LIMIT 1`,
      [abc]
    );
    const transferId = crypto.randomUUID();
    await query(
      `INSERT INTO workspace_ownership_transfers
         (id, workspace_id, from_user_id, target_user_id, outgoing_role_id, status, grace_ends_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING_GRACE',$6,$6,$6)`,
      [transferId, abc, fromId, toId, viewer[0]?.id || null, ts - 10]
    );
    await completeOwnershipTransfer(fromId, abc, transferId, { system: true });
    const replay = await spendForWorkspaceAction({
      workspaceId: abc, actorUserId: toId, operationId: op, amount: 5, kind: 'DEBIT',
    });
    assert.equal(replay.alreadyCharged, true);
    assert.equal((await walletState(fromId)).balance, fromBefore.balance);
    assert.equal((await walletState(toId)).balance, toBefore.balance);
    const later = await spendForWorkspaceAction({
      workspaceId: abc, actorUserId: toId, operationId: `after-xfer-${abc}`, amount: 3, kind: 'DEBIT',
    });
    assert.equal(later.alreadyCharged, false);
    assert.equal(later.payerUserId, toId);
    assert.equal((await walletState(toId)).balance, toBefore.balance - 3);
    assert.equal((await walletState(fromId)).balance, fromBefore.balance);
  });

  it('J. Demo writes no billing rows', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    const before = await walletState(userId);
    const { rows: txnBefore } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    await createDemoEntry({
      userId,
      workspaceId: ws,
      companyId: null,
      entryType: 'sales_invoice',
      payload: { test: true },
    }).catch(() => {});
    assert.equal((await walletState(userId)).balance, before.balance);
    const { rows: txnAfter } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    assert.equal(txnAfter[0].n, txnBefore[0].n);
  });

  it('K. same-owner two-workspace concurrency never goes negative', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Conc Multi');
    const abc = await insertWorkspace(owner, 'ABC conc');
    const xyz = await insertWorkspace(owner, 'XYZ conc');
    const results = await Promise.allSettled([
      ...Array.from({ length: 10 }, (_, i) => spendForWorkspaceAction({
        workspaceId: abc, actorUserId: owner, operationId: `cm-abc-${abc}-${i}`, amount: 1, kind: 'DEBIT',
      })),
      ...Array.from({ length: 10 }, (_, i) => spendForWorkspaceAction({
        workspaceId: xyz, actorUserId: owner, operationId: `cm-xyz-${xyz}-${i}`, amount: 1, kind: 'DEBIT',
      })),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(ok, 10);
    assert.equal((await walletState(owner)).balance, 0);
    const { rows: abcRows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE workspace_id = $1 AND amount < 0 AND reference LIKE $2`,
      [abc, `cm-abc-${abc}-%`]
    );
    const { rows: xyzRows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE workspace_id = $1 AND amount < 0 AND reference LIKE $2`,
      [xyz, `cm-xyz-${xyz}-%`]
    );
    assert.equal(abcRows[0].n + xyzRows[0].n, 10);
  });

  it('L. Razorpay still funds the owner wallet only', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Rzp Owner');
    await insertWorkspace(owner, 'ABC rzp');
    const billing = await ensureBillingAccount(owner);
    const order = await createPaymentOrder({ userId: owner, credits: 4, amountInr: 999 });
    assert.equal(Number(order.amount_inr), 4);
    await completePaymentOrder(owner, order.id);
    const after = await walletState(owner);
    assert.equal(after.balance, 14);
    assert.equal(after.walletId, billing.walletId);
  });

  it('M. historical CREDIT rows stay workspace_id NULL', async () => {
    if (!ctx) throw new Error('harness required');
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE kind = 'CREDIT' AND workspace_id IS NOT NULL`
    );
    assert.equal(rows[0].n, 0);
  });

  it('unpair does not change the owner wallet', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Unpair Owner');
    const abc = await insertWorkspace(owner, 'ABC unpair');
    const before = await walletState(owner);
    const deviceId = `dev-auth-${abc.slice(0, 8)}`;
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO devices (device_id, name, paired, workspace_id, binding_status, last_seen, created_at)
       VALUES ($1,'Desk 1',TRUE,$2,'ACTIVE',$3,$3)`,
      [deviceId, abc, ts]
    );
    await unpairDevice(deviceId, owner);
    assert.equal((await walletState(owner)).balance, before.balance);
  });

  it('overview has no workspaceCredits pot', async () => {
    if (!ctx) throw new Error('harness required');
    const overview = await getBillingOverview(ctx.fixtures.users.ownerA.id);
    assert.equal(overview.workspaceCredits, undefined);
  });

  it('IDOR: Owner B cannot read Owner A billing via Workspace A header', async () => {
    if (!ctx) throw new Error('harness required');
    const res = await httpJson(ctx.baseUrl, 'GET', '/api/billing/overview', {
      token: ctx.fixtures.tokens.ownerB.accessToken,
      headers: { 'X-Workspace-Id': ctx.fixtures.workspaces.A },
    });
    assert.ok(res.status === 403 || res.status === 404);
  });

  it('client-supplied ownerUserId cannot redirect the payer', async () => {
    if (!ctx) throw new Error('harness required');
    const ownerX = await insertFreshUser('Trust X');
    const ownerA = await insertFreshUser('Trust A');
    const xyz = await insertWorkspace(ownerX, 'XYZ trust');
    await insertWorkspace(ownerA, 'ABC trust');
    await topUpBy(ownerA, 90);
    const payer = await resolveWorkspacePayer(xyz);
    assert.equal(payer.ownerUserId, ownerX);
    assert.notEqual(payer.ownerUserId, ownerA);
    await spendForWorkspaceAction({
      workspaceId: xyz,
      actorUserId: ownerA,
      ownerUserId: ownerA,
      operationId: `trust-${xyz}`,
      amount: 2,
      kind: 'DEBIT',
    });
    assert.equal((await walletState(ownerA)).balance, 100);
    assert.equal((await walletState(ownerX)).balance, 8);
  });

  it('createAdditionalWorkspace charges the creator owner wallet in the same transaction', async () => {
    if (!ctx) throw new Error('harness required');
    const owner = await insertFreshUser('Paid WS Owner');
    await insertWorkspace(owner, 'ABC base', { isBase: true });
    const rate = await getServiceRate('ADDITIONAL_WORKSPACE');
    const cost = rate ? Number(rate.credits) : 1000;
    await topUpBy(owner, cost);
    const before = await walletState(owner);
    const ws = await createAdditionalWorkspace(owner, 'Paid extra');
    assert.ok(ws?.id);
    assert.equal(ws.owner_user_id, owner);
    assert.equal(ws.is_base, false);
    const after = await walletState(owner);
    assert.equal(after.balance, before.balance - cost);
    const { rows } = await query(
      `SELECT wallet_id, workspace_id, kind FROM wallet_transactions
        WHERE reference = $1 AND amount < 0`,
      [ws.id]
    );
    assert.equal(rows[0].wallet_id, before.walletId);
    assert.equal(rows[0].workspace_id, ws.id);
    assert.equal(rows[0].kind, 'ADDITIONAL_WORKSPACE');
  });
});

