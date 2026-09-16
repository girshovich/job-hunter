/**
 * Admin Stats — the operator's view of the user base.
 *
 * The page has two halves that never share a filter:
 *   • TOTALS  — all-time, unfiltered. Users, own API keys, activated, runs.
 *   • DAILY   — one row per day over a window of at most 30 days.
 *
 * Three rules govern the page:
 *
 *  1. All-time totals include admin profiles and admin runs, with the run total split back out
 *     into non-admin/admin so operator work remains visible. Daily run charts still exclude
 *     admins (`profiles.is_admin = 0`): admin runs are test runs, CV re-scores and pool crons —
 *     on a base this size they would be the whole chart.
 *  2. Days bucket in the ADMIN's timezone, not UTC, the same way the Stats cost chart buckets
 *     in the profile's (analytics.ts) and the ATS crons fire admin-timezone-local. The SQL
 *     window is widened a day at each edge so the shift cannot drop a row.
 *  3. `trigger = 'cv'` is a CV comparison, not a search: it writes a search_runs row with zero
 *     job counts. It is excluded from every run count and from activation.
 *
 * Speed: node:sqlite's DatabaseSync is synchronous and this app is one PM2 fork process, so a
 * slow query here stalls in-flight pipeline runs and every other request. Everything below is a
 * grouped or bounded scan — no per-day correlated subqueries — and the window is capped.
 */

import { getDb } from '../db';

/** The daily window can never exceed this. A month of columns is the most the chart reads. */
export const MAX_WINDOW_DAYS = 30;
const DAY_MS = 86400000;

/** Success rate is drawn as "nines" (-log10 of the failure rate) so 99.5 % and 99.7 % are
 *  visibly different. Capped at 4, which formats back to "100.0 %" at one decimal. */
export const NINES_CAP = 4;

export interface StatsDay {
  d: string;      // YYYY-MM-DD in admin-local time
  nu: number;     // profiles registered this day
  d0: number;     // ...of which ran on day 0 / 1 / 2 (independent, they overlap)
  d1: number;
  d2: number;
  any: number;    // ...of which ran on any of day 0-2, counted once
  mature: number; // whole days elapsed since this day; 0 = today, so d1/d2 are unknowable
  sch: number;    // runs started by the scheduler
  usr: number;    // runs a user asked for
  ok: number;     // runs that finished clean
  runs: number;   // runs that finished at all (a still-running row has no outcome yet)
}

export interface AdminTotals {
  users: number;
  nonAdminUsers: number;
  adminUsers: number;
  ownKeys: number;
  activated: number;
  runs: number;
  nonAdminRuns: number;
  adminRuns: number;
}

export interface AdminDaily {
  timezone: string;
  from: string;
  to: string;
  days: StatsDay[];
  headline: { hit: number; den: number; pct: number }[];   // index 0/1/2 = day 0/1/2
  bySource: [string, number][];
  byHour: number[];                                        // 24 entries, admin-local hour
  topFailers: TopFailer[];
}

/** One column of the DAU/WAU chart. `partial` marks the current week, which the clock cut short —
 *  it under-counts by construction and must never be read as a drop. Days are never partial. */
export interface ActiveBucket {
  k: string;          // day: YYYY-MM-DD. week: the Monday of that ISO week.
  n: number;          // distinct profiles active in the bucket
  first: number;      // first recorded active day/week
  returning: number;  // 2-6 cumulative distinct active days through this bucket
  loyal: number;      // 7+ cumulative distinct active days through this bucket
  partial: boolean;
}

export interface ActiveDaysWeekBucket {
  k: string;          // Monday of the ISO week.
  n: number;          // distinct profiles active that week
  once: number;
  twoThree: number;
  fourFive: number;
  sixSeven: number;
  avg: number;        // mean active days per active profile in this 7-day bucket
  partial: boolean;
}

export interface AdminActive {
  days: ActiveBucket[];
  weeks: ActiveBucket[];
  daysPerWeek: ActiveDaysWeekBucket[];
  since: string | null;   // first day ever recorded, or null if nothing is
  dayFrom: string;        // start of the day window BEFORE trimming, so the card can tell
                          // "nobody was here" from "we were not recording yet"
}

export interface TopFailer {
  id: number;
  email: string;
  lastActiveAt: string | null;
  hasActivityEvidence: number;
  failed: number;      // this profile's runs that finished without success
  finished: number;    // this profile's runs that reached an outcome
  share: number;       // % of every failed run in the window
  ownRate: number;     // % of this profile's own runs that succeeded
}

