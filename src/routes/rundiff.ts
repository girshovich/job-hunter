/**
 * Run Diff — compare jobs across the last 2 pipeline runs.
 * Accessible at /run-diff, no nav link.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchRunRow, type SettingsRow } from '../db';

const router = Router();

type LogEntry = {
  id: number;
  linkedin_job_id: string;
  job_source: string;
  title: string;
  company: string;
  location: string | null;
  ai_score: number | null;
  ai_verdict: string;
  url: string | null;
  logged_at: string;
  internal_job_id: number | null;
};

const VERDICT_PRIORITY: Record<string, number> = {
  STRONG_MATCH: 0,
  WEAK_MATCH: 1,
  NO_MATCH: 2,
  DUPLICATE: 3,
  BLACKLISTED: 4,
  FILTERED: 5,
};

function dedupeByJobId(logs: LogEntry[]): LogEntry[] {
  const map = new Map<string, LogEntry>();
  for (const log of logs) {
    const existing = map.get(log.linkedin_job_id);
    if (!existing) {
      map.set(log.linkedin_job_id, log);
    } else {
      const ep = VERDICT_PRIORITY[existing.ai_verdict] ?? 99;
      const np = VERDICT_PRIORITY[log.ai_verdict] ?? 99;
      // Prefer scored entries; among those, prefer better verdict
      if (log.ai_score != null && existing.ai_score == null) {
        map.set(log.linkedin_job_id, log);
      } else if (log.ai_score == null && existing.ai_score != null) {
        // keep existing
      } else if (np < ep) {
        map.set(log.linkedin_job_id, log);
      }
    }
  }
  return Array.from(map.values());
}

function sortJobs(jobs: LogEntry[]): LogEntry[] {
  return jobs.slice().sort((a, b) => {
    const pa = VERDICT_PRIORITY[a.ai_verdict] ?? 99;
    const pb = VERDICT_PRIORITY[b.ai_verdict] ?? 99;
    if (pa !== pb) return pa - pb;
    return (b.ai_score ?? -1) - (a.ai_score ?? -1);
  });
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const settings = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(profileId) as Pick<SettingsRow, 'timezone'> | undefined;

  const runs = db
    .prepare('SELECT * FROM search_runs WHERE profile_id = ? ORDER BY ran_at DESC LIMIT 2')
    .all(profileId) as SearchRunRow[];

  if (runs.length < 2) {
    res.render('rundiff', {
      title: 'Run Diff',
      error: `Need at least 2 runs to compare. Only ${runs.length} run(s) found.`,
      runNewer: null, runOlder: null,
      onlyInNewer: [], onlyInOlder: [], inBoth: [],
      timezone: settings?.timezone || 'UTC',
    });
    return;
  }

  const [runNewer, runOlder] = runs;

  const logQuery = `
    SELECT rjl.id, rjl.linkedin_job_id, rjl.job_source, rjl.title, rjl.company, rjl.location,
           rjl.ai_score, rjl.ai_verdict, rjl.url, rjl.logged_at, jps.job_id as internal_job_id,
           j.country, c.logo_url
    FROM run_job_logs rjl
    LEFT JOIN jobs j ON j.linkedin_job_id = rjl.linkedin_job_id AND j.job_source = rjl.job_source
    LEFT JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
    LEFT JOIN companies c ON c.company = LOWER(TRIM(rjl.company))
    WHERE rjl.run_id = ?`;

  const rawNewer = db.prepare(logQuery).all(profileId, runNewer.id) as LogEntry[];
  const rawOlder = db.prepare(logQuery).all(profileId, runOlder.id) as LogEntry[];

  const newer = dedupeByJobId(rawNewer);
  const older = dedupeByJobId(rawOlder);

  const idsNewer = new Set(newer.map((l) => l.linkedin_job_id));
  const idsOlder = new Set(older.map((l) => l.linkedin_job_id));

  const onlyInNewer = sortJobs(newer.filter((l) => !idsOlder.has(l.linkedin_job_id)));
  const onlyInOlder = sortJobs(older.filter((l) => !idsNewer.has(l.linkedin_job_id)));
  // inBoth uses older run's data so verdict reflects first time it was seen
  const inBoth      = sortJobs(older.filter((l) =>  idsNewer.has(l.linkedin_job_id)));

  res.render('rundiff', {
    title: 'Run Diff',
    error: null,
    runNewer,
    runOlder,
    onlyInNewer,
    onlyInOlder,
    inBoth,
    timezone: settings?.timezone || 'UTC',
  });
});

export { router as rundiffRouter };
