/**
 * E2E: custom job statuses — the list, the history, and everything that reads them
 * (application_status.md §15).
 *
 * Six things are worth a test here, and they are the six the doc calls out in §12.8: the migration
 * mapped 0/1/2 correctly; the applications count holds steady as a job advances *past* Applied; a
 * deleted history row recomputes the current status; a future date is refused; the 15-status cap
 * holds; and the quick filters agree with the Status control.
 *
 * Runs against the real DB. It mints its own session and deletes it **by exact token**, and it
 * restores every row it writes **by exact id** in afterAll — never a broad `profile_id` sweep.
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

const APPLIED_TYPES = "'applied','progress','offer','rejected'";
const EVER_APPLIED = `(EXISTS (
    SELECT 1 FROM job_status_events e JOIN statuses es ON es.id = e.status_id
    WHERE e.job_id = jps.job_id AND e.profile_id = jps.profile_id AND es.type IN (${APPLIED_TYPES})
  ) OR EXISTS (
    SELECT 1 FROM statuses cs WHERE cs.id = jps.status_id AND cs.type IN (${APPLIED_TYPES})
  ))`;

function statusIdOfType(type: string): number {
  const row = db.prepare(
    'SELECT id FROM statuses WHERE profile_id = ? AND type = ? AND archived_at IS NULL ORDER BY sort_order LIMIT 1',
  ).get(PROFILE_ID, type) as { id: number } | undefined;
  if (!row) throw new Error(`No status of type ${type}`);
  return row.id;
}

function applicationCount(): number {
  return (db.prepare(`
    SELECT COUNT(*) AS c FROM job_profile_states jps
    WHERE jps.profile_id = ? AND ${EVER_APPLIED} AND jps.is_duplicate = 0 AND jps.ai_verdict = 'STRONG_MATCH'
  `).get(PROFILE_ID) as { c: number }).c;
}

function pickJob(type: string): number {
  const row = db.prepare(`
    SELECT jps.job_id AS id FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
    WHERE jps.profile_id = ? AND s.type = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
    ORDER BY jps.job_id LIMIT 1
  `).get(PROFILE_ID, type) as { id: number } | undefined;
  if (!row) throw new Error(`No fixture job at status type ${type}`);
  return row.id;
}

// Everything this run creates or changes, so afterAll can put it back precisely.
const createdEvents: number[] = [];
const createdStatuses: number[] = [];
const originalState = new Map<number, { status_id: number | null; applied: number }>();

function remember(jobId: number): void {
  if (originalState.has(jobId)) return;
  const row = db.prepare('SELECT status_id, applied FROM job_profile_states WHERE job_id = ? AND profile_id = ?')
    .get(jobId, PROFILE_ID) as { status_id: number | null; applied: number };
  originalState.set(jobId, row);
}

function addStep(jobId: number, type: string, day: string): number {
  remember(jobId);
  const sid = statusIdOfType(type);
  const res = db.prepare(
    "INSERT INTO job_status_events (profile_id, job_id, status_id, changed_at, source) VALUES (?, ?, ?, ?, 'test')",
  ).run(PROFILE_ID, jobId, sid, day);
  db.prepare('UPDATE job_profile_states SET status_id = ? WHERE job_id = ? AND profile_id = ?')
    .run(sid, jobId, PROFILE_ID);
  const id = Number(res.lastInsertRowid);
  createdEvents.push(id);
  return id;
}

test.beforeAll(() => {
  db.prepare(
    `INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`,
  ).run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  try {
    for (const id of createdEvents) db.prepare('DELETE FROM job_status_events WHERE id = ?').run(id);
    for (const id of createdStatuses) db.prepare('DELETE FROM statuses WHERE id = ? AND profile_id = ?').run(id, PROFILE_ID);
    for (const [jobId, s] of originalState) {
      db.prepare('UPDATE job_profile_states SET status_id = ?, applied = ? WHERE job_id = ? AND profile_id = ?')
        .run(s.status_id, s.applied, jobId, PROFILE_ID);
    }
  } finally {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }
});

async function auth(page: Page) {
  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
}

// ── DM2, DM3: the migration ────────────────────────────────────────────────────────────────

test('every profile has the ten defaults, in order, with three built-ins (DM2)', () => {
  const profiles = db.prepare('SELECT id FROM profiles').all() as Array<{ id: number }>;
  expect(profiles.length).toBeGreaterThan(0);
  for (const { id } of profiles) {
    // The seeded ten only: `sort_order` 0-9 is what the migration wrote. Anything the user has
    // added since sits above that, and a user adding a status must never fail this assertion.
    const seeded = db.prepare(
      'SELECT name, type, is_builtin FROM statuses WHERE profile_id = ? AND sort_order < 10 ORDER BY sort_order',
    ).all(id) as Array<{ name: string; type: string; is_builtin: number }>;
    expect(seeded.map((r) => r.name)).toEqual([
      'New', 'Not applying', 'Applied', 'Recruiter', 'Hiring Manager',
      'Case', 'Team call', 'Offer', 'Rejected', 'I declined',
    ]);
    expect(seeded.filter((r) => r.is_builtin === 1).map((r) => r.name)).toEqual(['New', 'Not applying', 'Applied']);
  }
});

test('the old three-state column mapped onto the right statuses, and every row is mapped (DM3)', () => {
  const unmapped = (db.prepare('SELECT COUNT(*) AS c FROM job_profile_states WHERE status_id IS NULL').get() as { c: number }).c;
  expect(unmapped).toBe(0);

  const pairs = db.prepare(`
    SELECT jps.applied, s.type, COUNT(*) AS c
    FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
    WHERE jps.profile_id = ? GROUP BY jps.applied, s.type
  `).all(PROFILE_ID) as Array<{ applied: number; type: string; c: number }>;
  // Nothing migrated to a type its old value cannot mean.
  for (const p of pairs) {
    if (p.applied === 0) expect(p.type).toBe('new');
    if (p.applied === 2) expect(p.type).toBe('wont');
  }

  // No history was invented for the transition itself — only the opening `New`, dated the day the
  // job arrived, which is a fact rather than a guess (D8, D34).
  const invented = (db.prepare(`
    SELECT COUNT(*) AS c FROM job_status_events e JOIN statuses s ON s.id = e.status_id
    WHERE e.source = 'backfill' AND s.type <> 'new'
  `).get() as { c: number }).c;
  expect(invented).toBe(0);
});

// ── NR1, NR2: the applications count ───────────────────────────────────────────────────────

test('the applications count does not fall as a job advances past Applied (NR1)', () => {
  const job = pickJob('applied');
  const base = applicationCount();

  addStep(job, 'progress', '2026-09-01');
  expect(applicationCount()).toBe(base);

  addStep(job, 'offer', '2026-09-04');
  expect(applicationCount()).toBe(base);

  // "I declined" applied and then walked away. It still counts (§4.2).
  addStep(job, 'rejected', '2026-09-06');
  expect(applicationCount()).toBe(base);
});

test("Won't Apply is not an application, and the two are different types (NR2)", () => {
  const types = db.prepare('SELECT DISTINCT type FROM statuses WHERE profile_id = ?').all(PROFILE_ID) as Array<{ type: string }>;
  const names = types.map((t) => t.type);
  expect(names).toContain('wont');
  expect(names).toContain('rejected');
  // A job that only ever sat at `wont`, with no other step, is not an application.
  const wontOnly = (db.prepare(`
    SELECT COUNT(*) AS c FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
    WHERE jps.profile_id = ? AND s.type = 'wont' AND ${EVER_APPLIED}
      AND NOT EXISTS (SELECT 1 FROM job_status_events e JOIN statuses es ON es.id = e.status_id
                      WHERE e.job_id = jps.job_id AND e.profile_id = jps.profile_id AND es.type IN (${APPLIED_TYPES}))
  `).get(PROFILE_ID) as { c: number }).c;
  expect(wontOnly).toBe(0);
});

// ── DP9, DP10, DP12, DP13: history editing ─────────────────────────────────────────────────

test('deleting a step promotes the one below it; deleting them all returns the job to New (DP10)', async ({ page, request }) => {
  await auth(page);
  const job = pickJob('applied');
  const recruiterStep = addStep(job, 'progress', '2026-09-02');

  const current = () => {
    const r = db.prepare(`
      SELECT s.type FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
      WHERE jps.job_id = ? AND jps.profile_id = ?
    `).get(job, PROFILE_ID) as { type: string };
    return r.type;
  };
  expect(current()).toBe('progress');

  const res = await request.delete(`/api/history/${recruiterStep}`, {
    headers: { Cookie: `jh_session=${token}` },
  });
  expect(res.ok()).toBeTruthy();
  createdEvents.splice(createdEvents.indexOf(recruiterStep), 1);
  // The step below it is the migration's `New`, so the job falls back to New — there is no
  // Applied step in the log for a migrated job (D8).
  expect(current()).toBe('new');
});

test('a future date is refused (D9, DP8)', async ({ request }) => {
  const job = pickJob('applied');
  const step = addStep(job, 'progress', '2026-09-02');
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const res = await request.patch(`/api/history/${step}`, {
    headers: { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' },
    data: { changed_at: future },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/future/i);

  // And the row is untouched.
  const row = db.prepare('SELECT changed_at FROM job_status_events WHERE id = ?').get(step) as { changed_at: string };
  expect(row.changed_at).toBe('2026-09-02');
});

test('a step cannot be dated before the job arrived', async ({ request }) => {
  // Without this floor, dragging a step behind the opening `New` makes New the newest again and
  // the job silently reverts to New — which reads as lost data, not an edit.
  const job = pickJob('applied');
  const step = addStep(job, 'progress', '2026-09-02');
  const arrival = db.prepare(
    "SELECT changed_at FROM job_status_events WHERE job_id = ? AND profile_id = ? AND source = 'backfill'",
  ).get(job, PROFILE_ID) as { changed_at: string };

  const res = await request.patch(`/api/history/${step}`, {
    headers: { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' },
    data: { changed_at: '2020-01-01' },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toContain(arrival.changed_at);

  const still = db.prepare('SELECT changed_at FROM job_status_events WHERE id = ?').get(step) as { changed_at: string };
  expect(still.changed_at).toBe('2026-09-02');
});

test('a rejection must stay the last step (D35)', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  const job = pickJob('applied');
  addStep(job, 'applied', '2026-09-01');
  const rejected = addStep(job, 'rejected', '2026-09-05');

  const currentType = () => (db.prepare(`
    SELECT s.type FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
    WHERE jps.job_id = ? AND jps.profile_id = ?
  `).get(job, PROFILE_ID) as { type: string }).type;
  expect(currentType()).toBe('rejected');

  // Re-dating it behind the Applied step would reopen a closed line.
  const res = await request.patch(`/api/history/${rejected}`, {
    headers, data: { changed_at: '2026-08-20' },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/last step/i);
  expect(currentType()).toBe('rejected');

  // Retyping an earlier step to Rejected is refused for the same reason.
  const earlier = db.prepare(`
    SELECT id FROM job_status_events WHERE job_id = ? AND profile_id = ? AND changed_at = '2026-09-01'
  `).get(job, PROFILE_ID) as { id: number };
  const res2 = await request.patch(`/api/history/${earlier.id}`, {
    headers, data: { status_id: statusIdOfType('rejected') },
  });
  expect(res2.status()).toBe(400);
});

test('two steps on one date keep their order across reloads (DP13)', () => {
  const job = pickJob('applied');
  const first = addStep(job, 'progress', '2026-09-03');
  const second = addStep(job, 'offer', '2026-09-03');
  expect(second).toBeGreaterThan(first);

  // `(date, id)` ordering, twice — the later one is current both times.
  for (let i = 0; i < 2; i++) {
    const rows = db.prepare(`
      SELECT e.id, s.type FROM job_status_events e JOIN statuses s ON s.id = e.status_id
      WHERE e.job_id = ? AND e.profile_id = ? ORDER BY e.changed_at ASC, e.id ASC
    `).all(job, PROFILE_ID) as Array<{ id: number; type: string }>;
    expect(rows[rows.length - 1].id).toBe(second);
    expect(rows[rows.length - 1].type).toBe('offer');
  }
});

test('the list card cannot append a step past a rejection (D35)', async ({ request }) => {
  const job = pickJob('applied');
  addStep(job, 'applied', '2026-09-01');
  addStep(job, 'rejected', '2026-09-05');

  // The rail's `+` is disabled in this state; the card's chip has no rail to disable, so the rule
  // is enforced server-side or the list silently pushes a step past the rejection.
  const res = await request.patch(`/api/jobs/${job}/status`, {
    headers: { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' },
    data: { status_id: statusIdOfType('progress') },
  });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/end of this job/i);
});

test('an already-broken log stays repairable', async ({ request }) => {
  // A log written before the rule existed can have a rejection in the middle. Judged absolutely,
  // every edit on it is refused — including the one that would fix it. The check is a delta, so
  // an edit that does not make things worse is allowed through.
  const job = pickJob('applied');
  const first = addStep(job, 'rejected', '2026-09-01');   // rejection...
  addStep(job, 'progress', '2026-09-05');                 // ...with a step after it: already bad

  const res = await request.patch(`/api/history/${first}`, {
    headers: { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' },
    data: { changed_at: '2026-09-02' },
  });
  expect(res.ok()).toBeTruthy();
});

// ── DM4, DM5: the statuses admin ───────────────────────────────────────────────────────────

test('the cap is 15 live statuses; the 16th is refused by name (DM4)', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  const live = () => (db.prepare('SELECT COUNT(*) AS c FROM statuses WHERE profile_id = ? AND archived_at IS NULL')
    .get(PROFILE_ID) as { c: number }).c;

  const room = 15 - live();
  for (let i = 0; i < room; i++) {
    const res = await request.post('/api/statuses', { headers, data: { name: `Cap probe ${i}`, type: 'progress' } });
    expect(res.status()).toBe(201);
    createdStatuses.push((await res.json()).status.id);
  }
  expect(live()).toBe(15);

  const over = await request.post('/api/statuses', { headers, data: { name: 'One too many', type: 'progress' } });
  expect(over.status()).toBe(409);
  expect((await over.json()).error).toContain('15');

  // Release the slots again, so this test leaves the list as it found it and the next one has
  // room to create its own probe. They are this run's own rows, deleted by exact id.
  while (createdStatuses.length) {
    const id = createdStatuses.pop() as number;
    db.prepare('DELETE FROM statuses WHERE id = ? AND profile_id = ?').run(id, PROFILE_ID);
  }
  expect(live()).toBeLessThan(15);
});

test('a built-in cannot be deleted or retyped (AD3, DM5)', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  const applied = statusIdOfType('applied');

  const retype = await request.patch(`/api/statuses/${applied}`, { headers, data: { type: 'progress' } });
  expect(retype.status()).toBe(400);

  const del = await request.delete(`/api/statuses/${applied}`, { headers });
  expect(del.status()).toBe(400);

  // Still Applied, still built-in.
  const row = db.prepare('SELECT type, is_builtin FROM statuses WHERE id = ?').get(applied) as { type: string; is_builtin: number };
  expect(row.type).toBe('applied');
  expect(row.is_builtin).toBe(1);
});

test('deleting is refused while a job sits in the status, and archives rather than erases (DM5)', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  const made = await request.post('/api/statuses', { headers, data: { name: 'Archive probe', type: 'progress' } });
  const id = (await made.json()).status.id as number;
  createdStatuses.push(id);

  // Park a job in it — the delete must be refused.
  const job = pickJob('applied');
  remember(job);
  db.prepare('UPDATE job_profile_states SET status_id = ? WHERE job_id = ? AND profile_id = ?').run(id, job, PROFILE_ID);
  const blocked = await request.delete(`/api/statuses/${id}`, { headers });
  expect(blocked.status()).toBe(409);

  // Move it out, and the delete lands — as an archive, with the row still present.
  db.prepare('UPDATE job_profile_states SET status_id = ? WHERE job_id = ? AND profile_id = ?')
    .run(statusIdOfType('applied'), job, PROFILE_ID);
  const ok = await request.delete(`/api/statuses/${id}`, { headers });
  expect(ok.ok()).toBeTruthy();

  const row = db.prepare('SELECT archived_at FROM statuses WHERE id = ?').get(id) as { archived_at: string | null };
  expect(row.archived_at).not.toBeNull();
});

test('only In Progress, Offer and Rejected can be created or assigned', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  const listed = await (await request.get('/api/statuses', { headers })).json();
  expect(listed.assignableTypes).toEqual(['progress', 'offer', 'rejected']);

  // `New`, `Not applying` and `Applied` are single built-in rows; a second of any of them would
  // make "is this an application?" ambiguous.
  for (const type of ['new', 'wont', 'applied']) {
    const res = await request.post('/api/statuses', { headers, data: { name: `probe ${type}`, type } });
    expect(res.status()).toBe(400);
  }
});

test('a status with history cannot be retyped to Rejected (D35)', async ({ request }) => {
  const headers = { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' };
  // Unused: allowed, there is no history to strand.
  const made = await request.post('/api/statuses', { headers, data: { name: 'Retype probe', type: 'progress' } });
  const id = (await made.json()).status.id as number;
  createdStatuses.push(id);
  expect((await request.patch(`/api/statuses/${id}`, { headers, data: { type: 'rejected' } })).ok()).toBeTruthy();

  // Used: refused. A rejection ends the line, so retyping a status that jobs have passed THROUGH
  // would leave a rejection sitting mid-history on every one of them.
  const job = pickJob('applied');
  addStep(job, 'progress', '2026-09-02');
  addStep(job, 'applied', '2026-09-04');
  const used = statusIdOfType('progress');
  const res = await request.patch(`/api/statuses/${used}`, { headers, data: { type: 'rejected' } });
  expect(res.status()).toBe(409);
  expect((await res.json()).error).toMatch(/last step/i);
});

test('the list is ordered by type, then name — not by hand', async ({ request }) => {
  const list = (await (await request.get('/api/statuses', {
    headers: { Cookie: `jh_session=${token}` },
  })).json()).statuses as Array<{ name: string; type: string }>;
  const rank = ['new', 'wont', 'applied', 'progress', 'offer', 'rejected'];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    const ra = rank.indexOf(a.type), rb = rank.indexOf(b.type);
    expect(ra, `${a.name} before ${b.name}`).toBeLessThanOrEqual(rb);
    if (ra === rb) expect(a.name.toLowerCase() <= b.name.toLowerCase()).toBeTruthy();
  }
  // The hand-ordering endpoint is gone.
  const gone = await request.post('/api/statuses/order', {
    headers: { Cookie: `jh_session=${token}`, 'Content-Type': 'application/json' },
    data: { order: [] },
  });
  expect(gone.status()).toBe(404);
});

// ── FL: filters and shortcuts ──────────────────────────────────────────────────────────────

test('the Status filter reads a name when one is picked and a count when several (FL2)', async ({ page }) => {
  await auth(page);
  const applied = statusIdOfType('applied');
  const recruiter = statusIdOfType('progress');

  await page.goto(`/jobs?verdict=all&status=${applied}`);
  await expect(page.locator('[data-filter="status"] .fb-label')).toHaveText('Applied');

  await page.goto(`/jobs?verdict=all&status=${applied},${recruiter}`);
  await expect(page.locator('[data-filter="status"] .fb-label')).toHaveText('2 statuses');
});

test('the `applied` alias resolves, and an unknown id is dropped rather than zeroing (FL8)', async ({ page }) => {
  await auth(page);
  await page.goto('/jobs?verdict=all&status=applied');
  await expect(page.locator('[data-filter="status"] .fb-label')).toHaveText('Applied');
  const aliasCards = await page.locator('.jobcard').count();
  expect(aliasCards).toBeGreaterThan(0);

  // A status the user has since deleted must not silently empty the list.
  await page.goto('/jobs?verdict=all&status=99999');
  await expect(page.locator('[data-filter="status"] .fb-label')).toHaveText('Status');
  expect(await page.locator('.jobcard').count()).toBeGreaterThan(aliasCards);
});

test('id order is one cache entry, not two (FL9)', async ({ page }) => {
  await auth(page);
  const a = statusIdOfType('applied');
  const b = statusIdOfType('progress');
  await page.goto(`/jobs?verdict=all&status=${a},${b}`);
  const first = await page.locator('.jobcard').count();
  await page.goto(`/jobs?verdict=all&status=${b},${a}`);
  expect(await page.locator('.jobcard').count()).toBe(first);
});

test('a shortcut fills the filter with real ids and stops highlighting off-preset (FL3, FL4)', async ({ page }) => {
  await auth(page);
  await page.goto('/jobs');
  const shortcut = page.locator('.sb-subnav a[href^="/jobs?status="]').first();
  const href = await shortcut.getAttribute('href');
  // Real status ids, never a bucket name.
  expect(href).toMatch(/^\/jobs\?status=\d+(,\d+)*$/);

  await page.goto(href!);
  await expect(page.locator('.sb-subitem.active')).toHaveCount(1);

  // Take one status out of the preset and the sidebar stops claiming you are in that view.
  await page.goto(`${href},${statusIdOfType('applied')}`);
  await expect(page.locator('.sb-subitem.active')).toHaveCount(0);
});

// ── NV, LC, DP: the surfaces ───────────────────────────────────────────────────────────────

test('the nav never scrolls and always fits, at every height (NV1, NV2, NV11)', async ({ page }) => {
  await auth(page);
  for (const height of [900, 860, 800, 760, 700, 660]) {
    await page.setViewportSize({ width: 1440, height });
    await page.goto('/jobs');
    await page.waitForTimeout(250);
    const fit = await page.evaluate(() => {
      const nav = document.querySelector('.sb-nav-scroll') as HTMLElement;
      return { overflow: nav.scrollHeight - nav.clientHeight, css: getComputedStyle(nav).overflow };
    });
    expect(fit.css).toBe('hidden');
    expect(fit.overflow, `nav overflows at ${height}px`).toBeLessThanOrEqual(1);
  }
});

test('Admin left the column for the profile menu, as a heading (NV6, NV7)', async ({ page }) => {
  await auth(page);
  await page.goto('/jobs');
  await expect(page.locator('#sb-admin-btn')).toHaveCount(0);

  await page.locator('.sb-av-btn, .sb-acct').first().click();
  const menu = page.locator('#sb-profile-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.sb-pop-mail')).toHaveText(/@/);
  await expect(menu.locator('.sb-pop-lbl.adm')).toHaveText(/Admin/);
  await expect(menu.locator('a.sb-pop-row.adm')).toHaveCount(4);
  await expect(menu).not.toContainText('Top up');
});

test('the schedule clock carries a lamp, never animates, and opens Start (NV9)', async ({ page }) => {
  await auth(page);
  await page.goto('/jobs');
  const clock = page.locator('#sb-sched-btn');
  await expect(clock).toHaveAttribute('href', '/?schedule=1');
  const lamp = await page.locator('.sb-sched .lamp').evaluate((el) => {
    const s = getComputedStyle(el);
    return { bg: s.backgroundColor, animation: s.animationName };
  });
  expect(lamp.animation).toBe('none');
  // Red when idle, green when running — never anything else.
  expect(['rgb(239, 109, 112)', 'rgb(40, 177, 105)']).toContain(lamp.bg);
});

test('a New job shows the three exits; a tracked one shows the rail (LC1, DP1, DP2, DP5)', async ({ page }) => {
  await auth(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const newJob = pickJob('new');
  await page.goto(`/jobs?verdict=all&selected=${newJob}`);
  await expect(page.locator('.pane-exits .exit-btn')).toHaveCount(2);
  await expect(page.locator('.hist')).toHaveCount(0);
  // D18 revised: not "all three at equal weight" but **exactly one primary**. The fill is what makes
  // the strip read as the action the card exists for; making only one of the three filled is what
  // keeps that fill reading as emphasis rather than as a state the job is already in.
  await expect(page.locator('.pane-exits .exit-btn.is-primary')).toHaveCount(1);
  const fills = await page.locator('.pane-exits .exit-btn').evaluateAll(
    (els) => els.map((e) => getComputedStyle(e).backgroundColor),
  );
  // The primary carries --accent; the secondary carries nothing, so it takes the card's own colour
  // and can never sit lighter than the surface holding it.
  expect(fills).toContain('rgb(67, 115, 255)');
  expect(fills).toContain('rgba(0, 0, 0, 0)');

  const trackedJob = pickJob('applied');
  await page.goto(`/jobs?verdict=all&selected=${trackedJob}`);
  await expect(page.locator('.hist')).toHaveCount(1);
  await expect(page.locator('.hist-l')).toHaveText('Status history');
  // The first step is always `New`, and it opens no editor.
  const first = page.locator('.hist .rstep').first();
  await expect(first).toHaveClass(/is-fixed/);
  await expect(first).toContainText('New');
  // No rule above the rail (D36).
  await expect(page.locator('.hist')).toHaveCSS('border-top-width', '0px');
});

test('the step editor does all three jobs, and never offers New (DP7, DP5)', async ({ page }) => {
  await auth(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const job = pickJob('applied');
  addStep(job, 'progress', '2026-09-02');

  await page.goto(`/jobs?verdict=all&selected=${job}`);
  await page.locator('.hist .rstep:not(.is-fixed)').first().click();

  const editor = page.locator('.stepedit');
  await expect(editor).toBeVisible();
  await expect(editor.locator('.et')).toHaveText('Edit step');
  await expect(editor.locator('select')).toHaveCount(1);
  await expect(editor.locator('.eb.del')).toHaveText('Delete step');
  await expect(editor.locator('.eb.pri')).toHaveText('Save');
  await expect(editor.locator('option', { hasText: /^New$/ })).toHaveCount(0);

  // The date field is a trigger: it swaps this surface to the calendar, with a way back.
  await editor.locator('[data-step-cal]').click();
  await expect(editor.locator('.cal-back')).toBeVisible();
  await expect(editor.locator('.date-cal')).toHaveCount(1);
});

test('the rail is one row at three, four and nine steps on a phone (MB1, MB3)', async ({ page }) => {
  await auth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const job = pickJob('applied');

  const measure = async () => {
    await page.goto(`/job/${job}`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const rail = document.querySelector('.rail') as HTMLElement;
      const vis = [...rail.querySelectorAll('.rstep')].filter((s) => getComputedStyle(s).display !== 'none');
      return {
        height: Math.round(rail.getBoundingClientRect().height),
        visible: vis.length,
        datesHidden: vis.every((s) => {
          const d = s.querySelector('.d');
          return !d || getComputedStyle(d as Element).display === 'none';
        }),
      };
    });
  };

  addStep(job, 'applied', '2026-08-01');
  addStep(job, 'progress', '2026-08-05');
  const three = await measure();
  addStep(job, 'progress', '2026-08-10');
  const four = await measure();
  for (const d of ['08-15', '08-20', '08-25', '09-01', '09-05']) addStep(job, 'progress', `2026-${d}`);
  const nine = await measure();

  expect(three.height).toBe(four.height);
  expect(four.height).toBe(nine.height);
  // The chips give up their dates; the heading carries the one that matters.
  expect(nine.datesHidden).toBeTruthy();
  await expect(page.locator('.hist-age-mobile')).toContainText('since');
});