/** `profiles.created_at` holds two formats: ISO-Z from app code, and the SQLite
 *  `datetime('now')` default (`2026-05-09 15:33:47`), which is UTC but reads as LOCAL to
 *  `new Date()`. Normalise both to UTC before any bucketing. */
function parseStamp(s: string): Date {
  const t = s.trim();
  if (/[Zz]$|[+-]\d{2}:?\d{2}$/.test(t)) return new Date(t);
  return new Date(t.replace(' ', 'T') + 'Z');
}

interface RunGroup { d: string; trigger: string; job_source: string | null; status: string; c: number; h?: number }

/** Minutes a timezone runs ahead of UTC on a given day. */
function offsetMinutes(tz: string, day: string): number {
  const at = new Date(day + 'T12:00:00Z');
  const asLocal = new Date(at.toLocaleString('en-US', { timeZone: tz }));
  const asUtc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
  return Math.round((asLocal.getTime() - asUtc.getTime()) / 60000);
}

/** The window's constant UTC offset, or null if a DST transition falls inside it — in which
 *  case a single SQL shift would put some rows on the wrong day and we bucket in JS instead. */
function shiftMinutes(tz: string, from: string, to: string): number | null {
  const a = offsetMinutes(tz, from);
  return a === offsetMinutes(tz, to) ? a : null;
}

/** The admin's timezone, resolved the way atsScheduler already resolves "the admin". */
function adminTimezone(): string {
  const row = getDb().prepare(`
    SELECT s.timezone FROM profiles p
    LEFT JOIN settings s ON s.profile_id = p.id
    WHERE p.is_admin = 1 ORDER BY p.id LIMIT 1
  `).get() as { timezone: string | null } | undefined;
  return row?.timezone || 'UTC';
}

export function todayInAdminTz(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: adminTimezone() });
}

