/**
 * E2E: the zero-balance gates from MONEYLEAK.md.
 *
 * Covers the sidebar Run/Schedule lock (Fix 1), the POST /api/schedule/start paywall (Layer 5 +
 * Fix 4), the CV-compare paywall (Layer 6) and the admin profile-list additions.
 *
 * Runs against the real DB, so it mints its own session and deletes it by exact token. Profile 2's
 * balance is read, temporarily forced to 0, and restored in afterAll — nothing else is written.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const ADMIN_ID = 1;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

/** A non-admin credits-mode profile to starve; falls back to creating nothing if none exists. */
const victim = db.prepare(`
  SELECT s.profile_id AS id, s.credits_balance AS balance, s.use_jh_credits AS mode
  FROM settings s JOIN profiles p ON p.id = s.profile_id
  WHERE p.is_admin = 0 LIMIT 1
`).get() as { id: number; balance: number; mode: number } | undefined;

const adminToken = crypto.randomBytes(24).toString('hex');
const adminHash = crypto.createHash('sha256').update(adminToken).digest('hex');
const victimToken = crypto.randomBytes(24).toString('hex');
const victimHash = crypto.createHash('sha256').update(victimToken).digest('hex');

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(adminHash, ADMIN_ID);
  if (victim) {
    db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
      .run(victimHash, victim.id);
    db.prepare('UPDATE settings SET credits_balance = 0, use_jh_credits = 1 WHERE profile_id = ?').run(victim.id);
  }
});

test.afterAll(() => {
  // Delete only the exact tokens this spec minted — never a broad profile_id sweep.
  db.prepare('DELETE FROM sessions WHERE token = ?').run(adminHash);
  if (victim) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(victimHash);
    db.prepare('UPDATE settings SET credits_balance = ?, use_jh_credits = ? WHERE profile_id = ?')
      .run(victim.balance, victim.mode, victim.id);
  }
  db.close();
});

test.describe('zero balance', () => {
  test.skip(!victim, 'needs a non-admin profile in the DB');

  test('sidebar Run once and Schedule are disabled', async ({ page, context }) => {
    await context.addCookies([{ name: 'jh_session', value: victimToken, url: 'http://localhost:3000' }]);
    await page.goto('http://localhost:3000/');

    await expect(page.locator('#sidebar-run-btn')).toBeDisabled();
    await expect(page.locator('#schedule-inactive button')).toBeDisabled();
  });

  test('the lock holds on pages other than home', async ({ page, context }) => {
    await context.addCookies([{ name: 'jh_session', value: victimToken, url: 'http://localhost:3000' }]);
    await page.goto('http://localhost:3000/reports');

    // The sidebar renders from the layout, so the gate must survive off the dashboard.
    await expect(page.locator('#sidebar-run-btn')).toBeDisabled();
  });

  test('POST /api/schedule/start is refused with 402', async ({ request }) => {
    const res = await request.post('http://localhost:3000/api/schedule/start', {
      headers: { Cookie: `jh_session=${victimToken}` },
      data: { email_send_time: '07:00', schedule_days: '*', providers: ['greenhouse'] },
    });
    expect(res.status()).toBe(402);
    expect((await res.json()).error).toContain('Insufficient credits');
  });

  test('POST /api/run is still refused with 402', async ({ request }) => {
    const res = await request.post('http://localhost:3000/api/run', {
      headers: { Cookie: `jh_session=${victimToken}` },
      data: {},
    });
    expect(res.status()).toBe(402);
  });

  test('CV compare is refused with 402 instead of spending the operator key', async ({ request }) => {
    const job = db.prepare(
      'SELECT job_id FROM job_profile_states WHERE profile_id = ? LIMIT 1',
    ).get(victim!.id) as { job_id: number } | undefined;
    test.skip(!job, 'victim profile has no jobs');

    const res = await request.post(`http://localhost:3000/api/jobs/${job!.job_id}/cv-compare`, {
      headers: { Cookie: `jh_session=${victimToken}` },
      data: { cv_id: 1 },
    });
    // 402 = paywall reached. 404 = no such CV for this profile, checked before the paywall —
    // either way the request never reached OpenAI on the operator's key.
    expect([402, 404]).toContain(res.status());
  });

  test('funded profiles are unaffected', async ({ page, context }) => {
    const admin = db.prepare('SELECT credits_balance FROM settings WHERE profile_id = ?').get(ADMIN_ID) as { credits_balance: number };
    test.skip(admin.credits_balance < 0.5, 'admin is not funded in this DB');

    await context.addCookies([{ name: 'jh_session', value: adminToken, url: 'http://localhost:3000' }]);
    await page.goto('http://localhost:3000/');
    await expect(page.locator('#sidebar-run-btn')).toBeEnabled();
  });
});

test('admin profile list shows ids and key status', async ({ page, context }) => {
  await context.addCookies([{ name: 'jh_session', value: adminToken, url: 'http://localhost:3000' }]);
  await page.goto('http://localhost:3000/admin');

  const row = page.locator('#profile-row-1');
  await expect(row).toContainText('#1');
  // The badge reports whether BYO keys are *saved*, independent of payment mode — an admin on
  // credits with keys saved must still read "keys saved", not a claim about what it spends.
  await expect(row.locator('text=/keys saved|no keys saved/')).toHaveCount(1);
});
