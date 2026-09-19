/**
 * Billing / credits — live-row behaviour on the owner wallet.
 *
 * Workspace-specific spendable balances are not implemented (BILLING-POLICY-BLOCK).
 * These tests prove the owner-wallet contract: atomic spend, idempotent replay,
 * usage attribution, Razorpay claim, and Demo never touching the ledger.
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
} from '../../services/billingService.js';
import { createDemoEntry } from '../../services/demoSimulatedEntryService.js';

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
