import * as path from 'path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { config } from './config';
import { getDb } from './db';
import type { ProfileRow, SessionRow } from './db';
import { authRouter, SESSION_COOKIE, SESSION_DAYS } from './routes/auth';
import { dashboardRouter } from './routes/dashboard';
import { settingsRouter } from './routes/settings';
import { apiRouter } from './routes/api';
import { reportsRouter } from './routes/reports';
import { jobsRouter } from './routes/jobs';
import { analyticsRouter } from './routes/analytics';
import { rundiffRouter } from './routes/rundiff';
import { publicAnonymousRouter, publicAuthedRouter } from './routes/public';
import { startSchedule, stopSchedule, getScheduleStatus } from './pipeline/scheduler';
import { startAtsDiscoveryCron, startAtsValidationCron, startGhPoolCron, startAshbyPoolCron, startPoolCleanupCron, startTelegramIngestCron } from './pipeline/atsScheduler';
import { uiHelpers } from './uiHelpers';

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

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
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token) as SessionRow | undefined;

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
  res.status(404).render('layout', {
    body: '<div class="py-20 text-center text-gray-400">Page not found.</div>',
    title: '404',
  });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[express] Unhandled error:', err);
  res.status(500).render('layout', {
    body: `<div class="py-20 text-center"><p class="text-red-600 font-medium">${err.message}</p></div>`,
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
      SELECT ats_discovery_enabled, ats_discovery_cron, ats_validation_enabled, ats_validation_cron,
             ats_pool_gh_enabled, ats_pool_ashby_enabled, telegram_ingest_enabled, timezone
      FROM settings WHERE profile_id = ?
    `).get(adminProfile.id) as {
      ats_discovery_enabled: number;
      ats_discovery_cron: string;
      ats_validation_enabled: number;
      ats_validation_cron: string;
      ats_pool_gh_enabled: number;
      ats_pool_ashby_enabled: number;
      telegram_ingest_enabled: number;
      timezone: string;
    } | undefined;
    const atsTz = atsSettings?.timezone || 'UTC';
    if (atsSettings?.ats_discovery_enabled) {
      startAtsDiscoveryCron(atsSettings.ats_discovery_cron || '0 8 1 * *', atsTz);
    }
    if (atsSettings?.ats_validation_enabled) {
      startAtsValidationCron(atsSettings.ats_validation_cron || '0 8 * * 0', atsTz);
    }
    if (atsSettings?.ats_pool_gh_enabled) {
      startGhPoolCron('0 5 * * *', atsTz);
    }
    if (atsSettings?.ats_pool_ashby_enabled) {
      startAshbyPoolCron('0 5 * * *', atsTz);
    }
    if (atsSettings?.telegram_ingest_enabled) {
      startTelegramIngestCron('0 5 * * *', atsTz);
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
    const providers: string[] = row.scraping_providers ? JSON.parse(row.scraping_providers) : ['harvestapi'];
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
