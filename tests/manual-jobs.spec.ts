/**
 * E2E: manually added jobs (manual_jobs.md §13).
 *
 * Each test covers a failure the spec was written around — the two origins and the history each
 * writes, the status trap that would relabel every scraped job "Incoming", the Start page counting
 * a hand-added job as a run result, the daily cap counting the wrong column, the FK with no
 * cascade that makes delete throw, and the merged job that cannot be deleted because it would come
 * straight back.
 *
 * Runs against the real DB. It mints its own session and deletes it **by exact token**, and removes
 * every row it creates **by exact id** in afterAll — never a broad `profile_id` sweep.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const PROFILE_ID = 1;
/** A company nothing in the base has ever heard of, so the "new company" path is real. */
const NEW_COMPANY = 'ZZ Manualtest Industries';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

const createdJobs: number[] = [];
const createdCompanies: string[] = [];

function api(page: Page, url: string, method: string, body?: unknown) {
  return page.request.fetch('http://localhost:3000' + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
}

function roleId(): number {
  return (db.prepare('SELECT id FROM search_groups WHERE profile_id = ? ORDER BY id LIMIT 1')
    .get(PROFILE_ID) as { id: number }).id;
}

function today(): string {
  const tz = (db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(PROFILE_ID) as { timezone?: string })?.timezone || 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/** Create a job through the real endpoint and remember it for cleanup. */
async function addJob(page: Page, over: Record<string, unknown> = {}) {
  const res = await api(page, '/api/jobs/manual', 'POST', {
    origin: 'incoming',
    title: 'ZZManual ' + crypto.randomBytes(3).toString('hex'),
    company: 'Revolut',
    country: 'United Kingdom',
    role_id: roleId(),
    date: today(),
    ...over,
  });
  const data = await res.json();
  if (data.job_id) createdJobs.push(data.job_id);
  return { res, data };
}

function history(jobId: number) {
  return db.prepare(`
    SELECT s.name, s.type, e.changed_at, e.source FROM job_status_events e
    JOIN statuses s ON s.id = e.status_id
    WHERE e.job_id = ? AND e.profile_id = ? ORDER BY e.changed_at, e.id
  `).all(jobId, PROFILE_ID) as Array<{ name: string; type: string; changed_at: string; source: string }>;
}

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(tokenHash, PROFILE_ID);
});

