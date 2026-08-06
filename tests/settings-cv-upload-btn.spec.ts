/**
 * E2E: the CV Upload button is disabled until a file is chosen.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token).
 * Only chooses a file — it never submits, so no CV row is created.
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

test('CV Upload button is disabled until a file is chosen', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  await page.goto('/settings?tab=roles');

  const btn = page.locator('#cv-upload-btn');
  const input = page.locator('input[name="cv_file"]');

  await expect(btn).toBeDisabled();

  await input.setInputFiles({ name: 'probe-cv.txt', mimeType: 'text/plain', buffer: Buffer.from('probe') });
  await expect(btn).toBeEnabled();

  // Clearing the choice disables it again.
  await input.setInputFiles([]);
  await expect(btn).toBeDisabled();
});
