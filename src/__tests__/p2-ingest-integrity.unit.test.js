// DB-free unit tests for P2 ingest integrity helpers. No database or .env is touched.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseChunkBody,
  chunkContentHash,
  ChunkBodyError,
  MAX_CHUNK_RECORDS,
} from '../utils/chunkReceipts.js';
import {
  wrapIngestClient,
  ingestCompanyCtx,
  assertNoIngestFailures,
  IngestBatchError,
} from '../utils/ingestCompanyDualWrite.js';
import { aggregateInventoryLines } from '../utils/inventoryLineAggregate.js';
import { normalizeTerminalStatus, isVerifiedSyncSuccess } from '../utils/syncRuns.js';

function fakeClient(script = {}) {
  const calls = [];
  return {
    calls,
    async query(text) {
      const sql = String(text).trim();
      calls.push(sql);
      if (script.fail?.(sql)) {
        const err = new Error('duplicate key');
        err.code = '23505';
        throw err;
      }
      if (sql === 'COMMIT') return { command: script.commitResult || 'COMMIT' };
      return { command: sql.split(/\s+/)[0].toUpperCase(), rows: [] };
    },
    release() {},
  };
}

const inCtx = (fn) => {
  const ctx = { failures: [] };
  return ingestCompanyCtx.run(ctx, async () => {
    await fn();
    return ctx.failures;
  });
};

describe('parseChunkBody', () => {
  const r = (n) => ({ XML: 'LedgerFull.xml', n });
  const line = (n) => JSON.stringify(r(n));

  it('parses NDJSON with blank lines and CRLF', () => {
    assert.deepEqual(parseChunkBody(`${line(1)}\r\n\n${line(2)}\n`), [r(1), r(2)]);
  });

  it('accepts a single JSON array, a single object and no final newline', () => {
    assert.deepEqual(parseChunkBody(`[${line(1)},${line(2)}]`), [r(1), r(2)]);
    assert.deepEqual(parseChunkBody(line(1)), [r(1)]);
    assert.deepEqual(parseChunkBody(Buffer.from(`${line(1)}\n${line(2)}`)), [r(1), r(2)]);
  });

  it('rejects a bad line with its line number and never echoes content', () => {
    assert.throws(
      () => parseChunkBody(`${line(1)}\n{"secret":"x"\n${line(3)}`),
      (e) => e instanceof ChunkBodyError && e.code === 'NDJSON_INVALID' && e.line === 2 && !e.message.includes('secret')
    );
  });

  it('rejects non-object NDJSON lines', () => {
    assert.throws(() => parseChunkBody(`${line(1)}\n[1,2]`), (e) => e.code === 'NDJSON_INVALID' && e.line === 2);
  });

  // R2 / X11: valid JSON that is not a record never becomes a successful receipt.
  it('rejects null, primitives, arrays of non-objects, empty bodies and records without a collection', () => {
    for (const body of ['null', '\n\n', '', '5', '"text"', '[]', '[null]', `[${line(1)},7]`, '[[{"XML":"a"}]]']) {
      assert.throws(() => parseChunkBody(body), (e) => e instanceof ChunkBodyError && ['CHUNK_EMPTY', 'RECORD_INVALID', 'NDJSON_INVALID'].includes(e.code), `body ${JSON.stringify(body)}`);
    }
    assert.throws(() => parseChunkBody(`${line(1)}\n{"no":"xml"}\n${line(3)}`), (e) => e.code === 'RECORD_INVALID' && e.line === 2);
    assert.throws(() => parseChunkBody(`${line(1)}\n${line(2)}\n{"XML":""}`), (e) => e.code === 'RECORD_INVALID' && e.line === 3);
    assert.throws(() => parseChunkBody(`${line(1)}\n${line(2)}\n${line(3)}`.slice(0, -5)), (e) => e.code === 'NDJSON_INVALID' && e.line === 3, 'truncated last line');
  });

  it('rejects oversized chunks', () => {
    const big = Array.from({ length: MAX_CHUNK_RECORDS + 1 }, () => ({ XML: 'a' }));
    assert.throws(() => parseChunkBody(big), (e) => e.code === 'CHUNK_TOO_LARGE');
  });

  it('hashes identical content identically and different content differently', () => {
    assert.equal(chunkContentHash('{"a":1}'), chunkContentHash(Buffer.from('{"a":1}')));
    assert.notEqual(chunkContentHash('{"a":1}'), chunkContentHash('{"a":2}'));
  });
});

