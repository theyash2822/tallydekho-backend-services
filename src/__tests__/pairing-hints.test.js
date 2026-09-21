import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const src = readFileSync(new URL('../services/userPairingHints.js', import.meta.url), 'utf8');

describe('userPairingHints SQL', () => {
  it('joins workspace_tally_bindings on active_device_id', () => {
    assert.match(src, /b\.active_device_id\s*=\s*d\.device_id/);
    assert.doesNotMatch(src, /b\.device_id\s*=/);
  });
});
