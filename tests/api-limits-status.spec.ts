/**
 * E2E: the measured account-limits block (APIlimits.md, post-automation).
 *
 * The tier/plan dropdowns are gone. Both providers are asked what they allow and the answer is
 * shown read-only, so these tests assert three things: the figures render with a date, **nothing is
 * editable**, and a credits user never sees the operator's account described anywhere — not on
 * screen and not in the page source.
 *
 * Runs against the real DB, so it mints its own sessions and deletes them **by exact token**. Every
 * row it touches is restored in `finally`, including on a failing assertion.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { DatabaseSync } from 'node:sqlite';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const ADMIN_ID = 1;

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

type LimitCols = {
  use_jh_credits: number;
  apify_plan: string; apify_concurrency_detected: number; apify_limits_checked_at: string;
  openai_tier: string; openai_limits_json: string; openai_limits_checked_at: string;
};

const COLS = `use_jh_credits, apify_plan, apify_concurrency_detected, apify_limits_checked_at,
              openai_tier, openai_limits_json, openai_limits_checked_at`;

const readCols = (id: number) =>
  db.prepare(`SELECT ${COLS} FROM settings WHERE profile_id = ?`).get(id) as LimitCols;

const writeCols = (id: number, c: LimitCols) => db.prepare(`
  UPDATE settings SET use_jh_credits = ?, apify_plan = ?, apify_concurrency_detected = ?,
    apify_limits_checked_at = ?, openai_tier = ?, openai_limits_json = ?, openai_limits_checked_at = ?
  WHERE profile_id = ?
`).run(c.use_jh_credits, c.apify_plan, c.apify_concurrency_detected, c.apify_limits_checked_at,
       c.openai_tier, c.openai_limits_json, c.openai_limits_checked_at, id);

const adminBefore = readCols(ADMIN_ID);

const creditsUser = db.prepare(`
  SELECT s.profile_id AS id FROM settings s JOIN profiles p ON p.id = s.profile_id
  WHERE p.is_admin = 0 AND s.use_jh_credits != 0 LIMIT 1
`).get() as { id: number } | undefined;

const adminToken = crypto.randomBytes(24).toString('hex');
const adminHash = crypto.createHash('sha256').update(adminToken).digest('hex');
const userToken = crypto.randomBytes(24).toString('hex');
const userHash = crypto.createHash('sha256').update(userToken).digest('hex');

/**
 * A measured Tier 3 account — 29 Apify slots, 4M TPM. Matches the operator's real figures.
 *
 * Keyed by the row's *own* soft model: the OpenAI line describes the model that scores every job,
 * and an entry for some other model would correctly render as unmeasured.
 */
const softModel = (db.prepare('SELECT ai_model FROM settings WHERE profile_id = ?')
  .get(ADMIN_ID) as { ai_model: string }).ai_model;

const MEASURED = {
  apify_plan: '', apify_concurrency_detected: 29, apify_limits_checked_at: new Date().toISOString(),
  openai_tier: 'tier3', openai_limits_checked_at: new Date().toISOString(),
  openai_limits_json: JSON.stringify({
    [softModel]: { rpm: 5000, tpm: 4_000_000, concurrency: 32, at: new Date().toISOString() },
  }),
};

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(adminHash, ADMIN_ID);
  if (creditsUser) {
    db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
      .run(userHash, creditsUser.id);
  }
});

test.afterAll(() => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(adminHash);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(userHash);
  writeCols(ADMIN_ID, adminBefore);
});

async function loginAs(context: import('@playwright/test').BrowserContext, token: string) {
  await context.addCookies([{ name: 'jh_session', value: token, url: 'http://localhost:3000' }]);
}

