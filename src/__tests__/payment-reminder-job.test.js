/**
 * Payment reminder + compliance helpers: IST clock, due-day maths, channel gating.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  istNow, addDaysIso, parseHour, formatIndianDate, channelAvailability,
} from '../services/paymentReminderJob.js';
import { daysUntilDayOfMonth } from '../services/scheduler.js';

describe('payment reminder job helpers', () => {
  it('uses IST, not the server clock', () => {
    // 2026-09-29 20:00 UTC = 2026-09-30 01:30 IST
    assert.deepEqual(istNow(new Date('2026-09-29T20:00:00Z')), { hour: 1, day: '2026-09-30' });
    assert.deepEqual(istNow(new Date('2026-09-29T04:30:00Z')), { hour: 10, day: '2026-09-29' });
  });

  it('adds days across month ends', () => {
    assert.equal(addDaysIso('2026-09-29', 3), '2026-10-02');
    assert.equal(addDaysIso('2026-12-31', 1), '2027-01-01');
  });

  it('parses reminder times', () => {
    assert.equal(parseHour('10:00 AM'), 10);
    assert.equal(parseHour('12:00 AM'), 0);
    assert.equal(parseHour('5:30 PM'), 17);
    assert.equal(parseHour('14:00'), 14);
    assert.equal(parseHour(''), -1);
  });

  it('formats due dates for the message', () => {
    assert.equal(formatIndianDate('2026-10-02'), '02 Oct 2026');
    assert.equal(formatIndianDate(null), '');
  });

  it('placeholder provider keys count as not configured', () => {
    assert.deepEqual(
      channelAvailability({ CRONBERRY_TOKEN: 'abc', PROACTIVE_SMS_API_KEY: 'DUMMY_x', AWS_SES_ACCESS_KEY: '' }),
      { whatsapp: true, sms: false, email: false }
    );
  });
});

describe('GST due-day countdown', () => {
  it('counts to the 11th / 20th of the next month once the day has passed', () => {
    const at = (iso) => new Date(`${iso}T03:00:00Z`);
    assert.equal(daysUntilDayOfMonth(11, at('2026-09-08')), 3);
    assert.equal(daysUntilDayOfMonth(11, at('2026-09-11')), 0);
    assert.equal(daysUntilDayOfMonth(11, at('2026-09-12')), 29);
    assert.equal(daysUntilDayOfMonth(20, at('2026-09-17')), 3);
  });
});
