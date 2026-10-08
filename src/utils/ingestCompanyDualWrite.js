/**
 * Company Identity Phase 3D — ingest ALS + optional client wrap.
 * Explicit company_id on all INSERT writers; no SQL rewrite.
 */
import { AsyncLocalStorage } from 'async_hooks';

export const ingestCompanyCtx = new AsyncLocalStorage();

export function currentCompanyId() {
  const id = ingestCompanyCtx.getStore()?.companyId;
  return id == null ? null : Number(id);
}

export function currentUploadId() {
  return ingestCompanyCtx.getStore()?.uploadId || null;
}

export function currentBillSnapshotMode() {
  return ingestCompanyCtx.getStore()?.billSnapshotMode || null;
}

export function currentChunkKey() {
  return ingestCompanyCtx.getStore()?.chunkKey || null;
}

/** A required ingest unit rolled back; the chunk must not be reported as applied. */
export class IngestBatchError extends Error {
  constructor(failures) {
    super(`Ingest batch failed (${failures.length} unit${failures.length === 1 ? '' : 's'} rolled back)`);
    this.name = 'IngestBatchError';
    this.code = 'INGEST_BATCH_FAILED';
    this.failures = failures;
  }
}

const sqlVerb = (text) => String(typeof text === 'object' && text ? text.text : text || '')
  .trim().replace(/;$/, '').toUpperCase();

function recordFailure(err) {
  const store = ingestCompanyCtx.getStore();
  if (!store?.failures) return;
  store.failures.push({
    pgCode: err?.code || null,
    message: String(err?.message || 'transaction rolled back').slice(0, 300),
  });
}

/**
 * Ingest transaction client that cannot silently lose a batch.
 *
 * Postgres aborts the whole transaction on the first failed statement, so a
 * per-row catch without a savepoint turns COMMIT into ROLLBACK while the caller
 * logs "saved N". This wrapper remembers the failure, turns COMMIT of an aborted
 * transaction into an explicit ROLLBACK, and records every rolled-back unit in the
 * ingest context so the chunk route answers with a failure instead of 200.
 * A statement error recovered with ROLLBACK TO SAVEPOINT is not a failure.
 * Does NOT mutate SQL — writers must supply company_id explicitly.
 */
export function wrapIngestClient(client) {
  if (!client || client.__ingestGuarded) return client;
  let aborted = false;
  let firstError = null;
  let refusedCommit = false;
  const rawQuery = client.query.bind(client);

  const guardedQuery = async (text, params) => {
    const verb = sqlVerb(text);
    if (verb === 'BEGIN' || verb.startsWith('BEGIN ')) {
      aborted = false;
      firstError = null;
      refusedCommit = false;
    }
    if (verb === 'COMMIT') {
      if (aborted) {
        await rawQuery('ROLLBACK').catch(() => {});
        const err = firstError || new Error('transaction aborted');
        aborted = false;
        firstError = null;
        refusedCommit = true;
        recordFailure(err);
        const out = new Error(`commit refused: transaction aborted earlier (${err.code || 'error'})`);
        out.code = 'INGEST_TX_ABORTED';
        throw out;
      }
      const result = await rawQuery(text, params);
      if (result?.command === 'ROLLBACK') {
        const err = new Error('COMMIT returned ROLLBACK');
        err.code = 'INGEST_TX_ABORTED';
        refusedCommit = true;
        recordFailure(err);
        throw err;
      }
      return result;
    }
    if (verb === 'ROLLBACK') {
      const pending = firstError;
      aborted = false;
      firstError = null;
      if (!refusedCommit) recordFailure(pending || new Error('transaction rolled back'));
      refusedCommit = false;
      return rawQuery(text, params);
    }
    try {
      const result = await rawQuery(text, params);
      if (verb.startsWith('ROLLBACK TO')) {
        aborted = false;
        firstError = null;
      }
      return result;
    } catch (err) {
      aborted = true;
      if (!firstError) firstError = err;
      throw err;
    }
  };

  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'query') return guardedQuery;
      if (prop === '__ingestGuarded') return true;
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Throw when any required unit of this ingest call rolled back. */
export function assertNoIngestFailures(failures) {
  if (failures && failures.length) throw new IngestBatchError(failures);
}
