const { test } = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/utils/validation');

function invalid(fn) { assert.throws(fn, err => err.status === 400); }

test('emails are normalized and malformed values are rejected', () => {
  assert.equal(v.email('  Person@Example.com '), 'person@example.com');
  for (const value of [null, 123, {}, ' ', 'name', 'a@b', 'a b@example.com']) invalid(() => v.email(value));
});

test('password validation counts UTF-8 bytes and never truncates bcrypt input', () => {
  assert.equal(v.password(' valid password ', { signup: true }), ' valid password ');
  assert.equal(v.password('a'.repeat(72)), 'a'.repeat(72));
  for (const value of [null, 123, '', 'a'.repeat(73), '😀'.repeat(19)]) invalid(() => v.password(value));
  invalid(() => v.password('short', { signup: true }));
});

test('calendar dates reject rollover, timestamps, impossible and ambiguous dates', () => {
  assert.equal(v.date('2024-02-29', 'date'), '2024-02-29');
  for (const value of ['2025-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '01/02/2026', '2026-01-01T00:00:00Z', '', [], '0000-01-01']) {
    invalid(() => v.date(value, 'date'));
  }
  invalid(() => v.dateRange('2026-02-01', '2026-01-31'));
});

test('generation bounds accept zero but reject fractions, strings and unbounded work', () => {
  assert.equal(v.integer(undefined, 'days', 7, 0, 30), 7);
  assert.equal(v.integer(0, 'days', 7, 0, 30), 0);
  for (const value of [-1, 31, 1.5, '7', null, Infinity]) invalid(() => v.integer(value, 'days', 7, 0, 30));
});

test('schedule times and weekday filters have strict formats', () => {
  assert.equal(v.time('23:59:59'), '23:59:59');
  assert.deepEqual(v.weekdays([0, 6]), [0, 6]);
  assert.deepEqual(v.weekdays(), []);
  for (const value of ['24:00', '8:00', '12:60', '12:00:60', null]) invalid(() => v.time(value));
  for (const value of [null, [7], [-1], [1, 1], ['1'], {}]) invalid(() => v.weekdays(value));
});

test('timezones accept named zones and reject arbitrary offsets', () => {
  assert.equal(v.timezone(), 'Asia/Kolkata');
  assert.equal(v.timezone('America/New_York'), 'America/New_York');
  assert.equal(v.timezone('UTC'), 'UTC');
  for (const value of ['Invalid/Zone', '+05:30', 'GMT+5', '', null]) invalid(() => v.timezone(value));
});

test('identifiers and required text reject invalid types and blank values', () => {
  assert.equal(v.uuid('550e8400-e29b-41d4-a716-446655440000', 'id'), '550e8400-e29b-41d4-a716-446655440000');
  invalid(() => v.uuid('not-an-id', 'id'));
  for (const value of [' ', 12, {}, []]) invalid(() => v.text(value, 'name', { required: true }));
  invalid(() => v.text('long', 'name', { max: 3 }));
});
