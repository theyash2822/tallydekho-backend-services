/**
 * Write-back XML escaping (finding W3).
 *
 * Pure: no DB, no dotenv, no server.
 * Run: node --test src/__tests__/xml-escape.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmlText, xmlAttr } from '../utils/xmlEscape.js';
import {
  buildSalesLikeVoucherXml,
  buildMinimalVoucherAlterXml,
  buildVoucherCancelXml,
  buildSalesVoucherLinesXml,
} from '../utils/salesLikeVoucherXml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(__dirname, rel), 'utf8');

const NASTY = 'A & B <x> "q"';
const NASTY_ESC = 'A &amp; B &lt;x&gt; &quot;q&quot;';

const count = (haystack, needle) => haystack.split(needle).length - 1;

for (const [label, fn] of [['xmlText', xmlText], ['xmlAttr', xmlAttr]]) {
  test(`${label}: escapes the five XML specials`, () => {
    assert.equal(fn('&'), '&amp;');
    assert.equal(fn('<'), '&lt;');
    assert.equal(fn('>'), '&gt;');
    assert.equal(fn('"'), '&quot;');
    assert.equal(fn("'"), '&apos;');
    assert.equal(fn(NASTY), NASTY_ESC);
  });

  test(`${label}: preserves Unicode, newlines, numbers`, () => {
    assert.equal(fn('नमस्ते'), 'नमस्ते');
    assert.equal(fn('₹ 1,000'), '₹ 1,000');
    assert.equal(fn('line1\nline2\r\nline3'), 'line1\nline2\r\nline3');
    assert.equal(fn(1180.5), '1180.5');
    assert.equal(fn(0), '0');
    assert.equal(fn('20260401'), '20260401');
  });

  test(`${label}: literal entity-like text is escaped once`, () => {
    assert.equal(fn('&amp;'), '&amp;amp;');
    assert.equal(fn('&lt;b&gt;'), '&amp;lt;b&amp;gt;');
  });

  test(`${label}: null / undefined → empty string`, () => {
    assert.equal(fn(null), '');
    assert.equal(fn(undefined), '');
  });
}

const nastyVoucher = {
  companyName: NASTY,
  vchType: NASTY,
  action: 'Create',
  dt: '20260401',
  voucherNumber: NASTY,
  tdkRef: 'TDK-SAL-2026-0001',
  isOptional: false,
  narration: `${NASTY}\nनमस्ते ₹`,
  partyLedger: NASTY,
  partyAmt: 1180,
  items: [{
    itemName: NASTY,
    billedQty: 1,
    actualQty: 1,
    rate: 1000,
    amount: 1000,
    unit: 'nos',
    salesLedger: NASTY,
    godown: NASTY,
  }],
  taxes: [{ ledgerName: NASTY, taxAmount: 180, taxableValue: 1000 }],
};

test('buildSalesLikeVoucherXml escapes company, voucher type, number, party, item, ledgers', () => {
  const xml = buildSalesLikeVoucherXml(nastyVoucher);
  assert.ok(!xml.includes('A & B'), 'raw ampersand text must not reach the XML');
  assert.ok(!xml.includes('<x>'), 'raw angle brackets must not reach the XML');
  assert.ok(!xml.includes('&amp;amp;'), 'nothing may be double-escaped');
  assert.ok(xml.includes(`<SVCURRENTCOMPANY>${NASTY_ESC}</SVCURRENTCOMPANY>`));
  assert.ok(xml.includes(`VCHTYPE="${NASTY_ESC}"`));
  assert.ok(xml.includes(`<VOUCHERTYPENAME>${NASTY_ESC}</VOUCHERTYPENAME>`));
  assert.ok(xml.includes(`<VOUCHERNUMBER>${NASTY_ESC}</VOUCHERNUMBER>`));
  assert.ok(xml.includes(`<PARTYLEDGERNAME>${NASTY_ESC}</PARTYLEDGERNAME>`));
  assert.ok(xml.includes(`<STOCKITEMNAME>${NASTY_ESC}</STOCKITEMNAME>`));
  assert.ok(xml.includes(`<GODOWNNAME>${NASTY_ESC}</GODOWNNAME>`));
  assert.ok(xml.includes(`<NARRATION>${NASTY_ESC}\nनमस्ते ₹</NARRATION>`));
  assert.ok(xml.includes('<AMOUNT>-1180</AMOUNT>'));
  assert.ok(xml.includes('<DATE>20260401</DATE>'));
});

test('buildSalesLikeVoucherXml: literal "&amp;" typed by a user arrives as &amp;amp;', () => {
  const xml = buildSalesLikeVoucherXml({ ...nastyVoucher, companyName: 'R&amp;D', partyLedger: 'R&amp;D' });
  assert.ok(xml.includes('<SVCURRENTCOMPANY>R&amp;amp;D</SVCURRENTCOMPANY>'));
  assert.ok(xml.includes('<PARTYLEDGERNAME>R&amp;amp;D</PARTYLEDGERNAME>'));
});

test('buildMinimalVoucherAlterXml escapes company and voucher type', () => {
  const xml = buildMinimalVoucherAlterXml({
    companyName: NASTY, vchType: NASTY, dt: '20260401', masterId: '8559', narration: NASTY,
  });
  assert.ok(!xml.includes('A & B'));
  assert.ok(xml.includes(`<SVCURRENTCOMPANY>${NASTY_ESC}</SVCURRENTCOMPANY>`));
  assert.ok(xml.includes(`VCHTYPE="${NASTY_ESC}"`));
  assert.equal(count(xml, NASTY_ESC), 3);
});

test('buildVoucherCancelXml escapes company, voucher type, voucher number', () => {
  const xml = buildVoucherCancelXml({
    companyName: NASTY, vchType: NASTY, dt: '20260401', masterId: '8559', voucherNumber: NASTY,
  });
  assert.ok(!xml.includes('A & B'));
  assert.ok(xml.includes(`<SVCURRENTCOMPANY>${NASTY_ESC}</SVCURRENTCOMPANY>`));
  assert.ok(xml.includes(`VCHTYPE="${NASTY_ESC}"`));
  assert.ok(xml.includes(`<VOUCHERTYPENAME>${NASTY_ESC}</VOUCHERTYPENAME>`));
  assert.ok(xml.includes(`<VOUCHERNUMBER>${NASTY_ESC}</VOUCHERNUMBER>`));
});

test('buildSalesVoucherLinesXml escapes party, item, ledgers once', () => {
  const xml = buildSalesVoucherLinesXml({
    partyLedger: NASTY, partyAmt: 1180, tdkRef: 'TDK-1',
    items: nastyVoucher.items, taxes: nastyVoucher.taxes,
  });
  assert.ok(!xml.includes('A & B'));
  assert.ok(!xml.includes('&amp;amp;'));
  assert.ok(xml.includes(`<LEDGERNAME>${NASTY_ESC}</LEDGERNAME>`));
  assert.ok(xml.includes(`<STOCKITEMNAME>${NASTY_ESC}</STOCKITEMNAME>`));
});

test('source: local escapers delegate to xmlEscape.js', () => {
  const tw = read('../routes/tally-write.js');
  const sl = read('../utils/salesLikeVoucherXml.js');
  assert.match(tw, /from '\.\.\/utils\/xmlEscape\.js'/);
  assert.match(sl, /from '\.\/xmlEscape\.js'/);
  assert.match(tw, /const escapeXml = xmlText;/);
  assert.match(tw, /const escXml = xmlText;/);
  assert.match(sl, /const xmlEsc = xmlText;/);
  assert.doesNotMatch(tw, /\.replace\(\/\[<>&"\]\/g/, 'no inline four-char escaper bodies remain');
  assert.doesNotMatch(tw, /replace\(\/&\/g,\s*'&amp;'\)/, 'no inline replace chain escaper remains');
  assert.doesNotMatch(sl, /\.replace\(\/\[<>&"\]\/g/);
  for (const m of tw.matchAll(/const esc = (.+);/g)) {
    assert.equal(m[1], 'xmlText', `per-route esc must delegate, found: ${m[1]}`);
  }
});

test('source: no raw companyName / user text in write-back templates', () => {
  const tw = read('../routes/tally-write.js');
  const sl = read('../utils/salesLikeVoucherXml.js');
  for (const src of [tw, sl]) {
    assert.doesNotMatch(src, /<SVCURRENTCOMPANY>\$\{companyName\}<\/SVCURRENTCOMPANY>/);
    assert.doesNotMatch(src, /VCHTYPE="\$\{(vchType|voucherType)\}"/);
    assert.doesNotMatch(src, /<VOUCHERTYPENAME>\$\{(vchType|voucherType)\}<\/VOUCHERTYPENAME>/);
    assert.doesNotMatch(src, /<(PARTYLEDGERNAME|LEDGERNAME)>\$\{(partyLedger|bankLedger)\}</);
    assert.doesNotMatch(src, /<STOCKITEMNAME>\$\{item\.itemName\}</);
    assert.doesNotMatch(src, /<LEDGERNAME>\$\{(tax|lg|lt)\.ledgerName\}</);
    assert.doesNotMatch(src, /<GODOWNNAME>\$\{item\.godown/);
    assert.doesNotMatch(src, /<VOUCHERNUMBER>\$\{(voucherNumber|effectiveVoucherNumber)/);
    assert.doesNotMatch(src, /<NARRATION>\$\{(narration|fullNarration)/);
  }
  assert.doesNotMatch(tw, /GODOWN NAME="\$\{name\}"/);
  assert.doesNotMatch(tw, /STOCKITEM ACTION="Alter" NAME="\$\{existingName\}"/);
  assert.doesNotMatch(tw, /<BASICFINALDESTINATION>\$\{dd\.ship_to\}</);
});
