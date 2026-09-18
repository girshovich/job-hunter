/**
 * E2E: donations and the maker credit (donations.md §7.1).
 *
 * Four placements share one Donate panel: the credit at the end of the job page (desktop only),
 * the Offer ask under the status rail, the credit below Log out in both profile menus, and — out of
 * a browser's reach — the digest footer (unit/digestFooter.test.ts). What is worth a test is what
 * the review found fragile: the credit line wrapping in a narrow pane, the mobile sheet's footer
 * escaping Tailwind's `space-y` margin, the panel on 320px phones, Escape closing only the panel
 * over the Run Logs drawer, and the keyboard staying inside it.
 *
 * Runs against the real DB. It mints its own session and deletes it **by exact token**, restores
 * every row it writes **by exact id** in afterAll, and puts `use_jh_credits` back in `finally` —
 * never a broad `profile_id` sweep (§7.0).
 *
 * Prerequisite: the app running on http://localhost:3000 against data/jobs.db.
 */

import { test, expect, type Page } from '@playwright/test';
import * as crypto from 'crypto';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const PROFILE_ID = 1;
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA foreign_keys = ON');
const token = crypto.randomBytes(24).toString('hex');
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

// Everything this run creates or changes, so afterAll can put it back precisely.
const createdEvents: number[] = [];
const createdJobs: number[] = [];
const originalState = new Map<number, { status_id: number | null; applied: number }>();

function statusIdOfType(type: string): number {
  const row = db.prepare(
    'SELECT id FROM statuses WHERE profile_id = ? AND type = ? AND archived_at IS NULL ORDER BY sort_order LIMIT 1',
  ).get(PROFILE_ID, type) as { id: number } | undefined;
  if (!row) throw new Error(`No status of type ${type}`);
  return row.id;
}

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

