/**
 * Stats (`/analytics`) — the conversion page.
 *
 * Shape, per new_stats.md §A1: **two queries, one definition.**
 *   Q1 asks a question about a *job* — did it apply, did it progress — and feeds the funnel and
 *      both tile grids.
 *   Q2 asks about a *(job × status)* pair — which stages did it touch, and in which month did it
 *      first become an application — and feeds the two application tables.
 * Q2 takes its set of jobs from Q1 rather than re-selecting them, so "what counts as an
 * application" is written once. If Q2 ever grows its own `ai_verdict` predicate the two halves of
 * the page will drift, and the totals will stop agreeing.
 *
 * Aggregation happens in JS on purpose. node:sqlite's DatabaseSync is synchronous and the app is a
 * single PM2 fork, so a slow query here stalls in-flight pipeline runs; the rows below are a few
 * thousand per profile, and two bounded scans beat seven correlated ones.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchGroupRow } from '../db';
import { everAppliedSql, everProgressedSql, listStatuses, type StatusRow, type StatusType } from '../statuses';

const router = Router();

/** Strong, non-duplicate — the gate every figure on this page shares (new_stats.md §6). */
const VISIBLE = "jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0";

interface JobRow {
  job_id: number;
  group_id: number | null;
  country: string | null;
  status_id: number | null;
  is_visible: number;     // strong + non-duplicate
  is_dup: number;
  verdict: string | null;
  applied: number;
  progressed: number;
  first_app: string | null;   // 'YYYY-MM-DD' of the first application-counting event
}

export interface Tile { label: string; applications: number; progressed: number; rate: number }

/** progressed desc → rate desc → applications desc → name. The name makes the order total, which
 *  is what stops two tied rows swapping places between renders (new_stats.md A6). */
function sortTiles(a: Tile, b: Tile): number {
  return b.progressed - a.progressed
    || b.rate - a.rate
    || b.applications - a.applications
    || a.label.localeCompare(b.label);
}

