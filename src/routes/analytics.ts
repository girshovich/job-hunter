/**
 * Analytics Route — per-group stats, per-country breakdown, weekly trend.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SearchGroupRow } from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  // Overall totals
  const totals = db.prepare<{ total: number; strong: number; applied: number }>(`
    SELECT
      COUNT(CASE WHEN jps.is_duplicate = 0 THEN 1 END) as total,
      SUM(CASE WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
      SUM(CASE WHEN jps.applied = 1 AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as applied
    FROM job_profile_states jps WHERE jps.profile_id = ?
  `).get(profileId) as { total: number; strong: number; applied: number };

  // Status breakdown (all verdicts as counts)
  interface StatusRow { status: string; count: number }
  const statusBreakdown = db.prepare<StatusRow>(`
    SELECT
      CASE WHEN jps.is_duplicate = 1 THEN 'DUPLICATE'
           ELSE COALESCE(jps.ai_verdict, 'UNKNOWN') END as status,
      COUNT(*) as count
    FROM job_profile_states jps WHERE jps.profile_id = ?
    GROUP BY status
    ORDER BY count DESC
  `).all(profileId) as StatusRow[];

  // Per-group stats (for this profile only)
  const groups = db.prepare<SearchGroupRow>('SELECT id, group_name FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as Pick<SearchGroupRow, 'id' | 'group_name'>[];

  interface GroupStat {
    group_id: number | null;
    total: number;
    strong: number;
    applied: number;
  }
  const groupRows = db.prepare<GroupStat>(`
    SELECT
      jps.group_id,
      COUNT(CASE WHEN jps.is_duplicate = 0 THEN 1 END) as total,
      SUM(CASE WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as strong,
      SUM(CASE WHEN jps.applied = 1 AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0 THEN 1 ELSE 0 END) as applied
    FROM job_profile_states jps WHERE jps.profile_id = ?
    GROUP BY jps.group_id
  `).all(profileId) as GroupStat[];

  const groupStatMap = new Map<number | null, GroupStat>();
  for (const row of groupRows) groupStatMap.set(row.group_id, row);

  const groupStats = groups.map((g) => {
    const s = groupStatMap.get(g.id) ?? { total: 0, strong: 0, applied: 0 };
    return { id: g.id, name: g.group_name || `Role ${g.id}`, ...s };
  });

  // Per-country stats (strong matches only, non-duplicate) — single primary jobs.country (multi-country.md §15)
  interface JobLocationRow { country: string | null; applied: number }
  const allStrongJobs = db.prepare<JobLocationRow>(`
    SELECT j.country, jps.applied FROM jobs j
    JOIN job_profile_states jps ON jps.job_id = j.id
    WHERE jps.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
  `).all(profileId) as JobLocationRow[];

  const countryMap = new Map<string, { strong: number; applied: number }>();
  for (const job of allStrongJobs) {
    const country = job.country && job.country.trim() ? job.country.trim() : 'Unknown';
    if (!countryMap.has(country)) countryMap.set(country, { strong: 0, applied: 0 });
    const entry = countryMap.get(country)!;
    entry.strong++;
    if (job.applied) entry.applied++;
  }
  const countryStats = Array.from(countryMap.entries())
    .map(([country, s]) => ({ country, ...s }))
    .sort((a, b) => b.strong - a.strong);

  // Daily trend — last 14 days, verdict breakdown per group (filtered client-side)
  interface DayVerdictRow { day: string; group_id: number | null; verdict: string; count: number }
  const dailyGroupRaw = db.prepare<DayVerdictRow>(`
    SELECT
      strftime('%Y-%m-%d', jps.fetched_at) as day,
      jps.group_id,
      CASE WHEN jps.is_duplicate = 1 THEN 'DUPLICATE' ELSE jps.ai_verdict END as verdict,
      COUNT(*) as count
    FROM job_profile_states jps
    WHERE jps.profile_id = ? AND date(jps.fetched_at) >= date('now', '-13 days')
    GROUP BY day, jps.group_id, verdict
    ORDER BY day
  `).all(profileId) as DayVerdictRow[];

  // Monthly trend — last 12 months, verdict breakdown per group (filtered client-side)
  interface MonthVerdictRow { month: string; group_id: number | null; verdict: string; count: number }
  const monthlyRaw = db.prepare<MonthVerdictRow>(`
    SELECT
      strftime('%Y-%m', jps.fetched_at) as month,
      jps.group_id,
      CASE WHEN jps.is_duplicate = 1 THEN 'DUPLICATE' ELSE jps.ai_verdict END as verdict,
      COUNT(*) as count
    FROM job_profile_states jps
    WHERE jps.profile_id = ? AND strftime('%Y-%m', jps.fetched_at) >= strftime('%Y-%m', 'now', '-11 months')
    GROUP BY month, jps.group_id, verdict
    ORDER BY month
  `).all(profileId) as MonthVerdictRow[];

  // Strong match quality — last 14 days (daily)
  interface StrongQualityRow { day: string; category: string; count: number }
  const strongQualityRaw = db.prepare<StrongQualityRow>(`
    SELECT
      strftime('%Y-%m-%d', jps.fetched_at) as day,
      CASE
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND (jps.original_ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict IS NULL) THEN 'kept'
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.original_ai_verdict != 'STRONG_MATCH' THEN 'promoted'
        WHEN jps.ai_verdict != 'STRONG_MATCH' AND jps.original_ai_verdict = 'STRONG_MATCH' THEN 'demoted'
        ELSE NULL
      END as category,
      COUNT(*) as count
    FROM job_profile_states jps
    WHERE jps.profile_id = ?
      AND jps.is_duplicate = 0
      AND (jps.ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict = 'STRONG_MATCH')
      AND date(jps.fetched_at) >= date('now', '-13 days')
    GROUP BY day, category
    HAVING category IS NOT NULL
    ORDER BY day
  `).all(profileId) as StrongQualityRow[];

  // Strong match quality — last 12 months (monthly)
  interface StrongQualityMonthRow { month: string; category: string; count: number }
  const strongQualityMonthlyRaw = db.prepare<StrongQualityMonthRow>(`
    SELECT
      strftime('%Y-%m', jps.fetched_at) as month,
      CASE
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND (jps.original_ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict IS NULL) THEN 'kept'
        WHEN jps.ai_verdict = 'STRONG_MATCH' AND jps.original_ai_verdict != 'STRONG_MATCH' THEN 'promoted'
        WHEN jps.ai_verdict != 'STRONG_MATCH' AND jps.original_ai_verdict = 'STRONG_MATCH' THEN 'demoted'
        ELSE NULL
      END as category,
      COUNT(*) as count
    FROM job_profile_states jps
    WHERE jps.profile_id = ?
      AND jps.is_duplicate = 0
      AND (jps.ai_verdict = 'STRONG_MATCH' OR jps.original_ai_verdict = 'STRONG_MATCH')
      AND strftime('%Y-%m', jps.fetched_at) >= strftime('%Y-%m', 'now', '-11 months')
    GROUP BY month, category
    HAVING category IS NOT NULL
    ORDER BY month
  `).all(profileId) as StrongQualityMonthRow[];

  // Daily costs — last 14 days. Bucketed in the profile's timezone (not UTC) so a
  // run lands on the same calendar day here as it does in Run Logs (reports.ts:25).
  const tzRow = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?')
    .get(profileId) as { timezone: string } | undefined;
  const timezone = tzRow?.timezone || 'UTC';
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });

  // Civil-date arithmetic in UTC so a DST transition can't duplicate or skip a day.
  const [ty, tm, td] = dayKey(new Date()).split('-').map(Number);
  const todayUtc = Date.UTC(ty, tm - 1, td);
  const costDays: string[] = [];
  for (let i = 13; i >= 0; i--) costDays.push(new Date(todayUtc - i * 86400000).toISOString().slice(0, 10));

  // -15 days of UTC rows so timezone shifting can't drop a run at either edge.
  interface RunCostRow { ran_at: string; cost_apify_usd: number | null; cost_openai_usd: number | null }
  const runCosts = db.prepare<RunCostRow>(`
    SELECT ran_at, cost_apify_usd, cost_openai_usd
    FROM search_runs
    WHERE profile_id = ? AND date(ran_at) >= date('now', '-15 days')
  `).all(profileId) as RunCostRow[];

  const costMap = new Map<string, { fetch: number; ai: number }>();
  for (const run of runCosts) {
    const key = dayKey(new Date(run.ran_at));
    if (!costMap.has(key)) costMap.set(key, { fetch: 0, ai: 0 });
    const entry = costMap.get(key)!;
    entry.fetch += run.cost_apify_usd ?? 0;
    entry.ai += run.cost_openai_usd ?? 0;
  }

  // Long shape ({day, category, count}) so the chart renderer is shared with the quality charts.
  const dailyCostRaw: { day: string; category: string; count: number }[] = [];
  for (const day of costDays) {
    const entry = costMap.get(day);
    if (!entry) continue;
    if (entry.fetch > 0) dailyCostRaw.push({ day, category: 'fetch', count: entry.fetch });
    if (entry.ai > 0) dailyCostRaw.push({ day, category: 'ai', count: entry.ai });
  }

  res.render('analytics', {
    totals,
    statusBreakdown,
    groupStats,
    countryStats,
    strongQualityRaw,
    strongQualityMonthlyRaw,
    dailyCostRaw,
    costDays,
    groups,
    title: 'Stats',
  });
});

export { router as analyticsRouter };
