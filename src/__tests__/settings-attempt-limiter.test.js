/**
 * Wrong OTP/PIN in signed-in settings flows: 400 with attempts left, then locked.
 */
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  lockedMinutes, recordFailure, clearFailures, wrongCodeBody, _resetAttemptLimiter,
} from '../utils/settingsAttemptLimiter.js';

describe('settingsAttemptLimiter', () => {
  beforeEach(() => _resetAttemptLimiter());

  it('locks after 5 wrong codes for the same user + action only', () => {
    for (let i = 4; i >= 1; i--) assert.equal(recordFailure(7, 'remove-pin'), i);
    assert.equal(lockedMinutes(7, 'remove-pin'), 0);
    assert.equal(recordFailure(7, 'remove-pin'), 0);
    assert.equal(lockedMinutes(7, 'remove-pin'), 15);
    assert.equal(lockedMinutes(7, 'change-email'), 0);
    assert.equal(lockedMinutes(8, 'remove-pin'), 0);
  });

  it('a correct code clears the counter', () => {
    recordFailure(7, 'change-phone');
    recordFailure(7, 'change-phone');
    clearFailures(7, 'change-phone');
    assert.equal(recordFailure(7, 'change-phone'), 4);
  });

  it('message tells the user how many tries are left', () => {
    assert.match(wrongCodeBody('OTP_INVALID', 'OTP', 1).error.message, /1 attempt left/);
    assert.match(wrongCodeBody('OTP_INVALID', 'OTP', 0).error.message, /15 minutes/);
  });
});