describe('wrapIngestClient', () => {
  it('refuses COMMIT after a swallowed statement error and records one failure', async () => {
    const raw = fakeClient({ fail: (sql) => sql.startsWith('INSERT') });
    const client = wrapIngestClient(raw);
    const failures = await inCtx(async () => {
      await client.query('BEGIN');
      await client.query('INSERT INTO t VALUES (1)').catch(() => {});
      await client.query('UPDATE t SET a = 1');
      await assert.rejects(client.query('COMMIT'), (e) => e.code === 'INGEST_TX_ABORTED');
      await client.query('ROLLBACK');
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0].pgCode, '23505');
    assert.ok(raw.calls.includes('ROLLBACK'));
    assert.ok(!raw.calls.includes('COMMIT'));
  });

  it('treats ROLLBACK TO SAVEPOINT as recovery', async () => {
    const raw = fakeClient({ fail: (sql) => sql.startsWith('INSERT') });
    const client = wrapIngestClient(raw);
    const failures = await inCtx(async () => {
      await client.query('BEGIN');
      await client.query('SAVEPOINT sp');
      await client.query('INSERT INTO t VALUES (1)').catch(() => {});
      await client.query('ROLLBACK TO SAVEPOINT sp');
      await client.query('COMMIT');
    });
    assert.deepEqual(failures, []);
  });

  it('records a COMMIT that the server answered with ROLLBACK exactly once', async () => {
    const client = wrapIngestClient(fakeClient({ commitResult: 'ROLLBACK' }));
    const failures = await inCtx(async () => {
      await client.query('BEGIN');
      await assert.rejects(client.query('COMMIT'), (e) => e.code === 'INGEST_TX_ABORTED');
      await client.query('ROLLBACK');
    });
    assert.equal(failures.length, 1);
  });

  it('records an explicit ROLLBACK of a unit', async () => {
    const client = wrapIngestClient(fakeClient());
    const failures = await inCtx(async () => {
      await client.query('BEGIN');
      await client.query('ROLLBACK');
    });
    assert.equal(failures.length, 1);
  });

  it('assertNoIngestFailures throws IngestBatchError with the failures', () => {
    assert.doesNotThrow(() => assertNoIngestFailures([]));
    assert.throws(
      () => assertNoIngestFailures([{ pgCode: '23505', message: 'x' }]),
      (e) => e instanceof IngestBatchError && e.code === 'INGEST_BATCH_FAILED' && e.failures.length === 1
    );
  });
});

describe('aggregateInventoryLines', () => {
  const fields = { sum: ['qty', 'amount'], qty: 'qty', value: 'amount', rate: 'rate' };
  const key = (l) => `${l.v}|${l.item}|${l.godown}`;

  it('merges repeated item/godown lines instead of dropping them', () => {
    const { lines, merged, sources } = aggregateInventoryLines([
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 2, rate: 10, amount: 20 },
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 3, rate: 10, amount: 30 },
      { v: 'V1', item: 'Nut', godown: 'Main', qty: 1, rate: 5, amount: 5 },
    ], key, fields);
    assert.equal(merged, 1);
    assert.equal(lines.length, 2);
    assert.deepEqual(sources, [2, 1], 'source rows per merged line, so saved counts stay per input row');
    const bolt = lines.find((l) => l.item === 'Bolt');
    assert.deepEqual([bolt.qty, bolt.amount, bolt.rate], [5, 50, 10]);
  });

  it('derives a weighted rate when merged lines had different rates', () => {
    const { lines } = aggregateInventoryLines([
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 1, rate: 10, amount: 10 },
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 3, rate: 30, amount: 90 },
    ], key, fields);
    assert.equal(lines[0].rate, 25);
  });

  it('does not mutate input rows', () => {
    const input = [
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 1, rate: 1, amount: 1 },
      { v: 'V1', item: 'Bolt', godown: 'Main', qty: 1, rate: 1, amount: 1 },
    ];
    aggregateInventoryLines(input, key, fields);
    assert.equal(input[0].qty, 1);
  });
});

describe('sync run status rules', () => {
  it('accepts only terminal statuses from clients', () => {
    assert.equal(normalizeTerminalStatus(undefined), 'completed');
    assert.equal(normalizeTerminalStatus('PARTIAL'), 'partial');
    assert.equal(normalizeTerminalStatus('failed'), 'failed');
    assert.equal(normalizeTerminalStatus('running'), null);
    assert.equal(normalizeTerminalStatus('abandoned'), null);
    assert.equal(normalizeTerminalStatus("completed'; DROP"), null);
  });

  it('treats only advisory warnings as verified success', () => {
    assert.equal(isVerifiedSyncSuccess([]), true);
    assert.equal(isVerifiedSyncSuccess([{ code: 'warehouses_empty' }]), true);
    assert.equal(isVerifiedSyncSuccess([{ code: 'stock_transaction_insert' }]), false);
    assert.equal(isVerifiedSyncSuccess(null), true);
  });
});
