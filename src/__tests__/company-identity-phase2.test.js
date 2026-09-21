/**
 * Company Identity Phase 2 — static security contracts (no DB).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('Company Identity Phase 2 containment contracts', () => {
  it('deviceCompanyResolution exports resolve + conflict assert', async () => {
    const mod = await import('../services/deviceCompanyResolution.js');
    assert.equal(typeof mod.resolveCompanyForDevice, 'function');
    assert.equal(typeof mod.assertCompanyGuidAvailableForWorkspace, 'function');
    assert.equal(typeof mod.CompanyResolutionError, 'function');
  });

  it('init-sync uses workspace-scoped company upsert (never force-reassigns workspace_id)', () => {
    const src = read('routes/ingest.js');
    assert.ok(src.includes('assertCompanyGuidAvailableForWorkspace'));
    assert.ok(src.includes('ON CONFLICT (workspace_id, guid)'));
    assert.ok(
      !src.includes('UPDATE companies SET workspace_id = $1 WHERE guid = ANY'),
      'forced workspace reassignment must be removed'
    );
    assert.ok(
      !src.includes('ON CONFLICT (guid) DO UPDATE'),
      'global ON CONFLICT (guid) must be removed'
    );
  });

  it('chunk and sync-run/start resolve company for device before write', () => {
    const src = read('routes/ingest.js');
    assert.ok(src.includes("router.post('/ingest/chunk'"));
    assert.ok(src.includes("router.post('/ingest/sync-run/start'"));
    const chunkIdx = src.indexOf("router.post('/ingest/chunk'");
    const chunkBlock = src.slice(chunkIdx, chunkIdx + 3500);
    assert.ok(chunkBlock.includes('resolveCompanyForDevice'));
    assert.ok(chunkBlock.includes('COMPANY_GUID_REQUIRED') || chunkBlock.includes('companyGuid'));
    const startIdx = src.indexOf("router.post('/ingest/sync-run/start'");
    const startBlock = src.slice(startIdx, startIdx + 1200);
    assert.ok(startBlock.includes('resolveCompanyForDevice'));
  });

  it('payment-mode uses resolveCompanyInWorkspace (no assertCompanyInWorkspace helper)', () => {
    const src = read('services/workspaceService.js');
    assert.ok(!src.includes('async function assertCompanyInWorkspace'));
    assert.ok(src.includes('resolveCompanyInWorkspace'));
    assert.ok(!src.includes('OR user_id'), 'user_id ownership fallback must stay deleted');
  });

  it('companyInWorkspace is exported and does not fall back to user_id', () => {
    const src = read('middleware/companyAccess.js');
    assert.ok(src.includes('export async function companyInWorkspace'));
    assert.ok(src.includes('resolveCompanyForUserWorkspace'));
    assert.ok(!src.includes('OR c.user_id') && !src.includes('OR user_id'));
    const resolver = read('services/demoDataService.js');
    assert.match(
      resolver,
      /WHERE guid = \$1 AND workspace_id = \$2/,
      'own-workspace match stays workspace_id + guid'
    );
  });
});
