/**
 * Reports Route — Shows a collapsible audit log of every pipeline run.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchRunRow, type RunJobLogRow, type SettingsRow } from '../db';
import { countryToFlag } from '../uiHelpers';

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

// ---- Routes ----

// GET /reports — main page; preloads last 2 runs, stubs the rest for lazy-load
router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const timezone = getTimezone(profileId);

  // Single query: run summaries + aggregate verdict counts (no N+1)
  const runs = db
    .prepare<SearchRunRow & { filtered_count: number; blacklisted_count: number }>(
      `SELECT sr.*,
         (SELECT COUNT(*) FROM run_job_logs WHERE run_id = sr.id AND ai_verdict = 'FILTERED')   AS filtered_count,
         (SELECT COUNT(*) FROM run_job_logs WHERE run_id = sr.id AND ai_verdict = 'BLACKLISTED') AS blacklisted_count
       FROM search_runs sr
       WHERE sr.profile_id = ?
       ORDER BY sr.ran_at DESC
       LIMIT 30`,
    )
    .all(profileId);

  // Batch-load logs for the first 2 runs in one query
  const preloadIds = runs.slice(0, 2).map((r) => r.id);
  const preloadedMap = new Map<number, FormattedJob[]>();

  if (preloadIds.length > 0) {
    const placeholders = preloadIds.map(() => '?').join(', ');
    const logs = db
      .prepare<JobLogWithInternalId>(
        // internal_job_id is ownership-based (job_profile_states): set only when THIS
        // profile owns the job, so detail links never 404. The jobs join is kept solely
        // for resolved_country (global pool data, available regardless of ownership).
        `SELECT rjl.*, jps.job_id AS internal_job_id, j.country AS resolved_country
         FROM run_job_logs rjl
         LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = rjl.job_source
         LEFT JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
         WHERE rjl.run_id IN (${placeholders})`,
      )
      .all(profileId, ...preloadIds);

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

  res.render('reports', { runs: runSummaries, title: 'Run Logs', timezone });
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

  const logs = db
    .prepare<JobLogWithInternalId>(
      // Ownership-based internal_job_id (see preload query above).
      `SELECT rjl.*, jps.job_id AS internal_job_id, j.country AS resolved_country
       FROM run_job_logs rjl
       LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = rjl.job_source
       LEFT JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
       WHERE rjl.run_id = ?`,
    )
    .all(profileId, runId);

  res.json({ jobs: processJobs(logs, timezone) });
});

export { router as reportsRouter };
