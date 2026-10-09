// DB-free source contracts for P2 write-back fixes (X1, X9) and event payloads (W1 server side).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const tallyWrite = read('../routes/tally-write.js');
const socketHandler = read('../socket/socketHandler.js');

const sliceFn = (src, signature, length = 6000) => {
  const start = src.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  return src.slice(start, start + length);
};

describe('X1: offline retry has a declared actor', () => {
  it('retryOfflineEntries derives userId from the queued entry', () => {
    const body = sliceFn(tallyWrite, 'export async function retryOfflineEntries(');
    const decl = body.indexOf('const userId = entry.actor_user_id ?? entry.user_id ?? null;');
    assert.ok(decl > 0, 'userId must be declared from the entry');
    assert.ok(decl < body.indexOf('forwardToTally('), 'userId must be declared before forwarding');
  });
});

describe('X9: an unanswered write is never auto-re-pushed', () => {
  it('forwardToTally rejects a timeout as outcome-unknown and settles late acks', () => {
    const body = sliceFn(tallyWrite, 'const forwardToTally = async');
    assert.match(body, /reject\(outcomeUnknownError\(\)\)/);
    assert.match(body, /settleLateTallyAck\(xmlBody, result\)/);
  });

  it('updateWriteQueue flags outcome-unknown instead of plain failure', () => {
    const body = sliceFn(tallyWrite, 'const updateWriteQueue = async');
    assert.match(body, /startsWith\(OUTCOME_UNKNOWN_PREFIX\)/);
    assert.match(body, /outcome_unknown = TRUE/);
  });

  it('every automatic retry path excludes outcome-unknown rows', () => {
    const retry = sliceFn(tallyWrite, 'export async function retryOfflineEntries(');
    assert.match(retry, /outcome_unknown IS NOT TRUE/);
    const pending = sliceFn(tallyWrite, "router.post('/desktop/writeback/pending'");
    assert.match(pending, /outcome_unknown IS NOT TRUE/);
    const claim = sliceFn(tallyWrite, "router.post('/desktop/writeback/:outboxId/claim'");
    assert.match(claim, /outcome_unknown IS NOT TRUE/);
  });

  // Behaviour is proven in isolated/r1-writeback-unknown.test.js; this guards the
  // removed user-confirmation override from coming back.
  it('manual retry never re-posts an outcome-unknown row, even on confirmation', () => {
    const body = sliceFn(tallyWrite, 'export async function retrySingleEntry(');
    assert.match(body, /AND outcome_unknown IS NOT TRUE\n/);
    assert.doesNotMatch(body, /confirmOutcomeUnknown|\$3::boolean/);
    assert.match(body, /code: 'OUTCOME_UNKNOWN'/);
  });
});

describe('W1 (server): posting events carry workspace scope and both reference names', () => {
  it('emitCompanyEvent includes workspaceId', () => {
    const body = sliceFn(socketHandler, 'function emitCompanyEvent(', 400);
    assert.match(body, /workspaceId,/);
  });

  it('voucher events carry tdkRef alongside the existing field names', () => {
    const synced = sliceFn(socketHandler, 'export async function emitVoucherSynced(', 1400);
    assert.match(synced, /tdkReferenceNo: tdkRef,\s*tdkRef,/);
    assert.match(synced, /referenceNumber: tdkRef,\s*tdkRef,/);
    const regularized = sliceFn(socketHandler, 'export async function emitVoucherRegularized(', 900);
    assert.match(regularized, /tdkReferenceNo: tdkRef,\s*tdkRef,/);
  });
});
