import * as path from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config';
import { DEFAULT_PROVIDER_SELECTION_JSON, getDb, getMatchesCount } from './db';
import type { ProfileRow, SessionRow } from './db';
import { authRouter, SESSION_COOKIE, SESSION_DAYS, hashToken } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { settingsRouter } from './routes/settings';
import { adminRouter } from './routes/admin';
import { apiRouter } from './routes/api';
import { reportsRouter } from './routes/reports';
import { jobsRouter } from './routes/jobs';
import { analyticsRouter } from './routes/analytics';
import { rundiffRouter } from './routes/rundiff';
import { publicAnonymousRouter, publicAuthedRouter } from './routes/public';
import { startSchedule, stopSchedule, getScheduleStatus } from './pipeline/scheduler';
import { startAtsDiscoveryCron, startLeverDiscoveryCron, startAtsValidationCron, startGhPoolCron, startAshbyPoolCron, startLeverPoolCron, startPoolCleanupCron, startTelegramIngestCron, ATS_DISCOVERY_CRON, ATS_LEVER_CRON, ATS_VALIDATION_CRON } from './pipeline/atsScheduler';
import compression from 'compression';
import { uiHelpers } from './uiHelpers';

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(compression({
  filter: (req, res) => {
    const type = String(res.getHeader('Content-Type') || '');
    if (type.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  },
}));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Static files served before auth gate
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (unprotected) ──
app.use('/', authRouter);
app.use('/', publicAnonymousRouter);

// ── Session auth gate ──
app.use((req: Request, res: Response, next: NextFunction) => {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)jh_session=([^;]+)/);
  if (!match) { res.redirect('/welcome'); return; }

  const db = getDb();
  const token = match[1];
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(hashToken(token)) as SessionRow | undefined;

  if (!session || new Date(session.expires_at) < new Date()) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly`);
    res.redirect('/welcome');
    return;
  }

  const profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(session.profile_id) as ProfileRow | undefined;
  if (!profile) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly`);
    res.redirect('/welcome');
    return;
  }

  // Extend session (rolling 30 days) — only when last_active is stale, to cut write pressure
  const lastActiveMs = session.last_active ? new Date(session.last_active).getTime() : 0;
  if (Date.now() - lastActiveMs > 3_600_000) {
    const newExpiry = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
    const now = new Date().toISOString();
    db.prepare('UPDATE sessions SET expires_at = ?, last_active = ? WHERE id = ?').run(newExpiry, now, session.id);
  }

  req.profile = {
    id: profile.id,
    email: profile.email,
    displayName: profile.email.split('@')[0],
    isAdmin: profile.is_admin === 1,
  };
  res.locals.activeProfile = req.profile;
  next();
});

// ── Onboarding state ──
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.profile) { next(); return; }
  const pid = req.profile.id;
  const db  = getDb();
  const s = db.prepare(
    'SELECT profile_description, schedule_group_ids, use_jh_credits, credits_balance FROM settings WHERE profile_id = ?'
  ).get(pid) as { profile_description: string; schedule_group_ids: string; use_jh_credits: number; credits_balance: number } | undefined;
  const hasRole = !!db.prepare(
    'SELECT 1 FROM search_groups WHERE profile_id = ? LIMIT 1'
  ).get(pid);
  const hasRun = !!db.prepare(
    "SELECT 1 FROM search_runs WHERE profile_id = ? AND trigger = 'manual' AND status = 'success' LIMIT 1"
  ).get(pid);
  const done = [
    !!(s?.profile_description?.trim()),
    hasRole,
    (s?.credits_balance ?? 0) > 0 || (s?.use_jh_credits ?? 1) === 0,
    hasRun,
    !!(s?.schedule_group_ids?.trim()),
  ];
  let foundActive = false;
  const states = done.map((d): 'done' | 'active' | 'todo' => {
    if (d) return 'done';
    if (!foundActive) { foundActive = true; return 'active'; }
    return 'todo';
  });
  res.locals.onboarding = { states, completedCount: done.filter(Boolean).length };
  res.locals.useJhCredits = (s?.use_jh_credits ?? 1) === 1;
  res.locals.creditsBalance = s?.credits_balance ?? 0;
  res.locals.matchesCount = getMatchesCount(pid);
  next();
});

// ── EJS layout wrapper ──
app.use((req, res, next) => {
  if (req.profile) res.locals.scheduleStatus = getScheduleStatus(req.profile.id);
  const originalRender = res.render.bind(res);
  Object.assign(res.locals, uiHelpers);
  res.locals.uiHelpers = uiHelpers;
  res.render = function (view: string, locals?: object) {
    originalRender(view, locals, (err: Error, html: string) => {
      if (err) return next(err);
      originalRender('layout', { ...locals, body: html }, (err2: Error, layoutHtml: string) => {
        if (err2) return next(err2);
        res.send(layoutHtml);
      });
    });
  };
  next();
});

