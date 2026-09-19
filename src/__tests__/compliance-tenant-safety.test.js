/**
 * Compliance tenant safety — a Tally GUID must never be the sole key.
 *
 * A Tally voucher GUID is external identity: it is unique inside one workspace
 * and nowhere else. Two customers who restore the same Tally backup end up with
 * byte-identical GUIDs, so any `WHERE guid = $1` with no company pin can load,
 * update or submit the wrong tenant's voucher. That is tolerable in a report and
 * catastrophic in an IRN/e-Way Bill submission, where the payload leaves the
 * building and reaches the government portal under someone else's GSTIN.
 *
 * These guards are deliberately source-level. The auto-IRN and auto-EWB paths
 * fire from `setImmediate` after the HTTP response, with no request in scope, so
 * there is no seam to inject a fake tenant into — the cheapest way to keep them
 * honest is to make the unsafe SQL shape itself un-writable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { retryOfflineEntries } from '../routes/tally-write.js';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

/** Source with comment lines dropped — prose about a deleted pattern is not the pattern. */
const readCode = (rel) =>
  read(rel)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

/**
 * Every SQL string literal in a file — backtick templates and quoted strings.
 *
 * Compliance SQL is written both ways in these routes, and the subquery form
 * (`tally_voucher_no = (SELECT voucher_number FROM vouchers WHERE guid=$2)`)
 * only shows up if quoted strings are scanned too.
 */
function sqlLiterals(source) {
  const out = [];
  for (const m of source.matchAll(/`([^`]*)`/g)) out.push(m[1]);
  for (const m of source.matchAll(/'((?:[^'\\\n]|\\.){20,})'/g)) out.push(m[1]);
  return out.filter((s) => /\bFROM\s+vouchers\b/i.test(s));
}

/** SQL that keys off a voucher guid but never names a company. */
function unscopedVoucherGuidSql(source) {
  return sqlLiterals(source).filter((sql) => {
    const keysOnGuid = /\b(?:[a-z]+\.)?guid\s*=\s*\$\d/i.test(sql);
    if (!keysOnGuid) return false;
    return !/\bcompany_id\b/i.test(sql);
  });
}

const COMPLIANCE_FILES = ['routes/tally-write.js', 'routes/api-v1.js', 'routes/workspaceApi.js'];

describe('Compliance voucher lookups are company-scoped', () => {
  for (const rel of COMPLIANCE_FILES) {
    it(`${rel} has no voucher lookup keyed on GUID alone`, () => {
      const offenders = unscopedVoucherGuidSql(read(rel));
      assert.deepEqual(
        offenders.map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 140)),
        [],
        `${rel}: voucher GUID is unique per company, not globally`
      );
    });
  }

  it('auto-IRN reloads the voucher pinned to the queue entry company', () => {
    const src = read('routes/tally-write.js');
    const autoIrn = src.slice(src.indexOf('// Auto-IRN'), src.indexOf('// Auto-EWB'));
    assert.ok(autoIrn.length > 200, 'auto-IRN block not found — update this guard');
    assert.match(
      autoIrn,
      /SELECT \* FROM vouchers WHERE guid = \$1 AND company_id = \$2/,
      'auto-IRN voucher reload must carry company_id'
    );
    assert.ok(
      !/SELECT \* FROM vouchers WHERE guid = \$1`/.test(autoIrn),
      'auto-IRN must not reload a voucher by GUID alone'
    );
  });

  it('auto-IRN and auto-EWB take tenant context from write_queue, not the request', () => {
    // These run after the response is sent; `req` is out of scope and reading it
    // silently yielded undefined, which widened the query instead of failing.
    const src = read('routes/tally-write.js');
    const block = src.slice(src.indexOf('// Auto-IRN'), src.indexOf('// ── TDK Reference Generator'));
    assert.ok(block.length > 200, 'auto-IRN/EWB block not found — update this guard');
    assert.ok(!/req\.company/.test(block), 'deferred compliance work must not read req.company');
  });

  it('eInvoice cancel scopes its app_vouchers subquery to the company', () => {
    const src = read('routes/api-v1.js');
    const subqueries = [...src.matchAll(/\(SELECT voucher_number FROM vouchers WHERE guid=\$\d[^)]*\)/g)]
      .map((m) => m[0]);
    assert.ok(subqueries.length > 0, 'cancel subquery not found — update this guard');
    for (const sql of subqueries) {
      assert.match(sql, /company_id=\$\d/, `unscoped cancel subquery: ${sql}`);
    }
  });
});

