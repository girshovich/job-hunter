/**
 * E2E: the sidebar "Matches" badge recounts live when a job's applied status or
 * verdict changes on the Matches page — without a page reload.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token)
 * and restores every job row it touches, even if an assertion fails midway.
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
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

type JobState = { job_id: number; applied: number; ai_verdict: string };
const touched: JobState[] = [];

function remember(jobId: number): void {
  const row = db.prepare(
    'SELECT job_id, applied, ai_verdict FROM job_profile_states WHERE job_id = ? AND profile_id = ?',
  ).get(jobId, PROFILE_ID) as JobState;
  touched.push(row);
}

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  for (const t of touched) {
    db.prepare('UPDATE job_profile_states SET applied = ?, ai_verdict = ? WHERE job_id = ? AND profile_id = ?')
      .run(t.applied, t.ai_verdict, t.job_id, PROFILE_ID);
  }
  // Delete ONLY the token this run minted — never a broad profile_id sweep.
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

function dbCount(): number {
  return (db.prepare(
    "SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ? AND ai_verdict = 'STRONG_MATCH' AND is_duplicate = 0 AND applied = 0",
  ).get(PROFILE_ID) as { c: number }).c;
}

const badge = (page: Page) => page.locator('#sb-matches-count');

// Marks the document so a full page reload becomes detectable.
async function markNoReload(page: Page) {
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__noReload = true; });
}
async function assertNoReload(page: Page) {
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__noReload)).toBe(true);
}

// Opens Matches and returns a locator pinned to one job id, so it keeps pointing at the
// same card after the filters would otherwise reshuffle "the first card".
// Skips the card open in the detail pane: changing its verdict deliberately reloads the
// page (layout.ejs), which is not the live-update path under test.
async function openMatches(page: Page) {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);
  await page.goto('/jobs?verdict=STRONG_MATCH&status=new');
  const jobId = await page
    .locator('.jobcard[data-strong="1"][data-applied="0"]:not([data-selected="1"])')
    .first().getAttribute('data-id');
  expect(jobId).toBeTruthy();
  remember(Number(jobId));
  return page.locator(`.jobcard[data-id="${jobId}"]`);
}

test('applied change updates the badge without reloading', async ({ page }) => {
  const card = await openMatches(page);
  const before = dbCount();
  await expect(badge(page)).toHaveText(String(before));
  await markNoReload(page);

  await card.locator('.applied-btn').click();
  await page.locator('#applied-dropdown button', { hasText: 'Applied' }).click();

  await expect(badge(page)).toHaveText(String(before - 1));
  expect(dbCount()).toBe(before - 1);
  await assertNoReload(page);

  // Back to New — the badge must climb again.
  await card.locator('.applied-btn').click();
  await page.locator('#applied-dropdown button', { hasText: 'New' }).click();
  await expect(badge(page)).toHaveText(String(before));
  expect(dbCount()).toBe(before);
  await assertNoReload(page);
});

test('verdict change updates the badge without reloading', async ({ page }) => {
  const card = await openMatches(page);
  const before = dbCount();
  await expect(badge(page)).toHaveText(String(before));
  await markNoReload(page);

  await card.locator('.verdict-btn').click();
  await page.locator('#verdict-dropdown button', { hasText: 'Weak' }).click();
  await page.locator('#jh-confirm-modal button', { hasText: 'Confirm' }).click();

  await expect(badge(page)).toHaveText(String(before - 1));
  expect(dbCount()).toBe(before - 1);
  await assertNoReload(page);

  // Back to Strong — the badge must climb again.
  await card.locator('.verdict-btn').click();
  await page.locator('#verdict-dropdown button', { hasText: 'Strong' }).click();
  await page.locator('#jh-confirm-modal button', { hasText: 'Confirm' }).click();
  await expect(badge(page)).toHaveText(String(before));
  expect(dbCount()).toBe(before);
  await assertNoReload(page);
});

// Run Logs drives the same client-side updater through a different endpoint, so the only
// page-specific requirement is that this endpoint also returns the fresh count.
test('run-log verdict endpoint returns the fresh count', async ({ request }) => {
  const log = db.prepare(`
    SELECT rjl.id AS log_id, rjl.ai_verdict AS log_verdict, jps.job_id
    FROM run_job_logs rjl
    JOIN search_runs sr ON sr.id = rjl.run_id
    JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = 'LinkedIn'
    JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = sr.profile_id
    WHERE sr.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 AND jps.applied = 0
    ORDER BY rjl.id DESC LIMIT 1
  `).get(PROFILE_ID) as { log_id: number; log_verdict: string; job_id: number } | undefined;
  test.skip(!log, 'No run-log entry tied to an un-applied strong match');

  remember(log!.job_id);
  const before = dbCount();

  const res = await request.patch(`/api/run-log/${log!.log_id}/verdict`, {
    data: { verdict: 'WEAK_MATCH' },
    headers: { cookie: `jh_session=${token}` },
  });
  expect(res.ok()).toBeTruthy();
  expect(await res.json()).toMatchObject({ success: true, matchesCount: before - 1 });
  expect(dbCount()).toBe(before - 1);

  db.prepare('UPDATE run_job_logs SET ai_verdict = ? WHERE id = ?').run(log!.log_verdict, log!.log_id);
});
