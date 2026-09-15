/**
 * E2E: Admin → Stats → Active users. Only what a browser can answer.
 *
 * The bucketing rules — trimming, Mon–Sun weeks, the partial current week, uniques not summing —
 * are pure functions of stored rows and live in `unit/activeUsers.test.ts`, against a scratch
 * database where the fixture is the only data. Asserting them here meant asserting against the one
 * real DB, which forced a skip as soon as genuine activity appeared in the window.
 *
 * What is left is wiring: the card renders, it sits above the Daily range bar it does not obey,
 * and the switch changes the series rather than just the button state. Every assertion is about
 * presence and wording, never a count, so other people's activity cannot make it flap.
 *
 * Runs against the real DB. Mints its own session and deletes it **by exact token**; removes its
 * seeded rows **by exact (profile_id, day)** — never a broad sweep.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const DAY = 86400000;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

const admin = db.prepare(`
  SELECT p.id, s.timezone FROM profiles p LEFT JOIN settings s ON s.profile_id = p.id
  WHERE p.is_admin = 1 ORDER BY p.id LIMIT 1
`).get() as unknown as { id: number; timezone: string | null };

// Admins are counted on this card, so the admin's own rows are all the fixture needs.
const today = new Date().toLocaleDateString('en-CA', { timeZone: admin.timezone || 'UTC' });
const todayT = Date.parse(today + 'T00:00:00Z');
const days = [0, 1, 8].map((n) => new Date(todayT - n * DAY).toISOString().slice(0, 10));
const seeded: string[] = [];

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now','+1 day'))`)
    .run(tokenHash, admin.id);
  const ins = db.prepare('INSERT OR IGNORE INTO profile_active_days (profile_id, day) VALUES (?,?)');
  for (const d of days) if (ins.run(admin.id, d).changes) seeded.push(d);
});

test.afterAll(() => {
  const del = db.prepare('DELETE FROM profile_active_days WHERE profile_id = ? AND day = ?');
  for (const d of seeded) del.run(admin.id, d);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  db.close();
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
  await page.goto('/admin?tab=stats');
});

test('the card sits above the Daily range bar it does not obey', async ({ page }) => {
  const order = await page.evaluate(() => {
    const card = document.getElementById('sp-act-chart')!.closest('.sp-card')!;
    const bar = document.querySelector('#admin-pane-stats .sp-bar:not([style])')!;
    return card.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below';
  });
  expect(order).toBe('above');
  // The Daily bar's scope chip claims admin-timezone days; this card buckets per user, so it
  // must not be sitting underneath that claim.
  await expect(page.locator('#sp-act-chart > div').first()).toBeVisible();
});

test('the switch changes the series, not just the buttons', async ({ page }) => {
  await expect(page.locator('#sp-act-title')).toHaveText('Active users per day');
  await expect(page.locator('#sp-act-sub')).toContainText('own timezone');
  const dayLabel = await page.locator('#sp-act-chart > div').last().textContent();

  await page.click('#sp-act-w');
  await expect(page.locator('#sp-act-title')).toHaveText('Active users per week');
  await expect(page.locator('#sp-act-sub')).toContainText('not the sum of its days');
  expect(await page.locator('#sp-act-chart > div').last().textContent()).not.toBe(dayLabel);

  await page.click('#sp-act-d');
  await expect(page.locator('#sp-act-title')).toHaveText('Active users per day');
});

test('the current week is still marked partial, in the tooltip', async ({ page }) => {
  await page.click('#sp-act-w');
  const labels = await page.locator('#sp-act-chart > div [data-qtip]').evaluateAll(
    (els) => els.map((e) => JSON.parse(e.getAttribute('data-qtip') as string).label));
  expect(labels[labels.length - 1]).toContain('partial');
  expect(labels.slice(0, -1).some((l: string) => l.includes('partial'))).toBe(false);
});

test('the tooltip reads correctly at one active user', async ({ page }) => {
  const tips = await page.locator('#sp-act-chart > div [data-qtip]').evaluateAll(
    (els) => els.map((e) => JSON.parse(e.getAttribute('data-qtip') as string).totalText));
  expect(tips.some((t) => /^\d+ active$/.test(t))).toBe(true);
  expect(tips.some((t) => t.endsWith(' users'))).toBe(false);
});
