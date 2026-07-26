/**
 * Matches Route — filterable job list (two-pane) grouped by fetched date, paginated by run-dates.
 * Server-rendered: filters + selection live in the query string; the selected job's full detail
 * is rendered inline via the shared job-detail partial (loadJobDetail).
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobWithState, type SettingsRow } from '../db';
import { getPreferredCountries } from '../pipeline/locationNormalizer';
import { loadJobDetail } from './jobDetail';

const router = Router();
const PAGE_DATES = 10; // number of distinct run-dates shown per page

// Per-(profile+filter) cache of distinct fetch dates — only changes after a pipeline run.
// Invalidated by invalidateJobsDatesCache(), called from runner.ts on run completion.
const datesCache = new Map<string, Array<{ d: string }>>();
export function invalidateJobsDatesCache(profileId: number): void {
  for (const key of datesCache.keys()) {
    if (key.startsWith(profileId + '|')) datesCache.delete(key);
  }
}

interface DateGroup {
  label: string;
  jobs: JobWithState[];
}

const STATUS_MAP: Record<string, number> = { new: 0, applied: 1, wont: 2 };

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const q = req.query;

  // ── Parse filters ──
  // Verdict: default Strong (Q6), clearable via ?verdict=all
  const verdictParam = q.verdict === undefined ? 'STRONG_MATCH' : String(q.verdict);
  const verdict = verdictParam === 'all' ? null : verdictParam;
  // Roles (multi): comma list of search_group ids and/or 'other' (deleted-role jobs)
  const rolesParam = q.roles ? String(q.roles).split(',').filter(Boolean) : [];
  const roleIds = rolesParam.filter((r) => r !== 'other').map((r) => parseInt(r, 10)).filter((n) => !Number.isNaN(n));
  const roleOther = rolesParam.includes('other');
  const company = q.company ? String(q.company).trim() : '';
  const countries = q.country ? String(q.country).split(',').filter(Boolean) : [];
  const statusParam = q.status ? String(q.status) : '';
  const status = statusParam in STATUS_MAP ? STATUS_MAP[statusParam] : null;
  const dateFrom = q.df ? String(q.df) : '';
  const dateTo = q.dt ? String(q.dt) : '';

  // ── Build WHERE clause ──
  // Blacklisted/Filtered are not offered in the Verdict filter, so they must never appear on
  // Matches/All Jobs — not even under "All verdicts". Exclude them for every request.
  const where: string[] = ['jps.profile_id = ?', "jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')"];
  const params: (string | number)[] = [profileId];
  if (verdict === 'DUPLICATE') {
    where.push('jps.is_duplicate = 1');
  } else if (verdict) {
    where.push('jps.ai_verdict = ? AND jps.is_duplicate = 0');
    params.push(verdict);
  }
  if (roleIds.length || roleOther) {
    const parts: string[] = [];
    if (roleIds.length) {
      parts.push(`jps.group_id IN (${roleIds.map(() => '?').join(',')})`);
      params.push(...roleIds);
    }
    if (roleOther) {
      parts.push('(jps.group_id IS NULL OR jps.group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))');
      params.push(profileId);
    }
    where.push('(' + parts.join(' OR ') + ')');
  }
  if (company) { where.push('j.company LIKE ?'); params.push('%' + company + '%'); }
  if (countries.length) { where.push(`j.country IN (${countries.map(() => '?').join(',')})`); params.push(...countries); }
  if (status !== null) { where.push('jps.applied = ?'); params.push(status); }
  if (dateFrom) { where.push('DATE(jps.fetched_at) >= ?'); params.push(dateFrom); }
  if (dateTo) { where.push('DATE(jps.fetched_at) <= ?'); params.push(dateTo); }
  const whereSql = where.join(' AND ');

  // ── Distinct fetch dates matching the filters (cached per profile+filter signature) ──
  const cacheKey = profileId + '|' + JSON.stringify({ verdictParam, roleIds, roleOther, company, countries, statusParam, dateFrom, dateTo });
  let allDates = datesCache.get(cacheKey);
  if (!allDates) {
    allDates = db.prepare(`
      SELECT DISTINCT DATE(jps.fetched_at) as d
      FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
      WHERE ${whereSql} AND jps.fetched_at IS NOT NULL
      ORDER BY d DESC
    `).all(...params) as Array<{ d: string }>;
    datesCache.set(cacheKey, allDates);
  }

  const totalPages = Math.max(1, Math.ceil(allDates.length / PAGE_DATES));
  const page = Math.max(1, Math.min(parseInt(String(q.page || '1'), 10), totalPages));
  const pageDates = allDates.slice((page - 1) * PAGE_DATES, page * PAGE_DATES).map((r) => r.d);
  const pageNewest = pageDates[0] ?? null;
  const pageOldest = pageDates[pageDates.length - 1] ?? null;

  // ── Fetch jobs for this page's dates (sort: day DESC, then Score DESC within a day — Q8) ──
  const COLS = `j.id, j.title, j.company, j.location, j.country, j.url, j.apply_url, j.job_source,
                jps.ai_score, jps.ai_verdict, jps.is_duplicate, jps.ai_summary,
                jps.fetched_at, jps.applied, jps.user_notes, c.logo_url`;
  let jobs: JobWithState[] = [];
  if (pageDates.length > 0) {
    const ph = pageDates.map(() => '?').join(',');
    jobs = db.prepare(`
      SELECT ${COLS}
      FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      LEFT JOIN companies c ON c.company = j.company
      WHERE ${whereSql} AND DATE(jps.fetched_at) IN (${ph})
      ORDER BY DATE(jps.fetched_at) DESC, jps.ai_score DESC, j.id DESC
    `).all(...params, ...pageDates) as JobWithState[];
  }

  // Attach job_locations labels for the +N badge
  if (jobs.length > 0) {
    const ids = jobs.map((j) => j.id);
    const ph = ids.map(() => '?').join(',');
    const locRows = db.prepare(`SELECT job_id, label FROM job_locations WHERE job_id IN (${ph}) ORDER BY rowid ASC`).all(...ids) as Array<{ job_id: number; label: string }>;
    const labelsMap = new Map<number, string[]>();
    for (const { job_id, label } of locRows) {
      if (!labelsMap.has(job_id)) labelsMap.set(job_id, []);
      labelsMap.get(job_id)!.push(label);
    }
    for (const job of jobs) {
      (job as JobWithState & { locationLabels: string[] }).locationLabels = labelsMap.get(job.id) ?? [];
    }
  }

  // Group by fetched day (newest first; already score-sorted within a day by the query)
  const dateMap = new Map<string, JobWithState[]>();
  for (const job of jobs) {
    const key = job.fetched_at ? String(job.fetched_at).slice(0, 10) : 'Unknown';
    if (!dateMap.has(key)) dateMap.set(key, []);
    dateMap.get(key)!.push(job);
  }
  const dateGroups: DateGroup[] = Array.from(dateMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, groupJobs]) => ({
      label: key === 'Unknown' ? 'Unknown Date'
        : new Date(key + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
      jobs: groupJobs,
    }));

  // ── Filter option lists (unfiltered counts, like the mockup) ──
  const NOT_BL = "jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')";
  const roleOptions = db.prepare(`
    SELECT sg.id, sg.group_name, COUNT(jps.job_id) as cnt
    FROM search_groups sg
    LEFT JOIN job_profile_states jps ON jps.group_id = sg.id AND jps.profile_id = sg.profile_id AND ${NOT_BL}
    WHERE sg.profile_id = ?
    GROUP BY sg.id ORDER BY sg.id ASC
  `).all(profileId) as Array<{ id: number; group_name: string; cnt: number }>;
  const orphanCount = (db.prepare(`
    SELECT COUNT(*) as c FROM job_profile_states jps
    WHERE jps.profile_id = ? AND ${NOT_BL}
      AND (jps.group_id IS NULL OR jps.group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))
  `).get(profileId, profileId) as { c: number }).c;
  const countryOptions = db.prepare(`
    SELECT j.country, COUNT(*) as cnt
    FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE jps.profile_id = ? AND ${NOT_BL} AND j.country IS NOT NULL AND j.country <> ''
    GROUP BY j.country ORDER BY cnt DESC
  `).all(profileId) as Array<{ country: string; cnt: number }>;
  const statusRows = db.prepare(`
    SELECT applied, COUNT(*) as cnt FROM job_profile_states jps WHERE jps.profile_id = ? AND ${NOT_BL} GROUP BY applied
  `).all(profileId) as Array<{ applied: number; cnt: number }>;
  const statusCounts = { 0: 0, 1: 0, 2: 0, all: 0 };
  for (const r of statusRows) { statusCounts[(r.applied as 0 | 1 | 2)] = r.cnt; statusCounts.all += r.cnt; }

  // "N new" subtitle = applied-0 count across the whole filtered set
  const newCount = (db.prepare(`
    SELECT COUNT(*) as c FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE ${whereSql} AND jps.applied = 0
  `).get(...params) as { c: number }).c;

  // Truly-empty (no non-blacklisted jobs in account at all) vs filtered-empty
  const totalUnfiltered = (db.prepare(
    `SELECT COUNT(*) as c FROM job_profile_states jps WHERE jps.profile_id = ? AND ${NOT_BL}`,
  ).get(profileId) as { c: number }).c;

  // ── Selected job for the detail pane (explicit ?selected wins; else top of the sorted list) ──
  const flatJobs = dateGroups.flatMap((g) => g.jobs);
  const selectedParam = q.selected ? parseInt(String(q.selected), 10) : null;
  let pane = selectedParam ? loadJobDetail(profileId, selectedParam) : null;
  if (!pane && flatJobs.length > 0) pane = loadJobDetail(profileId, flatJobs[0].id);
  const selectedJobId = pane ? pane.job.id : null;

  const settings = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(profileId) as Pick<SettingsRow, 'timezone'> | undefined;

  res.render('jobs', {
    title: 'Matches',
    fullBleed: true,
    dateGroups,
    filters: { verdict: verdictParam, roleIds, roleOther, company, countries, status: statusParam, df: dateFrom, dt: dateTo },
    roleOptions, orphanCount, countryOptions, statusCounts,
    newCount, totalUnfiltered,
    page, totalPages, pageNewest, pageOldest,
    selectedJobId, pane,
    timezone: settings?.timezone || 'UTC',
    locPref: getPreferredCountries(profileId),
  });
});

export { router as jobsRouter };
