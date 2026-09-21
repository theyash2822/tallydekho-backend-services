/**
 * Universal Demo — identity, eligibility and the private simulated-entry layer.
 *
 * Demo is the known-good accounting fixture the rest of QA is measured against,
 * so these pin the properties that make it trustworthy: it is one dataset, it is
 * identified by a flag rather than by a name, a paired workspace never falls
 * back to it, and a user's practice entries cannot touch it or each other.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isDemoCompany,
  isDemoEligible,
  isDemoContext,
  filterCompaniesByPairingStatus,
  CANONICAL_DEMO_GUID,
  SYSTEM_DEMO_WORKSPACE_ID,
} from '../services/demoDataService.js';
import { DEMO_ENTRY_TYPES, toMyEntriesRow } from '../services/demoSimulatedEntryService.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Demo identity', () => {
  it('a real company named "Demo Traders" is not Demo', () => {
    // The whole reason the flag exists. Name matching hid a customer's real
    // company the moment Tally connected, and exempted it from the guards that
    // treat Demo as special.
    assert.equal(isDemoCompany({ name: 'Demo Traders', guid: 'a1b2c3d4-real', is_demo: false }), false);
    assert.equal(isDemoCompany({ name: 'Demo Company Pvt Ltd', guid: 'real-guid', is_demo: false }), false);
    assert.equal(isDemoCompany({ name: 'DEMOLITION SUPPLIES', is_demo: false }), false);
  });

  it('the flag decides, and outranks the name', () => {
    assert.equal(isDemoCompany({ name: 'Anything At All', is_demo: true }), true);
    assert.equal(isDemoCompany({ name: 'Demo Company', is_demo: false }), false);
  });

  it('a bare GUID falls back to the reserved prefix, never the name', () => {
    assert.equal(isDemoCompany(CANONICAL_DEMO_GUID), true);
    assert.equal(isDemoCompany('a1b2c3d4-e5f6-7890-abcd-ef1234567890'), false);
  });

  it('name-prefix classification is gone from the source', () => {
    // Comments still describe the old rule, which is the point of them; only
    // executable lines matter here.
    const code = read('services/demoDataService.js')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/name\.startsWith\(['"]demo['"]\)/.test(code),
      'name-prefix matching must not decide Demo identity'
    );
  });

  it('isDemoContext is the single hook billing will use', () => {
    assert.equal(isDemoContext({ authz: { demoMode: true } }), true);
    assert.equal(isDemoContext({ company: { is_demo: true } }), true);
    assert.equal(isDemoContext({ company: { is_demo: false } }), false);
    assert.equal(isDemoContext(null), false);
  });
});

describe('Demo eligibility follows pairing, not connectivity', () => {
  it('only a never-paired workspace gets Demo', () => {
    assert.equal(isDemoEligible('UNPAIRED'), true);
    assert.equal(isDemoEligible(undefined), true, 'unknown status fails closed to Demo');
  });

  it('a paired workspace keeps its real books even when the Desktop is away', () => {
    // RECONNECTING used to route to Demo, so closing the Desktop hid the
    // customer's own companies and 403'd their synced history.
    for (const status of ['CONNECTED', 'RECONNECTING', 'OFFLINE', 'CLAIMED']) {
      assert.equal(isDemoEligible(status), false, `${status} must not be Demo-eligible`);
    }
  });

  it('company lists never mix Demo with real books', () => {
    const list = [
      { name: 'Demo Company', is_demo: true },
      { name: 'Acme Pvt Ltd', is_demo: false },
    ];
    assert.deepEqual(filterCompaniesByPairingStatus(list, 'UNPAIRED').map((c) => c.name), ['Demo Company']);
    assert.deepEqual(filterCompaniesByPairingStatus(list, 'CONNECTED').map((c) => c.name), ['Acme Pvt Ltd']);
    assert.deepEqual(filterCompaniesByPairingStatus(list, 'RECONNECTING').map((c) => c.name), ['Acme Pvt Ltd']);
  });

  it('real data stays readable while the Desktop is offline', () => {
    const src = read('middleware/companyAccess.js');
    assert.match(
      src,
      /if \(!demoRow && isDemoEligible\(pairingStatus\)\)/,
      'the real-data gate must key on eligibility, not live connectivity'
    );
    assert.ok(
      !/!demoRow && pairingStatus !== 'CONNECTED'/.test(src),
      'denying real data whenever the Desktop is not connected is the bug'
    );
  });
});

describe('Canonical Demo is one dataset', () => {
  it('there is a single reserved GUID and system workspace', () => {
    assert.equal(CANONICAL_DEMO_GUID, 'dddddddd-dddd-4ddd-8ddd-000000000001');
    assert.equal(SYSTEM_DEMO_WORKSPACE_ID, 'system-demo-workspace');
  });

  it('the per-workspace GUID scheme survives only for cleanup', () => {
    const src = read('services/demoDataService.js');
    assert.match(src, /legacyDemoGuidForWorkspace/, 'cleanup needs to recognise old rows');
    assert.ok(
      !/export function demoCompanyGuidForWorkspace/.test(src),
      'the per-workspace generator must not be callable as a live path'
    );
  });

  it('unpaired list and access project the system Demo company', () => {
    const companiesRoute = read('routes/api-v1.js');
    const getCompanies = companiesRoute.slice(companiesRoute.indexOf("router.get('/companies'"));
    assert.match(getCompanies, /loadCanonicalDemoCompany/, 'GET /api/companies must project Demo');
    assert.match(getCompanies, /is_demo: true/, 'the projected row must carry is_demo');
    const access = read('middleware/companyAccess.js');
    assert.match(access, /resolveCompanyForUserWorkspace/, 'data routes must accept the projected Demo GUID');
    const resolver = read('services/demoDataService.js');
    const fn = resolver.slice(resolver.indexOf('export async function resolveCompanyForUserWorkspace'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    assert.match(body, /isDemoEligible/, 'projected Demo is only for unpaired workspaces');
    assert.match(body, /loadCanonicalDemoCompany/);
  });

  it('the seeded row is marked is_demo', () => {
    const src = read('services/demoDataService.js');
    assert.match(src, /gst_taxpayer_type, is_demo\)/);
    assert.match(src, /'Regular', TRUE\)/);
  });

  it('the reseed-on-every-call bug cannot return', () => {
    // The old guard selected guid and name then read demoRows[0].id, which is
    // undefined, so its voucher count was always zero and it reseeded the whole
    // fixture on every company-list fetch.
    const src = read('services/demoDataService.js');
    const fn = src.slice(src.indexOf('export async function ensureCanonicalDemoCompany'));
    const body = fn.slice(0, fn.indexOf('\nexport '));
    assert.match(body, /SELECT id, guid, name FROM companies/, 'the guard must select id');
    assert.match(body, /skipped: true/, 'an already-seeded fixture must short-circuit');
  });
});

describe('Private simulated Demo entries', () => {
  it('are their own table, not write_queue', () => {
    // write_queue couples workspace and company — the Desktop claim resolves
    // companies WHERE guid = ? AND workspace_id = ? — and the canonical Demo
    // belongs to the system workspace, not the user's. Reusing it would have
    // made "Demo never reaches a Desktop" depend on a status string.
    const schema = read('db/workspaceSchema.js');
    assert.match(schema, /CREATE TABLE IF NOT EXISTS demo_simulated_entries/);
    assert.match(schema, /status = 'DEMO_SIMULATED'/, 'status is constrained, not conventional');
  });

  it('never claim to have reached Tally', () => {
    const row = toMyEntriesRow({
      id: 7, entry_type: 'sales_invoice', title: 'x', amount: '100.00',
      entry_date: '2026-09-18', workspace_id: 'ws', created_at: 1,
    });
    assert.equal(row.source, 'DEMO_SIMULATED');
    assert.equal(row.posted_to_tally, false);
    assert.equal(row.tally_voucher_number, null);
  });

  it('every query is scoped by the authenticated user', () => {
    // Ownership must live in the statement. A filter applied after the fact is
    // one refactor away from being dropped.
    const src = read('services/demoSimulatedEntryService.js');
    assert.match(src, /DELETE FROM demo_simulated_entries WHERE id = \$1 AND user_id = \$2/);
    assert.match(src, /WHERE \$\{where\}/);
    assert.match(src, /let where = 'user_id = \$1'/);
  });

  it('only known entry types are accepted', () => {
    assert.ok(DEMO_ENTRY_TYPES.has('sales_invoice'));
    assert.ok(!DEMO_ENTRY_TYPES.has('../../etc/passwd'));
    assert.ok(!DEMO_ENTRY_TYPES.has('arbitrary'));
  });

  it('no billing or Desktop path reads the table', () => {
    for (const rel of ['services/billingService.js', 'routes/tally-write.js']) {
      assert.ok(
        !read(rel).includes('demo_simulated_entries'),
        `${rel} must not touch simulated Demo entries`
      );
    }
  });
});

describe('Pairing events carry their workspace', () => {
  it('paired, unpaired and synced all include workspaceId', () => {
    const src = read('socket/socketHandler.js');
    assert.match(src, /notifyPaired: \(userId, deviceName, workspaceId\)/);
    assert.match(src, /notifySynced refused: workspaceId required/);
    assert.ok(
      !/client\.emit\('synced'/.test(src),
      'user-socket fallback for synced must stay deleted'
    );
    assert.ok(
      !/client\.emit\('paired'/.test(src),
      'user-socket fallback for paired must stay deleted'
    );
    assert.match(src, /emit\('unpaired', \{ workspaceId \}\)/);
    assert.ok(
      !/client\.emit\('unpaired', \{\}\)/.test(src),
      'a bare {} leaves the client unable to tell which workspace unpaired'
    );
  });

  it('the second-Desktop claim race returns 409, not a raw 500', () => {
    const src = read('services/workspacePairingService.js');
    assert.match(
      src,
      /if \(e\?\.code === '23505'\)[\s\S]{0,160}WORKSPACE_ALREADY_HAS_DESKTOP/,
      'the unique violation must become a clean conflict'
    );
  });
});
