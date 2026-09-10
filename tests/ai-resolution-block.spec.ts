/**
 * E2E: the "AI analysis" block on job detail — both render branches.
 *
 * `ai_rationale` is a mixed-type column: rows written after the structured-resolution change hold
 * JSON, the 1,994 rows written before it hold prose. Both render in the *same* block — the shell,
 * tone strip and label are shared; only the body differs (marked ledger vs. paragraph). This spec
 * exercises both bodies, plus the tone map, the empty ledger and the headline-less header.
 *
 * Runs against the real DB. It mints its own session and deletes it by exact token, and it restores
 * every `ai_rationale` it overwrites, by exact job id, in afterAll.
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

function pickJob(where: string): number {
  const row = db.prepare(`
    SELECT job_id AS id FROM job_profile_states
    WHERE profile_id = ${PROFILE_ID} AND ai_rationale IS NOT NULL AND ai_rationale <> ''
      AND ${where}
    ORDER BY job_id LIMIT 1
  `).get() as { id: number } | undefined;
  if (!row) throw new Error(`No fixture job for: ${where}`);
  return row.id;
}

// Left untouched — it is the legacy prose branch.
const proseJob = pickJob("substr(ai_rationale, 1, 1) <> '{' AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'");
// Overwritten with JSON for the run, then restored.
const strongJob = pickJob(`is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH' AND job_id <> ${proseJob}`);
const dupJob = pickJob('is_duplicate = 1');

const RESOLUTION = JSON.stringify({
  headline: 'Strong platform fit, but the language bar is absolute',
  pros: ['Berlin-based hybrid role matches the preferred locations', 'Marketplace product ownership matches the profile directly'],
  cons: [
    { text: 'B2+ German is mandatory for dealer-facing collaboration', disqualifying: true },
    { text: 'Reports two levels below the previous Head of Product scope', disqualifying: false },
  ],
});
const EMPTY_RESOLUTION = JSON.stringify({ headline: 'No stated objections and no stated strengths', pros: [], cons: [] });

const originals = new Map<number, string | null>();
function setRationale(jobId: number, value: string): void {
  if (!originals.has(jobId)) {
    const row = db.prepare('SELECT ai_rationale FROM job_profile_states WHERE job_id = ? AND profile_id = ?')
      .get(jobId, PROFILE_ID) as { ai_rationale: string | null };
    originals.set(jobId, row.ai_rationale);
  }
  db.prepare('UPDATE job_profile_states SET ai_rationale = ? WHERE job_id = ? AND profile_id = ?')
    .run(value, jobId, PROFILE_ID);
}

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  try {
    // Restore every row this run overwrote, by exact job id — never a broad profile_id sweep.
    for (const [jobId, value] of originals) {
      db.prepare('UPDATE job_profile_states SET ai_rationale = ? WHERE job_id = ? AND profile_id = ?')
        .run(value, jobId, PROFILE_ID);
    }
  } finally {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }
});

async function openJob(page: Page, jobId: number) {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);
  await page.goto(`/job/${jobId}`);
}

test('legacy prose row renders in the same block, with a paragraph body', async ({ page }) => {
  await openJob(page, proseJob);

  const block = page.locator('.air');
  await expect(block).toHaveCount(1);
  await expect(block.locator('.air-lbl')).toHaveText('AI analysis');
  await expect(block.locator('.air-body p')).not.toBeEmpty();
  // No ledger, and — having no headline — no headline row and no rule to dangle beside the label.
  await expect(block.locator('.air-ledger')).toHaveCount(0);
  await expect(block.locator('.air-head')).toHaveCount(0);
  await expect(block.locator('.air-vr')).toHaveCount(0);
  // The old duplicate block is gone entirely.
  await expect(page.getByText('General AI analysis')).toHaveCount(0);
});

test('a structured row and a legacy row share one shell', async ({ page }) => {
  setRationale(strongJob, RESOLUTION);
  await openJob(page, strongJob);
  const structured = await page.locator('.air').evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.borderRadius, s.borderTopWidth].join('|');
  });

  await openJob(page, proseJob);
  const legacy = await page.locator('.air').evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.backgroundColor, s.borderRadius, s.borderTopWidth].join('|');
  });

  expect(legacy).toBe(structured);
});

test('structured row renders the ledger', async ({ page }) => {
  setRationale(strongJob, RESOLUTION);
  await openJob(page, strongJob);

  const block = page.locator('.air');
  await expect(block).toHaveCount(1);
  await expect(block.locator('.air-lbl')).toHaveText('AI analysis');
  await expect(block.locator('.air-head')).toHaveText('Strong platform fit, but the language bar is absolute');
  const items = block.locator('.air-li');
  await expect(items).toHaveCount(4);
  // The disqualifying con leads the cons regardless of the order the model returned them in.
  await expect(items.nth(2)).toHaveClass(/is-dq/);
  await expect(items.nth(2)).toHaveClass(/is-first-con/);
  await expect(items.nth(2).locator('p')).toHaveCSS('color', 'rgb(180, 35, 24)');   // --red-ink
  await expect(items.nth(3)).not.toHaveClass(/is-dq/);
});

test('strong match tones the strip green', async ({ page }) => {
  setRationale(strongJob, RESOLUTION);
  await openJob(page, strongJob);
  await expect(page.locator('.air-top')).toHaveCSS('background-color', 'rgb(238, 247, 241)');   // --green-soft
});

test('duplicate tones the strip purple', async ({ page }) => {
  setRationale(dupJob, RESOLUTION);
  await openJob(page, dupJob);
  await expect(page.locator('.air-top')).toHaveCSS('background-color', 'rgb(244, 243, 255)');   // --purple-soft
});

test('empty pros and cons omit the ledger', async ({ page }) => {
  setRationale(strongJob, EMPTY_RESOLUTION);
  await openJob(page, strongJob);
  await expect(page.locator('.air-head')).toBeVisible();
  await expect(page.locator('.air-ledger')).toHaveCount(0);
  await expect(page.locator('.air-body')).toHaveCount(0);
});
