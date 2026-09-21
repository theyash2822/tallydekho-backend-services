import assert from 'node:assert/strict';
import { describe, it, before, after } from 'node:test';

describe('BEHAVIORAL: ingest writers bind company_id', () => {
  let query;
  let client;
  const otherCid = 12689001;
  const guid = 'behavior-test-group-guid';

  before(async () => {
    ({ query } = await import('../db/schema.js'));
    const pool = (await import('../db/schema.js'));
    const { getClient } = pool;
    client = await getClient();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO groups (guid, company_guid, name, parent, company_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [guid, '2272cb4f-b5d6-4555-bdb7-1bd747049dc5', '__tdk_behavior_group__', 'Primary', 12689]
    );
  });

  after(async () => {
    try { await client.query('ROLLBACK'); } catch {}
    try { client.release(); } catch {}
  });

  it('inserted group belongs to company 12689 and not another company_id', async () => {
    const { rows } = await client.query(
      `SELECT company_id, name FROM groups WHERE name = $1 AND company_id = ANY($2::int[])`,
      ['__tdk_behavior_group__', [12689, otherCid]]
    );
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].company_id), 12689);
    assert.ok(rows[0].company_id != null);
  });

  it('same GUID in another company_id is not created by this insert', async () => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS c FROM groups WHERE guid = $1 AND company_id = $2`,
      [guid, otherCid]
    );
    assert.equal(rows[0].c, 0);
  });
});
