import { createHash } from 'crypto';

export const MAX_CHUNK_RECORDS = 100_000;
/** An 'applying' claim older than this belongs to a request that died; it may be taken over. */
export const STALE_CLAIM_SECONDS = 600;

export class ChunkBodyError extends Error {
  constructor(code, message, line = null) {
    super(message);
    this.name = 'ChunkBodyError';
    this.code = code;
    this.line = line;
  }
}

/**
 * Parse a chunk body (NDJSON, a JSON array or one JSON object) without dropping
 * anything: blank lines are separators, every other line must be valid JSON.
 * Errors carry a 1-based line number only — never the line content.
 */
export function parseChunkBody(body) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : body;
  let data;
  if (typeof raw === 'string') {
    const lines = raw.split('\n');
    const nonBlank = [];
    lines.forEach((line, i) => {
      if (line.trim()) nonBlank.push({ line: line.replace(/\r$/, ''), n: i + 1 });
    });
    if (nonBlank.length === 1) {
      try {
        data = JSON.parse(nonBlank[0].line);
      } catch {
        throw new ChunkBodyError('NDJSON_INVALID', 'Chunk line is not valid JSON', nonBlank[0].n);
      }
    } else {
      data = nonBlank.map(({ line, n }) => {
        let value;
        try {
          value = JSON.parse(line);
        } catch {
          throw new ChunkBodyError('NDJSON_INVALID', 'Chunk line is not valid JSON', n);
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new ChunkBodyError('NDJSON_INVALID', 'Chunk line is not a JSON object', n);
        }
        return value;
      });
    }
  } else {
    data = raw;
  }
  if (data == null) data = [];
  if (!Array.isArray(data)) data = [data];
  if (data.length > MAX_CHUNK_RECORDS) {
    throw new ChunkBodyError('CHUNK_TOO_LARGE', `Chunk has more than ${MAX_CHUNK_RECORDS} records`);
  }
  return data;
}

export function chunkContentHash(body) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? null), 'utf8');
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * Claim (upload, stream, index) before applying a chunk.
 * Returns { outcome: 'claimed' | 'duplicate' | 'conflict' | 'in_progress' }.
 */
export async function claimChunk(q, { uploadId, stream, chunkIndex, hash, recordCount }) {
  const inserted = await q(
    `INSERT INTO ingest_chunk_receipts (upload_id, stream, chunk_index, content_sha256, record_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (upload_id, stream, chunk_index) DO NOTHING
     RETURNING upload_id`,
    [uploadId, stream, chunkIndex, hash, recordCount]
  );
  if (inserted.rows.length) return { outcome: 'claimed' };

  const { rows } = await q(
    `SELECT content_sha256, status,
            EXTRACT(EPOCH FROM (NOW() - claimed_at))::INT AS age
       FROM ingest_chunk_receipts
      WHERE upload_id = $1 AND stream = $2 AND chunk_index = $3`,
    [uploadId, stream, chunkIndex]
  );
  const existing = rows[0];
  if (!existing) return claimChunk(q, { uploadId, stream, chunkIndex, hash, recordCount });
  if (existing.content_sha256 !== hash) return { outcome: 'conflict' };
  if (existing.status === 'applied') return { outcome: 'duplicate' };
  if (existing.age < STALE_CLAIM_SECONDS) return { outcome: 'in_progress' };

  const taken = await q(
    `UPDATE ingest_chunk_receipts SET claimed_at = NOW()
      WHERE upload_id = $1 AND stream = $2 AND chunk_index = $3
        AND status = 'applying' AND claimed_at < NOW() - make_interval(secs => $4)
      RETURNING upload_id`,
    [uploadId, stream, chunkIndex, STALE_CLAIM_SECONDS]
  );
  return taken.rows.length ? { outcome: 'claimed' } : { outcome: 'in_progress' };
}

export async function markChunkApplied(q, { uploadId, stream, chunkIndex }) {
  await q(
    `UPDATE ingest_chunk_receipts SET status = 'applied', applied_at = NOW()
      WHERE upload_id = $1 AND stream = $2 AND chunk_index = $3`,
    [uploadId, stream, chunkIndex]
  );
}

/** Failed apply: drop the claim so a corrected retry can run. */
export async function releaseChunkClaim(q, { uploadId, stream, chunkIndex }) {
  await q(
    `DELETE FROM ingest_chunk_receipts
      WHERE upload_id = $1 AND stream = $2 AND chunk_index = $3 AND status = 'applying'`,
    [uploadId, stream, chunkIndex]
  );
}
