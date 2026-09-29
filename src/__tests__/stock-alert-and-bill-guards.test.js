/**
 * Daily stock-alert job: per-kind capability gate + HTML-escaped email body.
 * Bill analyzer: rule-based bill scoring and GSTIN check digit (no OCR/network).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml, STOCK_ALERT_CAPABILITY } from '../services/stockAlertDispatch.js';
import { getCapability } from '../services/capabilityRegistry.js';
import { scoreBillText, isValidGstin } from '../services/billDocumentAnalyzer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dispatchSrc = fs.readFileSync(path.resolve(__dirname, '../services/stockAlertDispatch.js'), 'utf8');

describe('stock alert job', () => {
  it('escapes HTML special characters', () => {
    assert.equal(escapeHtml(`<b>Oil & "Gas"</b> 'x'`), '&lt;b&gt;Oil &amp; &quot;Gas&quot;&lt;/b&gt; &#39;x&#39;');
    assert.equal(escapeHtml(null), '');
  });

  it('maps every alert kind to a registered capability', () => {
    for (const kind of ['low_stock', 'negative_stock', 'expiry']) {
      const key = STOCK_ALERT_CAPABILITY[kind];
      assert.ok(key, `missing capability for ${kind}`);
      assert.ok(getCapability(key), `capability ${key} not in registry`);
    }
  });

  it('gates each alert kind and escapes the email body', () => {
    for (const kind of ['low_stock', 'negative_stock', 'expiry']) {
      assert.match(dispatchSrc, new RegExp(`canReceiveStockAlert\\(user\\.id, co, '${kind}'\\)`));
    }
    assert.match(dispatchSrc, /escapeHtml\(payload\.body\)/);
    assert.match(dispatchSrc, /ORDER BY c\.id ASC/);
  });
});

describe('bill analyzer scoring', () => {
  const bill = `ACME LTD\nTAX INVOICE\nGSTIN: 27AAPFU0939F1ZV\nInvoice No: AIL/2026/0457 Date: 15/09/2026\nHSN 3808\nCGST 9% 882.00\nSGST 9% 882.00\nGrand Total 11,564.00`;

  it('accepts a GST bill and extracts candidates', () => {
    const r = scoreBillText(bill);
    assert.equal(r.isBill, true);
    assert.deepEqual(r.extracted.gstins, ['27AAPFU0939F1ZV']);
    assert.ok(r.extracted.invoiceNos.includes('AIL/2026/0457'));
    assert.ok(r.extracted.totalCandidates.includes(11564));
  });

  it('rejects ordinary text', () => {
    assert.equal(scoreBillText('Weekend plans: buy vegetables, call mom at 7 pm.').isBill, false);
  });

  it('repairs OCR look-alikes only when the check digit passes', () => {
    assert.deepEqual(scoreBillText(bill.replace('27AAPFU0939F1ZV', '27AAPFUG93OF1ZV')).extracted.gstins, ['27AAPFU0939F1ZV']);
    assert.equal(isValidGstin('27AAPFU0939F1ZX'), false);
  });
});
