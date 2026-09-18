import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLineage, pickRetentionDeletes, lineageMatchesBackupManifest, lineageMatchesRestoredFolders } from '../utils/tallyLineage.js';
import { generateDeviceSecret, hashSecret, verifySecret, hashToken } from '../services/deviceCredential.js';
import {
  defaultKeysForTemplate,
  adminProtectedKeys,
  ownerOnlyKeys,
  getCapability,
  BUILTIN_ROLE_DEFS,
} from '../services/capabilityRegistry.js';
import { membershipAuthzGate } from '../services/authorizationService.js';

test('lineage: first bind allowed', () => {
  const v = evaluateLineage([], ['A', 'B']);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'first_bind');
});

test('lineage: new company in same Tally allowed', () => {
  const v = evaluateLineage(['A', 'B', 'C'], ['A', 'B', 'C', 'D']);
  assert.equal(v.ok, true);
  assert.deepEqual(v.extra, ['D']);
});

test('lineage: unrelated Tally blocked', () => {
  const v = evaluateLineage(['A', 'B', 'C'], ['X', 'Y', 'Z']);
  assert.equal(v.ok, false);
  assert.equal(v.code, 'TALLY_DATA_MISMATCH');
  assert.equal(v.reason, 'unrelated');
});

test('lineage: GUID replacement candidate blocked for normal sync', () => {
  const v = evaluateLineage(['A', 'B', 'C'], ['A', 'B', 'X']);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'guid_replacement_candidate');
});

test('restore: backup manifest must overlap restored GUIDs', () => {
  const miss = lineageMatchesBackupManifest([{ guid: 'A' }, { guid: 'B' }], ['X']);
  assert.equal(miss.ok, false);
  const hit = lineageMatchesBackupManifest([{ guid: 'A' }, { guid: 'B' }], ['B']);
  assert.equal(hit.ok, true);
  const skip = lineageMatchesBackupManifest([{ guid: 'A' }], []);
  assert.equal(skip.ok, true);
});

test('restore: restored folders must overlap backup company names', () => {
  const miss = lineageMatchesRestoredFolders([{ name: 'Acme' }, { name: 'Beta' }], ['OtherCo']);
  assert.equal(miss.ok, false);
  const hit = lineageMatchesRestoredFolders([{ name: 'Acme' }, { name: 'Beta' }], ['Beta']);
  assert.equal(hit.ok, true);
  const empty = lineageMatchesRestoredFolders([{ name: 'Acme' }], []);
  assert.equal(empty.ok, false);
  const byFolder = lineageMatchesRestoredFolders([{ name: 'Acme Ltd', folder: 'AcmeLtd' }], ['AcmeLtd']);
  assert.equal(byFolder.ok, true);
});

test('retention: failed backups are not in the successful list; keep latest 3', () => {
  const extras = pickRetentionDeletes([
    { id: '1', completed_at: 10 },
    { id: '2', completed_at: 20 },
    { id: '3', completed_at: 30 },
    { id: '4', completed_at: 40 },
  ], 3);
  assert.deepEqual(extras.map((x) => x.id).sort(), ['1']);
});

test('device secret hashes and verifies', async () => {
  const secret = generateDeviceSecret();
  const hash = await hashSecret(secret);
  assert.equal(await verifySecret(secret, hash), true);
  assert.equal(await verifySecret('nope', hash), false);
  assert.notEqual(hashToken('ABC'), hashToken('ABD'));
});

test('capability registry: Admin template excludes OWNER-only keys', () => {
  const adminKeys = new Set(defaultKeysForTemplate('ADMIN'));
  for (const k of ownerOnlyKeys()) {
    assert.equal(adminKeys.has(k), false, `Admin must not include ${k}`);
  }
  for (const k of adminProtectedKeys()) {
    assert.equal(adminKeys.has(k), true, `Admin must include protected ${k}`);
  }
});

test('capability registry: builtin system_keys are unique and non-display', () => {
  const keys = BUILTIN_ROLE_DEFS.map((d) => d.system_key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('ADMIN'));
  assert.ok(keys.includes('ACCOUNTANT'));
  assert.ok(keys.includes('SALES'));
  assert.ok(keys.includes('COLLECTION'));
  assert.ok(keys.includes('INVENTORY'));
  assert.ok(keys.includes('VIEWER'));
  assert.ok(keys.includes('AUDITOR'));
  assert.ok(getCapability('tally.pair')?.protected_authority === 'OWNER_OR_ADMIN_ROLE');
  assert.ok(getCapability('sales_invoice.create')?.supports_entry_mode === true);
  assert.equal(getCapability('sales_invoice.edit'), null); // LOCKED: no generic edit
  assert.equal(getCapability('sales_invoice.delete'), null); // LOCKED: no generic delete
});

test('authorize decision shape helpers: unknown capability key is falsy in registry', () => {
  assert.equal(getCapability('not.a.real.capability'), null);
});

test('authorize: Owner membership always ALLOW', () => {
  assert.deepEqual(
    membershipAuthzGate({ id: 'm1', membership_type: 'OWNER', status: 'ACTIVE' }),
    { decision: 'ALLOW' }
  );
  assert.deepEqual(
    membershipAuthzGate({ id: 'm2', membership_type: 'OWNER', status: 'SUSPENDED' }),
    { decision: 'DENY', reason: 'MEMBERSHIP_SUSPENDED' }
  );
  assert.equal(
    membershipAuthzGate({ id: 'm3', membership_type: 'MEMBER', status: 'ACTIVE', role_id: 'r1' }),
    null
  );
  assert.deepEqual(membershipAuthzGate(null), { decision: 'DENY', reason: 'NO_MEMBERSHIP' });
});
