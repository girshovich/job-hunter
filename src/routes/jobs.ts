/**
 * Matches Route — filterable job list (two-pane) grouped by fetched date, paginated by run-dates.
 * Server-rendered: filters + selection live in the query string; the selected job's full detail
 * is rendered inline via the shared job-detail partial (loadJobDetail).
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type JobWithState, type SettingsRow } from '../db';
import { getPreferredCountries, lookupCountry, getCanonicalCountries } from '../pipeline/locationNormalizer';
import { loadJobDetail } from './jobDetail';
import { companyKey } from '../uiHelpers';
import { listStatuses, parseStatusParam, statusFilterSql, idsOfPreset, PRESETS, TYPE_META, STATUS_TYPES, todayIn, type StatusRow } from '../statuses';

const router = Router();
const PAGE_DATES = 10; // number of distinct run-dates shown per page

// Config that differs between the two list pages that share this handler (Matches / All Jobs).
export interface JobListOpts {
  defaultVerdict: 'STRONG_MATCH' | 'all'; // default Verdict filter when ?verdict is absent
  withinDaySort: string;                  // ORDER BY fragment applied within each fetched day
  title: string;                          // page + list-header title
  basePath: string;                       // where "Clear all filters" navigates (route mount path)
  fromKey: string;                        // ?from= value used by the mobile card → /job/:id link
  showSubtitle: boolean;                  // show the "N new" list-header subtitle
}

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

export function renderJobList(req: Request, res: Response, opts: JobListOpts): void {
  const db = getDb();
  const profileId = req.profile.id;
  const q = req.query;

  // ── Parse filters ──
  // Verdict: default per page (Matches → Strong/Q6, All Jobs → all/Q11), clearable via ?verdict=all
  const verdictParam = q.verdict === undefined ? opts.defaultVerdict : String(q.verdict);
  const verdict = verdictParam === 'all' ? null : verdictParam;
  // Roles (multi): comma list of search_group ids and/or 'other' (deleted-role jobs)
  const rolesParam = q.roles ? String(q.roles).split(',').filter(Boolean) : [];
  const roleIds = rolesParam.filter((r) => r !== 'other').map((r) => parseInt(r, 10)).filter((n) => !Number.isNaN(n));
  const roleOther = rolesParam.includes('other');
  // One company filter with an operator: bare text is a substring search, "quoted text" is an
  // exact whole-name match (what the company modal's stat links use). Both are case-insensitive —
  // SQLite LIKE already folds ASCII case, and the exact form folds both sides explicitly.
  const company = q.company ? String(q.company).trim() : '';
  const companyIsExact = company.length >= 2 && company.startsWith('"') && company.endsWith('"');
  const companyTerm = companyIsExact ? company.slice(1, -1).trim() : company;
  const countries = q.country ? String(q.country).split(',').filter(Boolean) : [];
  // Status is multi-select (D45): `?status=` carries a comma list of status ids, and the two
  // single-word values `new|applied|wont` still resolve as a bookmark alias (D10, D49).
  const statusParam = q.status ? String(q.status) : '';
  const statusIds = parseStatusParam(profileId, statusParam);
  // Sorted ids, so `?status=b,a` and `?status=a,b` are one cache entry rather than two (FL9).
  const statusKey = statusIds ? statusIds.join(',') : '';
  // "Include past statuses": match any step in a job's history, not just the status held now.
  // Kept in the URL even with no status ticked, so it survives moving between Matches and All Jobs.
  const ever = q.ever === '1';
  const dateFrom = q.df ? String(q.df) : '';
  const dateTo = q.dt ? String(q.dt) : '';

  // ── Build WHERE clause ──
  // Blacklisted/Filtered are not offered in the Verdict filter, so they must never appear on
  // Matches/All Jobs — not even under "All verdicts". Exclude them for every request.
  // Each clause is tagged with the filter it belongs to, so a menu can count within every filter
  // on the page except its own (`whereExcept`) and its numbers match what ticking a row would show.
  type FilterKey = 'base' | 'verdict' | 'role' | 'company' | 'country' | 'date' | 'status';
  const clauses: Array<{ key: FilterKey; sql: string; params: (string | number)[] }> = [
    { key: 'base', sql: "jps.profile_id = ? AND jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')", params: [profileId] },
  ];
  if (verdict === 'DUPLICATE') {
    clauses.push({ key: 'verdict', sql: 'jps.is_duplicate = 1', params: [] });
  } else if (verdict) {
    clauses.push({ key: 'verdict', sql: 'jps.ai_verdict = ? AND jps.is_duplicate = 0', params: [verdict] });
  }
  if (roleIds.length || roleOther) {
    const parts: string[] = [];
    const roleParams: (string | number)[] = [];
    if (roleIds.length) {
      parts.push(`jps.group_id IN (${roleIds.map(() => '?').join(',')})`);
      roleParams.push(...roleIds);
    }
    if (roleOther) {
      parts.push('(jps.group_id IS NULL OR jps.group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))');
      roleParams.push(profileId);
    }
    clauses.push({ key: 'role', sql: '(' + parts.join(' OR ') + ')', params: roleParams });
  }
  if (companyTerm) {
    if (companyIsExact) clauses.push({ key: 'company', sql: 'LOWER(TRIM(j.company)) = ?', params: [companyKey(companyTerm)] });
    else clauses.push({ key: 'company', sql: 'j.company LIKE ?', params: ['%' + companyTerm + '%'] });
  }
  // Country: match against the multi-country list (job_countries) so a job open in several
  // countries is found under any of them; values are stored lowercase.
  if (countries.length) {
    clauses.push({
      key: 'country',
      sql: `EXISTS (SELECT 1 FROM job_countries jc WHERE jc.job_id = j.id AND jc.country IN (${countries.map(() => '?').join(',')}))`,
      params: countries.map((c) => c.toLowerCase()),
    });
  }
  if (dateFrom) clauses.push({ key: 'date', sql: 'DATE(jps.fetched_at) >= ?', params: [dateFrom] });
  if (dateTo) clauses.push({ key: 'date', sql: 'DATE(jps.fetched_at) <= ?', params: [dateTo] });
  if (statusIds) {
    const statusFilter = statusFilterSql(statusIds, ever);
    clauses.push({ key: 'status', sql: statusFilter.sql, params: statusFilter.params });
  }
  const whereExcept = (skip: FilterKey | null) => {
    const kept = clauses.filter((c) => c.key !== skip);
    return { sql: kept.map((c) => c.sql).join(' AND '), params: kept.flatMap((c) => c.params) };
  };
  const { sql: whereSql, params } = whereExcept(null);

  // ── Distinct fetch dates matching the filters (cached per profile+filter signature) ──
  const cacheKey = profileId + '|' + JSON.stringify({ verdictParam, roleIds, roleOther, company, countries, statusKey, ever, dateFrom, dateTo });
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
                jps.fetched_at, jps.applied, jps.status_id, jps.user_notes, c.logo_url,
                c.is_agency, c.employee_count, c.employee_range,
                st.name AS status_name, st.type AS status_type,
                (SELECT MAX(e.changed_at) FROM job_status_events e
                   WHERE e.job_id = jps.job_id AND e.profile_id = jps.profile_id) AS status_since`;
  let jobs: JobWithState[] = [];
  if (pageDates.length > 0) {
    const ph = pageDates.map(() => '?').join(',');
    jobs = db.prepare(`
      SELECT ${COLS}
      FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
      LEFT JOIN statuses st ON st.id = jps.status_id
      WHERE ${whereSql} AND DATE(jps.fetched_at) IN (${ph})
      ORDER BY DATE(jps.fetched_at) DESC, ${opts.withinDaySort}, j.id DESC
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

  // ── Filter option lists — each menu counts within every filter on the page except its own ──
  const NOT_BL = "jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')";
  // Every role is listed, a zero included; "Other" only when it holds jobs or is ticked.
  const noRole = whereExcept('role');
  const roleOptions = db.prepare(`
    SELECT sg.id, sg.group_name, COALESCE(rc.cnt, 0) as cnt
    FROM search_groups sg
    LEFT JOIN (
      SELECT jps.group_id, COUNT(*) as cnt FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
      WHERE ${noRole.sql} GROUP BY jps.group_id
    ) rc ON rc.group_id = sg.id
    WHERE sg.profile_id = ?
    ORDER BY sg.id ASC
  `).all(...noRole.params, profileId) as Array<{ id: number; group_name: string; cnt: number }>;
  const orphanCount = (db.prepare(`
    SELECT COUNT(*) as c FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    WHERE ${noRole.sql}
      AND (jps.group_id IS NULL OR jps.group_id NOT IN (SELECT id FROM search_groups WHERE profile_id = ?))
  `).get(...noRole.params, profileId) as { c: number }).c;
  // Country options come from the multi-country list (job_countries, lowercase); display a
  // capitalized label (recognition map, else title-case) matching the EXISTS filter above.
  // Every country among this profile's jobs is listed, a zero included, so the menu doesn't shrink
  // as other filters narrow the list — plus any ticked country that matches none, at 0.
  const titleCase = (s: string) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const noCountry = whereExcept('country');
  const countryRows = db.prepare(`
    SELECT ac.country as value, COALESCE(fc.cnt, 0) as cnt
    FROM (
      SELECT DISTINCT jc.country FROM job_countries jc JOIN job_profile_states jps ON jps.job_id = jc.job_id
      WHERE jps.profile_id = ? AND ${NOT_BL} AND jc.country IS NOT NULL AND jc.country <> ''
    ) ac
    LEFT JOIN (
      SELECT jc.country, COUNT(*) as cnt
      FROM job_countries jc JOIN job_profile_states jps ON jps.job_id = jc.job_id JOIN jobs j ON j.id = jps.job_id
      WHERE ${noCountry.sql} AND jc.country IS NOT NULL AND jc.country <> ''
      GROUP BY jc.country
    ) fc ON fc.country = ac.country
    ORDER BY cnt DESC, ac.country ASC
  `).all(profileId, ...noCountry.params) as Array<{ value: string; cnt: number }>;
  for (const c of countries.map((v) => v.toLowerCase())) {
    if (!countryRows.some((r) => r.value === c)) countryRows.push({ value: c, cnt: 0 });
  }
  const countryOptions = countryRows.map((c) => ({
    value: c.value,
    label: lookupCountry(c.value) ?? titleCase(c.value),
    cnt: c.cnt,
  }));
  // Status menu: every live status, its own count, grouped by type in the view (D45). The counts
  // follow the switch — with past statuses included, a status counts every job that ever held it.
  const noStatus = whereExcept('status');
  const statusRows = (ever
    ? db.prepare(`
      SELECT status_id, COUNT(*) as cnt FROM (
        SELECT e.job_id, e.status_id FROM job_status_events e
        JOIN job_profile_states jps ON jps.job_id = e.job_id AND jps.profile_id = e.profile_id
        JOIN jobs j ON j.id = jps.job_id
        WHERE ${noStatus.sql}
        UNION
        SELECT jps.job_id, jps.status_id FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
        WHERE ${noStatus.sql}
      ) GROUP BY status_id
    `).all(...noStatus.params, ...noStatus.params)
    : db.prepare(`
      SELECT jps.status_id, COUNT(*) as cnt FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
      WHERE ${noStatus.sql} GROUP BY jps.status_id
    `).all(...noStatus.params)) as Array<{ status_id: number | null; cnt: number }>;
  const statusCountById = new Map<number, number>();
  let statusTotal = 0;
  for (const r of statusRows) {
    if (r.status_id != null) statusCountById.set(r.status_id, r.cnt);
    statusTotal += r.cnt;
  }
  const statusOptions = listStatuses(profileId).map((st: StatusRow) => ({
    id: st.id,
    name: st.name,
    type: st.type,
    typeLabel: TYPE_META[st.type].label,
    dot: TYPE_META[st.type].dot,
    cnt: statusCountById.get(st.id) ?? 0,
  }));
  // Keep the menu in the user's own order but grouped, so each type heading appears once.
  statusOptions.sort((a, b) => STATUS_TYPES.indexOf(a.type) - STATUS_TYPES.indexOf(b.type));
  const statusCounts = { all: statusTotal };

  // "N new" subtitle = jobs of type `new` across the whole filtered set. Counted the same way as
  // the sidebar badge and the shortcut counts, so the three can never disagree (NR3).
  const newCount = (db.prepare(`
    SELECT COUNT(*) as c FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
    LEFT JOIN statuses ns ON ns.id = jps.status_id
    WHERE ${whereSql} AND COALESCE(ns.type, 'new') = 'new'
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

  // Everything the "Add a job" modal needs (PRD §7.26). It lives in the layout — the detail
  // pane re-injects its partial, which would duplicate ids — but it is rendered only where these
  // options are present, so no other page carries 250 country options it never shows.
  const addJobOptions = {
    roles: roleOptions.map((r) => ({ id: r.id, name: r.group_name })),
    countries: getCanonicalCountries(),
    today: todayIn(settings?.timezone || 'UTC'),
  };

  res.render('jobs', {
    addJobOptions,
    title: opts.title,
    basePath: opts.basePath,
    fromKey: opts.fromKey,
    showSubtitle: opts.showSubtitle,
    fullBleed: true,
    dateGroups,
    // `status` carries the RESOLVED ids, not the raw param: the view's chip, its checkboxes and
    // its "did this change" comparison all have to agree with what the query actually ran, or the
    // `applied` alias would render as an empty selection (D49, FL9).
    filters: { verdict: verdictParam, roleIds, roleOther, company, countries, status: statusKey, ever, df: dateFrom, dt: dateTo },
    roleOptions, orphanCount, countryOptions, statusCounts, statusOptions,
    newCount, totalUnfiltered,
    page, totalPages, pageNewest, pageOldest,
    selectedJobId, pane,
    timezone: settings?.timezone || 'UTC',
    locPref: getPreferredCountries(profileId),
  });
}

// Matches: default Strong (Q6), score-desc within a day (Q8).
router.get('/', (req: Request, res: Response) =>
  renderJobList(req, res, {
    defaultVerdict: 'STRONG_MATCH',
    withinDaySort: 'jps.ai_score DESC',
    title: 'Matches',
    basePath: '/jobs',
    fromKey: 'jobs',
    showSubtitle: true,
  }),
);

export { router as jobsRouter };
