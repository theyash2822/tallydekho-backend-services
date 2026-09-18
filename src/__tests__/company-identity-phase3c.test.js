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

  it('no write to companies is keyed on guid alone', () => {
    // A Tally GUID is unique only within a workspace, so `UPDATE companies ...
    // WHERE guid = $1` reaches every tenant that happens to sync the same Tally
    // company. Four such statements existed: the company profile update (GSTIN,
    // address), the logo upload, the opening-balance difference written during
    // ingest, and the legacy no-workspace branch of company activation.
    //
    // Writes must be scoped by internal id, or by workspace_id/device_id where a
    // set of companies is being addressed.
    const files = [
      'routes/api-v1.js',
      'routes/ingest.js',
      'controllers/ingestProcessor.js',
      'services/hardSyncService.js',
      'services/companyPurge.js',
    ];

    const offenders = [];
    for (const rel of files) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) continue;
      const src = fs.readFileSync(full, 'utf8');
      const re = /(UPDATE|DELETE FROM)\s+companies\b[\s\S]{0,400}?WHERE([\s\S]{0,300}?)(?=`|;|\n\s*\n)/gi;
      let m;
      while ((m = re.exec(src))) {
        const where = m[2];
        if (!/guid/i.test(where)) continue;
        const scoped = /\bid\s*=|workspace_id|device_id/i.test(where);
        if (!scoped) {
          offenders.push(`${rel}: ${m[0].replace(/\s+/g, ' ').slice(0, 110)}`);
        }
      }
    }

    assert.deepEqual(offenders, [], `writes to companies keyed on guid alone:\n${offenders.join('\n')}`);
  });

  it('company profile and logo updates target the internal id', () => {
    // The profile update compared the guid column against companyId, an integer,
    // so it matched no rows and every edit was discarded behind a success
    // response. Pin the column it keys on.
    const src = fs.readFileSync(path.join(root, 'routes/api-v1.js'), 'utf8');
    assert.match(src, /UPDATE companies SET logo_url=\$1 WHERE id=\$2/);
    assert.match(src, /email = COALESCE\(\$5, email\)\s*\n\s*WHERE id = \$6/);
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
