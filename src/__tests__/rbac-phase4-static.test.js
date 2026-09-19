/**
 * Static guards — reintroduction of deleted authz patterns must fail CI.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '__tests__') continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.js$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe('Phase 4 static authz guards', () => {
  it('rbas_enabled references remaining = 0 in src (except comments/tests handled)', () => {
    const files = walk(path.join(root, 'src'));
    const hits = [];
    for (const f of files) {
      if (f.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/rbas_enabled/.test(src) && !/no rbas_enabled/.test(src)) hits.push(f);
    }
    assert.deepEqual(hits, []);
  });

  it('membership_type ADMIN must not appear in src (Phase 6)', () => {
    const files = walk(path.join(root, 'src'));
    const hits = [];
    for (const f of files) {
      if (f.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/membership_type\s*===?\s*['"]ADMIN['"]/.test(src)) hits.push(path.relative(root, f));
      if (/membershipType\s*=\s*['"]ADMIN['"]/.test(src)) hits.push(path.relative(root, f));
      if (/isAdminMembership/.test(src)) hits.push(path.relative(root, f));
    }
    assert.deepEqual(hits, []);
  });

  it('companies.user_id / devices.user_id ownership writes are gone', () => {
    const files = [
      'routes/ingest.js',
      'services/workspacePairingService.js',
      'services/demoDataService.js',
    ].map((f) => path.join(root, 'src', f));
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      assert.ok(!/user_id\s*=\s*EXCLUDED\.user_id/.test(src), f);
      assert.ok(!/INSERT INTO companies\s*\([^)]*user_id/.test(src), f);
    }
  });

  it('register_desktop and /app/integrations are gone', () => {
    const socket = fs.readFileSync(path.join(root, 'src/socket/socketHandler.js'), 'utf8');
    assert.ok(!/register_desktop/.test(socket));
    const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
    assert.ok(!/\/app\/integrations/.test(server));
    assert.ok(!fs.existsSync(path.join(root, 'src/routes/integrations.js')));
    assert.ok(!fs.existsSync(path.join(root, 'src/middleware/integrationAccess.js')));
  });

  it('Phase 5: no remount of deleted /app business routers', () => {
    for (const rel of ['src/server.js', 'src/createApp.js']) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      assert.ok(!/dataRoutes/.test(src), `${rel} must not mount dataRoutes`);
      assert.ok(!/companiesRoutes/.test(src), `${rel} must not mount companiesRoutes`);
      assert.ok(!/app\.use\(['"]\/app['"],\s*pairingRoutes\)/.test(src), `${rel} must not mount pairing under /app`);
      assert.ok(!/app\.use\(['"]\/app\/ai['"]/.test(src), `${rel} must not mount /app/ai`);
    }
    assert.ok(!fs.existsSync(path.join(root, 'src/routes/data.js')));
    assert.ok(!fs.existsSync(path.join(root, 'src/routes/companies.js')));
  });

  it('Phase 5: no runtime SELECT of companies.user_id / devices.user_id', () => {
    const files = walk(path.join(root, 'src'));
    const hits = [];
    for (const f of files) {
      if (f.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/FROM\s+companies\s+WHERE\s+user_id/i.test(src) || /companies\s+WHERE\s+user_id\s*=/i.test(src)) {
        hits.push(path.relative(root, f));
      }
      if (/FROM\s+devices\s+WHERE\s+user_id/i.test(src) || /devices\s+WHERE\s+user_id\s*=/i.test(src)) {
        hits.push(path.relative(root, f));
      }
    }
    assert.deepEqual(hits, []);
  });

  // Deployment B dropped both columns, so a query naming one now errors at
  // runtime instead of quietly returning NULL.
  it('Deployment B: the schema no longer declares the legacy columns', () => {
    const schema = fs.readFileSync(path.join(root, 'src/db/schema.js'), 'utf8');
    for (const table of ['devices', 'companies']) {
      const start = schema.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
      assert.ok(start > -1, `${table} create statement not found — update this guard`);
      const ddl = schema.slice(start, schema.indexOf(');', start));
      assert.ok(!/\buser_id\b/.test(ddl), `${table} still declares user_id`);
    }
    assert.ok(!/idx_companies_user/.test(schema), 'the index on the dropped column is back');
  });

  it('Deployment B: nothing joins a device or company to its old owner column', () => {
    const files = walk(path.join(root, 'src'));
    const hits = [];
    for (const f of files) {
      if (f.includes(`${path.sep}__tests__${path.sep}`)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (/\b[dc]\.user_id\b/.test(src)) hits.push(path.relative(root, f));
    }
    assert.deepEqual(hits, []);
  });
});