function today(): string {
  const tz = (db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(PROFILE_ID) as { timezone?: string })?.timezone || 'UTC';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

/**
 * A Strong, non-duplicate scraped job of this profile, not at Offer, not yet touched here, and with
 * no step dated today or later — so a step the test adds today is the newest and becomes current.
 */
function pickStrongJob(): number | null {
  const rows = db.prepare(`
    SELECT jps.job_id AS id FROM job_profile_states jps JOIN statuses s ON s.id = jps.status_id
    JOIN jobs j ON j.id = jps.job_id
    WHERE jps.profile_id = ? AND s.type != 'offer' AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
      AND j.job_source != 'Manual'
      AND COALESCE((SELECT MAX(e.changed_at) FROM job_status_events e
                     WHERE e.profile_id = jps.profile_id AND e.job_id = jps.job_id), '') < ?
    ORDER BY jps.job_id DESC LIMIT 50
  `).all(PROFILE_ID, today()) as Array<{ id: number }>;
  const row = rows.find((r) => !originalState.has(r.id) && !usedJobs.has(r.id));
  if (row) usedJobs.add(row.id);
  return row ? row.id : null;
}
const usedJobs = new Set<number>();

function roleId(): number {
  return (db.prepare('SELECT id FROM search_groups WHERE profile_id = ? ORDER BY id LIMIT 1')
    .get(PROFILE_ID) as { id: number }).id;
}

test.beforeAll(() => {
  db.prepare(`INSERT INTO sessions (token, profile_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))`)
    .run(tokenHash, PROFILE_ID);
});

test.afterAll(() => {
  try {
    for (const id of createdEvents) db.prepare('DELETE FROM job_status_events WHERE id = ?').run(id);
    for (const [jobId, s] of originalState) {
      db.prepare('UPDATE job_profile_states SET status_id = ?, applied = ? WHERE job_id = ? AND profile_id = ?')
        .run(s.status_id, s.applied, jobId, PROFILE_ID);
    }
    for (const id of createdJobs) {
      db.prepare('UPDATE job_profile_states SET duplicate_of_job_id = NULL WHERE duplicate_of_job_id = ?').run(id);
      db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
    }
  } finally {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(tokenHash);
  }
});

test.beforeEach(async ({ page }) => {
  await page.context().addCookies([{ name: 'jh_session', value: token, domain: 'localhost', path: '/' }]);
});

function jobOrSkip(): number {
  const id = pickStrongJob();
  test.skip(id === null, 'No untouched Strong job for this profile');
  return id as number;
}

async function openPane(page: Page, jobId: number) {
  await page.goto(`/jobs?selected=${jobId}`);
  await expect(page.locator('#jh-pane .jd-foot-row')).toHaveCount(1);
}

// ── P1: end of the job page ─────────────────────────────────────────────────────────────────

test('P1 desktop: credit with both marks and Donate at the end of the pane', async ({ page }) => {
  const jobId = jobOrSkip();
  await page.setViewportSize(DESKTOP);
  await openPane(page, jobId);
  const credit = page.locator('#jh-pane .jd-credit');
  await expect(credit).toBeVisible();
  await expect(credit).toContainText('Made by Mikhail Girshovich');
  await expect(credit.locator('a.mk').nth(0)).toHaveAttribute('href', 'https://www.linkedin.com/in/girshovich/');
  await expect(credit.locator('a.mk').nth(1)).toHaveAttribute('href', 'mailto:mikhail@girshovich.me');
  await expect(credit.locator('.don-btn')).toBeVisible();
});

test('P1 mobile: the credit is hidden on the phone job page', async ({ page }) => {
  const jobId = jobOrSkip();
  await page.setViewportSize(PHONE);
  await page.goto(`/job/${jobId}`);
  await expect(page.locator('.jd-credit')).toHaveCount(1);
  await expect(page.locator('.jd-credit')).toBeHidden();
});

test('P1 Delete shares the credit line, wraps in a narrow pane, and still opens its panel', async ({ page }) => {
  const res = await page.request.post('http://localhost:3000/api/jobs/manual', {
    headers: { 'Content-Type': 'application/json' },
    data: JSON.stringify({
      origin: 'incoming', title: 'ZZDonate ' + crypto.randomBytes(3).toString('hex'), company: 'Revolut',
      country: 'United Kingdom', role_id: roleId(), date: today(),
    }),
  });
  const data = await res.json();
  expect(data.job_id).toBeTruthy();
  createdJobs.push(data.job_id);

  await page.setViewportSize(DESKTOP);
  await openPane(page, data.job_id);
  const row = page.locator('#jh-pane .jd-foot-row');
  const del = row.locator('#jd-delete-link');
  const credit = row.locator('.jd-credit');
  let r = (await row.boundingBox())!, d = (await del.boundingBox())!, c = (await credit.boundingBox())!;
  expect(Math.abs((d.y + d.height / 2) - (c.y + c.height / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs((d.x + d.width) - (r.x + r.width))).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 1024, height: 768 });
  r = (await row.boundingBox())!; d = (await del.boundingBox())!; c = (await credit.boundingBox())!;
  expect(d.y).toBeGreaterThan(c.y + c.height - 2);
  expect(Math.abs((d.x + d.width) - (r.x + r.width))).toBeLessThanOrEqual(2);
  expect(c.x + c.width).toBeLessThanOrEqual(r.x + r.width + 1);

  await del.click();
  await expect(page.locator('#jd-delete-panel')).toBeVisible();
});

test('P1 drawer: the Run Logs fragment carries no credit', async ({ page }) => {
  const jobId = jobOrSkip();
  const res = await page.request.get(`http://localhost:3000/reports/job/${jobId}/detail`);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).toContain('jd-');          // it is the detail body…
  expect(html).not.toContain('jd-credit'); // …without the credit
});

// ── The Donate panel ────────────────────────────────────────────────────────────────────────

test('panel: order, links, closing, and the credits line follows the mode', async ({ page }) => {
  const jobId = jobOrSkip();
  const before = (db.prepare('SELECT use_jh_credits FROM settings WHERE profile_id = ?').get(PROFILE_ID) as { use_jh_credits: number }).use_jh_credits;
  try {
    db.prepare('UPDATE settings SET use_jh_credits = 1 WHERE profile_id = ?').run(PROFILE_ID);
    await page.setViewportSize(DESKTOP);
    await openPane(page, jobId);
    const panel = page.locator('#jh-donate');
    await expect(panel).toBeHidden();
    await page.locator('#jh-pane .jd-credit .don-btn').click();
    await expect(panel).toBeVisible();

    const ctas = panel.locator('.dn-cta');
    await expect(ctas).toHaveText([/Connect on LinkedIn/, /Write me/, /Donate from €1 with Tribute/]);
    await expect(ctas.nth(2)).toHaveAttribute('href', 'https://t.me/tribute/app?startapp=dQCn');
    await expect(panel.locator('.alt a').nth(0)).toHaveAttribute('href', 'https://web.tribute.tg/d/QCn');
    await expect(panel.locator('.alt a').nth(1)).toHaveAttribute('href', 'https://hipolink.net/girshovich/tips');
    const external = panel.locator('a[href^="http"]');
    for (let i = 0; i < await external.count(); i++) await expect(external.nth(i)).toHaveAttribute('target', '_blank');
    await expect(panel.locator('.fine')).toHaveText('Separate from credits — your balance won’t change.');

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await page.locator('#jh-pane .jd-credit .don-btn').click();
    await expect(panel).toBeVisible();
    await page.locator('.jh-donate-scrim').click({ position: { x: 10, y: 10 } });
    await expect(panel).toBeHidden();

    db.prepare('UPDATE settings SET use_jh_credits = 0 WHERE profile_id = ?').run(PROFILE_ID);
    await page.reload();
    await expect(panel.locator('.fine')).toHaveCount(0);
  } finally {
    db.prepare('UPDATE settings SET use_jh_credits = ? WHERE profile_id = ?').run(before, PROFILE_ID);
  }
});