/** Clamp a requested window to at most MAX_WINDOW_DAYS, ending no later than today. */
export function clampWindow(fromIn: string, toIn: string): { from: string; to: string } {
  const today = todayInAdminTz();
  const ok = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let to = ok(toIn) && toIn <= today ? toIn : today;
  let from = ok(fromIn) ? fromIn : to;
  if (from > to) from = to;
  const span = (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / DAY_MS + 1;
  if (span > MAX_WINDOW_DAYS) {
    from = new Date(Date.parse(to + 'T00:00:00Z') - (MAX_WINDOW_DAYS - 1) * DAY_MS)
      .toISOString().slice(0, 10);
  }
  return { from, to };
}

/** Window ending today, n days long (n=7 → last week). */
export function presetWindow(n: number): { from: string; to: string } {
  const to = todayInAdminTz();
  const from = new Date(Date.parse(to + 'T00:00:00Z') - (n - 1) * DAY_MS).toISOString().slice(0, 10);
  return clampWindow(from, to);
}

// ── Totals: all-time, no date filter, nothing on this page changes them ────────
export function getAdminTotals(): AdminTotals {
  const db = getDb();
  const one = (sql: string) => (db.prepare(sql).get() as { c: number }).c;

  return {
    users: one(`SELECT COUNT(*) AS c FROM profiles`),
    nonAdminUsers: one(`SELECT COUNT(*) AS c FROM profiles WHERE is_admin = 0`),
    adminUsers: one(`SELECT COUNT(*) AS c FROM profiles WHERE is_admin = 1`),
    ownKeys: one(`
      SELECT COUNT(*) AS c FROM settings s JOIN profiles p ON p.id = s.profile_id
      WHERE TRIM(COALESCE(s.user_openai_api_key, '')) != ''
        AND TRIM(COALESCE(s.user_apify_api_token, '')) != ''`),
    activated: one(`
      SELECT COUNT(DISTINCT r.profile_id) AS c FROM search_runs r
      JOIN profiles p ON p.id = r.profile_id
      WHERE r.trigger != 'cv'`),
    runs: one(`
      SELECT COUNT(*) AS c FROM search_runs r JOIN profiles p ON p.id = r.profile_id
      WHERE r.trigger != 'cv'`),
    nonAdminRuns: one(`
      SELECT COUNT(*) AS c FROM search_runs r JOIN profiles p ON p.id = r.profile_id
      WHERE p.is_admin = 0 AND r.trigger != 'cv'`),
    adminRuns: one(`
      SELECT COUNT(*) AS c FROM search_runs r JOIN profiles p ON p.id = r.profile_id
      WHERE p.is_admin = 1 AND r.trigger != 'cv'`),
  };
}

// ── Daily: one row per day across a window of at most 30 days ──────────────────
export function getAdminDaily(fromIn: string, toIn: string): AdminDaily {
  const db = getDb();
  const timezone = adminTimezone();
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });
  const { from, to } = clampWindow(fromIn, toIn);

  const days: string[] = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY_MS) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  const today = todayInAdminTz();
  const elapsed = (d: string) =>
    Math.round((Date.parse(today + 'T00:00:00Z') - Date.parse(d + 'T00:00:00Z')) / DAY_MS);

  // Users. Full scan of a small table, bucketed in JS. Deliberate: the dual created_at format
  // makes an indexed string range scan unsafe (a space sorts before 'T', so same-day rows in the
  // older format fall out of a `created_at >= ?` window). See migration v_admin_stats_index.
  const profiles = db.prepare(`SELECT id, created_at FROM profiles WHERE is_admin = 0`)
    .all() as { id: number; created_at: string }[];
  const regDay = new Map<number, string>();
  for (const p of profiles) regDay.set(p.id, dayKey(parseStamp(p.created_at)));
  const inWindow = profiles.filter((p) => {
    const k = regDay.get(p.id)!;
    return k >= from && k <= to;
  });
  const windowIds = new Set(inWindow.map((p) => p.id));

  // Cohort: runs in the first three days after registration. Bounded by the join, not by a
  // per-user subquery; the SQL window is generous and the exact day-0/1/2 test happens in JS,
  // where the admin-timezone day boundary is known.
  const cohortRuns = db.prepare(`
    SELECT r.profile_id AS id, r.ran_at FROM search_runs r
    JOIN profiles p ON p.id = r.profile_id
    WHERE p.is_admin = 0
      AND r.trigger != 'cv'
      AND date(r.ran_at) >= date(?, '-1 day')
      AND date(r.ran_at) <= date(?, '+4 days')
      AND date(r.ran_at) <= date(p.created_at, '+4 days')
  `).all(from, to) as { id: number; ran_at: string }[];

  const hit = new Map<number, Set<number>>();
  for (const row of cohortRuns) {
    if (!windowIds.has(row.id)) continue;
    const offset = Math.round(
      (Date.parse(dayKey(parseStamp(row.ran_at)) + 'T00:00:00Z')
        - Date.parse(regDay.get(row.id)! + 'T00:00:00Z')) / DAY_MS,
    );
    if (offset < 0 || offset > 2) continue;
    if (!hit.has(row.id)) hit.set(row.id, new Set());
    hit.get(row.id)!.add(offset);
  }

  // Runs in the window, aggregated IN SQL rather than fetched row by row. The day bucket is the
  // admin-local date, expressed as a fixed minute shift off UTC — so the grouping is exact and
  // the result set is bounded by (days × triggers × statuses × sources), never by run volume.
  // Fetching raw rows instead cost ~870 ms at 30 k runs, which is 870 ms of blocked event loop.
  //
  // The shift is only valid while the offset is constant across the window; if a DST transition
  // falls inside it, `shiftMinutes` returns null and we fall back to bucketing in JS.
  const shift = shiftMinutes(timezone, from, to);
  const runs = shift !== null
    ? db.prepare(`
        SELECT date(datetime(r.ran_at, ?)) AS d, r.trigger, r.job_source, r.status, COUNT(*) AS c
        FROM search_runs r JOIN profiles p ON p.id = r.profile_id
        WHERE p.is_admin = 0 AND r.trigger != 'cv'
          AND date(r.ran_at) >= date(?, '-1 day')
          AND date(r.ran_at) <= date(?, '+1 day')
        GROUP BY 1, 2, 3, 4
      `).all(`${shift >= 0 ? '+' : '-'}${Math.abs(shift)} minutes`, from, to) as RunGroup[]
    : db.prepare(`
        SELECT r.ran_at AS d, r.trigger, r.job_source, r.status, 1 AS c
        FROM search_runs r JOIN profiles p ON p.id = r.profile_id
        WHERE p.is_admin = 0 AND r.trigger != 'cv'
          AND date(r.ran_at) >= date(?, '-1 day')
          AND date(r.ran_at) <= date(?, '+1 day')
      `).all(from, to).map((r) => {
        const row = r as RunGroup;
        const at = parseStamp(row.d);
        return {
          ...row,
          d: dayKey(at),
          h: Number(at.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false })),
        };
      }) as RunGroup[];

  // Start-time distribution. Grouped by hour ONLY, so the result is at most 24 rows however
  // many runs are in the window — the cost is one more scan of rows already being read, not
  // anything that grows with volume. Same admin-local shift as the day buckets.
  const byHour = new Array<number>(24).fill(0);
  if (shift !== null) {
    const rows = db.prepare(`
      SELECT CAST(strftime('%H', datetime(r.ran_at, ?)) AS INTEGER) AS h, COUNT(*) AS c
      FROM search_runs r JOIN profiles p ON p.id = r.profile_id
      WHERE p.is_admin = 0 AND r.trigger != 'cv'
        AND date(r.ran_at) >= date(?, '-1 day')
        AND date(r.ran_at) <= date(?, '+1 day')
      GROUP BY 1
    `).all(`${shift >= 0 ? '+' : '-'}${Math.abs(shift)} minutes`, from, to) as { h: number; c: number }[];
    for (const r of rows) if (r.h >= 0 && r.h < 24) byHour[r.h] += r.c;
  } else {
    // DST fallback: the hour came through on each row instead.
    for (const r of runs) if (r.h !== undefined && r.h >= 0 && r.h < 24) byHour[r.h] += r.c;
  }

  const byDay = new Map<string, StatsDay>();
  for (const d of days) {
    byDay.set(d, { d, nu: 0, d0: 0, d1: 0, d2: 0, any: 0, mature: elapsed(d), sch: 0, usr: 0, ok: 0, runs: 0 });
  }

  for (const p of inWindow) {
    const row = byDay.get(regDay.get(p.id)!);
    if (!row) continue;
    row.nu++;
    const h = hit.get(p.id);
    if (!h) continue;
    if (h.has(0)) row.d0++;
    if (h.has(1)) row.d1++;
    if (h.has(2)) row.d2++;
    if (h.size > 0) row.any++;
  }

  const src = new Map<string, number>();
  for (const r of runs) {
    const row = byDay.get(r.d);
    if (!row) continue;   // fell outside the window once shifted into admin time
    if (r.trigger === 'scheduled') row.sch += r.c;
    else row.usr += r.c;
    // A run still in flight has no outcome yet, so it belongs in neither side of the rate.
    if (r.status !== 'running') {
      row.runs += r.c;
      if (r.status === 'success') row.ok += r.c;
    }
    const key = r.job_source || 'Unknown';
    src.set(key, (src.get(key) ?? 0) + r.c);
  }

  // Who the failed runs belonged to. One grouped scan capped at three rows, so the cost is
  // bounded by profile count rather than run volume.
  //
  // "Failed" here means finished-but-not-success, which is the same definition the success-rate
  // chart above uses — the two must agree, since they sit in one card. That does sweep in
  // `stopped`, which is usually a user pressing Stop or a credits halt rather than a fault.
  //
  // MIN_RUNS keeps the list off single-run trivia: without it one profile with one failed run
  // tops a quiet range. The header states the floor, so the reader knows who is eligible.
  const MIN_RUNS = 5;
  const windowClause = shift !== null
    ? `date(datetime(r.ran_at, ?)) BETWEEN ? AND ?`
    : `date(r.ran_at) >= date(?, '-1 day') AND date(r.ran_at) <= date(?, '+1 day')`;
  const windowArgs = shift !== null
    ? [`${shift >= 0 ? '+' : '-'}${Math.abs(shift)} minutes`, from, to]
    : [from, to];

  const failerRows = db.prepare(`
    SELECT r.profile_id AS id, p.email AS email,
           MAX(p.last_active_at) AS lastActiveAt,
           MAX(CASE WHEN p.active_day_last IS NOT NULL OR EXISTS (
             SELECT 1 FROM sessions sess WHERE sess.profile_id = p.id LIMIT 1
           ) THEN 1 ELSE 0 END) AS hasActivityEvidence,
           SUM(CASE WHEN r.status != 'success' THEN 1 ELSE 0 END) AS failed,
           COUNT(*) AS finished
    FROM search_runs r
    JOIN profiles p ON p.id = r.profile_id
    WHERE p.is_admin = 0 AND r.trigger != 'cv' AND r.status != 'running'
      AND ${windowClause}
    GROUP BY 1, 2
    HAVING failed > 0 AND finished >= ${MIN_RUNS}
    ORDER BY failed DESC, finished DESC
    LIMIT 3
  `).all(...windowArgs) as { id: number; email: string; lastActiveAt: string | null; hasActivityEvidence: number; failed: number; finished: number }[];

  // The share denominator is every failure in the window, including profiles under the floor —
  // so three rows showing 41/23/14 correctly means the rest is spread elsewhere.
  let allFailed = 0;
  for (const row of byDay.values()) allFailed += row.runs - row.ok;

  const topFailers: TopFailer[] = failerRows.map((r) => ({
    id: r.id,
    email: r.email,
    lastActiveAt: r.lastActiveAt,
    hasActivityEvidence: r.hasActivityEvidence,
    failed: r.failed,
    finished: r.finished,
    share: allFailed > 0 ? Math.round((r.failed / allFailed) * 100) : 0,
    ownRate: r.finished > 0 ? ((r.finished - r.failed) / r.finished) * 100 : 0,
  }));

  // Headline D0/D1/D2 — a cohort leaves the denominator until its window closes.
  const headline = [0, 1, 2].map((k) => {
    let den = 0;
    let h = 0;
    for (const row of byDay.values()) {
      if (row.mature < k) continue;
      den += row.nu;
      h += k === 0 ? row.d0 : k === 1 ? row.d1 : row.d2;
    }
    return { hit: h, den, pct: den > 0 ? Math.round((h / den) * 100) : 0 };
  });

  return {
    timezone,
    from,
    to,
    days: days.map((d) => byDay.get(d)!),
    headline,
    bySource: [...src.entries()].sort((a, b) => b[1] - a[1]),
    byHour,
    topFailers,
  };
}

