/**
 * Phase 3C/3D — explicit ingest writers + ownership helpers.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('Company Identity Phase 3C/3D', () => {
  it('ingestProcessor INSERTs include explicit company_id + currentCompanyId()', () => {
    const src = fs.readFileSync(path.join(root, 'controllers/ingestProcessor.js'), 'utf8');
    assert.ok(src.includes('currentCompanyId()'));
    assert.ok(/INSERT INTO ledgers[\s\S]*company_id\)/.test(src));
    assert.ok(/INSERT INTO vouchers[\s\S]*company_id\)/.test(src));
    assert.ok(/INSERT INTO stocks[\s\S]*company_id\)/.test(src));
    assert.ok(src.includes('wrapIngestClient'));
  });

  it('rewriteInsertWithCompanyId is deleted (Phase 3D)', () => {
    const dual = fs.readFileSync(path.join(root, 'utils/ingestCompanyDualWrite.js'), 'utf8');
    assert.ok(!dual.includes('export function rewriteInsertWithCompanyId'));
    const src = fs.readFileSync(path.join(root, 'controllers/ingestProcessor.js'), 'utf8');
    assert.ok(src.includes('currentCompanyId()'));
  });

  it('api-v1 uses requireResolvedCompanyId after verify', () => {
    const src = fs.readFileSync(path.join(root, 'routes/api-v1.js'), 'utf8');
    assert.ok(src.includes('requireResolvedCompanyId'));
    assert.ok(src.includes('WHERE company_id='));
  });

  it('workspace_id NOT NULL + FK RESTRICT present in schema init', () => {
    const src = fs.readFileSync(path.join(root, 'db/schema.js'), 'utf8');
    assert.ok(src.includes("ALTER COLUMN workspace_id SET NOT NULL"));
    assert.ok(src.includes('ON DELETE RESTRICT'));
    assert.ok(src.includes('uq_mca_membership_company_id') || src.includes('member_company_access_pkey'));
  });
});
