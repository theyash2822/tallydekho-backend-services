/**
 * AI help boundary.
 *
 * `POST /api/ai/help` forwards user text to a paid third-party model. The body
 * limit is 10mb, so without its own cap one authenticated request can spend an
 * unbounded number of tokens, and the question itself is the user's words —
 * neither the prompt nor the history belongs in a retained log.
 *
 * These are source-level guards: the route reaches out to Groq over the network
 * and there is no seam to assert against without standing up the whole app.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(srcRoot, 'routes/ai.js'), 'utf8');
const code = source
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

const helpRoute = (() => {
  const start = code.indexOf("router.post('/help'");
  assert.ok(start > -1, '/help route not found — update this guard');
  return code.slice(start, code.indexOf('\n});', start));
})();

describe('AI help boundary', () => {
  it('requires authentication', () => {
    assert.match(helpRoute.slice(0, 120), /authMiddleware/);
  });

  it('rejects an oversized message before calling the model', () => {
    assert.match(helpRoute, /MESSAGE_TOO_LONG/);
    const cap = code.match(/const MAX_MESSAGE_CHARS = (\d+)/);
    assert.ok(cap, 'MAX_MESSAGE_CHARS must be declared');
    assert.ok(Number(cap[1]) > 0 && Number(cap[1]) <= 8000, `implausible cap: ${cap[1]}`);
    assert.ok(
      helpRoute.indexOf('MESSAGE_TOO_LONG') < helpRoute.indexOf('api.groq.com'),
      'the size check must run before the model call'
    );
  });

  it('bounds conversation history by turns and by length', () => {
    assert.match(code, /const MAX_HISTORY_TURNS = \d+/);
    assert.match(code, /const MAX_HISTORY_CHARS = \d+/);
    assert.match(helpRoute, /slice\(-MAX_HISTORY_TURNS\)/);
    assert.match(helpRoute, /slice\(0, MAX_HISTORY_CHARS\)/);
  });

  it('does not log the question or the conversation', () => {
    for (const line of helpRoute.split('\n')) {
      if (!/console\.\w+/.test(line)) continue;
      assert.ok(
        !/\bmessage\.slice\(|\$\{message\}|\bhistory\b/.test(line),
        `prompt text reaches the log: ${line.trim()}`
      );
    }
  });
});
