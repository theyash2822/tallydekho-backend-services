/**
 * TallyDekho KB Indexer — Phase 2 Setup Script
 * Run once: node src/scripts/indexKB.js
 * Re-run whenever KB files are updated.
 */

import { readFileSync, readdirSync } from 'fs';
import { config } from 'dotenv';
config({ path: new URL('../../.env', import.meta.url).pathname });
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { indexKBSection } from '../services/helpEmbeddings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const KB_DIR     = join(__dirname, '../kb');

async function main() {
  console.log('🔍 TallyDekho KB Indexer — Phase 2');
  console.log('📂 KB directory:', KB_DIR);
  console.log('⏳ Loading embedding model (downloads ~22MB on first run)...\n');

  const files = readdirSync(KB_DIR).filter(f => f.endsWith('.md'));
  console.log(`📚 Found ${files.length} KB files:\n  ${files.join('\n  ')}\n`);

  let totalChunks = 0;

  for (const file of files) {
    const section = file.replace('.md', '');
    const content = readFileSync(join(KB_DIR, file), 'utf-8');
    process.stdout.write(`  Indexing ${file}...`);

    try {
      const chunks = await indexKBSection(section, content);
      totalChunks += chunks;
      console.log(` ✅ ${chunks} chunk${chunks !== 1 ? 's' : ''}`);
    } catch (err) {
      console.log(` ❌ Error: ${err.message}`);
    }
  }

  console.log(`\n✅ Done! ${totalChunks} chunks indexed across ${files.length} KB files.`);
  console.log('🚀 Semantic search is now active for /ai/help endpoint.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