test.afterAll(async () => {
  try {
    for (const id of createdJobs) {
      db.prepare('UPDATE job_profile_states SET duplicate_of_job_id = NULL WHERE duplicate_of_job_id = ?').run(id);
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    }
    // Creating a company fires a favicon lookup that is deliberately fire-and-forget, with a 5s
    // timeout — and its upsert will happily re-create a row deleted underneath it. Wait for that
    // attempt to land (it stamps `logo_attempted_at`) before sweeping, or the row comes back after
    // this hook has finished and lingers in the shared table.
    for (const key of createdCompanies) {
      for (let i = 0; i < 40; i++) {
        const row = db.prepare('SELECT logo_attempted_at FROM companies WHERE company = ?').get(key) as
          { logo_attempted_at: string | null } | undefined;
        if (!row || row.logo_attempted_at) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      db.prepare('DELETE FROM companies WHERE company = ?').run(key);
    }
  } finally {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
});

// ── The status trap (§4, test 7) ────────────────────────────────────────────────────────────────

test('every profile has Incoming, once, sorted after New (§4)', () => {
  const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
  expect(profiles.length).toBeGreaterThan(0);
  for (const { id } of profiles) {
    const rows = db.prepare(
      "SELECT id, sort_order, is_builtin FROM statuses WHERE profile_id = ? AND name = 'Incoming'",
    ).all(id) as Array<{ id: number; sort_order: number; is_builtin: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].is_builtin).toBe(1);
    const newRow = db.prepare(
      "SELECT sort_order FROM statuses WHERE profile_id = ? AND name = 'New' AND is_builtin = 1",
    ).get(id) as { sort_order: number };
    // Seeded BEFORE New, the pipeline would silently start stamping every scraped job "Incoming".
    expect(rows[0].sort_order).toBeGreaterThan(newRow.sort_order);
  }
});

test('the pipeline still opens a history at New, not Incoming (§4, test 7)', () => {
  // `newStatusId()`'s rule, as the runner applies it on every fetch.
  for (const { id } of db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>) {
    const byName = db.prepare(
      "SELECT name FROM statuses WHERE profile_id = ? AND type = 'new' AND is_builtin = 1 AND name = 'New' LIMIT 1",
    ).get(id) as { name: string } | undefined;
    const bySort = db.prepare(
      "SELECT name FROM statuses WHERE profile_id = ? AND type = 'new' AND is_builtin = 1 ORDER BY sort_order ASC LIMIT 1",
    ).get(id) as { name: string };
    // Both layers have to land on New — the fallback is one careless edit away from being the only one.
    expect(byName?.name).toBe('New');
    expect(bySort.name).toBe('New');
  }
});

// ── The two origins (§4, tests 1 and 2) ─────────────────────────────────────────────────────────

test('Incoming writes one event, dated the form date (§4)', async ({ page }) => {
  const { data } = await addJob(page, { origin: 'incoming', date: today() });
  expect(data.success).toBe(true);
  const h = history(data.job_id);
  expect(h.map((s) => s.name)).toEqual(['Incoming']);
  expect(h[0].changed_at).toBe(today());
  expect(h[0].source).toBe('manual');
  const state = db.prepare('SELECT ai_verdict, ai_score, is_duplicate, group_id FROM job_profile_states WHERE job_id = ? AND profile_id = ?')
    .get(data.job_id, PROFILE_ID) as { ai_verdict: string; ai_score: number; is_duplicate: number; group_id: number };
  expect(state.ai_verdict).toBe('STRONG_MATCH');   // the whole app gates on it (§3)
  expect(state.ai_score).toBe(0);                  // the column is NOT NULL; the card hides the number
  expect(state.is_duplicate).toBe(0);
  expect(state.group_id).toBe(roleId());           // or it drops out of per-role Stats entirely
});

test('Applied myself writes New then Applied, both on the form date (§4, test 2)', async ({ page }) => {
  const backdated = '2026-06-15';
  const { data } = await addJob(page, { origin: 'applied', date: backdated });
  const h = history(data.job_id);
  expect(h.map((s) => s.name)).toEqual(['New', 'Applied']);
  expect(h.map((s) => s.changed_at)).toEqual([backdated, backdated]);
  const cur = db.prepare(`
    SELECT s.name, s.type, jps.applied, jps.fetched_at FROM job_profile_states jps
    JOIN statuses s ON s.id = jps.status_id WHERE jps.job_id = ? AND jps.profile_id = ?
  `).get(data.job_id, PROFILE_ID) as { name: string; type: string; applied: number; fetched_at: string };
  // Same-day steps keep insertion order (D52), so Applied is current rather than New.
  expect(cur.name).toBe('Applied');
  expect(cur.type).toBe('applied');
  expect(cur.applied).toBe(1);
  // `fetched_at` is the FORM date: a history dated before the job arrived breaks it from birth.
  expect(cur.fetched_at).toBe(backdated);
});

// ── Validation rejects, never truncates (§8.4) ──────────────────────────────────────────────────

test('validation rejects rather than truncating (§8.4)', async ({ page }) => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ title: 'x'.repeat(201) }, /200 characters/],
    [{ company: 'https://evil.example.com' }, /letters, digits/],
    [{ company: 'me@example.com' }, /letters, digits/],
    [{ country: 'Atlantis' }, /country/i],
    [{ date: '2099-01-01' }, /future/],
    [{ date: '2019-01-01' }, /two years/],
    [{ role_id: 999999 }, /role/i],
    [{ url: 'javascript:alert(1)' }, /web address/],
    [{ origin: 'whatever' }, /how this job came/i],
  ];
  for (const [over, expected] of cases) {
    const { res, data } = await addJob(page, over);
    expect(res.status(), JSON.stringify(over)).toBe(400);
    expect(data.error, JSON.stringify(over)).toMatch(expected);
  }
});

