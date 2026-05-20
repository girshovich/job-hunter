/**
 * Dashboard Routes — Home page, job history, and job detail.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobWithState, type SearchRunRow, type SearchGroupRow, type SettingsRow, type CvRow } from '../db';

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
        LEFT JOIN companies c ON c.company = j.company
        WHERE jps.profile_id = ? AND jps.fetched_at >= ? AND jps.is_duplicate = 0 AND jps.ai_verdict = 'STRONG_MATCH'
        ORDER BY jps.ai_score DESC
      `).all(profileId, lastRunAt) as JobWithState[])
    : [];

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
    title: 'Start',
  });
});

// Job History — paginated, filterable — queries jobs table (one row per unique linkedin_job_id)
router.get('/history', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10));
  const limit = 25;
  const offset = (page - 1) * limit;

  // Filters
  const verdict = String(req.query.verdict || '');
  const company = String(req.query.company || '');
  const country = String(req.query.country || '');
  const scoreMin = req.query.score_min !== undefined && req.query.score_min !== ''
    ? parseInt(String(req.query.score_min), 10) : null;
  const scoreMax = req.query.score_max !== undefined && req.query.score_max !== ''
    ? parseInt(String(req.query.score_max), 10) : null;
  const dateFrom = String(req.query.date_from || '');
  const dateTo   = String(req.query.date_to   || '');
  // group: undefined = all, 'null' = ungrouped jobs, number = specific group
  const groupParam = req.query.group;
  const groupId: number | null | undefined =
    groupParam === undefined || groupParam === ''
      ? undefined
      : groupParam === 'null'
        ? null
        : parseInt(String(groupParam), 10);

  const conditions: string[] = ['jps.profile_id = ?'];
  const params: (string | number)[] = [profileId];

  // DUPLICATE filter maps to is_duplicate=1; other verdicts filter by ai_verdict
  if (verdict === 'DUPLICATE') {
    conditions.push('jps.is_duplicate = 1');
  } else if (verdict && ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH'].includes(verdict)) {
    conditions.push('jps.ai_verdict = ?');
    params.push(verdict);
  }
  if (company) {
    conditions.push('j.company LIKE ?');
    params.push(`%${company}%`);
  }
  if (country) {
    conditions.push('j.country = ?');
    params.push(country);
  }
  if (scoreMin !== null) { conditions.push('jps.ai_score >= ?'); params.push(scoreMin); }
  if (scoreMax !== null) { conditions.push('jps.ai_score <= ?'); params.push(scoreMax); }
  if (dateFrom) { conditions.push('jps.fetched_at >= ?'); params.push(dateFrom); }
  if (dateTo)   { conditions.push('jps.fetched_at <= ?'); params.push(dateTo + 'T23:59:59Z'); }
  if (groupId === null) {
    conditions.push('jps.group_id IS NULL');
  } else if (groupId !== undefined && !isNaN(groupId)) {
    conditions.push('jps.group_id = ?');
    params.push(groupId);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const fromClause = `FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id`;

  const total = (
    db.prepare(`SELECT COUNT(*) as c ${fromClause} ${where}`).get(...params) as { c: number }
  ).c;

  const jobs = db
    .prepare(`
      SELECT j.*, jps.*, c.logo_url ${fromClause}
      LEFT JOIN companies c ON c.company = j.company
      ${where}
      ORDER BY jps.fetched_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as JobWithState[];

  const totalPages = Math.ceil(total / limit);
  const groups = db.prepare('SELECT id, group_name FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as Pick<SearchGroupRow, 'id' | 'group_name'>[];
  const histSettings = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(profileId) as Pick<SettingsRow, 'timezone'> | undefined;

  // Distinct countries for dropdown — resolved by locationNormalizer
  const countryRows = db.prepare(`
    SELECT DISTINCT j.country FROM jobs j
    JOIN job_profile_states jps ON jps.job_id = j.id
    WHERE jps.profile_id = ? AND j.country IS NOT NULL AND j.country != ''
    ORDER BY j.country ASC
  `).all(profileId) as Array<{ country: string }>;
  const countries = countryRows.map(r => r.country);

  res.render('history', {
    jobs,
    page,
    totalPages,
    total,
    groups,
    countries,
    filters: { verdict, company, country, scoreMin, scoreMax, dateFrom, dateTo, groupId },
    timezone: histSettings?.timezone || 'UTC',
    title: 'All Jobs',
  });
});

// Job Detail
router.get('/job/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);

  const profileId = req.profile.id;
  const jobRow = db.prepare(`
    SELECT j.*, jps.*, c.logo_url, COALESCE(jd.description_text, j.description) AS description_text
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    LEFT JOIN companies c ON c.company = j.company
    WHERE j.id = ? AND jps.profile_id = ?
  `).get(id, profileId) as (JobWithState & { description_text?: string }) | undefined;
  const job = jobRow ? { ...jobRow, description: jobRow.description_text ?? jobRow.description } : undefined;
  if (!job) {
    res.status(404).render('404', { title: 'Not Found' });
    return;
  }

  // Duplicate chain
  let original: JobWithState | undefined;
  if (job.duplicate_of_job_id) {
    const originalRow = db.prepare(`
      SELECT j.*, jps.*, c.logo_url, COALESCE(jd.description_text, j.description) AS description_text
      FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      LEFT JOIN job_descriptions jd ON jd.job_id = j.id
      LEFT JOIN companies c ON c.company = j.company
      WHERE j.id = ? AND jps.profile_id = ?
    `).get(job.duplicate_of_job_id, profileId) as (JobWithState & { description_text?: string }) | undefined;
    original = originalRow ? { ...originalRow, description: originalRow.description_text ?? originalRow.description } : undefined;
  }

  const duplicateRows = db.prepare(`
    SELECT j.*, jps.*, c.logo_url, COALESCE(jd.description_text, j.description) AS description_text
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    LEFT JOIN companies c ON c.company = j.company
    WHERE jps.duplicate_of_job_id = ? AND jps.profile_id = ?
    ORDER BY jps.fetched_at DESC
  `).all(job.id, profileId) as Array<JobWithState & { description_text?: string }>;
  const duplicatesOfThis = duplicateRows.map((row) => ({
    ...row,
    description: row.description_text ?? row.description,
  }));

  const from = String(req.query.from || 'history');
  const backUrl   = from === 'jobs' ? '/jobs' : from === 'home' ? '/' : '/history';
  const backLabel = 'Back';

  // Prev/Next navigation — scoped to same profile, order matches the source page
  let prevId: number | null = null;
  let nextId: number | null = null;
  if (from === 'jobs') {
    // Sort order: fetched_at DESC, ai_score DESC, id DESC (matches jobs page)
    // prev = item that appears above current = "bigger" in sort terms
    const prevRow = db.prepare(`
      SELECT j.id FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      WHERE jps.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
        AND (jps.fetched_at > ?
          OR (jps.fetched_at = ? AND jps.ai_score > ?)
          OR (jps.fetched_at = ? AND jps.ai_score = ? AND j.id > ?))
      ORDER BY jps.fetched_at ASC, jps.ai_score ASC, j.id ASC LIMIT 1
    `).get(profileId,
        job.fetched_at,
        job.fetched_at, job.ai_score,
        job.fetched_at, job.ai_score, id) as { id: number } | undefined;
    prevId = prevRow?.id ?? null;

    // next = item that appears below current = "smaller" in sort terms
    const nextRow = db.prepare(`
      SELECT j.id FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      WHERE jps.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
        AND (jps.fetched_at < ?
          OR (jps.fetched_at = ? AND jps.ai_score < ?)
          OR (jps.fetched_at = ? AND jps.ai_score = ? AND j.id < ?))
      ORDER BY jps.fetched_at DESC, jps.ai_score DESC, j.id DESC LIMIT 1
    `).get(profileId,
        job.fetched_at,
        job.fetched_at, job.ai_score,
        job.fetched_at, job.ai_score, id) as { id: number } | undefined;
    nextId = nextRow?.id ?? null;
  } else if (from === 'home') {
    const day = job.fetched_at ? String(job.fetched_at).slice(0, 10) : null;
    if (day) {
      const sameDayIds = db.prepare(`
        SELECT j.id FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
        WHERE jps.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
          AND strftime('%Y-%m-%d', jps.fetched_at) = ?
        ORDER BY jps.ai_score DESC
      `).all(profileId, day) as Array<{ id: number }>;
      const idx = sameDayIds.findIndex((r) => r.id === id);
      if (idx > 0) prevId = sameDayIds[idx - 1].id;
      if (idx >= 0 && idx < sameDayIds.length - 1) nextId = sameDayIds[idx + 1].id;
    }
  }

  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow | undefined;
  const cvs = db.prepare('SELECT id, filename, mime_type, file_size, uploaded_at FROM cvs WHERE profile_id = ? ORDER BY uploaded_at DESC').all(profileId) as Omit<CvRow, 'content_b64'>[];
  const companyNoteRow = db.prepare('SELECT note FROM company_notes WHERE profile_id = ? AND company = ?').get(profileId, job.company) as { note: string } | undefined;
  const companyNote = companyNoteRow?.note || '';

  res.render('job-detail', { job, original, duplicatesOfThis, title: job.title, backUrl, backLabel, prevId, nextId, from, cvs, settings, companyNote });
});

export { router as dashboardRouter };
