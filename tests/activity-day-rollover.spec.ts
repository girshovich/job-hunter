/**
 * E2E: the auth gate records a new local day even when the session was touched minutes ago.
 *
 * The gate throttles the rolling session extension to once an hour (`index.ts`) to cut write
 * pressure. Presence used to ride entirely on that throttle, so a visit at 23:50 followed by one
 * at 00:10 recorded nothing for the new day — half an hour apart, the staleness test never fires.
 * Two things were wrong because of it: `active_days_count` under-counted, and it is what picks the
 * reaper's 10- vs 30-day track (§7.9), so a user who *did* come back could sit at 1 and be paused
 * on the short one; and the day was missing from Admin Stats DAU/WAU (§7.22).
 *
 * Both halves are asserted here — the rollover is recorded, and the throttle still holds inside a
 * day, which is the property that made it worth keeping.
 *
 * Runs against the real DB. Restores every column it writes **by exact id** and deletes its
 * session **by exact token** — never a broad sweep.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

const profile = db.prepare(`
  SELECT p.id, p.last_active_at, p.active_day_last, p.active_days_count, s.timezone
  FROM profiles p LEFT JOIN settings s ON s.profile_id = p.id
  WHERE p.is_admin = 1 ORDER BY p.id LIMIT 1
`).get() as unknown as {
  id: number; last_active_at: string | null; active_day_last: string | null;
  active_days_count: number; timezone: string | null;
};

const tz = profile.timezone || 'UTC';
const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

const hadTodayRow = !!db.prepare('SELECT 1 FROM profile_active_days WHERE profile_id = ? AND day = ?')
  .get(profile.id, today);

const read = () => db.prepare(
  'SELECT last_active_at, active_day_last, active_days_count FROM profiles WHERE id = ?',
).get(profile.id) as unknown as { last_active_at: string | null; active_day_last: string | null; active_days_count: number };

const sessionLastActive = () => (db.prepare('SELECT last_active FROM sessions WHERE token = ?')
  .get(tokenHash) as unknown as { last_active: string }).last_active;

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`)
    .run(tokenHash, profile.id);
});

test.afterAll(() => {
  db.prepare('UPDATE profiles SET last_active_at = ?, active_day_last = ?, active_days_count = ? WHERE id = ?')
    .run(profile.last_active_at, profile.active_day_last, profile.active_days_count, profile.id);
  if (!hadTodayRow) {
    db.prepare('DELETE FROM profile_active_days WHERE profile_id = ? AND day = ?').run(profile.id, today);
  }
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  db.close();
});

test('a visit minutes after local midnight still records the new day', async ({ page }) => {
  // The shape of the bug: the session was touched five minutes ago, so the hourly staleness test
  // cannot fire — but the last day this profile was seen on is yesterday.
  db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?')
    .run(new Date(Date.now() - 5 * 60_000).toISOString(), tokenHash);
  db.prepare('UPDATE profiles SET active_day_last = ?, active_days_count = 7 WHERE id = ?')
    .run(yesterday, profile.id);
  if (!hadTodayRow) {
    db.prepare('DELETE FROM profile_active_days WHERE profile_id = ? AND day = ?').run(profile.id, today);
  }

  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
  await page.goto('/');

  const after = read();
  expect(after.active_day_last).toBe(today);
  expect(after.active_days_count).toBe(8);
  expect(db.prepare('SELECT 1 FROM profile_active_days WHERE profile_id = ? AND day = ?')
    .get(profile.id, today)).toBeTruthy();
});

test('within a day already recorded, the hourly throttle still holds', async ({ page }) => {
  const touched = new Date(Date.now() - 5 * 60_000).toISOString();
  db.prepare('UPDATE sessions SET last_active = ? WHERE token = ?').run(touched, tokenHash);
  db.prepare('UPDATE profiles SET active_day_last = ?, active_days_count = 7 WHERE id = ?')
    .run(today, profile.id);

  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
  await page.goto('/');

  // Nothing stale and nothing rolled over: no session write, no counter bump.
  expect(sessionLastActive()).toBe(touched);
  expect(read().active_days_count).toBe(7);
});
