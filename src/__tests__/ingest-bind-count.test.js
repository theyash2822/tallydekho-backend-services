import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../controllers/ingestProcessor.js', import.meta.url), 'utf8');

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      let depth = 1; j += 2;
      while (j < src.length && depth) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      j--;
      continue;
    }
    if (src[j] === q) return j;
  }
  return src.length;
}

function topLevelArrayLength(src, open) {
  let depth = 0;
  let count = 0;
  let sawToken = false;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); sawToken = true; continue; }
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
    if (c === '[' || c === '(' || c === '{') { depth++; if (depth > 1) sawToken = true; continue; }
    if (c === ']' || c === ')' || c === '}') {
      depth--;
      if (depth === 0) return sawToken ? count + 1 : count;
      continue;
    }
    if (depth === 1 && c === ',') { count++; sawToken = false; continue; }
    if (depth >= 1 && !/\s/.test(c)) sawToken = true;
  }
  return -1;
}

function collectQueries(src) {
  const out = [];
  const re = /client\.query\(\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1;
    const end = skipString(src, start);
    const sql = src.slice(start + 1, end);
    const after = src.slice(end + 1);
    const arr = after.match(/^\s*,\s*\[/);
    if (!arr) continue;
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((x) => Number(x[1]));
    if (!placeholders.length) continue;
    const params = topLevelArrayLength(src, end + 1 + arr[0].length - 1);
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, maxPlaceholder: Math.max(...placeholders), params });
  }
  return out;
}

describe('ingestProcessor SQL bind counts', () => {
  const queries = collectQueries(SRC);

  it('finds the inline-parameter queries', () => {
    assert.ok(queries.length > 20, `expected many queries, found ${queries.length}`);
  });

  it('every query passes exactly as many values as its highest $n placeholder', () => {
    const bad = queries.filter((q) => q.params !== q.maxPlaceholder);
    assert.deepEqual(bad, [], `bind mismatches: ${JSON.stringify(bad)}`);
  });

  it('StockValuation writer binds company_id as $12', () => {
    const body = SRC.slice(SRC.indexOf('async function processStockFyValuation'));
    const insert = body.slice(0, body.indexOf('saved++'));
    assert.match(insert, /\$12\)/);
    assert.match(insert, /closeQty, closeRate, closeVal, now, currentCompanyId\(\)\]/);
  });
});