function tile(label: string, applications: number, progressed: number): Tile {
  return { label, applications, progressed, rate: applications ? progressed / applications * 100 : 0 };
}

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  // ── Q1 — one row per job ────────────────────────────────────────────────────────────────────
  const jobs = db.prepare<JobRow>(`
    SELECT jps.job_id, jps.group_id, j.country, jps.status_id,
           CASE WHEN ${VISIBLE} THEN 1 ELSE 0 END AS is_visible,
           jps.is_duplicate AS is_dup,
           jps.ai_verdict AS verdict,
           CASE WHEN ${everAppliedSql('jps')} THEN 1 ELSE 0 END AS applied,
           CASE WHEN ${everProgressedSql('jps')} THEN 1 ELSE 0 END AS progressed,
           (SELECT MIN(e.changed_at) FROM job_status_events e
              JOIN statuses es ON es.id = e.status_id
             WHERE e.job_id = jps.job_id AND e.profile_id = jps.profile_id
               AND es.type IN ('applied','progress','offer','rejected')) AS first_app
      FROM job_profile_states jps
      JOIN jobs j ON j.id = jps.job_id
     WHERE jps.profile_id = ?
  `).all(profileId) as JobRow[];

  // ── Funnel ──────────────────────────────────────────────────────────────────────────────────
  const nonDup = jobs.filter((r) => r.is_dup === 0);
  const visible = jobs.filter((r) => r.is_visible === 1);
  const applications = visible.filter((r) => r.applied === 1);
  const funnel = {
    all: nonDup.length,
    strong: visible.length,
    applied: applications.length,
    progressed: applications.filter((r) => r.progressed === 1).length,
  };

  // ── Tiles — the same aggregate over two different keys ───────────────────────────────────────
  const byKey = (key: (r: JobRow) => string | null) => {
    const m = new Map<string, { a: number; p: number }>();
    for (const r of applications) {
      const k = key(r);
      if (k === null) continue;
      if (!m.has(k)) m.set(k, { a: 0, p: 0 });
      const e = m.get(k)!;
      e.a++;
      if (r.progressed === 1) e.p++;
    }
    return m;
  };

  const countryMap = byKey((r) => (r.country && r.country.trim() ? r.country.trim() : 'Unknown'));
  const countryTiles = Array.from(countryMap, ([label, v]) => tile(label, v.a, v.p)).sort(sortTiles);

  // Every existing role gets a tile, `is_active` deliberately NOT filtered: history belongs to the
  // role that made it, and on a real profile the inactive roles hold most of the progressions.
  const groups = db.prepare<SearchGroupRow>(
    'SELECT id, group_name FROM search_groups WHERE profile_id = ? ORDER BY id ASC',
  ).all(profileId) as Pick<SearchGroupRow, 'id' | 'group_name'>[];
  const roleMap = byKey((r) => (r.group_id === null ? null : String(r.group_id)));
  const roleTiles = groups
    .map((g) => {
      const v = roleMap.get(String(g.id)) ?? { a: 0, p: 0 };
      return tile(g.group_name || `Role ${g.id}`, v.a, v.p);
    })
    .sort(sortTiles);
  // Deleting a role nulls `group_id` rather than deleting its jobs (api.ts), so without this the
  // grid would silently stop summing to the funnel. Shown only when it holds an application.
  const orphan = applications.filter((r) => r.group_id === null);
  if (orphan.length > 0) {
    roleTiles.push(tile('Deleted roles', orphan.length, orphan.filter((r) => r.progressed === 1).length));
    roleTiles.sort(sortTiles);
  }

  // ── Q2 — (job × status), over Q1's application set ──────────────────────────────────────────
  const appIds = new Set(applications.map((r) => r.job_id));
  interface PairRow { job_id: number; status_id: number }
  const reached = new Map<number, Set<number>>();   // status_id → job ids that ever held it
  const addPair = (statusId: number, jobId: number) => {
    if (!appIds.has(jobId)) return;
    if (!reached.has(statusId)) reached.set(statusId, new Set());
    reached.get(statusId)!.add(jobId);
  };
  for (const p of db.prepare<PairRow>(
    'SELECT DISTINCT job_id, status_id FROM job_status_events WHERE profile_id = ?',
  ).all(profileId) as PairRow[]) addPair(p.status_id, p.job_id);
  for (const r of applications) if (r.status_id !== null) addPair(r.status_id, r.job_id);

  // ── Columns: live statuses only, non-empty only, Applied → In Progress → Offer → Rejected ───
  // Archived statuses draw no column but still feed every total above (new_stats.md A3), which is
  // why the column set is built here from `listStatuses` and never from the reached map alone.
  const live = listStatuses(profileId);
  const jobsIn = (s: StatusRow) => reached.get(s.id)?.size ?? 0;
  const typeTotal = (t: StatusType) => {
    const ids = new Set<number>();
    for (const s of live) if (s.type === t) for (const id of reached.get(s.id) ?? []) ids.add(id);
    return ids;
  };

  interface Column { key: string; label: string; type: StatusType; ids: Set<number> }
  const columns: Column[] = [];
  for (const s of live.filter((x) => x.type === 'applied')) {
    if (jobsIn(s) > 0) columns.push({ key: `s${s.id}`, label: s.name, type: 'applied', ids: reached.get(s.id)! });
  }
  const progressCols = live
    .filter((s) => s.type === 'progress' && jobsIn(s) > 0)
    .map((s) => ({ key: `s${s.id}`, label: s.name, type: 'progress' as StatusType, ids: reached.get(s.id)! }));
  // Volume desc; `live` already arrives in the list's own order (type, then name), so a stable
  // sort leaves ties in that order — which is why Case sits before Hiring Manager at equal counts.
  progressCols.sort((a, b) => b.ids.size - a.ids.size);
  columns.push(...progressCols);
  for (const t of ['offer', 'rejected'] as StatusType[]) {
    const ids = typeTotal(t);
    if (ids.size > 0) columns.push({ key: t, label: t === 'offer' ? 'Offer' : 'Rejected', type: t, ids });
  }

  // ── Month rows — the cohort is fixed by the first application-counting event ─────────────────
  // "Which month is now" is a question about the clock, not about stored data, so it uses the
  // profile's timezone — the same one the cost chart buckets in. (The month BUCKETS still need no
  // conversion: `changed_at` is already written as the profile's local day, A2.)
  const tzRow = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?')
    .get(profileId) as { timezone: string } | undefined;
  const timezone = tzRow?.timezone || 'UTC';
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });

  const { from, to } = clampMonthWindow(
    String(req.query.from || ''), String(req.query.to || ''), dayKey(new Date()).slice(0, 7));
  const monthKey = (r: JobRow) => (r.first_app ? r.first_app.slice(0, 7) : null);

  const roleFilter = String(req.query.role || '').split(',').filter(Boolean);
  const countryFilter = String(req.query.country || '').split(',').filter(Boolean);
  const passesFilter = (r: JobRow) =>
    (roleFilter.length === 0 || roleFilter.includes(String(r.group_id)))
    && (countryFilter.length === 0 || countryFilter.includes((r.country || 'Unknown').trim()));

  const dated = applications.filter((r) => monthKey(r) !== null);
  const months = Array.from(new Set(dated.map((r) => monthKey(r)!))).sort();
  // Empty months in the middle are kept — a run of them is a finding, a hole looks like a bug —
  // but leading and trailing empties are trimmed **within the selected range**.
  const inRange = months.filter((m) => m >= from && m <= to);
  const rows: { month: string; jobs: JobRow[] }[] = [];
  if (inRange.length > 0) {
    const first = inRange[0]!;
    const last = inRange[inRange.length - 1]!;
    for (let m = first; m <= last; m = nextMonth(m)) {
      rows.push({ month: m, jobs: dated.filter((r) => monthKey(r) === m && passesFilter(r)) });
    }
  }
  rows.reverse();   // newest first
  const undated = applications.filter((r) => monthKey(r) === null && passesFilter(r));
  const shown = rows.flatMap((r) => r.jobs).concat(undated);

  const cell = (ids: Set<number>, pool: JobRow[]) => pool.filter((r) => ids.has(r.job_id)).length;
  const monthRows = rows.map((r) => ({
    label: monthLabel(r.month),
    applied: r.jobs.length,
    cells: columns.map((c) => (r.jobs.length === 0 ? null : cell(c.ids, r.jobs))),
  }));
  const totalRow = { applied: shown.length, cells: columns.map((c) => cell(c.ids, shown)) };
  // All time, unfiltered — the one card no range or filter can narrow.
  const allTimeRow = { applied: applications.length, cells: columns.map((c) => c.ids.size) };

  // ── Verdict mix (unchanged) ─────────────────────────────────────────────────────────────────
  interface StatusCount { status: string; count: number }
  const statusBreakdown = db.prepare<StatusCount>(`
    SELECT CASE WHEN jps.is_duplicate = 1 THEN 'DUPLICATE'
                ELSE COALESCE(jps.ai_verdict, 'UNKNOWN') END as status,
           COUNT(*) as count
      FROM job_profile_states jps WHERE jps.profile_id = ?
     GROUP BY status ORDER BY count DESC
  `).all(profileId) as StatusCount[];

  // ── Strong-match quality, last 14 days (unchanged) ──────────────────────────────────────────
  interface QualityRow { day: string; category: string; count: number }
  const strongQualityRaw = db.prepare<QualityRow>(`
    SELECT strftime('%Y-%m-%d', jps.fetched_at) as day,
      CASE
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND (jps.original_ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict IS NULL) THEN 'kept'
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.original_ai_verdict != 'STRONG_MATCH' THEN 'promoted'
        WHEN jps.ai_verdict != 'STRONG_MATCH' AND jps.original_ai_verdict = 'STRONG_MATCH' THEN 'demoted'
        ELSE NULL END as category,
      COUNT(*) as count
    FROM job_profile_states jps
    WHERE jps.profile_id = ? AND jps.is_duplicate = 0
      AND (jps.ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict = 'STRONG_MATCH')
      AND date(jps.fetched_at) >= date('now', '-13 days')
    GROUP BY day, category HAVING category IS NOT NULL ORDER BY day
  `).all(profileId) as QualityRow[];

  // ── Costs — daily and monthly, both bucketed from the same dayKey() resolved above ─────────
  const [ty, tm, td] = dayKey(new Date()).split('-').map(Number);
  const todayUtc = Date.UTC(ty!, tm! - 1, td!);
  const costDays: string[] = [];
  for (let i = 13; i >= 0; i--) costDays.push(new Date(todayUtc - i * 86400000).toISOString().slice(0, 10));
  const costMonths: string[] = [];
  for (let i = 11; i >= 0; i--) costMonths.push(addMonths(`${ty}-${String(tm).padStart(2, '0')}`, -i));

  interface RunCostRow { ran_at: string; cost_apify_usd: number | null; cost_openai_usd: number | null }
  const runCosts = db.prepare<RunCostRow>(`
    SELECT ran_at, cost_apify_usd, cost_openai_usd FROM search_runs
     WHERE profile_id = ? AND date(ran_at) >= date('now', '-13 months')
  `).all(profileId) as RunCostRow[];

  const bucket = (keyOf: (k: string) => string) => {
    const m = new Map<string, { fetch: number; ai: number }>();
    for (const run of runCosts) {
      const k = keyOf(dayKey(new Date(run.ran_at)));
      if (!m.has(k)) m.set(k, { fetch: 0, ai: 0 });
      const e = m.get(k)!;
      e.fetch += run.cost_apify_usd ?? 0;
      e.ai += run.cost_openai_usd ?? 0;
    }
    return m;
  };
  const long = (periods: string[], m: Map<string, { fetch: number; ai: number }>) => {
    const out: { day: string; category: string; count: number }[] = [];
    for (const p of periods) {
      const e = m.get(p);
      if (!e) continue;
      if (e.fetch > 0) out.push({ day: p, category: 'fetch', count: e.fetch });
      if (e.ai > 0) out.push({ day: p, category: 'ai', count: e.ai });
    }
    return out;
  };
  const dailyCostRaw = long(costDays, bucket((k) => k));
  const monthlyCostRaw = long(costMonths, bucket((k) => k.slice(0, 7)));

  res.render('analytics', {
    funnel,
    countryTiles,
    roleTiles,
    columns: columns.map((c) => ({ key: c.key, label: c.label, type: c.type })),
    monthRows,
    totalRow,
    allTimeRow,
    undatedCount: undated.length,
    rangeFrom: from,
    rangeTo: to,
    rangeLabel: `${monthLabel(from)} – ${monthLabel(to)}`,
    roleOptions: groups.map((g) => ({ id: g.id, name: g.group_name || `Role ${g.id}` })),
    countryOptions: countryTiles.map((t) => t.label),
    selectedRoles: roleFilter,
    selectedCountries: countryFilter,
    statusBreakdown,
    strongQualityRaw,
    dailyCostRaw,
    monthlyCostRaw,
    costDays,
    costMonths,
    title: 'Stats',
  });
});

