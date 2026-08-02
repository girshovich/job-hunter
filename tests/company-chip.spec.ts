/**
 * E2E: the company chip on job detail + list cards, and the removal of Preview Fetch.
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

// Fixtures resolved from the live DB so the spec doesn't hard-code ids that enrichment may change.
function pickJob(where: string): { id: number; company: string } {
  const row = db.prepare(`
    SELECT j.id AS id, j.company AS company
    FROM jobs j
    JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ${PROFILE_ID}
    LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
    WHERE ${where}
    LIMIT 1
  `).get() as { id: number; company: string } | undefined;
  if (!row) throw new Error(`No fixture job for: ${where}`);
  return row;
}

const agencyJob = pickJob('c.is_agency = 1');
const countJob = pickJob('c.is_agency = 0 AND c.employee_count IS NOT NULL');
const rangeJob = pickJob('c.is_agency = 0 AND c.employee_count IS NULL AND c.employee_range IS NOT NULL');
const bareJob = pickJob('c.company IS NULL OR (c.is_agency IS NULL AND c.employee_count IS NULL AND c.employee_range IS NULL)');

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

// The chip lives in the company row, next to the name button and before `Applied N×`.
function detailChip(page: Page) {
  return page.locator('#company-name-btn').locator('xpath=following-sibling::span[1]');
}

test('detail header: an agency company shows the agency chip', async ({ page }) => {
  await auth(page);
  await page.goto(`/job/${agencyJob.id}`);
  await expect(page.locator('#company-name-btn')).toBeVisible();
  await expect(detailChip(page)).toHaveText('agency');
});

test('detail header: a non-agency company shows its exact headcount', async ({ page }) => {
  await auth(page);
  await page.goto(`/job/${countJob.id}`);
  await expect(detailChip(page)).toHaveText(/^\d+ employees$/);
});

test('detail header: a non-agency company with only a band shows the raw range', async ({ page }) => {
  await auth(page);
  await page.goto(`/job/${rangeJob.id}`);
  const range = db.prepare('SELECT employee_range AS r FROM companies WHERE company = ?')
    .get(rangeJob.company.trim().toLowerCase()) as { r: string };
  await expect(detailChip(page)).toHaveText(`${range.r} employees`);
});

test('detail header: an unenriched company shows no chip at all', async ({ page }) => {
  await auth(page);
  await page.goto(`/job/${bareJob.id}`);
  await expect(page.locator('#company-name-btn')).toBeVisible();
  // Omitted, not emptied (DS §6): the next sibling is the note span, never an empty chip.
  await expect(page.locator('#company-name-btn ~ span').filter({ hasText: /^agency$|employees$/ }))
    .toHaveCount(0);
});

test('list card: the agency chip shows for an agency, not for a sized company', async ({ page }) => {
  await auth(page);
  await page.goto(`/jobs?company=${encodeURIComponent(`"${agencyJob.company.trim()}"`)}&verdict=all`);
  const agencyCard = page.locator('.jobcard').first();
  await expect(agencyCard).toBeVisible();
  await expect(agencyCard.getByText('agency', { exact: true })).toBeVisible();

  await page.goto(`/jobs?company=${encodeURIComponent(`"${countJob.company.trim()}"`)}&verdict=all`);
  const sizedCard = page.locator('.jobcard').first();
  await expect(sizedCard).toBeVisible();
  await expect(sizedCard.getByText(/employees$/)).toHaveCount(0);
  await expect(sizedCard.getByText('agency', { exact: true })).toHaveCount(0);
});

test('Preview Fetch is gone from the API and the Roles tab', async ({ page }) => {
  await auth(page);
  const res = await page.request.post('/api/fetch-preview');
  expect(res.status()).toBe(404);

  await page.goto('/settings?tab=roles');
  await expect(page.locator('#fetch-preview-btn')).toHaveCount(0);
  await expect(page.getByText('Preview Fetch')).toHaveCount(0);
  // The footer keeps its saved-note (every tab has one; only the active tab's is visible).
  await expect(page.locator('.stg-saverow:visible .stg-saved-note')).toBeVisible();
});
