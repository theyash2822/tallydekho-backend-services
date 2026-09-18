import { v4 as uuid } from 'uuid';
import crypto from 'crypto';
import { query } from '../db/schema.js';
import { audit } from './auditService.js';

const now = () => Math.floor(Date.now() / 1000);
const SIGNUP_CREDITS = 10;
const FIVE_YEARS_SEC = 5 * 365 * 24 * 60 * 60;

/**
 * Ensures billing_accounts + wallets + signup credit lot (10 credits, 5yr expiry).
 * Idempotent per owner_user_id.
 */
export async function ensureBillingAccount(userId) {
  const { rows: existing } = await query(
    `SELECT ba.*, w.id AS wallet_id, w.balance_credits
     FROM billing_accounts ba
     LEFT JOIN wallets w ON w.billing_account_id = ba.id
     WHERE ba.owner_user_id = $1 LIMIT 1`,
    [userId]
  );
  if (existing[0]?.wallet_id) {
    return {
      billingAccountId: existing[0].id,
      walletId: existing[0].wallet_id,
      balanceCredits: Number(existing[0].balance_credits) || 0,
    };
  }

  const ts = now();
  let billingAccountId = existing[0]?.id;
  if (!billingAccountId) {
    billingAccountId = uuid();
    await query(
      `INSERT INTO billing_accounts (id, owner_user_id, created_at)
       VALUES ($1,$2,$3)
       ON CONFLICT (owner_user_id) DO NOTHING`,
      [billingAccountId, userId, ts]
    );
    const { rows: again } = await query(
      `SELECT id FROM billing_accounts WHERE owner_user_id = $1 LIMIT 1`,
      [userId]
    );
    billingAccountId = again[0]?.id || billingAccountId;
  }

  const { rows: wallets } = await query(
    `SELECT id, balance_credits FROM wallets WHERE billing_account_id = $1 LIMIT 1`,
    [billingAccountId]
  );
  let walletId = wallets[0]?.id;
  if (!walletId) {
    walletId = uuid();
    await query(
      `INSERT INTO wallets (id, billing_account_id, balance_credits, updated_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (billing_account_id) DO NOTHING`,
      [walletId, billingAccountId, SIGNUP_CREDITS, ts]
    );
    const { rows: w2 } = await query(
      `SELECT id, balance_credits FROM wallets WHERE billing_account_id = $1 LIMIT 1`,
      [billingAccountId]
    );
    walletId = w2[0]?.id || walletId;

    const { rows: lots } = await query(
      `SELECT id FROM credit_lots WHERE wallet_id = $1 AND source = 'SIGNUP' LIMIT 1`,
      [walletId]
    );
    if (!lots[0]) {
      await query(
        `INSERT INTO credit_lots (id, wallet_id, credits_remaining, credits_original, source, expires_at, created_at)
         VALUES ($1,$2,$3,$3,'SIGNUP',$4,$5)`,
        [uuid(), walletId, SIGNUP_CREDITS, ts + FIVE_YEARS_SEC, ts]
      );
      await query(
        `INSERT INTO wallet_transactions (id, wallet_id, amount, kind, reference, meta_json, created_at)
         VALUES ($1,$2,$3,'CREDIT','SIGNUP_BONUS',$4,$5)`,
        [uuid(), walletId, SIGNUP_CREDITS, JSON.stringify({ source: 'SIGNUP' }), ts]
      );
      await audit(null, userId, 'billing.signup_credit', { credits: SIGNUP_CREDITS });
    }
  }

  const wallet = await getWallet(userId);
  return {
    billingAccountId,
    walletId: wallet?.id,
    balanceCredits: wallet ? Number(wallet.balance_credits) || 0 : 0,
  };
}