// ── Application routes ──
app.use('/', publicAuthedRouter);
app.use('/', dashboardRouter);
app.use('/settings', settingsRouter);
app.use('/admin', adminRouter);
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  res.setHeader('Cache-Control', 'no-store');
  next();
}, apiRouter);
app.use('/reports', reportsRouter);
app.use('/jobs', jobsRouter);
app.use('/analytics', analyticsRouter);
app.use('/run-diff', rundiffRouter);

// 404
app.use((_req, res) => {
  res.status(404).render('404', { title: '404' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[express] Unhandled error:', err);
  res.status(500).render('layout', {
    body: `<div class="min-h-[60vh] flex items-center justify-center"><div class="text-center max-w-sm mx-auto">`
      + `<p class="text-sm font-semibold mb-2" style="color:var(--faint)">500</p>`
      + `<h1 class="text-2xl font-bold mb-2" style="color:var(--ink)">Something went wrong</h1>`
      + `<p class="text-sm mb-5" style="color:var(--muted)">${err.message}</p>`
      + `<button type="button" onclick="history.back()" class="inline-flex items-center justify-center rounded-lg jh-btn-secondary px-4 py-2 text-sm font-semibold">Go back</button>`
      + `</div></div>`,
    title: 'Error',
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[process] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] Uncaught exception:', err);
});

async function start(): Promise<void> {
  const db = getDb();

  // Mark any runs that were still 'running' when the server last stopped as failed.
  // This prevents them from showing as stuck "Running" in the UI indefinitely.
  const staleCount = db.prepare(
    `UPDATE search_runs SET status = 'failed', error_log = 'Server stopped during run'
     WHERE status = 'running'`
  ).run().changes;
  if (staleCount > 0) {
    console.log(`[startup] Marked ${staleCount} stale 'running' run(s) as failed`);
  }

  // Boot ATS crons from admin settings
  const adminProfile = db.prepare(`SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1`).get() as { id: number } | undefined;
  if (adminProfile) {
    const atsSettings = db.prepare(`
      SELECT ats_discovery_enabled, ats_lever_disc_enabled, ats_validation_enabled,
             ats_pool_gh_enabled, ats_pool_ashby_enabled, ats_pool_lever_enabled, telegram_ingest_enabled, timezone
      FROM settings WHERE profile_id = ?
    `).get(adminProfile.id) as {
      ats_discovery_enabled: number;
      ats_lever_disc_enabled: number;
      ats_validation_enabled: number;
      ats_pool_gh_enabled: number;
      ats_pool_ashby_enabled: number;
      ats_pool_lever_enabled: number;
      telegram_ingest_enabled: number;
      timezone: string;
    } | undefined;
    const atsTz = atsSettings?.timezone || 'UTC';
    if (atsSettings?.ats_discovery_enabled) {
      startAtsDiscoveryCron(ATS_DISCOVERY_CRON, atsTz);
    }
    if (atsSettings?.ats_lever_disc_enabled) {
      startLeverDiscoveryCron(ATS_LEVER_CRON, atsTz);
    }
    if (atsSettings?.ats_validation_enabled) {
      startAtsValidationCron(ATS_VALIDATION_CRON, atsTz);
    }
    if (atsSettings?.ats_pool_gh_enabled) {
      startGhPoolCron('0 5 * * *', atsTz);
    }
    if (atsSettings?.ats_pool_ashby_enabled) {
      startAshbyPoolCron('15 5 * * *', atsTz);
    }
    if (atsSettings?.ats_pool_lever_enabled) {
      startLeverPoolCron('45 5 * * *', atsTz);
    }
    if (atsSettings?.telegram_ingest_enabled) {
      startTelegramIngestCron('30 5 * * *', atsTz);
    }
  }
  startPoolCleanupCron();

  // Restore user schedules that were active before the last restart
  const activeSchedules = db.prepare(`
    SELECT s.profile_id, s.cron_schedule, s.timezone, s.schedule_date_range, s.schedule_group_ids, s.scraping_providers
    FROM settings s
    WHERE s.schedule_active = 1
  `).all() as Array<{
    profile_id: number;
    cron_schedule: string;
    timezone: string;
    schedule_date_range: string;
    schedule_group_ids: string;
    scraping_providers: string;
  }>;
  for (const row of activeSchedules) {
    const groupIds: number[] = row.schedule_group_ids ? JSON.parse(row.schedule_group_ids) : [];
    const providers: string[] = row.scraping_providers ? JSON.parse(row.scraping_providers) : JSON.parse(DEFAULT_PROVIDER_SELECTION_JSON);
    startSchedule(row.profile_id, row.cron_schedule, row.timezone || 'UTC', (row.schedule_date_range as '24h' | '7d' | 'month') || '24h', groupIds, providers);
  }
  if (activeSchedules.length > 0) {
    console.log(`[startup] Restored ${activeSchedules.length} user schedule(s)`);
  }

  console.log(`[server] Dashboard running at http://localhost:${config.port}`);
  app.listen(config.port);
}

start().catch((err) => {
  console.error('[startup] Fatal error:', err);
  process.exit(1);
});

export { startSchedule, stopSchedule, getScheduleStatus };
