/**
 * Critical RBAS unit tests — Universal §81 subset (no DB required).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  membershipAuthzGate,
  normalizeEntryMode,
  entryModeGate,
} from '../services/authorizationService.js';
import { getCapability, CAPABILITIES } from '../services/capabilityRegistry.js';
import { TALLY_WRITE_CAPABILITIES } from '../middleware/companyAccess.js';
import { FEATURE_FLAGS } from '../config/featureFlags.js';

describe('feature flags ON', () => {
  it('enables workspace + rbas + scopes', () => {
    assert.equal(FEATURE_FLAGS.workspace_model_enabled, true);
    assert.equal(FEATURE_FLAGS.rbas_enabled, true);
    assert.equal(FEATURE_FLAGS.scope_company_enabled, true);
  });
});

describe('capability registry', () => {
  it('has 83 capabilities and no generic voucher edit/delete/cancel', () => {
    assert.equal(CAPABILITIES.length, 83);
    assert.ok(!getCapability('voucher.edit'));
    assert.ok(!getCapability('voucher.delete'));
    assert.ok(!getCapability('voucher.cancel'));
    assert.ok(getCapability('sales_invoice.create')?.supports_entry_mode);
  });
});

describe('membershipAuthzGate', () => {
  it('denies missing / suspended membership', () => {
    assert.equal(membershipAuthzGate(null).decision, 'DENY');
    assert.equal(membershipAuthzGate({ status: 'SUSPENDED' }).reason, 'MEMBERSHIP_SUSPENDED');
  });
  it('allows Owner early', () => {
    assert.equal(membershipAuthzGate({ status: 'ACTIVE', membership_type: 'OWNER' }).decision, 'ALLOW');
  });
});

describe('normalizeEntryMode / entryModeGate', () => {
  it('normalizes OPTIONAL_ONLY / REGULAR_ONLY / BOTH', () => {
    assert.equal(normalizeEntryMode('OPTIONAL'), 'OPTIONAL');
    assert.equal(normalizeEntryMode('OPTIONAL_ONLY'), 'OPTIONAL');
    assert.equal(normalizeEntryMode('REGULAR'), 'REGULAR');
    assert.equal(normalizeEntryMode('REGULAR_ONLY'), 'REGULAR');
    assert.equal(normalizeEntryMode('BOTH'), 'BOTH');
    assert.equal(normalizeEntryMode(null), 'BOTH');
  });
  it('OPTIONAL role denies REGULAR entry kind', () => {
    const deny = entryModeGate('OPTIONAL', 'REGULAR', true);
    assert.equal(deny?.decision, 'DENY');
    assert.equal(deny?.reason, 'ENTRY_MODE_DENIED');
  });
  it('OPTIONAL role allows OPTIONAL entry kind', () => {
    assert.equal(entryModeGate('OPTIONAL_ONLY', 'OPTIONAL', true), null);
  });
  it('REGULAR role denies OPTIONAL entry kind', () => {
    assert.equal(entryModeGate('REGULAR', 'OPTIONAL', true)?.reason, 'ENTRY_MODE_DENIED');
  });
  it('skips when capability lacks entry mode support', () => {
    assert.equal(entryModeGate('OPTIONAL', 'REGULAR', false), null);
  });
});

describe('tally write capability map', () => {
  it('maps sales/proforma entry kinds', () => {
    assert.equal(TALLY_WRITE_CAPABILITIES['/voucher/sales'].entryKind, 'REGULAR');
    assert.equal(TALLY_WRITE_CAPABILITIES['/voucher/proforma'].entryKind, 'OPTIONAL');
  });
  it('TALLY_WRITE_CAPABILITIES cancel is deny', () => {
    assert.equal(TALLY_WRITE_CAPABILITIES['/voucher/cancel'].deny, true);
    assert.equal(TALLY_WRITE_CAPABILITIES['/voucher/cancel'].capability, null);
  });
});
