/**
 * E2E: Run Once role toggles apply to that run only; the Schedule Active modal lists the
 * schedule's saved roles; arming a schedule needs at least one role.
 *
 * Nothing here spends money or arms a cron: POST /api/run and POST /api/schedule/start are
 * fulfilled by the test, and the status-modal tests mock GET /api/schedule/status. Role toggles
 * that reach the real DB (the schedule modal's PATCHes) are snapshotted and restored, together
 * with the admin's saved schedule columns. Only the session token minted here is deleted.
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db, admin profile 1
 * with at least two roles.
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const PID = 1;
const BASE = 'http://localhost:3000';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');

type Role = { id: number; group_name: string; is_active: number };
const roles = db.prepare('SELECT id, group_name, is_active FROM search_groups WHERE profile_id = ? ORDER BY id ASC')
  .all(PID) as Role[];
const savedSettings = db.prepare('SELECT schedule_group_ids, schedule_active FROM settings WHERE profile_id = ?')
  .get(PID) as { schedule_group_ids: string; schedule_active: number };

const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

const setActive = (id: number, on: number) =>
  db.prepare('UPDATE search_groups SET is_active = ? WHERE id = ? AND profile_id = ?').run(on, id, PID);
const isActive = (id: number) =>
  (db.prepare('SELECT is_active FROM search_groups WHERE id = ?').get(id) as { is_active: number }).is_active;

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(tokenHash, PID);
});

test.afterEach(() => {
  for (const r of roles) setActive(r.id, r.is_active);
});

test.afterAll(() => {
  for (const r of roles) setActive(r.id, r.is_active);
  db.prepare('UPDATE settings SET schedule_group_ids = ?, schedule_active = ? WHERE profile_id = ?')
    .run(savedSettings.schedule_group_ids, savedSettings.schedule_active, PID);
  db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  db.close();
});

async function login(page: Page) {
  await page.context().addCookies([{ name: 'jh_session', value: token, url: BASE }]);
}

/** Records every PATCH /api/groups/:id the page sends. */
function trackPatches(page: Page): Request[] {
  const patches: Request[] = [];
  page.on('request', (r) => { if (r.method() === 'PATCH' && /\/api\/groups\/\d+/.test(r.url())) patches.push(r); });
  return patches;
}

/** Clicks the visible switch of one role row inside a modal container. */
async function flip(page: Page, container: string, id: number) {
  await page.locator(`${container} input[value="${id}"]`).locator('..').click();
}

test.describe('Run Once', () => {
  test.skip(roles.length < 2, 'needs two roles on profile 1');

  test('toggles apply to the run only (A1, A2, A3, A5)', async ({ page }) => {
    const [a, b] = roles;
    setActive(a.id, 1);  // on in Settings, will be switched off for this run
    setActive(b.id, 0);  // off in Settings, will be switched on for this run
    for (const r of roles.slice(2)) setActive(r.id, 0);

    await login(page);
    const patches = trackPatches(page);
    let runBody: { groupIds?: number[] } | null = null;
    await page.route('**/api/run', async (route) => {
      runBody = route.request().postDataJSON();
      await route.fulfill({ json: { success: true } });
    });

    await page.goto(BASE + '/reports');
    await page.evaluate(() => (window as unknown as { openRunModal: () => void }).openRunModal());
    await expect(page.locator(`#run-modal-groups input[value="${a.id}"]`)).toBeAttached();
    await flip(page, '#run-modal-groups', a.id);
    await flip(page, '#run-modal-groups', b.id);
    await page.locator('#run-modal-submit').click();

    await page.waitForURL(BASE + '/');
    expect(runBody).toEqual(expect.objectContaining({ groupIds: [b.id] }));
    await page.waitForTimeout(300);
    expect(patches).toHaveLength(0);
    expect(isActive(a.id)).toBe(1);
    expect(isActive(b.id)).toBe(0);
    const after = db.prepare('SELECT schedule_group_ids FROM settings WHERE profile_id = ?').get(PID) as { schedule_group_ids: string };
    expect(after.schedule_group_ids).toBe(savedSettings.schedule_group_ids);

    await page.goto(BASE + '/settings');
    const rows = page.locator('.stg-role-row');
    await expect(rows.nth(0)).toContainText('Active');
    await expect(rows.nth(1)).toContainText('Paused');
  });

  test('reopened modal follows Settings, not the last run (A4)', async ({ page }) => {
    const [a] = roles;
    setActive(a.id, 1);
    await login(page);
    await page.route('**/api/run', (route) => route.fulfill({ json: { success: true } }));

    await page.goto(BASE + '/reports');
    const open = () => page.evaluate(() => (window as unknown as { openRunModal: () => void }).openRunModal());
    await open();
    await expect(page.locator(`#run-modal-groups input[value="${a.id}"]`)).toBeAttached();
    await flip(page, '#run-modal-groups', a.id);
    // make sure at least one role stays selected
    if (roles.every((r) => r.id === a.id || !isActive(r.id))) await flip(page, '#run-modal-groups', roles[1].id);
    await page.locator('#run-modal-submit').click();
    await page.waitForURL(BASE + '/');

    await open();
    await expect(page.locator(`#run-modal-groups input[value="${a.id}"]`)).toBeChecked();
  });

  test('a rejected run changes nothing (A6)', async ({ page }) => {
    const [a] = roles;
    setActive(a.id, 1);
    await login(page);
    const patches = trackPatches(page);
    await page.route('**/api/run', (route) =>
      route.fulfill({ status: 409, json: { success: false, error: 'Pipeline is already running.' } }));

    await page.goto(BASE + '/reports');
    await page.evaluate(() => (window as unknown as { openRunModal: () => void }).openRunModal());
    await expect(page.locator(`#run-modal-groups input[value="${a.id}"]`)).toBeAttached();
    await flip(page, '#run-modal-groups', a.id);
    if (roles.every((r) => r.id === a.id || !isActive(r.id))) await flip(page, '#run-modal-groups', roles[1].id);
    await page.locator('#run-modal-submit').click();
    await expect(page.getByText('Pipeline is already running.')).toBeVisible();
    expect(patches).toHaveLength(0);
    expect(isActive(a.id)).toBe(1);
  });
});

