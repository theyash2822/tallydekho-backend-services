/**
 * Billing integrity — money paths that must not double-charge or double-credit.
 *
 * These are source-level assertions rather than live gateway runs: the defects
 * they guard are structural (a missing atomic claim, a re-serialised signature
 * payload, an absent idempotency check), and each was reachable in normal use
 * rather than under exotic timing.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('billing integrity', () => {
  it('a payment is claimed atomically before credits are granted', () => {
    // A successful payment reports twice by design — the browser verify call and
    // the Razorpay webhook. Reading the status and then crediting let both pass
    // the check and credit the wallet twice, giving away credits for one payment.
    const src = read('services/billingService.js');
    assert.match(
      src,
      /UPDATE billing_payment_orders[\s\S]{0,400}?WHERE id = \$1 AND status IN \('PENDING', 'CREATED'\)[\s\S]{0,80}?RETURNING id/,
      'fulfilment must claim the order with a conditional UPDATE'
    );
    assert.match(
      src,
      /if \(!claim\.rowCount\)[\s\S]{0,160}alreadyFulfilled: true/,
      'the caller that loses the claim must not credit the wallet'
    );

    // The claim must be taken before the wallet is touched, or the race returns.
    // Scoped to this function: other code paths also credit with kind TOPUP.
    const fnStart = src.indexOf('export async function fulfillRechargePayment');
    assert.ok(fnStart > -1, 'fulfillRechargePayment must exist');
    const fn = src.slice(fnStart, src.indexOf('\nexport ', fnStart + 1));
    const claimAt = fn.indexOf("WHERE id = $1 AND status IN ('PENDING', 'CREATED')");
    const creditAt = fn.indexOf('await creditWallet({');
    assert.ok(claimAt > -1, 'the conditional claim must be inside fulfillRechargePayment');
    assert.ok(creditAt > claimAt, 'claim must precede creditWallet');
  });

  it('a failed grant releases the claim so the payment can be retried', () => {
    // Otherwise the order reads COMPLETED with no credits issued: money taken,
    // nothing delivered, and no path for the webhook retry to recover.
    const src = read('services/billingService.js');
    assert.match(
      src,
      /catch \(err\) \{[\s\S]{0,400}?SET status = \$2, completed_at = NULL[\s\S]{0,200}?throw err/,
      'a failure after claiming must restore the previous status and rethrow'
    );
  });

  it('the Razorpay webhook verifies the bytes it was sent', () => {
    // express.json() replaces the body with an object, so re-serialising it
    // changes key order and escaping and the HMAC never matches. Every webhook
    // was rejected as an invalid signature, leaving credits ungranted whenever
    // the payer closed the tab before the browser verify call ran.
    for (const rel of ['createApp.js', 'server.js']) {
      const src = read(rel);
      const rawAt = src.indexOf('/api/billing/webhooks/razorpay');
      const jsonAt = src.indexOf('express.json(');
      assert.ok(rawAt > -1, `${rel}: webhook path needs a raw body parser`);
      assert.ok(rawAt < jsonAt, `${rel}: raw parser must be mounted before express.json`);
    }
    assert.match(
      read('routes/workspaceApi.js'),
      /Buffer\.isBuffer\(req\.body\)[\s\S]{0,200}verifyRazorpayWebhookSignature/,
      'the handler must hash the raw Buffer'
    );
  });

  it('activating an already-active integration does not charge again', () => {
    // Only NOT_CONFIGURED was rejected, so pressing Activate on a live
    // integration deducted the fee again — and the control is reachable by
    // anyone holding integrations.configure, spending the Owner's credits.
    const src = read('routes/workspaceApi.js');
    const activeGuard = src.indexOf("rows[0].status === 'ACTIVE'");
    const deduct = src.indexOf('await deductCredits({');
    assert.ok(activeGuard > -1, 'an ACTIVE short-circuit must exist');
    assert.ok(deduct > activeGuard, 'the ACTIVE check must precede the deduction');
  });

  it('activation price comes from service_rates, not a literal', () => {
    const src = read('routes/workspaceApi.js');
    assert.match(src, /getServiceRate\(rateKey\)/, 'price must be looked up');
    assert.ok(
      !/amount:\s*100\b/.test(src),
      'a hardcoded 100 means repricing in service_rates has no effect'
    );
  });

  it('spending credits is a single conditional statement, never read-then-write', () => {
    // balance=10 with two concurrent costs of 8 must settle at one success.
    const src = read('services/billingService.js');
    assert.match(
      src,
      /UPDATE wallets SET balance_credits = balance_credits - \$1[\s\S]{0,200}?WHERE id = \$3 AND balance_credits >= \$1/,
      'the balance guard must live in the UPDATE itself'
    );
  });
});
