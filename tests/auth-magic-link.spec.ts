/**
 * E2E: OTP magic-link login flow (GET /welcome/verify).
 *
 * Runs against the real DB and the real running app. It mints its own OTP row directly in
 * `otp_codes` — the same pattern matches-badge-live.spec.ts uses to mint its own session —
 * so no email is sent and the app needs no test-only endpoint. Both the OTP row and the
 * session the login creates are deleted by exact id/token in afterAll, even if an assertion
 * fails midway.
 *
 * Covers: a valid link logs in and lands on the dashboard; the same link cannot be reused;
 * a bad code is rejected. It deliberately does NOT cover POST /welcome/request, because that
 * path sends a real email through Resend.
 *
 * Safety: the OTP it mints is a genuine login for profile 1 while it exists, so the code is
 * random per run and valid for two minutes, and the row is deleted in afterAll. Because
 * verifyOtp() only ever considers the newest unused row for an address, do not run this while
 * someone is actually logging in with that email — their pending code would be shadowed.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

// The codes minted here are briefly valid logins for a real account, so they must not be a
// guessable constant: random per run, and short-lived (see mintOtp's validity window).
const CODE = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
const otpIds: number[] = [];
const sessionHashes: string[] = [];
let email = '';

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v).digest('hex');
}

// verifyOtp() takes the newest unused row for the address, so each test inserts a fresh one.
function mintOtp(code = CODE, minutesValid = 2): void {
  const now = new Date();
  const res = db.prepare(
    'INSERT INTO otp_codes (email, code, attempts, created_at, expires_at, used) VALUES (?, ?, 0, ?, ?, 0)',
  ).run(email, code, now.toISOString(), new Date(now.getTime() + minutesValid * 60000).toISOString());
  otpIds.push(Number(res.lastInsertRowid));
}

test.beforeAll(() => {
  const profile = db.prepare('SELECT email FROM profiles WHERE id = 1').get() as { email: string } | undefined;
  if (!profile) throw new Error('No profile with id 1 — cannot run magic-link e2e');
  email = profile.email;
});

test.afterAll(() => {
  // Delete ONLY the rows this run created — never a broad email/profile sweep.
  for (const id of otpIds) db.prepare('DELETE FROM otp_codes WHERE id = ?').run(id);
  for (const h of sessionHashes) db.prepare('DELETE FROM sessions WHERE token = ?').run(h);
});

function linkFor(code: string): string {
  return `${BASE_URL}/welcome/verify?email=${encodeURIComponent(email)}&code=${code}`;
}

test.describe('magic-link login (GET /welcome/verify)', () => {
  test('clicking the magic link logs in and lands on the dashboard', async ({ page }) => {
    mintOtp();
    await page.goto(linkFor(CODE));

    await expect(page).toHaveURL(`${BASE_URL}/`);

    const cookie = (await page.context().cookies()).find((c) => c.name === 'jh_session');
    expect(cookie?.value).toBeTruthy();
    sessionHashes.push(sha256(cookie!.value));

    // The session is real: a guarded page renders instead of bouncing to /welcome.
    await page.goto(`${BASE_URL}/jobs`);
    await expect(page).toHaveURL(new RegExp('/jobs'));

    // And the code is now spent.
    const row = db.prepare('SELECT used FROM otp_codes WHERE id = ?').get(otpIds.at(-1)) as { used: number };
    expect(row.used).toBe(1);
  });

  test('the same link cannot be used twice', async ({ browser }) => {
    mintOtp();
    const first = await browser.newContext();
    await first.newPage().then((p) => p.goto(linkFor(CODE)));
    const used = (await first.cookies()).find((c) => c.name === 'jh_session');
    if (used) sessionHashes.push(sha256(used.value));
    await first.close();

    // Fresh context: no session cookie, so /welcome renders instead of redirecting to /.
    const second = await browser.newContext();
    const page = await second.newPage();
    await page.goto(linkFor(CODE));
    await expect(page).toHaveURL(/\/welcome\?error=/);
    expect((await second.cookies()).find((c) => c.name === 'jh_session')).toBeUndefined();
    await second.close();
  });

  test('a wrong code is rejected', async ({ browser }) => {
    mintOtp();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(linkFor('000000'));
    await expect(page).toHaveURL(/\/welcome\?error=/);
    expect((await ctx.cookies()).find((c) => c.name === 'jh_session')).toBeUndefined();
    await ctx.close();
  });

  test('invalid magic link redirects to /welcome with error', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}/welcome/verify?email=&code=`);
    await expect(page).toHaveURL(/\/welcome\?error=invalid-link/);
    await ctx.close();
  });
});
