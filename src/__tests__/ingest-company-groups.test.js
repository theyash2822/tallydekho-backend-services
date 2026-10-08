import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  groupRecordsByCompany,
  completeCompanyGuids,
} from '../utils/ingestCompanyGroups.js';

test('a chunk that straddles two companies is split by each record\'s own COMPANY_GUID', () => {
  const chunk = [
    { GUID: 'A-1', COMPANY_GUID: 'A' },
    { GUID: 'A-2', COMPANY_GUID: 'A' },
    { GUID: 'B-1', COMPANY_GUID: 'B' },
    { GUID: 'C-1', company_guid: 'C' },
  ];
  const { groups, missing } = groupRecordsByCompany(chunk, 'A');
  assert.equal(missing, 0);
  assert.deepEqual([...groups.keys()], ['A', 'B', 'C']);
  assert.deepEqual(groups.get('B').map((r) => r.GUID), ['B-1']);
  assert.deepEqual(groups.get('A').map((r) => r.GUID), ['A-1', 'A-2']);
});

test('records without COMPANY_GUID use the header / upload company, never the first record', () => {
  const { groups } = groupRecordsByCompany([{ COMPANY_GUID: 'B' }, { GUID: 'x' }], 'H');
  assert.deepEqual([...groups.keys()], ['B', 'H']);
});

test('records with no company and no fallback are reported as missing', () => {
  const { groups, missing } = groupRecordsByCompany([{ GUID: 'x' }, { COMPANY_GUID: 'A' }], null);
  assert.equal(missing, 1);
  assert.deepEqual([...groups.keys()], ['A']);
});

test('/ingest/complete covers every company in the upload', () => {
  assert.deepEqual(completeCompanyGuids({ companies: [{ guid: 'A' }, { guid: 'B' }, { guid: 'A' }] }, 'Z'), ['A', 'B']);
  assert.deepEqual(completeCompanyGuids({ companyGuid: 'X', companies: [{ guid: 'A' }] }, 'Z'), ['X']);
  assert.deepEqual(completeCompanyGuids({}, 'Z'), ['Z']);
  assert.deepEqual(completeCompanyGuids({}, null), []);
});