describe('write_queue retry cannot cross-route on a shared GUID', () => {
  it('a retry without a workspace is refused', async () => {
    await assert.rejects(
      () => retryOfflineEntries(null, 'dddddddd-shared-guid'),
      /workspaceId is required/,
      'a GUID alone can match another tenant’s queued XML'
    );
    await assert.rejects(
      () => retryOfflineEntries(null),
      /workspaceId is required/,
      'a user id is not a tenant — one user can own several workspaces'
    );
  });

  it('the retry query resolves companyGuid through companies scoped by workspace', () => {
    const src = read('routes/tally-write.js');
    const fn = src.slice(src.indexOf('export async function retryOfflineEntries'));
    assert.match(
      fn,
      /company_id IN \(SELECT id FROM companies WHERE guid = \$\$\{params\.length\} AND workspace_id = \$1\)/,
      'companyGuid filter must resolve through the workspace-owned company row'
    );
    assert.ok(
      !/workspace_id IS NULL AND user_id/.test(fn.slice(0, fn.indexOf('\n}'))),
      'the workspace-less retry fallback must not come back'
    );
  });
});

describe('Demo classification is the is_demo flag, not the company name', () => {
  it('tally-sync status does not classify by a demo name prefix', () => {
    const src = read('routes/api-v1.js');
    const executable = src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    assert.ok(
      !/LIKE\s+'demo%'/i.test(executable),
      "a real Tally company called 'Demo Traders' must not be classified as Demo"
    );
    assert.ok(
      !/guid (?:NOT )?LIKE 'dddddddd-dddd-4ddd-8ddd-%'/i.test(executable),
      'GUID-prefix matching is not Demo identity either'
    );
  });

  it('the status company resolver asks is_demo', () => {
    const src = read('routes/api-v1.js');
    const fn = src.slice(src.indexOf('async function resolveStatusCompany'));
    assert.ok(fn.length > 100, 'resolveStatusCompany not found — update this guard');
    assert.match(fn.slice(0, 1400), /is_demo/);
  });

  it('workspace reset classifies with isDemoCompany', () => {
    const src = read('services/workspaceService.js');
    assert.match(src, /isDemoCompany\(c\)/);
    assert.ok(!/\/demo\/i\.test\(c\.name/.test(src), 'reset must not name-match Demo');
  });
});

describe('One authentication architecture', () => {
  it('the 30-day sessionless token minter is gone', () => {
    const auth = read('middleware/auth.js');
    assert.ok(!/export function generateToken/.test(auth), 'generateToken must not exist');
    assert.ok(!/JWT_EXPIRES_IN \|\| '30d'/.test(auth), 'no 30-day bearer default');
  });

  it('no route imports or calls generateToken', () => {
    // The prose in auth.js explains why the minter went away, so only imports
    // and call sites count here.
    for (const rel of ['routes/auth.js', 'routes/api-v1.js', 'routes/pairing.js']) {
      const code = readCode(rel);
      assert.ok(!/^\s*import[^;]*\bgenerateToken\b/m.test(code), `${rel} still imports generateToken`);
      assert.ok(!/\bgenerateToken\s*\(/.test(code), `${rel} still calls generateToken`);
    }
  });

  it('legacy /app login issues a server-backed session', () => {
    const src = read('routes/auth.js');
    assert.match(src, /createAuthSession/);
    assert.match(src, /LEGACY-BLOCK-APP-AUTH/, 'the retained legacy surface must stay documented');
  });

  it('login no longer parks a bearer token in users.token', () => {
    for (const rel of ['routes/auth.js', 'routes/api-v1.js']) {
      const src = read(rel);
      assert.ok(
        !/UPDATE users SET[^`']*\btoken\s*=\s*\$\d/.test(src),
        `${rel}: users.token is a dead credential column`
      );
    }
  });
});

describe('Compliance helpers take the internal company id, not the Tally GUID', () => {
  // company_id is a bigint. Passing the GUID meant the lookups matched nothing,
  // so the IRP payload carried no GST details and no line items.
  it('generateIRN refuses a non-numeric company', async () => {
    const { generateIRN } = await import('../utils/irnGenerator.js');
    await assert.rejects(
      () => generateIRN('dddddddd-dddd-4ddd-8ddd-000000000001', { guid: 'v1' }, {}, {}),
      /numeric companyId is required/
    );
  });

  it('generateEWB refuses a non-numeric company', async () => {
    const { generateEWB } = await import('../utils/ewbGenerator.js');
    await assert.rejects(
      () =>
        generateEWB('dddddddd-dddd-4ddd-8ddd-000000000001', { guid: 'v1' }, {}, {}, {
          dispatch_from: 'A',
          ship_to: 'B',
          transport_mode: 'Road',
        }),
      /numeric companyId is required/
    );
  });

  it('no caller hands a guid variable to either generator', () => {
    for (const rel of ['routes/api-v1.js', 'routes/tally-write.js']) {
      const code = readCode(rel);
      for (const m of code.matchAll(/generate(?:IRN|EWB)\(\s*([A-Za-z_$][\w$]*)/g)) {
        assert.ok(
          !/guid/i.test(m[1]),
          `${rel}: generate*(${m[1]}) passes a GUID where company_id is required`
        );
      }
    }
  });

  it('compliance detail rows are keyed by company_id, not company_guid', () => {
    const code = readCode('routes/api-v1.js');
    const conflicts = [...code.matchAll(/ON CONFLICT \(([^)]*)\) DO UPDATE/g)].map((m) => m[1]);
    const guidKeyed = conflicts.filter((c) => /voucher_guid/.test(c) && !/company_id/.test(c));
    assert.deepEqual(guidKeyed, [], 'a Tally GUID repeats across workspaces and cannot key a row');
  });

  it('the e-Way Bill cancel reports 404 when it cancelled nothing', () => {
    const code = readCode('routes/api-v1.js');
    const route = code.slice(code.indexOf("router.post('/ewaybills/cancel'"));
    const body = route.slice(0, route.indexOf('\n});'));
    assert.match(body, /rowCount/, 'cancel must check that a row was actually cancelled');
    assert.match(body, /EWB_NOT_FOUND/);
    assert.ok(
      !/UPDATE e_way_bill_details[^`]*`,[^)]*\)\.catch\(\(\) => \{\}\)/.test(body),
      'the cancel UPDATE must not swallow its own failure'
    );
  });
});

describe('Credentials do not reach the logs', () => {
  // An OTP is valid for five minutes; a log line holding it is readable for as
  // long as the log is retained. devOtpSuffix() drops it outside development.
  it('no source interpolates an OTP straight into a log line', () => {
    const files = fs
      .readdirSync(path.join(srcRoot, 'routes'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `routes/${f}`)
      .concat(['services/sms.js', 'services/whatsapp.js', 'services/notifications.js']);
    const hits = [];
    for (const rel of files) {
      const full = path.join(srcRoot, rel);
      if (!fs.existsSync(full)) continue;
      for (const line of readCode(rel).split('\n')) {
        if (!/console\.(log|warn|error|info)/.test(line)) continue;
        if (/\$\{\s*(?!devOtpSuffix)[A-Za-z_$][\w$]*[Oo][Tt][Pp][\w$]*\s*\}/.test(line)) {
          hits.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
});

describe('Dangerous maintenance routes are not in the runtime API', () => {
  const gone = [
    ['routes/api-v1.js', "'/admin/backfill-stock-voucher-types'"],
    ['routes/api-v1.js', "'/admin/backfill-gst'"],
    ['routes/tally-write.js', "'/debug/alter-probe'"],
  ];
  for (const [rel, route] of gone) {
    it(`${route} is removed from ${rel}`, () => {
      assert.ok(!read(rel).includes(route), `${route} must not be reachable over HTTP`);
    });
  }

  it('reseedAllDemoCompanies is deleted', () => {
    assert.ok(!/reseedAllDemoCompanies/.test(read('services/demoDataService.js')));
  });
});
