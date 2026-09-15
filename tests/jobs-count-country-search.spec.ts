/**
 * E2E: Matches / All Jobs list header shows the filtered total, and the Country filter menu is
 * sorted A→Z with a search box.
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

const BASE = `jps.profile_id = ${PROFILE_ID} AND jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')`;
function count(where: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM job_profile_states jps WHERE ${BASE} AND ${where}`).get() as { c: number }).c;
}
// The profile's most common country — a fixture the live DB is sure to have.
const country = (db.prepare(`
  SELECT jc.country FROM job_countries jc JOIN job_profile_states jps ON jps.job_id = jc.job_id
  WHERE ${BASE} GROUP BY jc.country ORDER BY COUNT(*) DESC LIMIT 1
`).get() as { country: string }).country;

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
const countryMenu = (page: Page) => page.locator('[data-menu="country"]');
const rowLabels = (page: Page) =>
  countryMenu(page).locator('.menu-rows > div > span:nth-last-child(2)').allTextContents();

test('Matches header shows the total for its default Strong filter', async ({ page }) => {
  await auth(page);
  await page.goto('/jobs');
  await expect(headerCount(page)).toHaveText(String(count("jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0")));
});

test('All Jobs header shows the total, narrowed by a country filter', async ({ page }) => {
  await auth(page);
  await page.goto('/history');
  await expect(headerCount(page)).toHaveText(String(count('1=1')));
  await page.goto('/history?country=' + encodeURIComponent(country));
  await expect(headerCount(page)).toHaveText(String(count(
    `EXISTS (SELECT 1 FROM job_countries jc WHERE jc.job_id = jps.job_id AND jc.country = '${country}')`,
  )));
});

test('Country options are sorted A→Z by label', async ({ page }) => {
  await auth(page);
  await page.goto('/history');
  const labels = await page.evaluate(() => (window as any).__filterOpts.country.map((o: any) => o.label));
  expect(labels.length).toBeGreaterThan(1);
  expect(labels).toEqual([...labels].sort((a: string, b: string) => a.localeCompare(b)));
});

test('Country search filters rows, keeps ticked ones, and clears', async ({ page }) => {
  await auth(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/history');
  const all: string[] = await page.evaluate(() => (window as any).__filterOpts.country.map((o: any) => o.label));
  const first = all[0];
  const other = all.find((l) => !l.toLowerCase().includes(first.slice(0, 3).toLowerCase()))!;

  await page.locator('[data-filter="country"]').click();
  const input = countryMenu(page).locator('.country-search-input');
  await expect(input).toBeFocused();
  await expect(countryMenu(page).getByText('All countries')).toBeVisible();

  // Tick `first`, then search for `other`: the ticked row stays, the box keeps its text.
  await countryMenu(page).locator('.menu-rows > div').filter({ hasText: first }).first().click();
  await input.fill(other.slice(0, 4));
  const shown = await rowLabels(page);
  expect(shown).toContain(first);
  expect(shown).toContain(other);
  // The menu folds accents ("Åland" is searched as "aland"), so compare the same way.
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const l of shown) if (l !== first) expect(fold(l)).toContain(fold(other.slice(0, 4)));
  await expect(countryMenu(page).getByText('All countries')).toHaveCount(0);
  await expect(input).toHaveValue(other.slice(0, 4));

  await input.fill('zzzzqqq');
  await expect(countryMenu(page).getByText('No countries match')).toHaveCount(0); // `first` is ticked
  await countryMenu(page).locator('.menu-rows > div').filter({ hasText: first }).first().click(); // untick
  await expect(countryMenu(page).getByText('No countries match')).toBeVisible();

  await countryMenu(page).locator('.country-search-clear').click();
  await expect(input).toHaveValue('');
  await expect(countryMenu(page).getByText('All countries')).toBeVisible();
  expect((await rowLabels(page)).length).toBe(all.length + 1); // every country + "All countries"
  await expect(countryMenu(page)).toBeVisible(); // clearing doesn't close the menu
});
