/**
 * Billing stub — placeholder wallet/credits model so RBAS-gated integration
 * activation has something real to check against. Not a payment processor;
 * a proper billing_connection domain replaces this later
 * (see billing_connection_enabled flag).
 */
import { v4 as uuid } from 'uuid';
import { query } from '../db/schema.js';

const now = () => Math.floor(Date.now() / 1000);
const DEMO_CREDITS = () => {
  const v = parseInt(process.env.BILLING_STUB_CREDITS, 10);
  return Number.isFinite(v) ? v : 100;
};

// Best-effort in-process idempotency guard for the stub reservation flow.
// A real billing domain would persist this; acceptable for a stub service.
const _seenIdempotencyKeys = new Map();

export async function ensureBillingAccount(ownerUserId) {
  const { rows } = await query('SELECT * FROM billing_accounts WHERE owner_user_id = $1 LIMIT 1', [ownerUserId]);
  if (rows[0]) return rows[0];

  const id = uuid();
  const ts = now();
  await query(
    `INSERT INTO billing_accounts (id, owner_user_id, created_at) VALUES ($1,$2,$3)
     ON CONFLICT (owner_user_id) DO NOTHING`,
    [id, ownerUserId, ts]
  );
  const { rows: account } = await query('SELECT * FROM billing_accounts WHERE owner_user_id = $1', [ownerUserId]);
  const acct = account[0];

  const { rows: wallet } = await query('SELECT * FROM wallets WHERE billing_account_id = $1 LIMIT 1', [acct.id]);
  if (!wallet[0]) {
    await query(
      `INSERT INTO wallets (id, billing_account_id, balance_credits, updated_at) VALUES ($1,$2,$3,$4)`,
      [uuid(), acct.id, DEMO_CREDITS(), ts]
    );
  }
  return acct;
}

async function getWalletForOwner(ownerUserId) {
  const account = await ensureBillingAccount(ownerUserId);
  const { rows } = await query('SELECT * FROM wallets WHERE billing_account_id = $1 LIMIT 1', [account.id]);
  return rows[0] || null;
}

/**
 * Owner-only exposure by convention — callers must have already checked
 * capability 'billing.wallet.view' (protected_authority: OWNER) before
 * calling this.
 */
export async function getWalletBalance(ownerUserId) {
  const wallet = await getWalletForOwner(ownerUserId);
  return { balanceCredits: wallet?.balance_credits ?? 0 };
}

async function getOwnerUserIdForWorkspace(workspaceId) {
  const { rows } = await query('SELECT owner_user_id FROM workspaces WHERE id = $1', [workspaceId]);
  return rows[0]?.owner_user_id || null;
}

/**
 * Attempts to reserve `amount` credits against the workspace owner's
 * wallet. Fail-closed: any missing owner/wallet/insufficient-balance path
 * returns { ok: false }, never throws a false "ok".
 */
export async function tryReserveCredits(workspaceId, amount, idempotencyKey = null) {
  if (idempotencyKey && _seenIdempotencyKeys.has(idempotencyKey)) {
    return _seenIdempotencyKeys.get(idempotencyKey);
  }
  const ownerUserId = await getOwnerUserIdForWorkspace(workspaceId);
  if (!ownerUserId) {
    const result = { ok: false, code: 'BILLING_ACCOUNT_NOT_FOUND' };
    if (idempotencyKey) _seenIdempotencyKeys.set(idempotencyKey, result);
    return result;
  }
  const wallet = await getWalletForOwner(ownerUserId);
  const need = Math.max(0, Number(amount) || 0);
  if (!wallet || (wallet.balance_credits ?? 0) < need) {
    const result = { ok: false, code: 'BILLING_INSUFFICIENT_CREDITS', balanceCredits: wallet?.balance_credits ?? 0 };
    if (idempotencyKey) _seenIdempotencyKeys.set(idempotencyKey, result);
    return result;
  }
  await query(
    `UPDATE wallets SET balance_credits = balance_credits - $2, updated_at = $3 WHERE id = $1`,
    [wallet.id, need, now()]
  );
  const result = { ok: true, balanceCredits: (wallet.balance_credits ?? 0) - need };
  if (idempotencyKey) _seenIdempotencyKeys.set(idempotencyKey, result);
  return result;
}
