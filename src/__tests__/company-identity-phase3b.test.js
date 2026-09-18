/**
 * Phase 3B/3C/3D — stamp deleted; rewrite deleted; explicit writers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Company Identity dual-write / rewrite retirement', () => {
  it('rewriteInsertWithCompanyId is deleted', () => {
    const dual = fs.readFileSync(path.join(root, 'utils/ingestCompanyDualWrite.js'), 'utf8');
    assert.ok(!dual.includes('export function rewriteInsertWithCompanyId'));
    const src = fs.readFileSync(path.join(root, 'controllers/ingestProcessor.js'), 'utf8');
    assert.ok(!src.includes('rewriteInsertWithCompanyId'));
    assert.ok(!src.includes('stampCompanyIdAfterIngest'));
  });

  it('assertCompanyAccess uses company_id only (no company_guid OR)', () => {
    const src = fs.readFileSync(path.join(root, 'services/scopeService.js'), 'utf8');
    const idx = src.indexOf('export async function assertCompanyAccess');
    const block = src.slice(idx, idx + 1200);
    assert.ok(block.includes('company_id = $2'));
    assert.ok(!block.includes('company_guid = $2') || !block.includes('OR company_guid'));
  });

  it('verifyCompanyAccess attaches req.company', () => {
    const src = fs.readFileSync(path.join(root, 'middleware/companyAccess.js'), 'utf8');
    assert.ok(src.includes('req.company = {'));
    assert.ok(src.includes('tallyGuid:'));
  });
});
