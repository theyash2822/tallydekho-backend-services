import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSalesLikeVoucherXml } from '../utils/salesLikeVoucherXml.js';
import { PHASE0_SHAS } from './workspace-rbas-phase0.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '../../tests/fixtures/tally');

test('phase0 SHAs recorded', () => {
  assert.equal(PHASE0_SHAS.mobile.length, 40);
  assert.equal(PHASE0_SHAS.backend.length, 40);
});

test('golden Sales Invoice XML contains ENVELOPE and never Workspace id', () => {
  mkdirSync(fixtureDir, { recursive: true });
  const xml = buildSalesLikeVoucherXml({
    companyName: 'Demo Co',
    vchType: 'Sales',
    dt: '20260401',
    voucherNumber: 'SI-1',
    tdkRef: 'TDK-GOLDEN-001',
    isOptional: false,
    partyLedger: 'Cash',
    partyAmt: 1180,
    items: [{ ledger: 'Sales', amount: 1000, qty: 1, rate: 1000, godown: 'Main' }],
    taxes: [{ ledger: 'CGST', amount: 90 }, { ledger: 'SGST', amount: 90 }],
  });
  assert.match(xml, /<ENVELOPE>/);
  assert.match(xml, /<VOUCHER/);
  assert.doesNotMatch(xml, /workspace/i);
  assert.doesNotMatch(xml, /X-Workspace/i);
  const out = join(fixtureDir, 'sales_invoice_regular.golden.xml');
  writeFileSync(out, xml, 'utf8');
  const roundTrip = readFileSync(out, 'utf8');
  assert.equal(roundTrip, xml);
});

test('golden Proforma (optional) Sales XML', () => {
  const xml = buildSalesLikeVoucherXml({
    companyName: 'Demo Co',
    vchType: 'Sales',
    dt: '20260401',
    voucherNumber: 'PF-1',
    tdkRef: 'TDK-GOLDEN-PF-001',
    isOptional: true,
    partyLedger: 'Customer A',
    partyAmt: 500,
    items: [{ ledger: 'Sales', amount: 500, qty: 1, rate: 500 }],
  });
  assert.match(xml, /ISOPTIONAL>Yes/i);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, 'sales_proforma_optional.golden.xml'), xml, 'utf8');
});
