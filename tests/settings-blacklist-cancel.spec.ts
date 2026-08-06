/**
 * E2E: the Blacklist modal's Cancel button is hidden in Add mode and shown in Edit mode.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token) and
 * deletes only the one blacklist entry it creates.
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
const probeCompany = 'ZZ Guard Probe ' + Date.now();

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  // Delete ONLY the row this run created — never a broad profile_id sweep.
  db.prepare('DELETE FROM blacklisted_companies WHERE profile_id = ? AND company_name = ?')
    .run(PROFILE_ID, probeCompany);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

test('Blacklist Cancel button is hidden until an entry is being edited', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  await page.goto('/settings?tab=roles');
  await page.locator('[onclick="openBlacklistMgmtModal()"]').click();

  const cancel = page.locator('#bl-form-cancel-btn');
  await expect(cancel).toBeHidden();

  // Create an entry so there is something to edit.
  await page.locator('#bl-form-name').fill(probeCompany);
  await page.locator('#bl-form-save-label').click();
  const row = page.locator('#bl-mgmt-list .stg-role-row', { hasText: probeCompany });
  await expect(row).toBeVisible();
  await expect(cancel).toBeHidden();  // still Add mode after a save

  await row.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('#bl-form-title')).toHaveText('Edit Entry');
  await expect(cancel).toBeVisible();

  await cancel.click();
  await expect(page.locator('#bl-form-title')).toHaveText('Add Company');
  await expect(cancel).toBeHidden();
});
