/**
 * Dashboard Routes — Home page, job history, and job detail.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobWithState, type SearchRunRow, type SettingsRow } from '../db';
import { getScheduleStatus } from '../pipeline/scheduler';
import { getPreferredCountries } from '../pipeline/locationNormalizer';
import { loadJobDetail } from './jobDetail';
import { renderJobList } from './jobs';
import { uiHelpers } from '../uiHelpers';

const router = Router();

// Home — today's curated jobs, last run stats, "Run Now" button
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  const lastRun = db.prepare(`
    SELECT
      MIN(ran_at)            AS ran_at,
      SUM(jobs_fetched)      AS jobs_fetched,
      SUM(jobs_scored)       AS jobs_scored,
      SUM(jobs_strong_match) AS jobs_strong_match,
      SUM(jobs_weak_match)   AS jobs_weak_match,
      SUM(jobs_no_match)     AS jobs_no_match,
      SUM(jobs_duplicate)    AS jobs_duplicate,
      SUM(duration_ms)       AS duration_ms,
      CASE
        WHEN COUNT(*) = SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) THEN 'success'
        WHEN COUNT(*) = SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) THEN 'failed'
        WHEN SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) > 0 THEN 'stopped'
        ELSE 'partial_error'
      END AS status,
      GROUP_CONCAT(error_log, '\n') AS error_log
    FROM search_runs
    WHERE profile_id = ?
      AND COALESCE(session_id, CAST(id AS TEXT)) = (
        SELECT COALESCE(session_id, CAST(id AS TEXT))
        FROM search_runs WHERE profile_id = ? AND status != 'running'
        ORDER BY ran_at DESC LIMIT 1
      )
      AND status != 'running'
  `).get(profileId, profileId) as SearchRunRow | undefined;

  // Jobs from the last pipeline run
  const lastRunAt = lastRun?.ran_at ?? null;

  // Live counts — recalculate from job_profile_states so manual verdict changes are reflected
  const liveLastRunStats = lastRunAt
    ? (db.prepare(`
        SELECT
          SUM(CASE WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
          SUM(CASE WHEN jps.ai_verdict = 'WEAK_MATCH'   AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as weak,
          SUM(CASE WHEN jps.is_duplicate = 1 THEN 1 ELSE 0 END) as duplicate
        FROM job_profile_states jps
        WHERE jps.profile_id = ? AND jps.fetched_at >= ?
      `).get(profileId, lastRunAt) as { strong: number; weak: number; duplicate: number } | undefined)
    : undefined;

  const lastRunJobs = lastRunAt
    ? (db.prepare(`
        SELECT j.*, jps.*, c.logo_url
        FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
        LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
        WHERE jps.profile_id = ? AND jps.fetched_at >= ? AND jps.is_duplicate = 0 AND jps.ai_verdict = 'STRONG_MATCH'
        ORDER BY jps.ai_score DESC
      `).all(profileId, lastRunAt) as JobWithState[])
    : [];
  if (lastRunJobs.length > 0) {
    const ids = lastRunJobs.map((j) => j.id);
    const ph = ids.map(() => '?').join(',');
    const locRows = db.prepare(`SELECT job_id, label FROM job_locations WHERE job_id IN (${ph}) ORDER BY rowid ASC`).all(...ids) as Array<{ job_id: number; label: string }>;
    const labelsMap = new Map<number, string[]>();
    for (const { job_id, label } of locRows) {
      if (!labelsMap.has(job_id)) labelsMap.set(job_id, []);
      labelsMap.get(job_id)!.push(label);
    }
    for (const job of lastRunJobs) {
      (job as JobWithState & { locationLabels: string[] }).locationLabels = labelsMap.get(job.id) ?? [];
    }
  }

  const newCount = db
    .prepare(`SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ? AND seen = 0 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`)
    .get(profileId) as { c: number };

  const seenCount = db
    .prepare(`SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ? AND seen = 1 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`)
    .get(profileId) as { c: number };

  const allTimeStats = db.prepare(`
    SELECT
      COALESCE(SUM(jobs_fetched), 0)      as total_fetched,
      COALESCE(SUM(jobs_scored), 0)       as total_scored,
      COALESCE(SUM(jobs_strong_match), 0) as total_strong,
      COALESCE(SUM(jobs_weak_match), 0)   as total_weak,
      COALESCE(SUM(jobs_no_match), 0)     as total_no_match,
      COALESCE(SUM(jobs_duplicate), 0)    as total_duplicate
    FROM search_runs WHERE profile_id = ? AND status != 'running'
  `).get(profileId) as {
    total_fetched: number; total_scored: number; total_strong: number;
    total_weak: number; total_no_match: number; total_duplicate: number;
  };

  const locationBreakdown = lastRunAt
    ? (db.prepare(`
        SELECT j.location, COUNT(*) as count
        FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
        WHERE jps.profile_id = ? AND jps.fetched_at >= ? AND jps.is_duplicate = 0
          AND jps.ai_verdict = 'STRONG_MATCH' AND j.location IS NOT NULL
        GROUP BY j.location ORDER BY count DESC LIMIT 10
      `).all(profileId, lastRunAt) as Array<{ location: string; count: number }>)
    : [];

  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow | undefined;
  const groupCount = (db.prepare('SELECT COUNT(*) as c FROM search_groups WHERE profile_id = ?').get(profileId) as { c: number }).c;
  const appliedCount = (db.prepare(`SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ? AND applied = 1 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`).get(profileId) as { c: number }).c;

  // Onboarding checklist steps
  const checklist = {
    hasGroups:   groupCount > 0,
    hasRun:      !!lastRun,
    hasEmail:    !!(settings?.resend_api_key && settings?.email_recipient),
    hasSchedule: !!(settings?.cron_schedule),
  };
  const checklistDone = Object.values(checklist).every(Boolean);
  const canRun = (settings?.use_jh_credits === 0) || ((settings?.credits_balance ?? 0) > 0);

  const scheduleStatus = getScheduleStatus(profileId);
  res.render('home', {
    canRun,
    lastRun,
    liveStrong: liveLastRunStats?.strong ?? lastRun?.jobs_strong_match ?? 0,
    liveWeak:   liveLastRunStats?.weak   ?? lastRun?.jobs_weak_match   ?? 0,
    lastRunJobs,
    newCount: newCount.c,
    seenCount: seenCount.c,
    allTimeStats,
    locationBreakdown,
    appliedCount,
    checklist,
    checklistDone,
    timezone: settings?.timezone || 'UTC',
    scheduleStatus,
    title: 'Start',
    locPref: getPreferredCountries(profileId),
  });
});

// Job History — paginated, filterable — queries jobs table (one row per unique linkedin_job_id)
// All Jobs — shares the Matches list+pane implementation (renderJobList), differing only by the
// default Verdict (all/Q11) and the within-day sort (newest-first/Q8). Score min–max (Q9) and the
// "Ungrouped" option (now "Other"/Q10) fall away by using the shared handler.
router.get('/history', (req: Request, res: Response) =>
  renderJobList(req, res, {
    defaultVerdict: 'all',
    withinDaySort: 'jps.fetched_at DESC',
    title: 'All Jobs',
    basePath: '/history',
    fromKey: 'history',
    showSubtitle: false,
  }),
);

// GET /job/:id/detail — HTML fragment (the shared job-detail body) for the Matches / All Jobs
// detail pane. Owned jobs only (loadJobDetail is scoped to the profile); rendered WITHOUT the app
// layout so the client can swap the pane instead of re-navigating the whole page.
router.get('/job/:id/detail', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).send(''); return; }

  const detail = loadJobDetail(req.profile.id, id);
  if (!detail) { res.status(404).send(''); return; }

  req.app.render('partials/job-detail-body', { ...uiHelpers, ...detail }, (err: Error, html: string) => {
    if (err) { res.status(500).send(''); return; }
    res.send(html);
  });
});

// Job Detail
router.get('/job/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  const detail = loadJobDetail(req.profile.id, id);
  if (!detail) {
    res.status(404).render('404', { title: 'Not Found' });
    return;
  }
  res.render('job-detail', { ...detail, title: detail.job.title });
});

export { router as dashboardRouter };