test('admin General shows measured limits in plain terms, with a date', async ({ page, context }) => {
  await loginAs(context, adminToken);
  try {
    writeCols(ADMIN_ID, { ...adminBefore, ...MEASURED });
    await page.goto('/admin?tab=general');

    const block = page.locator('.stg-limits');
    await expect(block).toBeVisible();

    // Capability, never raw TPM — "4000000" must not reach a human.
    await expect(block).toContainText('up to 28 job searches at once');
    await expect(block).toContainText('up to 32 jobs scored at once');
    await expect(block).not.toContainText('4000000');
    await expect(block).not.toContainText('TPM');

    // 29 matches no published Apify plan, so no plan name is invented; OpenAI's tier is unambiguous.
    await expect(block).toContainText('Tier 3');
    await expect(block).toContainText('Checked');
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});

test('nothing in the limits block is editable', async ({ page, context }) => {
  await loginAs(context, adminToken);
  try {
    writeCols(ADMIN_ID, { ...adminBefore, ...MEASURED });
    await page.goto('/admin?tab=general');

    // The dropdowns are gone for good: an editable control here let people describe their account
    // wrongly, which is the failure the measurement exists to remove.
    await expect(page.locator('#openai-tier-select')).toHaveCount(0);
    await expect(page.locator('#apify-plan-select')).toHaveCount(0);
    await expect(page.locator('select[name="openai_tier"], select[name="apify_plan"]')).toHaveCount(0);
    await expect(page.locator('.stg-limits input, .stg-limits select, .stg-limits textarea')).toHaveCount(0);
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});

test('an unmeasured account says so instead of showing a made-up plan', async ({ page, context }) => {
  await loginAs(context, adminToken);
  try {
    writeCols(ADMIN_ID, {
      ...adminBefore,
      apify_plan: '', apify_concurrency_detected: 0, apify_limits_checked_at: '',
      openai_tier: '', openai_limits_json: '', openai_limits_checked_at: '',
    });
    await page.goto('/admin?tab=general');

    const block = page.locator('.stg-limits');
    await expect(block).toContainText('not measured yet');
    await expect(block).toContainText('safe default of 4');
    await expect(block).toContainText('We check automatically on your next run');
    await expect(block).not.toContainText('Checked');
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});

test('settings AI tab shows the block in own-keys mode and hides it on credits', async ({ page, context }) => {
  await loginAs(context, adminToken);
  try {
    writeCols(ADMIN_ID, { ...adminBefore, ...MEASURED, use_jh_credits: 0 });
    await page.goto('/settings?tab=ai');
    await expect(page.locator('.stg-limits')).toBeVisible();

    writeCols(ADMIN_ID, { ...adminBefore, ...MEASURED, use_jh_credits: 1 });
    await page.goto('/settings?tab=ai');
    await expect(page.locator('.stg-limits')).not.toBeVisible();
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});

test('a credits user never receives the operator account figures', async ({ page, context }) => {
  test.skip(!creditsUser, 'no non-admin credits profile in this database');
  try {
    writeCols(ADMIN_ID, { ...adminBefore, ...MEASURED, use_jh_credits: 1 });

    await loginAs(context, userToken);
    await page.goto('/settings?tab=ai');

    // Not "hidden" — absent from the markup. The block is hidden by CSS in credits mode, so a
    // route that built it anyway would ship the operator's real ceiling in every user's HTML.
    const html = await page.content();
    expect(html).not.toContain('stg-limits');
    expect(html).not.toContain('job searches at once');
    expect(html).not.toContain('Tier 3');
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});

/**
 * Regression: a model with no measurement of its own must not borrow another model's date.
 *
 * The row carries one "checked at" for the whole account, but limits are per model — an account can
 * have `gpt-5.4-mini` on file and never have been asked about `gpt-5.6-luna`. Dating the fallback
 * number with the row-level timestamp presents a guess as a measurement.
 */
test('an unmeasured model is not date-stamped with another model measurement', async ({ page, context }) => {
  await loginAs(context, adminToken);
  try {
    writeCols(ADMIN_ID, {
      ...adminBefore, ...MEASURED,
      openai_limits_json: JSON.stringify({
        'some-other-model': { rpm: 5000, tpm: 4_000_000, concurrency: 32, at: new Date().toISOString() },
      }),
    });
    await page.goto('/admin?tab=general');

    const openaiRow = page.locator('.stg-limits-row').nth(1);
    await expect(openaiRow).toContainText('not measured yet');
    await expect(openaiRow).not.toContainText('Checked');
  } finally {
    writeCols(ADMIN_ID, adminBefore);
  }
});