// ── P2: the Offer ask ───────────────────────────────────────────────────────────────────────

test('P2 always shows on Offer: pane, reselect, standalone page; no dismiss', async ({ page }) => {
  const jobId = jobOrSkip();
  addStep(jobId, 'offer', today());
  await page.setViewportSize(DESKTOP);
  await page.goto(`/jobs?selected=${jobId}`);
  const ask = page.locator('#jh-pane .offer-ask');
  await expect(ask).toBeVisible();
  await expect(ask).toContainText('Congratulations on the offer.');
  await expect(ask).toContainText('— Misha');
  await expect(ask.locator('button')).toHaveCount(1);

  await page.evaluate((id) => (window as any).JH.reloadPane(id), jobId);
  await expect(page.locator('#jh-pane .offer-ask')).toBeVisible();

  await page.goto(`/job/${jobId}`);
  await expect(page.locator('.offer-ask')).toBeVisible();
  await page.locator('.offer-ask-btn').click();
  await expect(page.locator('#jh-donate')).toBeVisible();
});

test('P2 is absent on applied, progress and rejected; the GDPR helper is untouched', async ({ page }) => {
  const jobId = jobOrSkip();
  const day = today();
  for (const type of ['applied', 'progress', 'rejected']) {
    addStep(jobId, type, day);
    const html = await (await page.request.get(`http://localhost:3000/job/${jobId}/detail`)).text();
    expect(html, type).not.toContain('offer-ask');
    if (type === 'rejected') expect(html).toContain('gdpr-help');
  }
});

test('P2 mobile: the button stacks above the text', async ({ page }) => {
  const jobId = jobOrSkip();
  addStep(jobId, 'offer', today());
  await page.setViewportSize(PHONE);
  await page.goto(`/job/${jobId}`);
  const b = (await page.locator('.offer-ask-btn').boundingBox())!;
  const t = (await page.locator('.offer-ask-txt').boundingBox())!;
  expect(b.y + b.height).toBeLessThanOrEqual(t.y + 1);
});

// ── P3: the profile menus ───────────────────────────────────────────────────────────────────

test('P3 desktop: credit follows Log out; its Donate closes the menu and opens the panel', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/');
  await page.evaluate(() => (window as any).jhToggleProfileMenu());
  const menu = page.locator('#sb-profile-menu');
  await expect(menu).toBeVisible();
  const follows = await page.evaluate(() => {
    const form = document.querySelector('#sb-profile-menu form[action="/logout"]')!;
    const credit = document.querySelector('#sb-profile-menu .sb-pop-credit')!;
    return !!(form.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(follows).toBe(true);
  await menu.locator('.sb-pop-credit .don-btn').click();
  await expect(menu).toBeHidden();
  await expect(page.locator('#jh-donate')).toBeVisible();
});

test('P3 mobile: Legal group gone, footer and credit sit on the panel itself', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await page.evaluate(() => (window as any).openProfileSheet());
  const sheet = page.locator('#profile-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Legal', { exact: true })).toHaveCount(0);

  const shape = await page.evaluate(() => {
    const panel = document.querySelector('#profile-sheet .bottom-16')!;
    const foot = panel.querySelector('.ps-foot')!;
    const credit = panel.querySelector('.ps-credit')!;
    const settingsRow = panel.querySelector('.space-y-0\\.5 > .flex.gap-2')!;
    const kids = Array.from(panel.children);
    const p = panel.getBoundingClientRect(), c = credit.getBoundingClientRect();
    return {
      footParent: foot.parentElement === panel,
      creditParent: credit.parentElement === panel,
      order: kids.indexOf(foot) < kids.indexOf(credit),
      creditLast: panel.lastElementChild === credit,
      gap: foot.getBoundingClientRect().top - settingsRow.getBoundingClientRect().bottom,
      left: Math.abs(c.left - p.left), right: Math.abs(c.right - p.right),
    };
  });
  expect(shape.footParent).toBe(true);
  expect(shape.creditParent).toBe(true);
  expect(shape.order).toBe(true);
  expect(shape.creditLast).toBe(true);
  expect(shape.gap).toBeGreaterThanOrEqual(18);
  expect(shape.left).toBeLessThanOrEqual(1);
  expect(shape.right).toBeLessThanOrEqual(1);

  const foot = sheet.locator('.ps-foot');
  await expect(foot.locator('button[type="submit"]')).toContainText('Log out');
  await expect(foot.locator('a[href="/terms"]')).toBeVisible();
  await expect(foot.locator('a[href="/privacy"]')).toBeVisible();
  const form = foot.locator('form');
  expect(await form.getAttribute('action')).toMatch(/\/logout$/);
  expect((await form.getAttribute('method'))!.toLowerCase()).toBe('post');

  await sheet.locator('.ps-credit .don-btn').click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('#jh-donate')).toBeVisible();
});

