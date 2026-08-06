/**
 * E2E: saving the Profile settings tab must not trip the unsaved-changes unload guard.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token) and
 * restores the one field it edits (`languages`) through the UI before finishing.
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

test('Save on the Profile tab saves without an unsaved-changes prompt', async ({ page }) => {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);

  const dialogs: string[] = [];
  page.on('dialog', async (d) => {
    dialogs.push(d.type());
    await d.accept();
  });

  await page.goto('/settings');
  const languages = page.locator('#profile-form [name="languages"]');
  const original = await languages.inputValue();
  const probe = 'guard-probe-' + Date.now();

  try {
    await languages.fill(probe);

    // The guard itself still works: a leave with unsaved edits is cancelable.
    const guarded = await page.evaluate(() =>
      !window.dispatchEvent(new Event('beforeunload', { cancelable: true })),
    );
    expect(guarded).toBe(true);

    await page.locator('#profile-save-btn').click();
    await page.waitForURL(/\/settings/);

    expect(dialogs).toEqual([]);
    await expect(page.locator('#profile-form [name="languages"]')).toHaveValue(probe);
  } finally {
    await page.locator('#profile-form [name="languages"]').fill(original);
    await page.locator('#profile-save-btn').click();
    await page.waitForURL(/\/settings/);
  }
});
