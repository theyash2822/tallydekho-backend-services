// R2 / X6: omission keeps a ledger field; an explicit empty value from a full export clears it;
// a GUID-preserving rename keeps its per-year balances; companies stay independent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupIsolatedDb, uniq } from './isolatedDb.js';

const schema = await setupIsolatedDb();
const pool = schema.getPool();
const q = (text, params) => pool.query(text, params);
const { processIngestedData } = await import('../../controllers/ingestProcessor.js');
test.after(() => pool.end());

async function makeCompany() {
  const guid = uniq('co');
  const workspaceId = uniq('ws');
  await q(`INSERT INTO workspaces (id, name) VALUES ($1, $2)`, [workspaceId, `Synthetic ${workspaceId}`]);
  const { rows } = await q(`INSERT INTO companies (guid, name, is_active, workspace_id) VALUES ($1, $2, TRUE, $3) RETURNING id`, [guid, `Synthetic ${guid}`, workspaceId]);
  return { guid, id: rows[0].id };
}
const full = (co, guid, name, extra = {}) => ({ XML: 'LedgerFull.xml', COMPANY_GUID: co.guid, GUID: guid, NAME: name, PARENT: 'Sundry Debtors', ALTERID: '5', ...extra });
const thin = (co, guid, name) => ({ XML: 'Master.xml', COMPANY_GUID: co.guid, GUID: guid, NAME: name, PARENT: 'Sundry Debtors' });
const ledger = async (co, guid) => (await q('SELECT name, gstin, email FROM ledgers WHERE company_id = $1 AND guid = $2', [co.id, guid])).rows[0];
const run = (co, rows) => processIngestedData('master', rows, co.guid, null, null, { companyId: co.id });

test('omitted fields are kept; a full export with an empty GSTIN clears it', async () => {
  const co = await makeCompany();
  const g = `${co.guid}-l1`;
  await run(co, [full(co, g, 'Shah Traders', { GSTIN: '27ABCDE1234F1Z5', LEDGEREMAIL: 'a@example.invalid' })]);
  assert.deepEqual(await ledger(co, g), { name: 'Shah Traders', gstin: '27ABCDE1234F1Z5', email: 'a@example.invalid' });
  await run(co, [thin(co, g, 'Shah Traders')]);
  assert.deepEqual(await ledger(co, g), { name: 'Shah Traders', gstin: '27ABCDE1234F1Z5', email: 'a@example.invalid' }, 'a thin row changes nothing it does not carry');
  await run(co, [full(co, g, 'Shah Traders', { GSTIN: '', LEDGEREMAIL: 'a@example.invalid' })]);
  assert.deepEqual(await ledger(co, g), { name: 'Shah Traders', gstin: null, email: 'a@example.invalid' }, 'explicit clear in Tally reaches the app');
});

test('a GUID-preserving rename moves its per-year balances; another company with the same name is untouched', async () => {
  const co = await makeCompany();
  const other = await makeCompany();
  const g = `${co.guid}-l2`;
  await run(co, [full(co, g, 'Old Name')]);
  await run(other, [full(other, `${other.guid}-l2`, 'Old Name')]);
  for (const c of [co, other]) {
    await q(`INSERT INTO ledger_fy_balances (ledger_guid, ledger_name, company_guid, financial_year, opening_balance, balance_type, synced_at, company_id)
             VALUES ($1, 'Old Name', $2, '2025-2026', 100, 'Dr', NOW(), $3)`, [`${c.guid}-l2`, c.guid, c.id]);
  }
  await run(co, [full(co, g, 'New Name')]);
  assert.equal((await ledger(co, g)).name, 'New Name');
  const names = async (c) => (await q('SELECT ledger_name FROM ledger_fy_balances WHERE company_id = $1', [c.id])).rows.map((r) => r.ledger_name);
  assert.deepEqual(await names(co), ['New Name']);
  assert.deepEqual(await names(other), ['Old Name']);
});
