/**
 * E2E: a run that ended `partial_error` must not look like a success on the Start page.
 *
 * It used to share the green pill with `success` and finish with a "Done" toast that then
 * reloaded the page three seconds later, erasing the only notice the user got. Three accounts
 * ran broken for days behind that.
 *
 * Runs against the real DB, so it mints its own session and one `search_runs` row, both deleted
 * by exact id. The toast is driven through the real poller with `/api/status` stubbed, so no
 * pipeline is started and nothing is spent.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const PROFILE_ID = 1;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const sessionId = 'test-partial-' + crypto.randomBytes(6).toString('hex');
let runId: number;

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);

  db.prepare(
    `INSERT INTO search_runs (profile_id, ran_at, status, trigger, scraping_provider, job_source,
                              session_id, jobs_fetched, jobs_scored, error_log, duration_ms)
     VALUES (?, ?, 'partial_error', 'manual', 'greenhouse', 'Greenhouse', ?, 0, 0, ?, 1000)`,
  ).run(PROFILE_ID, new Date().toISOString(), sessionId,
    'Group 1 fetch error: Monthly usage hard limit exceeded');
  runId = Number(
    (db.prepare('SELECT id FROM search_runs WHERE session_id = ?').get(sessionId) as { id: number }).id,
  );
});

test.afterAll(() => {
  db.prepare('DELETE FROM search_runs WHERE id = ?').run(runId);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

test('the Last Session pill is amber, not the success green', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  await page.goto('/');
  const pill = page.locator('.hp-status-pill');
  await expect(pill).toHaveText('partial error');

  const color = await pill.evaluate((el) => getComputedStyle(el).color);
  const green = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--green2').trim());
  const amber = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--amber-ink').trim());

  expect(green).not.toBe(amber);           // the two tones are actually distinct
  expect(color).toBe(hexToRgb(amber));
  expect(color).not.toBe(hexToRgb(green));
});

test('a partial_error run reports the error and does not reload the page away', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  await page.route('**/api/status', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        isRunning: false,
        lastRun: {
          status: 'partial_error',
          jobs_scored: 3,
          duration_ms: 4000,
          error_log: 'Group 1 fetch error: Monthly usage hard limit exceeded\nsecond line',
        },
      }),
    }));

  await page.goto('/');
  await page.evaluate(() => { (window as never as { __alive: boolean }).__alive = true; });
  await page.evaluate(() => (window as never as { startPolling: () => void }).startPolling());

  const result = page.locator('#home-run-result');
  await expect(result).toContainText('Finished with errors');
  await expect(result).toContainText('3 jobs scored');
  await expect(result).toContainText('Monthly usage hard limit exceeded');
  await expect(result).not.toContainText('second line');   // first line only
  await expect(result.locator('a[href="/reports"]')).toBeVisible();

  const amber = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--amber-ink').trim());
  const color = await result.locator('span').first().evaluate((el) => getComputedStyle(el).color);
  expect(color).toBe(hexToRgb(amber));

  // The success path reloads after 3s; this one must not — a reload would wipe the notice.
  await page.waitForTimeout(4500);
  expect(await page.evaluate(() => (window as never as { __alive?: boolean }).__alive)).toBe(true);
  await expect(result).toContainText('Finished with errors');
});

function hexToRgb(hex: string): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
