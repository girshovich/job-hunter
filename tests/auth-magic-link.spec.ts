/**
 * E2E: OTP magic-link login flow (GET /welcome/verify).
 *
 * The test needs a running server with a known DB state. It:
 * 1. Reads the OTP code directly from the DB (avoids real email delivery).
 * 2. Visits the magic-link URL — expects redirect to dashboard.
 * 3. Confirms the same code can't be reused (single-use).
 *
 * Prerequisites: start the app with TEST_DB_PATH pointing to a fresh DB that
 * already has one profile seeded (e-mail: test@example.com).
 * The test sets up the OTP row itself via a helper endpoint or direct DB manipulation.
 *
 * Because we cannot easily seed the DB without running the server, this test
 * uses the existing POST /welcome/request → inspect DB pattern via a small
 * helper script. For CI, run: npm run dev &, then npx playwright test.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';

const BASE_URL = 'http://localhost:3000';

// Helper: request an OTP code by posting to /welcome/request, then read it
// from the DB via a test-only API endpoint. In production the endpoint is
// absent, so this test only runs when the server exposes GET /api/test/otp.
test.describe('magic-link login (GET /welcome/verify)', () => {
  test('clicking magic link logs in and lands on dashboard', async ({ page, request }) => {
    // Step 1: check if the test helper endpoint is available
    const statusRes = await request.get(`${BASE_URL}/api/test/otp-peek`);
    test.skip(statusRes.status() === 404, 'Test helper endpoint not available — skipping magic-link e2e');

    // Step 2: request an OTP for the test account
    const email = 'test@example.com';
    const requestRes = await request.post(`${BASE_URL}/welcome/request`, {
      data: { email },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      form: { email },
    });
    expect(requestRes.ok()).toBeTruthy();

    // Step 3: read the OTP from the test helper
    const peekRes = await request.get(`${BASE_URL}/api/test/otp-peek?email=${encodeURIComponent(email)}`);
    expect(peekRes.ok()).toBeTruthy();
    const { code } = await peekRes.json() as { code: string };
    expect(code).toMatch(/^\d{6}$/);

    // Step 4: visit the magic-link URL in a fresh browser context (no session cookie)
    const loginUrl = `${BASE_URL}/welcome/verify?email=${encodeURIComponent(email)}&code=${code}`;
    await page.goto(loginUrl);

    // Should land on dashboard, not on /welcome
    await expect(page).not.toHaveURL(/\/welcome/);
    await expect(page).toHaveURL('/');

    // Step 5: the same code must be rejected (single-use)
    const reusePage = await page.context().newPage();
    await reusePage.goto(loginUrl);
    await expect(reusePage).toHaveURL(/\/welcome/);
    await reusePage.close();
  });

  test('invalid magic link redirects to /welcome with error', async ({ page }) => {
    const badUrl = `${BASE_URL}/welcome/verify?email=nobody@example.com&code=000000`;
    await page.goto(badUrl);
    await expect(page).toHaveURL(/\/welcome/);
  });
});
