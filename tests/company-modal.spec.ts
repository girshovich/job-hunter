/**
 * E2E: the company details modal on the Matches detail pane.
 *
 * Runs against the real DB, so it mints its own session (deleted by exact token) and
 * restores the one company note it touches, even if an assertion fails midway.
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
// The app holds the DB open in WAL mode; without this, a write here races the server's and
// fails outright instead of waiting.
db.exec('PRAGMA busy_timeout = 5000');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

// The company shown in the pane, resolved once the first test opens Matches.
let companyKey = '';
let captured = false;
let noteExisted = false;
let noteBefore = '';

function key(name: string): string {
  return name.trim().replace(/[A-Z]/g, (c) => c.toLowerCase());
}

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  if (companyKey) {
    if (noteExisted) {
      db.prepare('UPDATE company_notes SET note = ? WHERE profile_id = ? AND company = ?')
        .run(noteBefore, PROFILE_ID, companyKey);
    } else {
      // Delete ONLY the row this run created — never a broad profile_id sweep.
      db.prepare('DELETE FROM company_notes WHERE profile_id = ? AND company = ?')
        .run(PROFILE_ID, companyKey);
    }
  }
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
});

// Resolves the pane's company on every call — each test may run in a fresh worker, so
// nothing may depend on module state set by an earlier test.
async function openMatches(page: Page) {
  await page.context().addCookies([
    { name: 'jh_session', value: token, domain: 'localhost', path: '/' },
  ]);
  await page.goto('/jobs');
  await expect(page.locator('#company-name-btn')).toBeVisible();
  const company = (await page.locator('#company-name-btn').innerText()).trim();
  companyKey = key(company);
  // Snapshot the ORIGINAL note exactly once. Re-reading later would pick up the note a
  // previous test in this file wrote, and afterAll would then "restore" the test's own text.
  if (!captured) {
    captured = true;
    const existing = db.prepare('SELECT note FROM company_notes WHERE profile_id = ? AND company = ?')
      .get(PROFILE_ID, companyKey) as { note: string } | undefined;
    noteExisted = existing !== undefined;
    noteBefore = existing?.note ?? '';
  }
  return companyKey;
}

// The list pages' own WHERE clause (jobs.ts), re-implemented here so the modal's counts are
// checked against an independent query rather than against themselves.
function listCount(k: string, extra: string): number {
  return (db.prepare(`
    SELECT COUNT(*) AS c
    FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE jps.profile_id = ?
      AND jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')
      AND LOWER(TRIM(j.company)) = ?
      ${extra}
  `).get(PROFILE_ID, k) as { c: number }).c;
}

async function openModal(page: Page) {
  await page.locator('#company-name-btn').click();
  await expect(page.locator('#jh-company-modal')).toBeVisible();
  await expect(page.locator('#cm-sub')).not.toHaveText('Loading…');
}

test('modal opens from the Matches pane with name, stats and note', async ({ page }) => {
  await openMatches(page);
  await openModal(page);

  await expect(page.locator('#cm-name')).not.toBeEmpty();
  // Three stats always render; a zero one is muted text rather than a link.
  await expect(page.locator('#cm-stats > *')).toHaveCount(3);
  await expect(page.locator('#cm-note')).toHaveValue(noteBefore);
  // Basics render some state — never an error, even with no enrichment yet.
  await expect(page.locator('#cm-basics')).not.toBeEmpty();
});

test('each stat matches its list page, and zero stats are not links', async ({ page }) => {
  const k = await openMatches(page);
  await openModal(page);

  // "Jobs from this company: N total, N match(es), N applied." — read all three figures while
  // the modal is open, since navigating away tears it down.
  const cells = await page.locator('#cm-stats > a, #cm-stats > span').evaluateAll((nodes) =>
    nodes.map((n) => ({
      value: Number((n as HTMLElement).innerText.trim().split(/\s+/)[0]),
      href: n.tagName === 'A' ? (n as HTMLAnchorElement).getAttribute('href') : null,
    })),
  );
  expect(cells).toHaveLength(3);
  await expect(page.locator('#cm-stats')).toContainText('Jobs from this company:');

  const expected = [
    listCount(k, ''),
    listCount(k, "AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0"),
    listCount(k, 'AND jps.applied = 1'),
  ];

  for (let i = 0; i < 3; i++) {
    expect(cells[i].value).toBe(expected[i]);
    // A zero stat renders as muted text, never a link to an empty page.
    if (cells[i].value === 0) { expect(cells[i].href).toBeNull(); continue; }

    await page.goto(cells[i].href!);
    await expect(page.locator('.jobcard').first()).toBeVisible();
    // The one company filter shows the quoted exact-match operator, so the narrowing is visible
    // and clearable with the box's existing ✕.
    await expect(page.locator('.company-input')).toHaveValue(/^".+"$/);
  }
});

test('the company box does substring and quoted-exact search, case-insensitively', async ({ page }) => {
  const k = await openMatches(page);
  const display = (await page.locator('#company-name-btn').innerText()).trim();
  const exact = listCount(k, '');

  // Quoted → whole-name match, and case in the URL must not matter.
  await page.goto('/history?verdict=all&company=' + encodeURIComponent('"' + display.toUpperCase() + '"'));
  await expect(page.locator('.jobcard').first()).toBeVisible();
  expect(await page.locator('.jobcard').count()).toBeLessThanOrEqual(exact);

  // Bare text → substring, so a prefix of the name still finds it.
  const frag = display.slice(0, Math.max(3, Math.ceil(display.length / 2)));
  await page.goto('/history?verdict=all&company=' + encodeURIComponent(frag.toLowerCase()));
  await expect(page.locator('.jobcard').first()).toBeVisible();
  await expect(page.locator('.company-input')).toHaveValue(frag.toLowerCase());
});

test('saving a note updates the inline header line and leaves the saved date alone', async ({ page }) => {
  const k = await openMatches(page);
  await openModal(page);

  const savedBefore = db.prepare('SELECT enriched_at FROM companies WHERE company = ?')
    .get(k) as { enriched_at: string | null } | undefined;

  const text = 'e2e note ' + Date.now();
  await page.locator('#cm-note').fill(text);
  await page.locator('#cm-note-save').click();
  await expect(page.locator('#cm-note-status')).toBeVisible();

  await expect(page.locator('#company-note-text')).toHaveText(text);
  await expect(page.locator('#company-note-inline')).toBeVisible();
  await expect(page.locator('#company-note-inline')).toHaveText('(note: ' + text + ')');

  const row = db.prepare('SELECT note FROM company_notes WHERE profile_id = ? AND company = ?')
    .get(PROFILE_ID, k) as { note: string };
  expect(row.note).toBe(text);

  const savedAfter = db.prepare('SELECT enriched_at FROM companies WHERE company = ?')
    .get(k) as { enriched_at: string | null } | undefined;
  expect(savedAfter?.enriched_at ?? null).toBe(savedBefore?.enriched_at ?? null);
});

test('blacklisting needs a confirm step and never writes on the first click', async ({ page }) => {
  await openMatches(page);
  await openModal(page);

  const blRows = () => (db.prepare('SELECT COUNT(*) c FROM blacklisted_companies WHERE profile_id = ?')
    .get(PROFILE_ID) as { c: number }).c;

  // Already blacklisted → status only, no button. Nothing to test here.
  if (await page.locator('#cm-bl-btn').count() === 0) {
    await expect(page.locator('#cm-blacklist')).toContainText('Blacklisted');
    return;
  }

  const before = blRows();
  await page.locator('#cm-bl-btn').click();
  await expect(page.locator('#cm-bl-note')).toBeVisible();
  expect(blRows()).toBe(before);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('#cm-bl-btn')).toBeVisible();
  expect(blRows()).toBe(before);
});

test('a company with no enrichment shows the empty state, not an error', async ({ page }) => {
  const k = await openMatches(page);
  await openModal(page);

  const status = db.prepare('SELECT enrich_status FROM companies WHERE company = ?')
    .get(k) as { enrich_status: string | null } | undefined;

  if (!status?.enrich_status) {
    await expect(page.locator('#cm-basics')).toContainText("haven't been collected yet");
  } else {
    await expect(page.locator('#cm-basics')).not.toContainText("haven't been collected yet");
  }
});
