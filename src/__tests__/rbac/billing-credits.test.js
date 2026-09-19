/**
 * Billing / credits — owner wallet + workspace-restricted lots.
 *
 * Owner spend remains wallets.balance_credits. Workspace spend consumes
 * credit_lots.workspace_id rows. Mixed/split funding is policy-blocked.
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
  grantWorkspaceCredits,
  spendForWorkspaceAction,
  workspaceAvailableCredits,
  getBillingOverview,
} from '../../services/billingService.js';
import { createDemoEntry } from '../../services/demoSimulatedEntryService.js';
import { completeOwnershipTransfer } from '../../services/workspaceService.js';
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
    await query(`UPDATE wallets SET balance_credits = 5 WHERE id = $1`, [billing.walletId]);
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

async function zeroOwnerWallet(userId) {
  const billing = await ensureBillingAccount(userId);
  await query(`UPDATE wallets SET balance_credits = 0 WHERE id = $1`, [billing.walletId]);
  return billing;
}

describe('Workspace-specific credits', () => {
  it('workspace-only credits spend inside ABC and are denied in XYZ', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('WS Only Owner');
    const abc = await insertWorkspace(userId, 'ABC pot');
    const xyz = await insertWorkspace(userId, 'XYZ empty');
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 10, reference: `grant-abc-${abc}` });
    for (let i = 0; i < 3; i += 1) {
      const result = await spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: abc,
        operationId: `abc-op-${abc}-${i}`,
        amount: 3,
        kind: 'DEBIT',
      });
      assert.equal(result.fundingSource, 'WORKSPACE');
      assert.equal(result.alreadyCharged, false);
    }
    assert.equal(await workspaceAvailableCredits(abc), 1);
    const owner = await query(
      `SELECT w.balance_credits FROM wallets w
         JOIN billing_accounts ba ON ba.id = w.billing_account_id
        WHERE ba.owner_user_id = $1`,
      [userId]
    );
    assert.equal(Number(owner.rows[0].balance_credits), 0);
    const { rows: spends } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions
        WHERE workspace_id = $1 AND amount < 0 AND funding_source = 'WORKSPACE'`,
      [abc]
    );
    assert.equal(spends[0].n, 3);
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: xyz,
        operationId: `xyz-op-${xyz}`,
        amount: 3,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'INSUFFICIENT_CREDITS'
    );
    assert.equal(await workspaceAvailableCredits(abc), 1);
  });

  it('owner-only credits fund ABC usage with OWNER_GLOBAL source', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Owner Only');
    const abc = await insertWorkspace(userId, 'ABC owner-only');
    const billing = await zeroOwnerWallet(userId);
    await query(`UPDATE wallets SET balance_credits = 10 WHERE id = $1`, [billing.walletId]);
    const result = await spendForWorkspaceAction({
      ownerUserId: userId,
      workspaceId: abc,
      operationId: `owner-only-${abc}`,
      amount: 4,
      kind: 'DEBIT',
    });
    assert.equal(result.fundingSource, 'OWNER_GLOBAL');
    const { rows: txn } = await query(
      `SELECT workspace_id, funding_source, amount FROM wallet_transactions
        WHERE reference = $1 AND amount < 0`,
      [`owner-only-${abc}`]
    );
    assert.equal(txn[0].workspace_id, abc);
    assert.equal(txn[0].funding_source, 'OWNER_GLOBAL');
    assert.equal(await workspaceAvailableCredits(abc), 0);
  });

  it('blocks when both pots can cover — MIXED_FUNDING_PRIORITY_UNDEFINED', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Mixed Owner');
    const abc = await insertWorkspace(userId, 'ABC mixed');
    const billing = await zeroOwnerWallet(userId);
    await query(`UPDATE wallets SET balance_credits = 100 WHERE id = $1`, [billing.walletId]);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 20, reference: `mixed-grant-${abc}` });
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: abc,
        operationId: `mixed-${abc}`,
        amount: 5,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'MIXED_FUNDING_PRIORITY_UNDEFINED'
    );
    assert.equal(await workspaceAvailableCredits(abc), 20);
    const { rows } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(Number(rows[0].balance_credits), 100);
  });

  it('blocks partial pots — no 4+6 split', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Partial Owner');
    const abc = await insertWorkspace(userId, 'ABC partial');
    const billing = await zeroOwnerWallet(userId);
    await query(`UPDATE wallets SET balance_credits = 20 WHERE id = $1`, [billing.walletId]);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 4, reference: `partial-grant-${abc}` });
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: abc,
        operationId: `partial-${abc}`,
        amount: 10,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'MIXED_FUNDING_PRIORITY_UNDEFINED'
    );
    assert.equal(await workspaceAvailableCredits(abc), 4);
    const { rows } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(Number(rows[0].balance_credits), 20);
  });

  it('blocks split when neither pot alone covers', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Split Owner');
    const abc = await insertWorkspace(userId, 'ABC split');
    const billing = await zeroOwnerWallet(userId);
    await query(`UPDATE wallets SET balance_credits = 4 WHERE id = $1`, [billing.walletId]);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 4, reference: `split-grant-${abc}` });
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: abc,
        operationId: `split-${abc}`,
        amount: 6,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'SPLIT_FUNDING_RULE_UNDEFINED'
    );
  });

  it('XYZ cannot consume ABC workspace credits', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Cross WS Owner');
    const abc = await insertWorkspace(userId, 'ABC isolated');
    const xyz = await insertWorkspace(userId, 'XYZ isolated');
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 100, reference: `iso-abc-${abc}` });
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: xyz,
        operationId: `iso-xyz-${xyz}`,
        amount: 1,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'INSUFFICIENT_CREDITS'
    );
    assert.equal(await workspaceAvailableCredits(abc), 100);
  });

  it('same company GUID does not mix workspace credit pots', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('GUID Owner');
    const abc = await insertWorkspace(userId, 'ABC guid');
    const xyz = await insertWorkspace(userId, 'XYZ guid');
    const guid = `shared-guid-${abc.slice(0, 8)}`;
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 8, reference: `guid-abc-${abc}` });
    await spendForWorkspaceAction({
      ownerUserId: userId,
      workspaceId: abc,
      operationId: `guid-spend-${abc}`,
      amount: 2,
      kind: 'DEBIT',
      meta: { companyGuid: guid },
    });
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: xyz,
        operationId: `guid-spend-${xyz}`,
        amount: 2,
        kind: 'DEBIT',
        meta: { companyGuid: guid },
      }),
      (e) => e.code === 'INSUFFICIENT_CREDITS'
    );
    assert.equal(await workspaceAvailableCredits(abc), 6);
  });

  it('XYZ cannot consume ABC lots while owner wallet stays atomic', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Dual Conc');
    const abc = await insertWorkspace(userId, 'ABC dual');
    const xyz = await insertWorkspace(userId, 'XYZ dual');
    const billing = await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 5, reference: `dual-abc-${abc}` });
    await query(`UPDATE wallets SET balance_credits = 4 WHERE id = $1`, [billing.walletId]);
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        spendForWorkspaceAction({
          ownerUserId: userId,
          workspaceId: xyz,
          operationId: `dual-xyz-${xyz}-${i}`,
          amount: 1,
          kind: 'DEBIT',
        })
      )
    );
    const xyzOk = results.filter((r) => r.status === 'fulfilled').length;
    assert.equal(xyzOk, 4);
    assert.equal(await workspaceAvailableCredits(abc), 5);
    const { rows } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(Number(rows[0].balance_credits), 0);
    await assert.rejects(
      () => spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: xyz,
        operationId: `dual-xyz-after-${xyz}`,
        amount: 1,
        kind: 'DEBIT',
      }),
      (e) => e.code === 'INSUFFICIENT_CREDITS'
    );
  });

  it('20 concurrent workspace spends against 5 credits succeed five times', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('WS Conc');
    const abc = await insertWorkspace(userId, 'ABC conc');
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 5, reference: `conc-grant-${abc}` });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        spendForWorkspaceAction({
          ownerUserId: userId,
          workspaceId: abc,
          operationId: `ws-conc-${abc}-${i}`,
          amount: 1,
          kind: 'DEBIT',
        })
      )
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const fail = results.filter((r) => r.status === 'rejected').length;
    assert.equal(ok, 5);
    assert.equal(fail, 15);
    assert.equal(await workspaceAvailableCredits(abc), 0);
    const { rows } = await query(
      `SELECT coalesce(min(credits_remaining),0)::text AS m FROM credit_lots WHERE workspace_id = $1`,
      [abc]
    );
    assert.ok(Number(rows[0].m) >= 0);
  });

  it('workspace and owner replay keep the original funding source', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Replay Owner');
    const abc = await insertWorkspace(userId, 'ABC replay');
    const billing = await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 6, reference: `replay-grant-${abc}` });
    const wsRef = `ws-replay-${abc}`;
    const first = await spendForWorkspaceAction({
      ownerUserId: userId,
      workspaceId: abc,
      operationId: wsRef,
      amount: 2,
      kind: 'DEBIT',
    });
    for (let i = 0; i < 4; i += 1) {
      const replay = await spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: abc,
        operationId: wsRef,
        amount: 2,
        kind: 'DEBIT',
      });
      assert.equal(replay.alreadyCharged, true);
      assert.equal(replay.fundingSource, 'WORKSPACE');
    }
    assert.equal(first.fundingSource, 'WORKSPACE');
    assert.equal(await workspaceAvailableCredits(abc), 4);
    await query(`UPDATE wallets SET balance_credits = 10 WHERE id = $1`, [billing.walletId]);
    const xyz = await insertWorkspace(userId, 'XYZ owner replay');
    const ownerRef = `owner-replay-${xyz}`;
    const ownerFirst = await spendForWorkspaceAction({
      ownerUserId: userId,
      workspaceId: xyz,
      operationId: ownerRef,
      amount: 2,
      kind: 'DEBIT',
    });
    for (let i = 0; i < 4; i += 1) {
      const replay = await spendForWorkspaceAction({
        ownerUserId: userId,
        workspaceId: xyz,
        operationId: ownerRef,
        amount: 2,
        kind: 'DEBIT',
      });
      assert.equal(replay.alreadyCharged, true);
      assert.equal(replay.fundingSource, 'OWNER_GLOBAL');
    }
    assert.equal(ownerFirst.fundingSource, 'OWNER_GLOBAL');
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions WHERE reference = $1 AND amount < 0`,
      [wsRef]
    );
    assert.equal(rows[0].n, 1);
  });

  it('ownership transfer keeps workspace credits with the workspace', async () => {
    if (!ctx) throw new Error('harness required');
    const fromId = await insertFreshUser('From Owner');
    const toId = await insertFreshUser('To Owner');
    const abc = await insertWorkspace(fromId, 'ABC transfer', { isBase: false });
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
       VALUES ($1,$2,$3,'MEMBER',NULL,'ACTIVE',$4)`,
      [crypto.randomUUID(), abc, toId, ts]
    );
    const fromBilling = await zeroOwnerWallet(fromId);
    await zeroOwnerWallet(toId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 12, reference: `xfer-grant-${abc}` });
    const transferId = crypto.randomUUID();
    const { rows: viewer } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'VIEWER' LIMIT 1`,
      [abc]
    );
    await query(
      `INSERT INTO workspace_ownership_transfers
         (id, workspace_id, from_user_id, target_user_id, outgoing_role_id, status, grace_ends_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'PENDING_GRACE',$6,$6,$6)`,
      [transferId, abc, fromId, toId, viewer[0]?.id || null, ts - 10]
    );
    await completeOwnershipTransfer(fromId, abc, transferId, { system: true });
    assert.equal(await workspaceAvailableCredits(abc), 12);
    const { rows: ws } = await query(`SELECT owner_user_id FROM workspaces WHERE id = $1`, [abc]);
    assert.equal(Number(ws[0].owner_user_id), toId);
    const { rows: fromBal } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [fromBilling.walletId]);
    assert.equal(Number(fromBal[0].balance_credits), 0);
    const spent = await spendForWorkspaceAction({
      ownerUserId: toId,
      workspaceId: abc,
      operationId: `xfer-spend-${abc}`,
      amount: 2,
      kind: 'DEBIT',
    });
    assert.equal(spent.fundingSource, 'WORKSPACE');
    assert.equal(await workspaceAvailableCredits(abc), 10);
  });

  it('unpair and desktop replace leave workspace credits unchanged', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Unpair Owner');
    const abc = await insertWorkspace(userId, 'ABC unpair');
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 9, reference: `unpair-grant-${abc}` });
    const deviceId = `dev-unpair-${abc.slice(0, 8)}`;
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO devices (device_id, name, paired, workspace_id, binding_status, last_seen, created_at)
       VALUES ($1,'Desk 1',TRUE,$2,'ACTIVE',$3,$3)`,
      [deviceId, abc, ts]
    );
    await unpairDevice(deviceId, userId);
    assert.equal(await workspaceAvailableCredits(abc), 9);
    const device2 = `dev-restore-${abc.slice(0, 8)}`;
    await query(
      `INSERT INTO devices (device_id, name, paired, workspace_id, binding_status, last_seen, created_at)
       VALUES ($1,'Desk 2',TRUE,$2,'ACTIVE',$3,$3)`,
      [device2, abc, ts]
    );
    assert.equal(await workspaceAvailableCredits(abc), 9);
    const { rows } = await query(
      `SELECT count(*)::int AS n FROM wallet_transactions
        WHERE workspace_id = $1 AND funding_source = 'WORKSPACE' AND amount > 0`,
      [abc]
    );
    assert.equal(rows[0].n, 1);
  });

  it('Demo consumes neither owner nor workspace credits', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    const billing = await ensureBillingAccount(userId);
    await grantWorkspaceCredits({
      workspaceId: ws,
      amount: 7,
      reference: `demo-ws-${Date.now()}`,
    });
    const { rows: ownerBefore } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    const wsBefore = await workspaceAvailableCredits(ws);
    const { rows: txnBefore } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    await createDemoEntry({
      userId,
      workspaceId: ws,
      companyId: null,
      entryType: 'sales_invoice',
      payload: { test: true },
    }).catch(() => {});
    const { rows: ownerAfter } = await query(`SELECT balance_credits FROM wallets WHERE id = $1`, [billing.walletId]);
    assert.equal(String(ownerAfter[0].balance_credits), String(ownerBefore[0].balance_credits));
    assert.equal(await workspaceAvailableCredits(ws), wsBefore);
    const { rows: txnAfter } = await query(`SELECT count(*)::int AS n FROM wallet_transactions`);
    assert.equal(txnAfter[0].n, txnBefore[0].n);
  });

  it('RBAC: member and auditor cannot view or mutate billing', async () => {
    if (!ctx) throw new Error('harness required');
    const ws = ctx.fixtures.workspaces.A;
    const before = await workspaceAvailableCredits(ws);
    const memberRes = await httpJson(ctx.baseUrl, 'GET', '/api/billing/overview', {
      token: ctx.fixtures.tokens.memberA.accessToken,
      headers: { 'X-Workspace-Id': ws },
    });
    assert.ok(memberRes.status === 403 || memberRes.status === 401);
    const auditorId = await insertFreshUser('Auditor A');
    const { rows: auditorRole } = await query(
      `SELECT id FROM workspace_roles WHERE workspace_id = $1 AND system_key = 'AUDITOR' LIMIT 1`,
      [ws]
    );
    const ts = Math.floor(Date.now() / 1000);
    await query(
      `INSERT INTO workspace_memberships (id, workspace_id, user_id, membership_type, role_id, status, joined_at)
       VALUES ($1,$2,$3,'MEMBER',$4,'ACTIVE',$5)`,
      [crypto.randomUUID(), ws, auditorId, auditorRole[0]?.id || null, ts]
    );
    const { createAuthSession } = await import('../../services/authSessionService.js');
    const session = await createAuthSession(auditorId, { clientType: 'rbac-test' });
    const auditorRes = await httpJson(ctx.baseUrl, 'GET', '/api/billing/overview', {
      token: session.accessToken,
      headers: { 'X-Workspace-Id': ws },
    });
    assert.ok(auditorRes.status === 403 || auditorRes.status === 401);
    const seat = await httpJson(ctx.baseUrl, 'POST', `/api/workspaces/${ws}/seats`, {
      token: ctx.fixtures.tokens.memberA.accessToken,
      headers: { 'X-Workspace-Id': ws },
      body: {},
    });
    assert.ok(seat.status === 403 || seat.status === 401 || seat.status === 404);
    assert.equal(await workspaceAvailableCredits(ws), before);
  });

  it('IDOR: authorized XYZ user cannot read ABC workspace credits', async () => {
    if (!ctx) throw new Error('harness required');
    const abc = ctx.fixtures.workspaces.A;
    await grantWorkspaceCredits({ workspaceId: abc, amount: 3, reference: `idor-abc-${Date.now()}` });
    const res = await httpJson(ctx.baseUrl, 'GET', '/api/billing/overview', {
      token: ctx.fixtures.tokens.ownerB.accessToken,
      headers: { 'X-Workspace-Id': abc },
    });
    assert.ok(res.status === 403 || res.status === 404);
    const leaked = res.json?.data?.workspaceCredits?.available;
    assert.ok(leaked == null || leaked === 0);
  });

  it('overview for a member workspace returns workspaceCredits; owner lots stay owner-scoped', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = ctx.fixtures.users.ownerA.id;
    const ws = ctx.fixtures.workspaces.A;
    await grantWorkspaceCredits({ workspaceId: ws, amount: 2, reference: `overview-${Date.now()}` });
    const overview = await getBillingOverview(userId, { workspaceId: ws });
    assert.ok(overview.workspaceCredits);
    assert.equal(overview.workspaceCredits.workspaceId, ws);
    assert.ok(overview.workspaceCredits.available >= 2);
    assert.ok((overview.lots || []).every((lot) => !lot.workspace_id));
  });

  it('workspace lots reconcile to the workspace ledger', async () => {
    if (!ctx) throw new Error('harness required');
    const userId = await insertFreshUser('Reconcile Owner');
    const abc = await insertWorkspace(userId, 'ABC recon');
    await zeroOwnerWallet(userId);
    await grantWorkspaceCredits({ workspaceId: abc, amount: 11, reference: `recon-grant-${abc}` });
    await spendForWorkspaceAction({
      ownerUserId: userId,
      workspaceId: abc,
      operationId: `recon-spend-${abc}`,
      amount: 5,
      kind: 'DEBIT',
    });
    const { rows: lotSum } = await query(
      `SELECT coalesce(sum(credits_remaining),0)::text AS n FROM credit_lots WHERE workspace_id = $1`,
      [abc]
    );
    const { rows: ledger } = await query(
      `SELECT coalesce(sum(amount),0)::text AS n FROM wallet_transactions
        WHERE workspace_id = $1 AND funding_source = 'WORKSPACE'`,
      [abc]
    );
    assert.equal(Number(lotSum[0].n), Number(ledger[0].n));
    assert.equal(Number(lotSum[0].n), 6);
  });
});
