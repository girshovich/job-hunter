/**
 * E2E: a bare work-mode word ("remote") must be rejected as a search location.
 *
 * Such a value never resolves to a country, so the ATS providers (greenhouse/lever/ashby)
 * throw at fetch time and the whole run lands as partial_error — silently, because the UI
 * renders partial_error like success.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token). It never
 * saves a group: the client guard blocks the save, and the API guard is checked directly.
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

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

test('the role modal warns about a work-mode location and blocks the save', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  await page.goto('/settings?tab=roles');
  await page.locator('#add-group-btn').click();

  const warning = page.locator('#location-warning');
  await expect(warning).toBeHidden();

  await page.locator('#modal-locations').fill('remote');
  await expect(warning).toContainText('work mode, not a location');

  // A qualified form still resolves (to the US, which Indeed covers), so the warning clears.
  await page.locator('#modal-locations').fill('Remote US');
  await expect(warning).toBeHidden();

  await page.locator('#modal-locations').fill('London, Remote');
  await expect(warning).toContainText('work mode, not a location');

  await page.locator('#modal-save-btn').click();
  await expect(page.locator('#modal-error')).toContainText('work mode, not a location');

  await page.locator('#group-modal button:has-text("Cancel")').click();
});

test('the API rejects a work-mode location', async ({ request }) => {
  const res = await request.post('/api/groups', {
    headers: { Cookie: `jh_session=${token}` },
    data: {
      group_name: 'work-mode-guard-probe',
      locations: ['remote'],
      keywords: ['engineer'],
      job_type: ['fulltime'],
      work_modes: ['remote'],
      use_main_profile_description: 0,
      profile_description: 'probe',
      scoring_criteria: 'probe',
      no_match_criteria: 'probe',
      score_no_match_max: 50,
      score_weak_match_max: 70,
      score_strong_match_min: 71,
    },
  });

  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain('work mode, not a location');

  const created = db
    .prepare('SELECT COUNT(*) AS c FROM search_groups WHERE group_name = ?')
    .get('work-mode-guard-probe') as { c: number };
  expect(created.c).toBe(0);
});
