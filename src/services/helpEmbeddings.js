/**
 * TallyDekho Help Center — Phase 2 Embedding Service
 *
 * Uses: all-MiniLM-L6-v2 (local, no API key, 384-dim vectors)
 * Storage: pgvector kb_chunks table
 * Strategy: semantic similarity search → replace keyword routing
 */

import { pipeline } from '@xenova/transformers';
import { query } from '../db/schema.js';

let embedder = null;
let embedderLoading = null;

// ─── Load embedding model (cached singleton) ───────────────────────────────────
async function getEmbedder() {
  if (embedder) return embedder;
  if (embedderLoading) return embedderLoading; // prevent concurrent loads

  embedderLoading = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true, // smaller + faster
  }).then(model => {
    embedder = model;
    embedderLoading = null;
    console.log('[KB Embeddings] Model loaded: Xenova/all-MiniLM-L6-v2');
    return model;
  });

  return embedderLoading;
}

// ─── Embed a single text string → float array (384 dims) ─────────────────────
export async function embedText(text) {
  const model = await getEmbedder();
  const output = await model(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

// ─── Chunk KB content into ~400-token pieces ──────────────────────────────────
function chunkContent(content, section) {
  // Split by double newline (paragraph breaks) then merge small chunks
  const paragraphs = content.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    if ((current + '\n\n' + para).length > 1200) {
      if (current) chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + '\n\n' + para : para;
    }
  }
  if (current) chunks.push(current.trim());

  return chunks.map((text, i) => ({ section, chunk_index: i, content: text }));
}

// ─── Index a KB section into the database ─────────────────────────────────────
export async function indexKBSection(section, content) {
  const chunks = chunkContent(content, section);
  let indexed = 0;

  for (const chunk of chunks) {
    const vector = await embedText(chunk.content);
    const vectorStr = `[${vector.join(',')}]`;

    await query(`
      INSERT INTO kb_chunks (section, chunk_index, content, embedding, updated_at)
      VALUES ($1, $2, $3, $4::vector, NOW())
      ON CONFLICT (section, chunk_index)
      DO UPDATE SET content=$3, embedding=$4::vector, updated_at=NOW()
    `, [chunk.section, chunk.chunk_index, chunk.content, vectorStr]);

    indexed++;
  }

  return indexed;
}

// ─── Semantic search: find top N most relevant KB chunks ──────────────────────
export async function semanticSearch(question, topN = 5) {
  try {
    const vector = await embedText(question);
    const vectorStr = `[${vector.join(',')}]`;

    const { rows } = await query(`
      SELECT section, content,
             1 - (embedding <=> $1::vector) AS similarity
      FROM kb_chunks
      WHERE embedding IS NOT NULL
      ORDER BY embedding <=> $1::vector
      LIMIT $2
    `, [vectorStr, topN]);

    return rows; // [{ section, content, similarity }]
  } catch (err) {
    console.error('[KB Embeddings] Semantic search failed:', err.message);
    return [];
  }
}

// ─── Check if KB is indexed ────────────────────────────────────────────────────
export async function isKBIndexed() {
  try {
    const { rows } = await query('SELECT COUNT(*) as cnt FROM kb_chunks WHERE embedding IS NOT NULL');
    return parseInt(rows[0].cnt) > 0;
  } catch { return false; }
}
