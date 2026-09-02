/**
 * Admin Stats — the operator's view of the user base.
 *
 * The page has two halves that never share a filter:
 *   • TOTALS  — all-time, unfiltered. Users, own API keys, activated, runs.
 *   • DAILY   — one row per day over a window of at most 30 days.
 *
 * Three rules govern every figure:
 *
 *  1. Admin accounts are excluded (`profiles.is_admin = 0`). Admin runs are test runs, CV
 *     re-scores and the pool crons — on a base this size they would be the whole chart.
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
  ownKeys: number;
  activated: number;
  runs: number;
}

export interface AdminDaily {
  timezone: string;
  from: string;
  to: string;
  days: StatsDay[];
  headline: { hit: number; den: number; pct: number }[];   // index 0/1/2 = day 0/1/2
  bySource: [string, number][];
  byHour: number[];                                        // 24 entries, admin-local hour
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
    users: one(`SELECT COUNT(*) AS c FROM profiles WHERE is_admin = 0`),
    ownKeys: one(`
      SELECT COUNT(*) AS c FROM settings s JOIN profiles p ON p.id = s.profile_id
      WHERE p.is_admin = 0
        AND TRIM(COALESCE(s.user_openai_api_key, '')) != ''
        AND TRIM(COALESCE(s.user_apify_api_token, '')) != ''`),
    activated: one(`
      SELECT COUNT(DISTINCT r.profile_id) AS c FROM search_runs r
      JOIN profiles p ON p.id = r.profile_id
      WHERE p.is_admin = 0 AND r.trigger != 'cv'`),
    runs: one(`
      SELECT COUNT(*) AS c FROM search_runs r JOIN profiles p ON p.id = r.profile_id
      WHERE p.is_admin = 0 AND r.trigger != 'cv'`),
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
  };
}