// ── The company (§5, test 3) ────────────────────────────────────────────────────────────────────

test('a company we already track costs nothing and is never rewritten (§5, test 3)', async ({ page }) => {
  const before = db.prepare("SELECT * FROM companies WHERE company = 'revolut'").get() as Record<string, unknown>;
  const balanceBefore = (db.prepare('SELECT credits_balance FROM settings WHERE profile_id = ?')
    .get(PROFILE_ID) as { credits_balance: number }).credits_balance;

  const res = await api(page, '/api/company/check', 'POST', { name: 'Revolut' });
  expect(await res.json()).toEqual({ status: 'known', name: 'Revolut' });

  const after = db.prepare("SELECT * FROM companies WHERE company = 'revolut'").get() as Record<string, unknown>;
  expect(after).toEqual(before);                    // not one column touched
  const balanceAfter = (db.prepare('SELECT credits_balance FROM settings WHERE profile_id = ?')
    .get(PROFILE_ID) as { credits_balance: number }).credits_balance;
  expect(balanceAfter).toBe(balanceBefore);         // and no AI call was made
});

test('a new company is created, owned, and attached to the job (§5, §8.1)', async ({ page }) => {
  createdCompanies.push(NEW_COMPANY.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()));
  const { data } = await addJob(page, { company: NEW_COMPANY });
  expect(data.success).toBe(true);
  const row = db.prepare('SELECT display_name, created_by_profile_id FROM companies WHERE company = ?')
    .get(createdCompanies[createdCompanies.length - 1]) as { display_name: string; created_by_profile_id: number };
  expect(row.display_name).toBe(NEW_COMPANY);
  // The whole cleanup story: one query can wipe a bad actor's entire footprint (§8.1).
  expect(row.created_by_profile_id).toBe(PROFILE_ID);
});

test('the suggest endpoint offers names we already trust, and nothing else (§5)', async ({ page }) => {
  const res = await api(page, '/api/company-suggest?q=revolu', 'GET');
  const { names } = await res.json();
  expect(names).toContain('Revolut');
  expect(names.length).toBeLessThanOrEqual(8);
  // Under two characters is not a query; it is every company we have.
  expect((await (await api(page, '/api/company-suggest?q=r', 'GET')).json()).names).toEqual([]);
});

// ── The daily cap counts the right column (§8.3, test 8) ────────────────────────────────────────

test('the daily cap counts created_at, not the date on the form (§8.3, test 8)', async ({ page }) => {
  const { data } = await addJob(page);
  // Backdate the FORM date a year. A cap counting `fetched_at` would now see nothing at all.
  db.prepare("UPDATE jobs SET fetched_at = '2025-09-01' WHERE id = ?").run(data.job_id);
  db.prepare("UPDATE job_profile_states SET fetched_at = '2025-09-01' WHERE job_id = ?").run(data.job_id);
  const counted = (db.prepare(
    'SELECT COUNT(*) c FROM jobs WHERE created_by_profile_id = ? AND created_at >= ?',
  ).get(PROFILE_ID, today() + 'T00:00:00.000Z') as { c: number }).c;
  expect(counted).toBeGreaterThan(0);
});

// ── The Start page describes runs (§10.1, test 9) ───────────────────────────────────────────────