// ── DAU / WAU: distinct profiles with logged-in activity ──────────────────────
/** Day mode shows this many days back, ending today. */
export const DAU_DAYS = 14;
/** Week mode shows this many Mon-Sun weeks, ending with the current, partial one. */
export const WAU_WEEKS = 12;

/**
 * Unlike every other figure on this page this one reads `profile_active_days` rather than
 * `search_runs`, and it breaks BOTH of the page's other rules on purpose:
 *
 *  1. **Admins are counted, like anyone else.** Everywhere else `is_admin = 1` is excluded
 *     because admin *runs* are test runs and crons. Presence is not a run — the operator opening
 *     their own product is a person being there, which is what this chart measures. So there is
 *     no join to `profiles` at all, and the queries stay entirely inside `idx_pad_day`.
 *  2. **It owns its window and ignores the Daily range.** That is why the card sits ABOVE the
 *     range bar. Weekly needs a quarter to say anything, and MAX_WINDOW_DAYS caps the Daily half
 *     at 30 — a cap that guards queries bounded by RUN VOLUME. This one is bounded by
 *     (profiles x days) and reads ~84 rows per profile at most, so the cap does not apply to it.
 *
 * Two more things a reader can get wrong, both stated on the card:
 *  - **Days bucket in the PROFILE's timezone**, written by `touchProfileActivity` from the day the
 *    user was living in. Every other card buckets admin-local, which is the other reason this one
 *    is not filed under "Daily".
 *  - **Uniques do not add up.** WAU is not the sum of its DAU — one person on five days is five
 *    DAU and one WAU — so the two series are counted separately and neither derives from the other.
 *
 * There is no backfill (see the migration), so `since` is returned for the card to state and empty
 * leading buckets are trimmed rather than drawn as a run of zeroes that reads like a collapse.
 */
