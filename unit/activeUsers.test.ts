/**
 * The DAU/WAU bucketing rules, against a scratch database.
 *
 * These are pure functions of stored rows — trimming, week boundaries, the partial current week,
 * and the fact that uniques do not add up. Asserting them through the browser meant asserting
 * against the one real DB every other spec also writes to, so the suite had to skip itself the
 * moment genuine user activity landed in the window: green, and guarding nothing. Here the data
 * is ours alone and the rules can be pinned exactly.
 *
 * `tests/admin-dau-wau.spec.ts` keeps what only a browser can answer: that the card renders and
 * the switch works.
 *
 * The scratch database comes from `npm run test:unit`, which puts a fresh path in
 * DATABASE_PATH before anything loads — `config.ts` reads that variable at import time.
 *
 *   npm run test:unit
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '../src/db';
import { getAdminActive, DAU_DAYS, WAU_WEEKS } from '../src/routes/adminStats';

const DAY = 86400000;
const db = getDb();
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

// The page buckets the window in the admin's timezone, so the fixture reads it the same way.
db.exec(`DELETE FROM profiles;
  INSERT INTO profiles (id, email, is_admin, created_at) VALUES
    (1,'admin@x.io',1,'2026-01-01T00:00:00Z'),
    (2,'a@x.io',0,'2026-01-01T00:00:00Z'),
    (3,'b@x.io',0,'2026-01-01T00:00:00Z');`);
db.exec(`INSERT OR REPLACE INTO settings (profile_id, timezone) VALUES (1,'UTC'),(2,'UTC'),(3,'UTC');`);

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'UTC' });
const todayT = Date.parse(today + 'T00:00:00Z');
const dayAgo = (n: number) => iso(todayT - n * DAY);

function seed(pairs: Array<[number, number]>): void {
  db.exec('DELETE FROM profile_active_days');
  const ins = db.prepare('INSERT OR IGNORE INTO profile_active_days (profile_id, day) VALUES (?,?)');
  for (const [profile, back] of pairs) ins.run(profile, dayAgo(back));
}

test('empty edges are trimmed, an interior empty day keeps its column', () => {
  seed([[2, 10], [2, 6], [2, 0]]);
  const { days } = getAdminActive();
  assert.equal(days[0].k, dayAgo(10), 'leading empty days dropped');
  assert.equal(days[days.length - 1].k, dayAgo(0), 'series runs to today');
  assert.equal(days.length, 11, 'every day between the ends kept');
  assert.equal(days.find((d) => d.k === dayAgo(8))!.n, 0, 'the hole is a real zero column');
  assert.ok(days.every((d) => !d.partial), 'a day is never partial');
});

test('the day window is DAU_DAYS long and nothing older reaches it', () => {
  seed([[2, DAU_DAYS], [2, DAU_DAYS - 1], [2, 0]]);
  const { days } = getAdminActive();
  assert.equal(days.length, DAU_DAYS, 'window is exactly DAU_DAYS once both ends are populated');
  assert.equal(days[0].k, dayAgo(DAU_DAYS - 1), 'the day before the window is excluded');
});

test('a week is not the sum of its days', () => {
  // One person on five days of the same week, plus a second person on one of them.
  seed([[2, 4], [2, 5], [2, 6], [2, 7], [2, 8], [3, 6]]);
  const { days, weeks } = getAdminActive();
  const profileDays = days.reduce((s, d) => s + d.n, 0);
  assert.equal(profileDays, 6, 'six profile-days were recorded');
  const peak = Math.max(...weeks.map((w) => w.n));
  assert.equal(peak, 2, 'but only two distinct people — WAU never sums its DAU');
});

test('weeks run Monday to Sunday and only the current one is partial', () => {
  seed([[2, 0], [2, 7], [2, 14], [3, 7]]);
  const { weeks } = getAdminActive();
  for (const w of weeks) {
    assert.equal(new Date(w.k + 'T00:00:00Z').getUTCDay(), 1, `${w.k} is a Monday`);
  }
  assert.ok(weeks[weeks.length - 1].partial, 'the current week is short by construction');
  assert.ok(weeks.slice(0, -1).every((w) => !w.partial), 'no earlier week is partial');
});

test('the week window is WAU_WEEKS long and starts on a week boundary', () => {
  seed([[2, (WAU_WEEKS - 1) * 7], [2, 0]]);
  const { weeks } = getAdminActive();
  assert.equal(weeks.length, WAU_WEEKS, 'exactly WAU_WEEKS columns when both ends are populated');
});

test('admins are counted here, unlike everywhere else on the page', () => {
  seed([[1, 0]]);
  const a = getAdminActive();
  assert.equal(a.days.length, 1, 'the admin alone still draws a column');
  assert.equal(a.days[0].n, 1);
});

test('since and dayFrom let the card tell "nobody came" from "not recording yet"', () => {
  seed([[2, 3]]);
  const a = getAdminActive();
  assert.equal(a.since, dayAgo(3), 'since is the first day ever recorded');
  assert.equal(a.dayFrom, dayAgo(DAU_DAYS - 1), 'dayFrom is the untrimmed window start');
  assert.ok(a.since! > a.dayFrom, 'so the card knows the series is younger than its window');
});

test('nothing recorded draws nothing rather than a row of zeroes', () => {
  seed([]);
  const a = getAdminActive();
  assert.deepEqual(a.days, []);
  assert.deepEqual(a.weeks, []);
  assert.equal(a.since, null);
});