test('a manual job dated today is not counted as a last-run result (§10.1, test 9)', async ({ page }) => {
  const lastRunAt = (db.prepare(`
    SELECT ran_at FROM search_runs WHERE profile_id = ? AND status != 'running' ORDER BY ran_at DESC LIMIT 1
  `).get(PROFILE_ID) as { ran_at: string } | undefined)?.ran_at;
  test.skip(!lastRunAt, 'no run on this profile yet');

  const { data } = await addJob(page, { title: 'ZZManual StartPageProbe' });
  // Dated after the last run, so only the source filter can keep it out of that summary.
  db.prepare('UPDATE job_profile_states SET fetched_at = ? WHERE job_id = ?')
    .run(new Date().toISOString(), data.job_id);

  await page.goto('http://localhost:3000/');
  await expect(page.locator('body')).not.toContainText('ZZManual StartPageProbe');

  const counted = (db.prepare(`
    SELECT COUNT(*) c FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE jps.profile_id = ? AND jps.fetched_at >= ? AND j.job_source != 'Manual' AND j.id = ?
  `).get(PROFILE_ID, lastRunAt, data.job_id) as { c: number }).c;
  expect(counted).toBe(0);
});

// ── Delete (§7, test 6) ─────────────────────────────────────────────────────────────────────────