export function getAdminActive(): AdminActive {
  const db = getDb();
  const today = todayInAdminTz();
  const todayT = Date.parse(today + 'T00:00:00Z');

  const dayFrom = iso(todayT - (DAU_DAYS - 1) * DAY_MS);
  // Anchored on Mondays, so the window always starts on a week boundary and a truncated FIRST
  // week cannot occur. The last week is the current one and is short by construction.
  const weekFrom = iso(mondayOf(today) - (WAU_WEEKS - 1) * 7 * DAY_MS);

  const rows = db.prepare(`
    SELECT profile_id, day FROM profile_active_days
    WHERE day <= ? ORDER BY profile_id, day
  `).all(today) as { profile_id: number; day: string }[];

  const since = rows.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
  const byProfile = new Map<number, string[]>();
  for (const r of rows) {
    let list = byProfile.get(r.profile_id);
    if (!list) {
      list = [];
      byProfile.set(r.profile_id, list);
    }
    list.push(r.day);
  }

  // Every day in the window gets a column whether or not anyone was there: a gap mid-series is
  // the finding, and dropping it would silently close the distance between the days either side.
  const days: ActiveBucket[] = [];
  for (let t = Date.parse(dayFrom + 'T00:00:00Z'); t <= todayT; t += DAY_MS) {
    const k = iso(t);
    days.push({ k, n: 0, first: 0, returning: 0, loyal: 0, partial: false });
  }
  const byDay = new Map(days.map((d) => [d.k, d]));

  const weeks: ActiveBucket[] = [];
  const daysPerWeek: ActiveDaysWeekBucket[] = [];
  for (let t = Date.parse(weekFrom + 'T00:00:00Z'); t <= todayT; t += 7 * DAY_MS) {
    const k = iso(t);
    const partial = iso(t + 6 * DAY_MS) > today;
    weeks.push({ k, n: 0, first: 0, returning: 0, loyal: 0, partial });
    daysPerWeek.push({ k, n: 0, once: 0, twoThree: 0, fourFive: 0, sixSeven: 0, avg: 0, partial });
  }
  const byWeek = new Map(weeks.map((w) => [w.k, w]));
  const byFreqWeek = new Map(daysPerWeek.map((w) => [w.k, { row: w, activeDays: 0 }]));

  for (const activeDays of byProfile.values()) {
    const firstDay = activeDays[0];
    const firstWeek = iso(mondayOf(firstDay));
    const weeklyCounts = new Map<string, number>();

    activeDays.forEach((day, index) => {
      const cumulative = index + 1;
      const dayBucket = byDay.get(day);
      if (dayBucket) {
        dayBucket.n++;
        if (day === firstDay) dayBucket.first++;
        else if (cumulative >= 7) dayBucket.loyal++;
        else dayBucket.returning++;
      }

      const wk = iso(mondayOf(day));
      if (byWeek.has(wk)) weeklyCounts.set(wk, (weeklyCounts.get(wk) ?? 0) + 1);
    });

    for (const [wk, activeInWeek] of weeklyCounts) {
      const weekBucket = byWeek.get(wk);
      const freqBucket = byFreqWeek.get(wk);
      if (!weekBucket || !freqBucket) continue;

      const weekEnd = Math.min(Date.parse(wk + 'T00:00:00Z') + 6 * DAY_MS, todayT);
      const cumulativeThroughWeek = countThrough(activeDays, iso(weekEnd));
      weekBucket.n++;
      if (wk === firstWeek) weekBucket.first++;
      else if (cumulativeThroughWeek >= 7) weekBucket.loyal++;
      else weekBucket.returning++;

      freqBucket.row.n++;
      freqBucket.activeDays += activeInWeek;
      if (activeInWeek === 1) freqBucket.row.once++;
      else if (activeInWeek <= 3) freqBucket.row.twoThree++;
      else if (activeInWeek <= 5) freqBucket.row.fourFive++;
      else freqBucket.row.sixSeven++;
    }
  }

  for (const bucket of byFreqWeek.values()) {
    bucket.row.avg = bucket.row.n > 0 ? bucket.activeDays / bucket.row.n : 0;
  }

  return {
    days: trimEdges(days),
    weeks: trimEdges(weeks),
    daysPerWeek: trimEdges(daysPerWeek),
    since,
    dayFrom,
  };
}

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The Monday of the ISO week containing `day`, as epoch ms. */
function mondayOf(day: string): number {
  const t = Date.parse(day + 'T00:00:00Z');
  return t - ((new Date(t).getUTCDay() + 6) % 7) * DAY_MS;
}

function countThrough(days: string[], through: string): number {
  let n = 0;
  for (const d of days) {
    if (d > through) break;
    n++;
  }
  return n;
}

/** Drop empty buckets at BOTH ends, keep every one between. Leading zeroes are almost always
 *  "before tracking started" and trailing ones "nothing yet today" — neither is a measurement.
 *  A zero with data on both sides is one, and keeps its place on the axis. */
function trimEdges<T extends { n: number }>(b: T[]): T[] {
  let lo = 0;
  let hi = b.length - 1;
  while (lo <= hi && b[lo].n === 0) lo++;
  while (hi >= lo && b[hi].n === 0) hi--;
  return b.slice(lo, hi + 1);
}