/** The month window can never exceed this. `JHCal`'s `maxSpan` is measured in DAYS, so the
 *  picker alone cannot enforce a month cap — 1 Jan 2025 to 1 Jan 2026 is 366 days inclusive,
 *  passes a 366-day cap, and spans 13 months. And a hand-typed `?from=` never meets the picker
 *  at all. The server is the only place the real rule can live. */
export const MAX_RANGE_MONTHS = 12;

function monthSpan(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty! * 12 + tm!) - (fy! * 12 + fm!) + 1;
}
function addMonths(m: string, n: number): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo! - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Resolve `?from`/`?to` into a window of at most MAX_RANGE_MONTHS, however it was asked for —
 * the same shape as `clampWindow` in routes/adminStats.ts, and the same convention: **`from`
 * moves forward**, so the most recent months survive a clamp.
 *
 * `to` is pinned first. That is what handles `?from=2020-01` with no `to`, which would otherwise
 * imply a six-year span before anything got a chance to cap it.
 */
export function clampMonthWindow(fromIn: string, toIn: string, thisMonth: string): { from: string; to: string } {
  const ok = (v: string) => /^\d{4}-\d{2}$/.test(v);
  const to = ok(toIn) && toIn <= thisMonth ? toIn : thisMonth;
  let from = ok(fromIn) ? fromIn : addMonths(to, -(MAX_RANGE_MONTHS - 1));
  if (from > to) from = to;
  if (monthSpan(from, to) > MAX_RANGE_MONTHS) from = addMonths(to, -(MAX_RANGE_MONTHS - 1));
  return { from, to };
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  return `${MONTH_NAMES[(mo ?? 1) - 1]} ${y}`;
}
function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y!, mo!, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export { router as analyticsRouter };
