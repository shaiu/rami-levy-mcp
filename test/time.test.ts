import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jerusalemLocalToUtcMs } from '../src/time.js';

const iso = (s: string) => new Date(jerusalemLocalToUtcMs(s)!).toISOString();

test('a winter created_at is read as UTC+2 (IST)', () => {
  assert.equal(iso('2026-01-15 10:00:00'), '2026-01-15T08:00:00.000Z');
  assert.equal(iso('2026-12-24 23:30:00'), '2026-12-24T21:30:00.000Z');
});

test('a summer created_at is read as UTC+3 (IDT)', () => {
  assert.equal(iso('2026-07-15 10:00:00'), '2026-07-15T07:00:00.000Z');
  assert.equal(iso('2026-09-08 00:30:00'), '2026-09-07T21:30:00.000Z');
});

test('times either side of the 2026 DST switches get the right offset', () => {
  // Spring forward: Fri 2026-03-27 02:00 -> 03:00. Fall back: Sun 2026-10-25 02:00 -> 01:00.
  assert.equal(iso('2026-03-27 01:30:00'), '2026-03-26T23:30:00.000Z');
  assert.equal(iso('2026-03-27 03:30:00'), '2026-03-27T00:30:00.000Z');
  assert.equal(iso('2026-10-24 23:00:00'), '2026-10-24T20:00:00.000Z');
  assert.equal(iso('2026-10-25 03:00:00'), '2026-10-25T01:00:00.000Z');
});

test('accepts a T separator, fractional seconds, a date alone, and an explicit zone', () => {
  assert.equal(iso('2026-07-15T10:00:00'), '2026-07-15T07:00:00.000Z');
  assert.equal(iso('2026-07-15 10:00:00.000000'), '2026-07-15T07:00:00.000Z');
  assert.equal(iso('2026-01-15'), '2026-01-14T22:00:00.000Z');
  assert.equal(iso('2026-07-15T10:00:00Z'), '2026-07-15T10:00:00.000Z');
  assert.equal(iso('2026-07-15T10:00:00+03:00'), '2026-07-15T07:00:00.000Z');
});

test('rejects what is not a date-time, including rolled-over values', () => {
  for (const bad of ['', 'yesterday', '15/07/2026 10:00', '2026-13-01 10:00:00', '2026-02-30 10:00:00', '2026-07-15 25:00:00']) {
    assert.equal(jerusalemLocalToUtcMs(bad), null, bad);
  }
});