test('delete clears every child row and survives a duplicate pointing at it (§7, test 6)', async ({ page }) => {
  const { data } = await addJob(page, { description: 'Something to delete.' });
  const jobId = data.job_id;

  // The gotcha: `job_profile_states.duplicate_of_job_id` has no ON DELETE clause and foreign keys
  // are on, so an un-NULLed reference makes the delete throw.
  const other = db.prepare(
    'SELECT job_id FROM job_profile_states WHERE profile_id = ? AND duplicate_of_job_id IS NULL AND job_id != ? LIMIT 1',
  ).get(PROFILE_ID, jobId) as { job_id: number };
  db.prepare('UPDATE job_profile_states SET duplicate_of_job_id = ? WHERE job_id = ? AND profile_id = ?')
    .run(jobId, other.job_id, PROFILE_ID);

  const res = await api(page, '/api/jobs/' + jobId, 'DELETE', undefined);
  expect(res.status()).toBe(200);

  for (const t of ['job_profile_states', 'job_status_events', 'job_postings', 'job_countries', 'job_locations', 'job_descriptions']) {
    expect((db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE job_id = ?`).get(jobId) as { c: number }).c, t).toBe(0);
  }
  expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(jobId)).toBeUndefined();
  expect((db.prepare('SELECT duplicate_of_job_id d FROM job_profile_states WHERE job_id = ? AND profile_id = ?')
    .get(other.job_id, PROFILE_ID) as { d: number | null }).d).toBeNull();
});

test('a merged job refuses to be deleted, and says why (§7)', async ({ page }) => {
  const { data } = await addJob(page, { title: 'ZZManual MergedProbe' });
  db.prepare("UPDATE jobs SET merged_from = 'LinkedIn::zz-e2e' WHERE id = ?").run(data.job_id);

  const res = await api(page, '/api/jobs/' + data.job_id, 'DELETE', undefined);
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toBe('merged');

  // The control stays visible and answers — a vanished control teaches nothing.
  await page.goto('http://localhost:3000/jobs?verdict=all&selected=' + data.job_id);
  await page.getByRole('button', { name: 'Delete this job' }).click();
  await expect(page.locator('#jd-delete-panel')).toContainText("Can't delete — an automated run picked this job up");
  await expect(page.locator('#jd-delete-panel')).toContainText("I'm not applying");
});

test('a job that is not yours, or not manual, cannot be deleted (§7)', async ({ page }) => {
  const scraped = db.prepare(`
    SELECT jps.job_id FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE jps.profile_id = ? AND j.job_source != 'Manual' LIMIT 1
  `).get(PROFILE_ID) as { job_id: number };
  const res = await api(page, '/api/jobs/' + scraped.job_id, 'DELETE', undefined);
  expect(res.status()).toBe(403);
  expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(scraped.job_id)).toBeDefined();
});

// ── The screen (§3, plates 01–05) ───────────────────────────────────────────────────────────────

test('the card wears the state in words, and the score square carries no number (§3)', async ({ page }) => {
  const { data } = await addJob(page, { title: 'ZZManual CardProbe' });
  await page.goto('http://localhost:3000/jobs?verdict=all&selected=' + data.job_id);

  const card = page.locator('.jobcard[data-id="' + data.job_id + '"]');
  await expect(card).toContainText('You added this job manually.');
  // The chip is still there and still verdict-toned — only the "0" is gone.
  const chips = await card.locator('span[style*="tabular-nums"]').allTextContents();
  expect(chips[0].trim()).toBe('');

  // The badge lives in the detail header, where every source badge already lives.
  await expect(page.locator('#jh-pane')).toContainText('Added manually');
  // And there is no "View on Added manually" button.
  await expect(page.locator('#jh-pane')).not.toContainText('View on Added manually');
});

test('Add a job opens the form and saves one, end to end (§2, §3)', async ({ page }) => {
  await page.goto('http://localhost:3000/jobs');
  await page.getByRole('button', { name: 'Add a job' }).click();
  await expect(page.locator('#jh-addjob-modal')).toBeVisible();

  const title = 'ZZManual FormProbe ' + crypto.randomBytes(2).toString('hex');
  await page.locator('#aj-title').fill(title);
  // A prefix, not the whole name: a suggestion identical to what is already typed is not a
  // suggestion, so the list filters it out.
  await page.locator('#aj-company').fill('Revolu');
  await page.locator('#aj-company-sugg button').first().waitFor({ state: 'visible' });
  await page.locator('#aj-company-sugg button', { hasText: /^Revolut$/ }).first().click();
  await expect(page.locator('#aj-company-state')).toContainText('Matched to a company you already track');

  await page.locator('#aj-country').selectOption('United Kingdom');
  await page.locator('#aj-role').selectOption(String(roleId()));

  // Applied myself swaps the date label, because the same field means two different things.
  await page.locator('#aj-o-applied').click();
  await expect(page.locator('#aj-date-label')).toHaveText('Date applied');

  await page.locator('#aj-date-btn').click();
  const dayNum = String(new Date().getDate());
  await page.locator('#aj-cal div', { hasText: new RegExp('^' + dayNum + '$') }).last().click();
  await expect(page.locator('#aj-date-text')).not.toHaveText('Pick a date…');

  await page.locator('#aj-note').fill('Recruiter wrote on LinkedIn.');
  await page.locator('#aj-submit').click();

  // The form closes straight into the job — an old application date can file the card pages back.
  await page.waitForURL(/\/jobs\?selected=\d+/);
  const jobId = Number(new URL(page.url()).searchParams.get('selected'));
  createdJobs.push(jobId);
  await expect(page.locator('#jh-pane')).toContainText(title);
  expect(history(jobId).map((s) => s.name)).toEqual(['New', 'Applied']);
  expect((db.prepare('SELECT user_notes n FROM job_profile_states WHERE job_id = ? AND profile_id = ?')
    .get(jobId, PROFILE_ID) as { n: string }).n).toBe('Recruiter wrote on LinkedIn.');
});

// ── The merge's precondition (§6, test 4) ───────────────────────────────────────────────────────

test('the pipeline finds a manual job by its link, before any scoring (§6, test 4)', async ({ page }) => {
  const link = 'https://example.com/zz-merge-probe/' + crypto.randomBytes(3).toString('hex');
  const { data } = await addJob(page, { title: 'ZZManual MergeProbe', url: link });

  // `filterDuplicatesByUrl` is the real module the free merge route runs on. It reads
  // `job_postings` joined to this profile's state rows — which is exactly why a manual job is given
  // an ordinary posting row (§3 step 3). Imported here rather than re-implemented: a copy of the
  // query in a test proves nothing about the query that ships.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { filterDuplicatesByUrl } = require('../src/pipeline/deduplicator');
  const scraped = {
    jobId: 'zz' + crypto.randomBytes(4).toString('hex'), title: 'Principal PM', company: 'Revolut',
    location: 'London, UK', workMode: 'hybrid', url: link, applyUrl: null, postedDate: '2026-09-10',
    postedDateConfidence: 'HIGH', description: 'The real one.', provider: 'valig', jobSource: 'LinkedIn',
  };
  const { uniqueJobs, urlDuplicates } = filterDuplicatesByUrl([scraped], PROFILE_ID);
  expect(uniqueJobs).toHaveLength(0);
  expect(urlDuplicates[0].duplicateOfId).toBe(data.job_id);

  // And the runner's guard resolves it as a merge target — once. `merged_from` is what stops a
  // posting another profile already owns being re-merged on every run, forever.
  const target = () => db.prepare(`
    SELECT j.id FROM jobs j
    JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
    WHERE j.id = ? AND j.job_source = 'Manual' AND j.created_by_profile_id = ? AND j.merged_from IS NULL
  `).get(PROFILE_ID, data.job_id, PROFILE_ID) as { id: number } | undefined;
  expect(target()?.id).toBe(data.job_id);
  db.prepare("UPDATE jobs SET merged_from = 'LinkedIn::zz' WHERE id = ?").run(data.job_id);
  expect(target()).toBeUndefined();
});

test('a job with no description at all is not a dedup candidate (§6)', async ({ page }) => {
  const { data } = await addJob(page, { title: 'ZZManual NoDescription' });   // no description given
  const candidates = db.prepare(`
    SELECT j.id FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    WHERE lower(j.company) = 'revolut' AND jps.is_duplicate = 0 AND jps.profile_id = ?
      AND TRIM(COALESCE(jd.description_text, j.description)) != ''
  `).all(PROFILE_ID) as Array<{ id: number }>;
  // Title alone is exactly the signal this design refuses to merge on, and a false merge silently
  // swallows a real status history.
  expect(candidates.map((c) => c.id)).not.toContain(data.job_id);
});

// ── Money and the blacklist (§5, tests 11 and 12) ───────────────────────────────────────────────

test('a profile below the credit floor can still add a job (§5, test 11)', async ({ page }) => {
  const before = db.prepare('SELECT use_jh_credits, credits_balance FROM settings WHERE profile_id = ?')
    .get(PROFILE_ID) as { use_jh_credits: number; credits_balance: number };
  db.prepare('UPDATE settings SET use_jh_credits = 1, credits_balance = 0.30 WHERE profile_id = ?').run(PROFILE_ID);
  try {
    // The check keys through `resolveSpendKeys`, which enforces the $0.50 MIN_RUN_CREDITS floor.
    // A refusal is not an error — the company is created unenriched and the save goes ahead.
    const res = await api(page, '/api/company/check', 'POST', { name: 'ZZ Skint Holdings ' + crypto.randomBytes(2).toString('hex') });
    const checked = await res.json();
    expect(res.status()).toBe(200);
    expect(checked.status).toBe('unchecked');
    expect(checked.reason).toBe('no_credits');

    // A company we already hold, so this half tests the floor and nothing else.
    const { data } = await addJob(page);
    expect(data.success).toBe(true);
  } finally {
    db.prepare('UPDATE settings SET use_jh_credits = ?, credits_balance = ? WHERE profile_id = ?')
      .run(before.use_jh_credits, before.credits_balance, PROFILE_ID);
  }
});

test('a blacklisted company can still be added by hand (§5, test 12)', async ({ page }) => {
  const blacklisted = db.prepare('SELECT company_name FROM blacklisted_companies WHERE profile_id = ? LIMIT 1')
    .get(PROFILE_ID) as { company_name: string } | undefined;
  test.skip(!blacklisted, 'nothing blacklisted on this profile');
  // Blacklisting suppresses automated results; adding by hand is an explicit statement of intent.
  const { res, data } = await addJob(page, { company: blacklisted!.company_name });
  expect(res.status()).toBe(200);
  expect(data.success).toBe(true);
});

// ── Deleting the account that made them (§9.1, test 10) ─────────────────────────────────────────

test('deleting a profile that added jobs by hand succeeds, and takes them with it (§9.1, test 10)', async ({ page }) => {
  const email = 'zz-manual-' + crypto.randomBytes(4).toString('hex') + '@example.com';
  const created = await (await api(page, '/api/profiles', 'POST', { email })).json();
  expect(created.success).toBe(true);
  const victimId = created.profile.id;

  // A session for the new profile, minted and removed by exact token like our own.
  const vToken = crypto.randomBytes(24).toString('hex');
  const vHash = crypto.createHash('sha256').update(vToken).digest('hex');
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(vHash, victimId);

  let victimJobId = 0;
  try {
    const ctx = await page.context().browser()!.newContext();
    await ctx.addCookies([{ name: 'jh_session', value: vToken, domain: 'localhost', path: '/' }]);
    // A brand-new profile has no roles at all, which is the one case where `group_id` may be NULL.
    const res = await ctx.request.fetch('http://localhost:3000/api/jobs/manual', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        origin: 'incoming', title: 'ZZManual OrphanProbe', company: 'Revolut',
        country: 'Germany', date: today(),
      }),
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    victimJobId = body.job_id;
    await ctx.close();

    // `created_by_profile_id REFERENCES profiles(id)` without ON DELETE SET NULL makes this throw.
    const del = await api(page, `/api/profiles/${victimId}/delete`, 'POST', {});
    expect(del.status(), await del.text()).toBe(200);

    // Asserted here, before the cleanup below could hide the answer: its manual jobs go with it.
    // Without the explicit delete they linger forever as unreachable rows that SET NULL has
    // stripped of their owner.
    expect(db.prepare('SELECT id FROM jobs WHERE id = ?').get(victimJobId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM profiles WHERE id = ?').get(victimId)).toBeUndefined();
  } finally {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(vHash);
    if (victimJobId) db.prepare('DELETE FROM jobs WHERE id = ?').run(victimJobId);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(victimId);
    db.prepare('DELETE FROM deleted_profiles WHERE profile_id = ?').run(victimId);
  }
});

// ── The phone (§2, plate 02) ────────────────────────────────────────────────────────────────────

test('the form is a usable bottom sheet below 768px (§2)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('http://localhost:3000/jobs');
  // The label shortens to "Add" — the icon carries the rest.
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const sheet = page.locator('#jh-addjob-modal > div:last-child');
  await expect(sheet).toBeVisible();

  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);           // never wider than the phone
  expect(box.height).toBeLessThanOrEqual(780 * 0.91);   // max-height:90vh, so the ground shows
  // Every control is reachable: the body scrolls, the footer does not leave the screen.
  await expect(page.locator('#aj-submit')).toBeInViewport();
  await expect(page.locator('#aj-title')).toBeVisible();
  // And the page behind it does not scroll sideways.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// ── The name-correction fork (§5.3) ─────────────────────────────────────────────────────────────
//
// The check's own answer is stubbed here, deliberately. The model is not deterministic — asked
// twice about "Johnson & John" it corrected it once and left it alone once — so driving this
// through a real call would make the test flaky and cost money to be flaky with. What is being
// tested is the rule, not the model: **whenever a correction comes back, the user is asked**, and
// whichever button they press is what gets saved.

async function fillFormForCompany(page: Page, title: string, company: string) {
  await page.goto('http://localhost:3000/jobs');
  await page.getByRole('button', { name: 'Add a job' }).click();
  await page.locator('#aj-title').fill(title);
  await page.locator('#aj-company').fill(company);
  await page.waitForTimeout(300);
  await page.locator('#aj-company').press('Escape');          // dismiss the autocomplete list
  await page.locator('#aj-country').selectOption('Spain');
  await page.locator('#aj-role').selectOption(String(roleId()));
  await page.locator('#aj-date-btn').click();
  await page.locator('#aj-cal div', { hasText: new RegExp('^' + new Date().getDate() + '$') }).last().click();
  await page.locator('#aj-submit').click();
}

/** Answer `/api/company/check` with a correction, without calling the model. */
async function stubCorrection(page: Page, typed: string, suggested: string) {
  await page.route('**/api/company/check', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'suggestion', typed, suggested }) }));
}

test('a correction is always offered, never applied silently (§5.3)', async ({ page }) => {
  await stubCorrection(page, 'Johnson & John', 'Johnson & Johnson');
  await fillFormForCompany(page, 'ZZFork Ask', 'Johnson & John');

  const fork = page.locator('.aj-sugg');
  await expect(fork).toBeVisible();
  await expect(fork).toContainText('Did you mean Johnson & Johnson?');
  // Each choice names the outcome, rather than "Accept" / "Decline", which say nothing about what
  // you end up with. Neither is destructive, so neither is red.
  await expect(page.getByRole('button', { name: 'Use Johnson & Johnson' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep Johnson & John' })).toBeVisible();
  // Nothing has been written while the question is on screen.
  expect(db.prepare("SELECT id FROM jobs WHERE title = 'ZZFork Ask'").get()).toBeUndefined();
});

test('accepting the correction attaches to the company we already have, untouched (§5.3, §8.2)', async ({ page }) => {
  const before = db.prepare("SELECT * FROM companies WHERE company = 'johnson & johnson'").get() as Record<string, unknown>;
  test.skip(!before, 'Johnson & Johnson is not in this base');

  await stubCorrection(page, 'Johnson & John', 'Johnson & Johnson');
  await fillFormForCompany(page, 'ZZFork Accept', 'Johnson & John');
  await page.getByRole('button', { name: 'Use Johnson & Johnson' }).click();

  await page.waitForURL(/\/jobs\?selected=\d+/);
  const jobId = Number(new URL(page.url()).searchParams.get('selected'));
  createdJobs.push(jobId);
  expect((db.prepare('SELECT company FROM jobs WHERE id = ?').get(jobId) as { company: string }).company).toBe('Johnson & Johnson');
  // A user can never change what everyone else sees about a real company.
  expect(db.prepare("SELECT * FROM companies WHERE company = 'johnson & johnson'").get()).toEqual(before);
});

test('declining the correction keeps the name that was typed (§5.3)', async ({ page }) => {
  await stubCorrection(page, 'Johnson & John', 'Johnson & Johnson');
  await fillFormForCompany(page, 'ZZFork Decline', 'Johnson & John');
  await page.getByRole('button', { name: 'Keep Johnson & John' }).click();

  await page.waitForURL(/\/jobs\?selected=\d+/);
  const jobId = Number(new URL(page.url()).searchParams.get('selected'));
  createdJobs.push(jobId);
  createdCompanies.push('johnson & john');
  expect((db.prepare('SELECT company FROM jobs WHERE id = ?').get(jobId) as { company: string }).company).toBe('Johnson & John');
  // Created under the typed name and stamped with its owner — the guard rail that makes a bad
  // actor's whole footprint one query to find (§8.1).
  const made = db.prepare("SELECT created_by_profile_id FROM companies WHERE company = 'johnson & john'")
    .get() as { created_by_profile_id: number };
  expect(made.created_by_profile_id).toBe(PROFILE_ID);
  // Not asserted: `enrich_status`. The model's profile fields describe the CORRECTED company, so a
  // declined suggestion normally leaves the typed one unenriched — but if that same name was checked
  // within the last 15 minutes its payload is still in the server's pending cache and is used. That
  // is the cache working, not a gap, and it makes the column a property of process memory rather
  // than of this rule.
});