export async function getWallet(userId) {
  const { rows } = await query(
    `SELECT w.* FROM wallets w
     JOIN billing_accounts ba ON ba.id = w.billing_account_id
     WHERE ba.owner_user_id = $1 LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

export async function getServiceRate(key) {
  const { rows } = await query(`SELECT * FROM service_rates WHERE key = $1 LIMIT 1`, [key]);
  return rows[0] || null;
}

export async function listRates() {
  const { rows } = await query(`SELECT key, credits, version, updated_at FROM service_rates ORDER BY key`);
  return rows;
}

/**
 * Simple debit: decrement wallet balance + write transaction. Fail closed if insufficient.
 */
export async function deductCredits({ userId, amount, kind, reference, workspaceId = null, meta = {} }) {
  const credits = Number(amount);
  if (!Number.isFinite(credits) || credits <= 0) {
    const err = new Error('Invalid debit amount');
    err.code = 'BILLING_INVALID_AMOUNT';
    err.httpStatus = 400;
    throw err;
  }
  await ensureBillingAccount(userId);
  const wallet = await getWallet(userId);
  if (!wallet) {
    const err = new Error('Wallet not found');
    err.code = 'WALLET_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const balance = Number(wallet.balance_credits) || 0;
  if (balance < credits) {
    const err = new Error('Insufficient credits');
    err.code = 'INSUFFICIENT_CREDITS';
    err.httpStatus = 402;
    throw err;
  }
  const ts = now();
  const { rows } = await query(
    `UPDATE wallets SET balance_credits = balance_credits - $1, updated_at = $2
     WHERE id = $3 AND balance_credits >= $1
     RETURNING *`,
    [credits, ts, wallet.id]
  );
  if (!rows[0]) {
    const err = new Error('Insufficient credits');
    err.code = 'INSUFFICIENT_CREDITS';
    err.httpStatus = 402;
    throw err;
  }
  const txnId = uuid();
  await query(
    `INSERT INTO wallet_transactions (id, wallet_id, workspace_id, amount, kind, reference, meta_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [txnId, wallet.id, workspaceId, -credits, kind || 'DEBIT', reference || null, JSON.stringify(meta || {}), ts]
  );
  await recordUsageEvent({
    userId,
    workspaceId,
    kind: kind || 'DEBIT',
    amount: -credits,
    reference,
    walletTxnId: txnId,
    meta,
  }).catch(() => {});
  return rows[0];
}

export async function getBillingOverview(userId) {
  await ensureBillingAccount(userId);
  const wallet = await getWallet(userId);
  const rates = await listRates();
  const { rows: lots } = await query(
    `SELECT id, credits_remaining, credits_original, source, expires_at, created_at
     FROM credit_lots WHERE wallet_id = $1 ORDER BY expires_at NULLS LAST`,
    [wallet.id]
  );
  return {
    wallet: {
      id: wallet.id,
      balanceCredits: Number(wallet.balance_credits) || 0,
      updatedAt: wallet.updated_at,
    },
    lots,
    rates,
  };
}

/**
 * Wallet ledger for the Owner's billing account (fail closed → []).
 */
export async function listWalletTransactions(userId, { limit = 100 } = {}) {
  try {
    await ensureBillingAccount(userId);
    const wallet = await getWallet(userId);
    if (!wallet?.id) return [];
    const { rows } = await query(
      `SELECT id, wallet_id, workspace_id, amount, kind, reference, meta_json, created_at
       FROM wallet_transactions
       WHERE wallet_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [wallet.id, Math.min(Number(limit) || 100, 500)]
    );
    return rows;
  } catch (err) {
    console.warn('[billing] listWalletTransactions:', err.message);
    return [];
  }
}

/**
 * Credit wallet + optional credit lot. Used by payment order completion (manual/dev without Razorpay).
 */
export async function creditWallet({
  userId,
  amount,
  kind = 'TOPUP',
  reference = null,
  workspaceId = null,
  meta = {},
  source = 'PURCHASE',
}) {
  const credits = Number(amount);
  if (!Number.isFinite(credits) || credits <= 0) {
    const err = new Error('Invalid credit amount');
    err.code = 'BILLING_INVALID_AMOUNT';
    err.httpStatus = 400;
    throw err;
  }
  await ensureBillingAccount(userId);
  const wallet = await getWallet(userId);
  if (!wallet) {
    const err = new Error('Wallet not found');
    err.code = 'WALLET_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const ts = now();
  const { rows } = await query(
    `UPDATE wallets SET balance_credits = balance_credits + $1, updated_at = $2
     WHERE id = $3 RETURNING *`,
    [credits, ts, wallet.id]
  );
  const txnId = uuid();
  await query(
    `INSERT INTO wallet_transactions (id, wallet_id, workspace_id, amount, kind, reference, meta_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [txnId, wallet.id, workspaceId, credits, kind, reference, JSON.stringify(meta || {}), ts]
  );
  await query(
    `INSERT INTO credit_lots (id, wallet_id, credits_remaining, credits_original, source, expires_at, created_at)
     VALUES ($1,$2,$3,$3,$4,$5,$6)`,
    [uuid(), wallet.id, credits, source, ts + FIVE_YEARS_SEC, ts]
  );
  await recordUsageEvent({
    userId,
    workspaceId,
    kind,
    amount: credits,
    reference,
    walletTxnId: txnId,
    meta,
  });
  return rows[0];
}

/**
 * Create a PENDING payment order. Razorpay provider wiring is a documented dependency —
 * completePaymentOrder credits the wallet for manual/dev completion.
 */
export async function createPaymentOrder({ userId, credits, amountInr, meta = {} }) {
  const creditAmt = Number(credits);
  const inr = Number(amountInr);
  if (!Number.isFinite(creditAmt) || creditAmt <= 0) {
    const err = new Error('credits must be a positive number');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  if (!Number.isFinite(inr) || inr < 0) {
    const err = new Error('amountInr must be a non-negative number');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  const billing = await ensureBillingAccount(userId);
  const orderId = uuid();
  const ts = now();
  await query(
    `INSERT INTO billing_payment_orders
       (id, billing_account_id, owner_user_id, credits, amount_inr, status, provider, meta_json, created_at)
     VALUES ($1,$2,$3,$4,$5,'PENDING','MANUAL',$6,$7)`,
    [
      orderId,
      billing.billingAccountId,
      userId,
      creditAmt,
      inr,
      JSON.stringify({
        ...meta,
        note: 'Razorpay not wired — use POST /api/billing/payment-orders/:id/complete for manual/dev settle',
      }),
      ts,
    ]
  );
  await audit(null, userId, 'billing.payment_order_created', { orderId, credits: creditAmt, amountInr: inr });
  const { rows } = await query(`SELECT * FROM billing_payment_orders WHERE id = $1`, [orderId]);
  return rows[0];
}

export async function listPaymentOrders(userId, { limit = 50 } = {}) {
  await ensureBillingAccount(userId);
  const { rows } = await query(
    `SELECT * FROM billing_payment_orders
     WHERE owner_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

/**
 * Manually complete a PENDING order (dev / ops). Credits wallet + creates invoice.
 * Production Razorpay webhook should call the same path after payment verification.
 */
export async function completePaymentOrder(userId, orderId) {
  const { rows } = await query(
    `SELECT * FROM billing_payment_orders WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [orderId, userId]
  );
  const order = rows[0];
  if (!order) {
    const err = new Error('Payment order not found');
    err.code = 'ORDER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (order.status !== 'PENDING') {
    const err = new Error(`Order is ${order.status}`);
    err.code = 'ORDER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }
  const ts = now();
  await creditWallet({
    userId,
    amount: Number(order.credits),
    kind: 'TOPUP',
    reference: orderId,
    meta: { orderId, amountInr: Number(order.amount_inr), provider: order.provider },
    source: 'PURCHASE',
  });
  await query(
    `UPDATE billing_payment_orders SET status = 'COMPLETED', completed_at = $2 WHERE id = $1`,
    [orderId, ts]
  );
  const invoice = await createInvoiceFromOrder(userId, orderId);
  await audit(null, userId, 'billing.payment_order_completed', { orderId, invoiceId: invoice?.id });
  const { rows: updated } = await query(`SELECT * FROM billing_payment_orders WHERE id = $1`, [orderId]);
  return { order: updated[0], invoice };
}

export async function createInvoiceFromOrder(userId, orderId) {
  const { rows } = await query(
    `SELECT * FROM billing_payment_orders WHERE id = $1 AND owner_user_id = $2 LIMIT 1`,
    [orderId, userId]
  );
  const order = rows[0];
  if (!order) {
    const err = new Error('Payment order not found');
    err.code = 'ORDER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  const { rows: existing } = await query(
    `SELECT * FROM billing_invoices WHERE order_id = $1 LIMIT 1`,
    [orderId]
  );
  if (existing[0]) return existing[0];

  const billing = await ensureBillingAccount(userId);
  const invoiceId = uuid();
  const ts = now();
  const invoiceNumber = `TD-${ts}-${String(invoiceId).slice(0, 8).toUpperCase()}`;
  await query(
    `INSERT INTO billing_invoices
       (id, billing_account_id, owner_user_id, order_id, credits, amount_inr, currency, status,
        invoice_number, meta_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,'INR','PAID',$7,$8,$9)`,
    [
      invoiceId,
      billing.billingAccountId,
      userId,
      orderId,
      order.credits,
      order.amount_inr,
      invoiceNumber,
      JSON.stringify({ provider: order.provider }),
      ts,
    ]
  );
  const { rows: inv } = await query(`SELECT * FROM billing_invoices WHERE id = $1`, [invoiceId]);
  return inv[0];
}

export async function listInvoices(userId, { limit = 50 } = {}) {
  await ensureBillingAccount(userId);
  const { rows } = await query(
    `SELECT * FROM billing_invoices
     WHERE owner_user_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [userId, Math.min(Number(limit) || 50, 200)]
  );
  return rows;
}

export async function recordUsageEvent({
  userId,
  workspaceId = null,
  kind,
  amount = 0,
  reference = null,
  walletTxnId = null,
  meta = {},
}) {
  try {
    const id = uuid();
    const ts = now();
    await query(
      `INSERT INTO usage_events
         (id, owner_user_id, workspace_id, kind, amount, reference, wallet_txn_id, meta_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        userId,
        workspaceId,
        kind || 'UNKNOWN',
        amount,
        reference,
        walletTxnId,
        JSON.stringify(meta || {}),
        ts,
      ]
    );
    return id;
  } catch (err) {
    console.warn('[billing] recordUsageEvent:', err.message);
    return null;
  }
}

/**
 * Usage drilldown: usage_events ∪ wallet_transactions with optional workspace/kind filters.
 */
export async function listUsageEvents(userId, { workspaceId, kind, limit = 100 } = {}) {
  await ensureBillingAccount(userId);
  const lim = Math.min(Number(limit) || 100, 500);
  const params = [userId];
  let where = 'owner_user_id = $1';
  if (workspaceId) {
    params.push(workspaceId);
    where += ` AND workspace_id = $${params.length}`;
  }
  if (kind) {
    params.push(kind);
    where += ` AND kind = $${params.length}`;
  }
  params.push(lim);

  let events = [];
  try {
    const { rows } = await query(
      `SELECT id, owner_user_id, workspace_id, kind, amount, reference, wallet_txn_id, meta_json, created_at,
              'usage_event' AS source
       FROM usage_events
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    events = rows;
  } catch (err) {
    console.warn('[billing] listUsageEvents table:', err.message);
  }

  // Also surface wallet ledger rows (deducts/credits) when no dedicated usage_events yet
  const wallet = await getWallet(userId);
  let txns = [];
  if (wallet?.id) {
    const tParams = [wallet.id];
    let tWhere = 'wallet_id = $1';
    if (workspaceId) {
      tParams.push(workspaceId);
      tWhere += ` AND workspace_id = $${tParams.length}`;
    }
    if (kind) {
      tParams.push(kind);
      tWhere += ` AND kind = $${tParams.length}`;
    }
    tParams.push(lim);
    const { rows } = await query(
      `SELECT id, NULL::integer AS owner_user_id, workspace_id, kind, amount, reference,
              id AS wallet_txn_id, meta_json, created_at, 'wallet_transaction' AS source
       FROM wallet_transactions
       WHERE ${tWhere}
       ORDER BY created_at DESC
       LIMIT $${tParams.length}`,
      tParams
    );
    txns = rows.map((r) => ({ ...r, owner_user_id: userId }));
  }

  const merged = [...events, ...txns]
    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
    .slice(0, lim);
  return merged;
}

const INR_PER_CREDIT = 1; // LOCKED: ₹1 = 1 credit

function razorpayConfigured() {
  return !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

function razorpayAuthHeader() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

/**
 * Create Razorpay order for Owner credit recharge.
 * Returns order payload for Mobile/Web Razorpay Checkout.
 */
export async function createRechargeOrder(userId, { credits, workspaceId = null } = {}) {
  const n = Number(credits);
  if (!Number.isFinite(n) || n < 1 || n > 1_000_000) {
    const err = new Error('credits must be between 1 and 1000000');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }
  if (!razorpayConfigured()) {
    const err = new Error('Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
    err.code = 'PAYMENT_PROVIDER_NOT_CONFIGURED';
    err.httpStatus = 503;
    throw err;
  }

  const account = await ensureBillingAccount(userId);
  const amountInr = Math.round(n * INR_PER_CREDIT * 100) / 100;
  const amountPaise = Math.round(amountInr * 100);
  const orderId = uuid();
  const ts = now();
  const receipt = `td_${orderId.replace(/-/g, '').slice(0, 20)}`;

  const rzRes = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: razorpayAuthHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: amountPaise,
      currency: 'INR',
      receipt,
      notes: { tallydekho_order_id: orderId, user_id: String(userId), credits: String(n) },
    }),
  });
  const rzBody = await rzRes.json().catch(() => ({}));
  if (!rzRes.ok) {
    const err = new Error(rzBody?.error?.description || 'Razorpay order create failed');
    err.code = 'RAZORPAY_ERROR';
    err.httpStatus = 502;
    throw err;
  }

  await query(
    `INSERT INTO billing_payment_orders
       (id, billing_account_id, owner_user_id, credits, amount_inr, status, provider, provider_order_id, meta_json, created_at)
     VALUES ($1,$2,$3,$4,$5,'PENDING','RAZORPAY',$6,$7,$8)`,
    [
      orderId, account.billingAccountId, userId, n, amountInr, rzBody.id,
      JSON.stringify({ workspaceId, receipt, razorpay: rzBody }), ts,
    ]
  );
  await audit(workspaceId, userId, 'billing.recharge_order_created', {
    orderId, credits: n, amountInr, providerOrderId: rzBody.id,
  });

  return {
    orderId,
    credits: n,
    amountInr,
    currency: 'INR',
    provider: 'RAZORPAY',
    razorpayOrderId: rzBody.id,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    amountPaise,
  };
}

/**
 * Credit wallet after successful Razorpay payment (idempotent by provider payment id).
 */
export async function fulfillRechargePayment({
  providerOrderId,
  providerPaymentId,
  signature = null,
  raw = {},
}) {
  if (!providerOrderId) {
    const err = new Error('providerOrderId required');
    err.code = 'VALIDATION_ERROR';
    err.httpStatus = 400;
    throw err;
  }

  const { rows } = await query(
    `SELECT * FROM billing_payment_orders WHERE provider_order_id = $1 LIMIT 1`,
    [providerOrderId]
  );
  const order = rows[0];
  if (!order) {
    const err = new Error('Payment order not found');
    err.code = 'ORDER_NOT_FOUND';
    err.httpStatus = 404;
    throw err;
  }
  if (order.status === 'PAID' || order.status === 'COMPLETED') {
    return { orderId: order.id, status: order.status, alreadyFulfilled: true };
  }
  if (order.status !== 'PENDING' && order.status !== 'CREATED') {
    const err = new Error(`Order status ${order.status} cannot be fulfilled`);
    err.code = 'ORDER_INVALID_STATE';
    err.httpStatus = 409;
    throw err;
  }

  const credits = Number(order.credits);
  const ts = now();

  // Claim the order before granting anything. A successful payment arrives twice
  // by design — once from the browser's verify call and once from Razorpay's
  // webhook — and the status check above is not a lock, so both could pass it
  // and both credit the wallet. Only the caller whose UPDATE matches a row may
  // proceed; the loser reports the payment as already fulfilled.
  const claim = await query(
    `UPDATE billing_payment_orders
     SET status = 'COMPLETED', completed_at = $2,
         meta_json = COALESCE(meta_json, '{}'::jsonb) || $3::jsonb
     WHERE id = $1 AND status IN ('PENDING', 'CREATED')
     RETURNING id`,
    [order.id, ts, JSON.stringify({ providerPaymentId, fulfilledAt: ts, signature: signature || null })]
  );
  if (!claim.rowCount) {
    return { orderId: order.id, status: 'COMPLETED', alreadyFulfilled: true };
  }

  let invoice;
  try {
    await creditWallet({
      userId: order.owner_user_id,
      amount: credits,
      kind: 'TOPUP',
      reference: order.id,
      meta: { source: 'RAZORPAY', providerOrderId, providerPaymentId, signature },
      source: 'RECHARGE',
    });
    invoice = await createInvoiceFromOrder(order.owner_user_id, order.id);
  } catch (err) {
    // Release the claim so the webhook retry can fulfil it. Leaving it COMPLETED
    // would mean money taken and credits never granted, with no path to recover.
    await query(
      `UPDATE billing_payment_orders SET status = $2, completed_at = NULL WHERE id = $1`,
      [order.id, order.status]
    ).catch(() => {});
    throw err;
  }
  const wallet = await getWallet(order.owner_user_id);
  await audit(null, order.owner_user_id, 'billing.recharge_fulfilled', {
    orderId: order.id, credits, providerPaymentId, invoiceId: invoice?.id,
  });
  return {
    orderId: order.id,
    status: 'COMPLETED',
    credits,
    balanceCredits: Number(wallet?.balance_credits) || 0,
    invoiceId: invoice?.id,
    invoiceNumber: invoice?.invoice_number,
  };
}

/** Verify Razorpay payment signature (checkout success callback). */
export function verifyRazorpayCheckoutSignature({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return expected === signature;
}

export function verifyRazorpayWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected === signatureHeader;
}

export { INR_PER_CREDIT, razorpayConfigured };
