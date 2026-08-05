/**
 * Reports Route — Shows a collapsible audit log of every pipeline run.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchRunRow, type RunJobLogRow, type SettingsRow } from '../db';
import { countryToFlag, uiHelpers } from '../uiHelpers';
import { loadJobDetail } from './jobDetail';

const router = Router();

// ---- Constants ----

const VERDICT_PRIORITY: Record<string, number> = {
  STRONG_MATCH: 0,
  WEAK_MATCH: 1,
  NO_MATCH: 2,
  DUPLICATE: 3,
  BLACKLISTED: 4,
  FILTERED: 5,
};

// ---- Utilities ----

function fmtDate(iso: string | null, timezone: string): { date: string; time: string } {
  if (!iso) return { date: '—', time: '' };
  const d = new Date(String(iso));
  if (isNaN(d.getTime())) return { date: String(iso).slice(0, 10), time: '' };
  return {
    date: d.toLocaleDateString('en-CA', { timeZone: timezone }),
    time: d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: timezone }),
  };
}

function extractCountry(location: string | null): string {
  if (!location) return 'Remote / Unknown';
  const parts = location.split(',');
  const last = parts[parts.length - 1].trim();
  if (!last || last.toLowerCase() === 'remote') return 'Remote / Unknown';
  return last;
}

// ---- Types ----

interface JobLogWithInternalId extends RunJobLogRow {
  internal_job_id: number | null;
  job_source: string;
  resolved_country?: string | null;
  apply_url?: string | null;
}

export interface FormattedJob {
  id: number;
  run_id: number;
  internal_job_id: number | null;
  title: string;
  company: string;
  location: string | null;
  country: string;
  flag: string;
  url: string | null;
  apply_url: string | null;
  job_source: string;
  ai_score: number | null;
  ai_verdict: string;
  rejection_category: string | null;
  logged_at: string;
  logged_date: string;
  logged_time: string;
}

interface RunSummary extends SearchRunRow {
  filtered_count: number;
  blacklisted_count: number;
  ran_at_date: string;
  ran_at_time: string;
  jobs: FormattedJob[];
  preloaded: boolean;
}

// ---- Helpers ----

function processJobs(logs: JobLogWithInternalId[], timezone: string): FormattedJob[] {
  const jobs: FormattedJob[] = logs.map((log) => {
    const { date, time } = fmtDate(log.logged_at, timezone);
    return {
      id: log.id,
      run_id: log.run_id,
      internal_job_id: log.internal_job_id,
      title: log.title,
      company: log.company,
      location: log.location,
      country: log.resolved_country || extractCountry(log.location),
      flag: countryToFlag(log.resolved_country || extractCountry(log.location) || null),
      url: log.url,
      apply_url: log.apply_url ?? null,
      job_source: log.job_source || 'LinkedIn',
      ai_score: log.ai_score,
      ai_verdict: log.ai_verdict,
      rejection_category: log.rejection_category,
      logged_at: log.logged_at,
      logged_date: date,
      logged_time: time,
    };
  });

  jobs.sort((a, b) => {
    const pa = VERDICT_PRIORITY[a.ai_verdict] ?? 99;
    const pb = VERDICT_PRIORITY[b.ai_verdict] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.ai_score ?? -1) - (a.ai_score ?? -1);
  });

  return jobs;
}

function getTimezone(profileId: number): string {
  const row = getDb()
    .prepare('SELECT timezone FROM settings WHERE profile_id = ?')
    .get(profileId) as Pick<SettingsRow, 'timezone'> | undefined;
  return row?.timezone || 'UTC';
}

// Row-level filters (Verdict-in-log / Company) applied to run_job_logs, shared by the
// main preload query and the lazy-load endpoint so both stay consistent.
const VALID_LOG_VERDICTS = new Set([
  'STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE', 'FILTERED', 'BLACKLISTED',
]);

function buildRowFilter(verdict: string, company: string): { clause: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (verdict && VALID_LOG_VERDICTS.has(verdict)) {
    clauses.push('rjl.ai_verdict = ?');
    params.push(verdict);
  }
  if (company) {
    clauses.push('rjl.company LIKE ?');
    params.push(`%${company}%`);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', params };
}

// ---- Routes ----

// GET /reports — main page; preloads last 2 runs, stubs the rest for lazy-load
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const timezone = getTimezone(profileId);

  // Filters (server-rendered, query-string): Source is run-level; Verdict-in-log & Company
  // are row-level. When a row-level filter is set, runs with no matching row are hidden.
  const source = String(req.query.source ?? '').trim();
  const verdict = String(req.query.verdict ?? '').trim().toUpperCase();
  const company = String(req.query.company ?? '').trim();
  const rowFilter = buildRowFilter(verdict, company);
  const rowFilterActive = rowFilter.params.length > 0;

  // Source filter options: distinct scraping providers across this profile's runs.
  const sourceOptions = (db
    .prepare(
      `SELECT DISTINCT scraping_provider FROM search_runs
       WHERE profile_id = ? AND scraping_provider IS NOT NULL AND scraping_provider != ''
       ORDER BY scraping_provider`,
    )
    .all(profileId) as Array<{ scraping_provider: string }>)
    .map((r) => ({ value: r.scraping_provider, label: uiHelpers.formatSourceLabel(r.scraping_provider) }));

  // Single query: run summaries + aggregate verdict counts (no N+1)
  const runsSql =
    `SELECT sr.*,
       (SELECT COUNT(*) FROM run_job_logs WHERE run_id = sr.id AND ai_verdict = 'FILTERED')   AS filtered_count,
       (SELECT COUNT(*) FROM run_job_logs WHERE run_id = sr.id AND ai_verdict = 'BLACKLISTED') AS blacklisted_count
     FROM search_runs sr
     WHERE sr.profile_id = ? AND sr.trigger != 'cv'${source ? ' AND sr.scraping_provider = ?' : ''}
     ORDER BY sr.ran_at DESC
     LIMIT 30`;
  let runs = db
    .prepare<SearchRunRow & { filtered_count: number; blacklisted_count: number }>(runsSql)
    .all(...(source ? [profileId, source] : [profileId]));

  // Row-level filter: keep only runs that contain ≥1 matching log row.
  if (rowFilterActive && runs.length > 0) {
    const ph = runs.map(() => '?').join(', ');
    const matchingIds = new Set(
      (db
        .prepare(
          `SELECT DISTINCT rjl.run_id FROM run_job_logs rjl
           WHERE rjl.run_id IN (${ph})${rowFilter.clause}`,
        )
        .all(...runs.map((r) => r.id), ...rowFilter.params) as Array<{ run_id: number }>)
        .map((r) => r.run_id),
    );
    runs = runs.filter((r) => matchingIds.has(r.id));
  }

  // Batch-load logs for the first 2 runs in one query (row filter applied)
  const preloadIds = runs.slice(0, 2).map((r) => r.id);
  const preloadedMap = new Map<number, FormattedJob[]>();

  if (preloadIds.length > 0) {
    const placeholders = preloadIds.map(() => '?').join(', ');
    const logs = db
      .prepare<JobLogWithInternalId>(
        // internal_job_id is ownership-based (job_profile_states): set only when THIS
        // profile owns the job, so detail links never 404. The jobs join is kept solely
        // for resolved_country (global pool data, available regardless of ownership).
        `SELECT rjl.*, jps.job_id AS internal_job_id, j.country AS resolved_country, j.apply_url AS apply_url
         FROM run_job_logs rjl
         LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = rjl.job_source
         LEFT JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
         WHERE rjl.run_id IN (${placeholders})${rowFilter.clause}`,
      )
      .all(profileId, ...preloadIds, ...rowFilter.params);

    // Group by run_id in one pass, then process+sort each group
    const byRunId = new Map<number, JobLogWithInternalId[]>();
    for (const log of logs) {
      const bucket = byRunId.get(log.run_id) ?? [];
      byRunId.set(log.run_id, bucket);
      bucket.push(log);
    }
    for (const runId of preloadIds) {
      preloadedMap.set(runId, processJobs(byRunId.get(runId) ?? [], timezone));
    }
  }

  const runSummaries: RunSummary[] = runs.map((run, i) => {
    const { date, time } = fmtDate(run.ran_at, timezone);
    return {
      ...run,
      ran_at_date: date,
      ran_at_time: time,
      jobs: preloadedMap.get(run.id) ?? [],
      preloaded: i < 2,
    };
  });

  res.render('reports', {
    runs: runSummaries,
    title: 'Run Logs',
    timezone,
    sourceOptions,
    filterSource: source,
    filterVerdict: verdict,
    filterCompany: company,
  });
});

// GET /reports/runs/:id/logs — JSON fragment for lazy-load
router.get('/runs/:id/logs', (req: Request, res: Response) => {
  const runId = parseInt(req.params.id, 10);
  if (isNaN(runId)) { res.status(400).json({ error: 'Invalid run id' }); return; }

  const db = getDb();
  const profileId = req.profile.id;

  const run = db
    .prepare('SELECT id FROM search_runs WHERE id = ? AND profile_id = ?')
    .get(runId, profileId);
  if (!run) { res.status(404).json({ error: 'Not found' }); return; }

  const timezone = getTimezone(profileId);

  // Same row-level filter as the main page, so lazy-expanded runs match the filtered view.
  const verdict = String(req.query.verdict ?? '').trim().toUpperCase();
  const company = String(req.query.company ?? '').trim();
  const rowFilter = buildRowFilter(verdict, company);

  const logs = db
    .prepare<JobLogWithInternalId>(
      // Ownership-based internal_job_id (see preload query above).
      `SELECT rjl.*, jps.job_id AS internal_job_id, j.country AS resolved_country
       FROM run_job_logs rjl
       LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = rjl.job_source
       LEFT JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
       WHERE rjl.run_id = ?${rowFilter.clause}`,
    )
    .all(profileId, runId, ...rowFilter.params);

  res.json({ jobs: processJobs(logs, timezone) });
});

// GET /reports/job/:id/detail — HTML fragment (the shared job-detail body) for the slide-in
// drawer. Owned jobs only (loadJobDetail is scoped to the profile); rendered WITHOUT the app
// layout so the client can inject it into the drawer.
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

export { router as reportsRouter };