test.describe('Schedule Active modal', () => {
  test.skip(roles.length < 2, 'needs two roles on profile 1');

  /** A status payload whose toggles deliberately disagree with the saved list (B4). */
  function status(savedIds: number[], groups: Role[]) {
    return {
      success: true, active: true, expression: '0 7 * * *', timezone: 'UTC',
      email_send_time: '07:00', schedule_date_range: '24h', schedule_group_ids: savedIds,
      scraping_providers: ['valig'], run_date_range: '24h', run_providers: ['valig'],
      groups: groups.map((g) => ({ ...g, is_active: savedIds.includes(g.id) ? 0 : 1 })),
    };
  }

  test('lists saved roles, fetched fresh on open (B1–B7)', async ({ page }) => {
    const [a, b] = roles;
    const unnamed = { ...b, group_name: '' };
    let payload = status([b.id, a.id], [a, unnamed]);
    let hold: Promise<void> | null = null;
    await page.route('**/api/schedule/status', async (route) => {
      if (hold) await hold;
      await route.fulfill({ json: payload });
    });

    await login(page);
    await page.goto(BASE + '/reports');
    await page.waitForFunction('_scheduleActive === true');   // `let` global, not on window

    const roleCell = page.locator('#sched-status-roles');
    let release!: () => void;
    hold = new Promise((r) => { release = r; });
    const statusReq = page.waitForRequest('**/api/schedule/status');
    await page.evaluate(() => (window as unknown as { openScheduleStatusModal: () => void }).openScheduleStatusModal());
    await statusReq;                                             // B1: fetched on open
    await expect(roleCell).toHaveText('Loading…');               // B1
    release();
    hold = null;
    // B2 order by id, B3 unnamed fallback, B4 independent of toggles
    await expect(roleCell).toHaveText(`${a.group_name || 'Role #' + a.id}, Role #${b.id}`);
    await expect(page.locator('#schedule-status-modal')).not.toContainText('All active');   // B7
    await expect(page.locator('#sched-status-freq')).toHaveText('Daily');                  // B8 sanity

    // B5: a deleted role drops out on the next open, no reload
    await page.evaluate(() => (window as unknown as { closeScheduleStatusModal: () => void }).closeScheduleStatusModal());
    payload = status([a.id, b.id], [a]);
    await page.evaluate(() => (window as unknown as { openScheduleStatusModal: () => void }).openScheduleStatusModal());
    await expect(roleCell).toHaveText(a.group_name || 'Role #' + a.id);

    // B6: every saved role deleted
    await page.evaluate(() => (window as unknown as { closeScheduleStatusModal: () => void }).closeScheduleStatusModal());
    payload = status([999999], [a]);
    await page.evaluate(() => (window as unknown as { openScheduleStatusModal: () => void }).openScheduleStatusModal());
    await expect(roleCell).toHaveText('No roles — re-arm the schedule');
    await expect(roleCell).toHaveCSS('color', 'rgb(180, 35, 24)');   // --red-ink #b42318
  });
});

test.describe('Schedule modal', () => {
  test.skip(roles.length < 2 || roles.length > 5, 'needs 2–5 roles on profile 1 (inline switches)');

  async function openSchedule(page: Page) {
    await page.goto(BASE + '/reports');
    await page.evaluate(() => (window as unknown as { openScheduleModal: () => void }).openScheduleModal());
    await expect(page.locator(`#sched-modal-groups input[value="${roles[0].id}"]`)).toBeAttached();
  }

  test('refuses to arm with no roles (C1)', async ({ page }) => {
    for (const r of roles) setActive(r.id, 1);
    await login(page);
    const patches = trackPatches(page);
    let startCalls = 0;
    await page.route('**/api/schedule/start', (route) => { startCalls++; return route.fulfill({ json: { success: false } }); });

    await openSchedule(page);
    for (const r of roles) await flip(page, '#sched-modal-groups', r.id);
    await page.locator('#sched-start-btn').click();

    await expect(page.locator('#sched-modal-msg')).toHaveText('Select at least one role.');
    await page.waitForTimeout(300);
    expect(patches).toHaveLength(0);
    expect(startCalls).toBe(0);
  });

  test('arms with the selected roles (C2)', async ({ page }) => {
    const [a, b] = roles;
    for (const r of roles) setActive(r.id, 0);
    setActive(a.id, 1);
    await login(page);
    const patches = trackPatches(page);
    let startCalls = 0;
    await page.route('**/api/schedule/start', (route) => {
      startCalls++;
      return route.fulfill({ json: { success: true, expression: '0 7 * * *', timezone: 'UTC', schedule_group_ids: [b.id], groups: [] } });
    });

    await openSchedule(page);
    await flip(page, '#sched-modal-groups', a.id);
    await flip(page, '#sched-modal-groups', b.id);
    await page.locator('#sched-start-btn').click();

    await expect(page.locator('#schedule-modal')).toBeHidden();
    expect(startCalls).toBe(1);
    const sent = Object.fromEntries(patches.map((p) => [Number(p.url().split('/').pop()), p.postDataJSON().is_active]));
    expect(sent[a.id]).toBe(false);
    expect(sent[b.id]).toBe(true);
    expect(isActive(b.id)).toBe(1);   // the schedule's role choice still reaches is_active
  });
});
