import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateLineage, pickRetentionDeletes } from '../utils/tallyLineage.js';
import { generateDeviceSecret, hashSecret, verifySecret, hashToken } from '../services/deviceCredential.js';

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
