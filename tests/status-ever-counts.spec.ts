/**
 * E2E: flipping "Include past statuses" re-counts the open Status menu straight away, and the
 * numbers match what the page shows after the switch is applied. The list header waits for apply.
 *
 * Runs against the real DB, so it mints its own session and deletes it by exact token.
 * It only reads app state — nothing here writes to the user's data.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const PROFILE_ID = 1;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  // Delete ONLY the token this run minted — never a broad profile_id sweep.
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

async function auth(page: Page) {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);
}

const headerCount = (page: Page) => page.locator('.jh-jobs-head h1 + span');
const statusMenu = (page: Page) => page.locator('[data-menu="status"]:visible');

async function openStatusMenu(page: Page) {
  await page.locator('[data-filter="status"]:visible').click();
  await expect(statusMenu(page)).toBeVisible();
}

/** Status name → the count shown beside it in the open menu. */
async function menuCounts(page: Page): Promise<Record<string, string>> {
  return statusMenu(page).locator(':scope > div[onclick*="toggleMulti"]').evaluateAll((rows) =>
    Object.fromEntries(rows.map((r) => {
      const spans = r.querySelectorAll(':scope > span');
      return [spans[spans.length - 2].textContent, spans[spans.length - 1].textContent];
    })),
  );
}

for (const { title, url } of [{ title: 'Matches', url: '/jobs' }, { title: 'All Jobs', url: '/history' }]) {
  test(`${title}: the switch re-counts the menu live, the header waits for apply`, async ({ page }) => {
    await auth(page);

    // What the server renders for each reading — the numbers a live flip must reproduce.
    await page.goto(`${url}?ever=1`);
    await openStatusMenu(page);
    const everCounts = await menuCounts(page);

    await page.goto(url);
    await openStatusMenu(page);
    const nowCounts = await menuCounts(page);
    const header = await headerCount(page).textContent();
    // Guard: the fixture must have history, or this test would pass without the fix.
    expect(everCounts).not.toEqual(nowCounts);

    await statusMenu(page).locator('.ever-switch').click();
    expect(await menuCounts(page)).toEqual(everCounts);
    await expect(headerCount(page)).toHaveText(header!);

    await statusMenu(page).locator('.ever-switch').click();
    expect(await menuCounts(page)).toEqual(nowCounts);
  });
}