test('narrow phones: the credit strip and the panel never overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.evaluate(() => (window as any).openProfileSheet());
  const strip = page.locator('.ps-credit');
  await expect(strip).toBeVisible();
  const s = await strip.evaluate((el) => ({
    over: el.scrollWidth - el.clientWidth,
    nameBottom: el.querySelector('.t')!.getBoundingClientRect().bottom,
    btn: el.querySelector('.don-btn')!.getBoundingClientRect().toJSON(),
  }));
  expect(s.over).toBeLessThanOrEqual(0);
  expect(s.nameBottom).toBeLessThanOrEqual(s.btn.top + 1);
  expect(s.btn.left).toBeGreaterThanOrEqual(0);
  expect(s.btn.right).toBeLessThanOrEqual(320);

  await strip.locator('.don-btn').click();
  const box = page.locator('.jh-donate-box');
  await expect(box).toBeVisible();
  const overflow = await box.evaluate((b) => {
    const limit = b.getBoundingClientRect().right + 0.5;
    return Array.from(b.querySelectorAll('*'))
      .filter((el) => el.getBoundingClientRect().right > limit || el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible' && el.clientWidth > 0)
      .map((el) => el.className || el.tagName);
  });
  expect(overflow).toEqual([]);

  await page.setViewportSize(PHONE);
  const lines = await page.locator('#jh-donate .one').evaluateAll((els) =>
    els.map((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).fontSize)));
  expect(lines.length).toBeGreaterThanOrEqual(2);
  for (const ratio of lines) expect(ratio).toBeLessThanOrEqual(1.6);
});

test('Escape over the Run Logs drawer closes only the panel', async ({ page }) => {
  const jobId = jobOrSkip();
  await page.setViewportSize(DESKTOP);
  await page.goto('/reports');
  await page.evaluate((id) => (window as any).openDrawer(id), jobId);
  const drawer = page.locator('#rl-drawer');
  await expect(drawer).toBeVisible();
  await expect(page.locator('#rl-drawer-body .jd-foot-row, #rl-drawer-body [data-job-id]').first()).toBeAttached();
  await page.evaluate(() => (window as any).jhOpenDonate());
  const panel = page.locator('#jh-donate');
  await expect(panel).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(drawer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
});

test('keyboard: focus lands on ×, Tab cycles inside the box, Escape returns focus', async ({ page }) => {
  const jobId = jobOrSkip();
  await page.setViewportSize(DESKTOP);
  await openPane(page, jobId);
  const trigger = page.locator('#jh-pane .jd-credit .don-btn');
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#jh-donate')).toBeVisible();
  await expect(page.locator('.dn-x')).toBeFocused();

  const active = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return { inBox: !!el.closest('.jh-donate-box'), label: el.getAttribute('aria-label') || (el.textContent || '').trim() };
  });
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab');
    const a = await active();
    expect(a.inBox).toBe(true);
    seen.push(a.label);
  }
  expect(seen).toEqual(['Connect on LinkedIn', 'Write me', 'Donate from €1 with Tribute', 'Pay by card in browser', 'Try Hipolink', 'Close']);

  await page.keyboard.press('Shift+Tab');
  expect((await active()).label).toBe('Try Hipolink');

  await page.keyboard.press('Escape');
  await expect(page.locator('#jh-donate')).toBeHidden();
  await expect(trigger).toBeFocused();
});

// ── Alignment ───────────────────────────────────────────────────────────────────────────────

test('mobile sheet: two edges — Settings, Log out, credit left; Admin, Privacy, Donate right', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await page.evaluate(() => (window as any).openProfileSheet());
  const e = await page.evaluate(() => {
    const textBox = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect(); };
    const sheet = document.querySelector('#profile-sheet .bottom-16')!;
    const admin = sheet.querySelector('a[href="/admin"]');
    return {
      settings: sheet.querySelector('a[href="/settings"] svg')!.getBoundingClientRect().left,
      logout: sheet.querySelector('.ps-foot button svg')!.getBoundingClientRect().left,
      credit: textBox(sheet.querySelector('.ps-credit .t')!).left,
      admin: admin ? textBox(admin.querySelector('span')!).right : null,
      privacy: textBox(sheet.querySelector('.ps-legal a[href="/privacy"]')!).right,
      donate: sheet.querySelector('.ps-credit .don-btn')!.getBoundingClientRect().right,
    };
  });
  expect(Math.abs(e.settings - e.logout)).toBeLessThanOrEqual(1);
  expect(Math.abs(e.credit - e.logout)).toBeLessThanOrEqual(1);
  expect(Math.abs(e.privacy - e.donate)).toBeLessThanOrEqual(1.5);
  if (e.admin !== null) expect(Math.abs(e.admin - e.donate)).toBeLessThanOrEqual(1.5);
});

test('desktop pane scrolled to the end: the credit line sits on the legal bar row', async ({ page }) => {
  const jobId = jobOrSkip();
  await page.setViewportSize(DESKTOP);
  await openPane(page, jobId);
  const m = await page.evaluate(() => {
    const list = document.querySelector('.jh-jobs-body')!, pane = document.getElementById('jh-detail')!;
    list.scrollTop = list.scrollHeight; pane.scrollTop = pane.scrollHeight;
    const mid = (el: Element) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    return { bar: mid(document.querySelector('.jh-jobs-foot > div')!), credit: mid(document.querySelector('#jh-pane .jd-credit')!),
             scrolls: pane.scrollHeight > pane.clientHeight };
  });
  test.skip(!m.scrolls, 'Pane content shorter than the viewport');
  expect(Math.abs(m.bar - m.credit)).toBeLessThanOrEqual(2);
});

test('full-bleed pages render no second app footer under the columns', async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto('/jobs');
  await expect(page.locator('.jh-jobs-foot')).toBeVisible();
  await expect(page.locator('footer.app-footer')).toBeHidden();
  await page.goto('/');
  await expect(page.locator('footer.app-footer')).toBeVisible();
});

test('welcome page legal footer: credit, marks and Donate to Hipolink; fits on phones', async ({ browser }) => {
  // Signed out on purpose: /welcome is the public page.
  for (const vp of [DESKTOP, { width: 320, height: 640 }]) {
    const page = await browser.newPage({ viewport: vp });
    await page.goto('http://localhost:3000/welcome');
    const foot = page.locator('.wf-foot');
    await expect(foot).toBeVisible();
    await expect(foot.locator('.wf-name')).toHaveText('Mikhail Girshovich');
    await expect(foot.locator('.wf-marks a').nth(0)).toHaveAttribute('href', 'https://www.linkedin.com/in/girshovich/');
    await expect(foot.locator('.wf-marks a').nth(1)).toHaveAttribute('href', 'mailto:mikhail@girshovich.me');
    const don = foot.locator('.wf-don');
    await expect(don).toHaveAttribute('href', 'https://hipolink.net/girshovich/tips');
    await expect(don).toHaveAttribute('target', '_blank');
    await expect(foot.locator('a[href="/terms"]')).toBeVisible();
    expect(await foot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    await page.close();
  }
});

test('welcome scrolled to the end: legal card level with the sidebar account row', async ({ browser }) => {
  const page = await browser.newPage({ viewport: DESKTOP });
  await page.goto('http://localhost:3000/welcome');
  const d = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const mid = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return (b.top + b.bottom) / 2; };
    return Math.abs(mid('.wf-foot') - mid('.sb-profile'));
  });
  expect(d).toBeLessThanOrEqual(2);
  await page.close();
});
