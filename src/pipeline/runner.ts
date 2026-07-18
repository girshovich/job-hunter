/**
 * Pipeline Runner — Orchestrates the full daily job-hunting pipeline.
 * Sequence: for each group → fetch → blacklist filter → provider dedup → AI score
 *           → semantic dedup → store. Then: send email → update run log.
 * All evaluated jobs (blacklisted + scored) are logged to run_job_logs per run.
 */

import { randomUUID } from 'node:crypto';
import { getDb, type SettingsRow, type SearchGroupRow, type BlacklistedCompanyRow } from '../db';
import { invalidateJobsDatesCache } from '../routes/jobs';
import { config } from '../config';
import { fetchJobs, type JobPosting, type DateRange } from './fetcher';
import { providerToSource, parseJobTypes } from './types';
import { filterNewJobs, filterDuplicatesByUrl } from './deduplicator';
import { scoreJobs, dedupAndSummarise, preFilterDuplicateCandidates, buildScoringSystemPrompt, type ScoredJob, type ExistingJob } from './aiScorer';
import { resolveLocationString, lookupCountry, expandRegionToCountries } from './locationNormalizer';
import { groupOrDrop } from './locationGrouping';
import pLimit from 'p-limit';
import { sendDailyReport, sendLowCreditsEmail, sendRateLimitAlert, type RunStats } from './emailReport';
import { fetchClearbitLogosForAts } from './companyLogos';
import { enqueue } from './runQueue';

const lastRateLimitAlert = new Map<string, number>(); // recipient email → last alert timestamp
const RATE_LIMIT_ALERT_COOLDOWN_MS = 30 * 60_000;

// Price per 1M tokens in USD — sorted longest key first so prefix matching is unambiguous
// cachedInput: prompt-cache read price (billed instead of input for cached tokens)
const OPENAI_PRICING: Record<string, { input: number; cachedInput: number; output: number }> = {
  'gpt-5.4-mini':  { input: 0.75,  cachedInput: 0.075, output: 4.50  },
  'gpt-5.4-nano':  { input: 0.20,  cachedInput: 0.02,  output: 1.25  },
  'gpt-5.4':       { input: 2.50,  cachedInput: 0.25,  output: 15.00 },
  'gpt-5-mini':    { input: 0.25,  cachedInput: 0.025, output: 2.00  },
  'gpt-4o-mini':   { input: 0.15,  cachedInput: 0.075, output: 0.60  },
  'gpt-4o':        { input: 2.50,  cachedInput: 1.25,  output: 10.00 },
  'gpt-4-turbo':   { input: 10.00, cachedInput: 10.00, output: 30.00 },
  'gpt-4':         { input: 30.00, cachedInput: 30.00, output: 60.00 },
  'o1-mini':       { input: 3.00,  cachedInput: 1.50,  output: 12.00 },
  'o1':            { input: 15.00, cachedInput: 7.50,  output: 60.00 },
  'o3-mini':       { input: 1.10,  cachedInput: 0.55,  output: 4.40  },
  'gpt-3.5-turbo': { input: 0.50,  cachedInput: 0.25,  output: 1.50  },
};

function calcOpenAiCost(model: string, inputTokens: number, cachedInputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(OPENAI_PRICING)
    .sort((a, b) => b.length - a.length)
    .find((k) => model.startsWith(k));
  if (!key) return null;
  const p = OPENAI_PRICING[key];
  const billableInputTokens = inputTokens - cachedInputTokens;
  return (
    (billableInputTokens / 1_000_000) * p.input +
    (cachedInputTokens  / 1_000_000) * p.cachedInput +
    (outputTokens       / 1_000_000) * p.output
  );
}

// Strip common legal entity suffixes so "Every. GmbH" and "Every." share the same key.
function normalizeCompany(name: string): string {
  return name
    .replace(/[\s,]+(GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|SE|KG|Inc\.?|Ltd\.?|LLC|LLP|Corp\.?|S\.A\.|BV|NV|Srl|SpA|SA|Plc\.?|AB|ApS|AS|OÜ|Oy|SAS|SRL|Pte\.?)\s*$/i, '')
    .trim()
    .toLowerCase();
}

function matchesTitleFilter(title: string, filter: string): boolean {
  const titleWords = new Set(title.toLowerCase().split(/\W+/).filter(Boolean));
  return filter
    .split(',')
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean)
    .some((line) => line.split(/\W+/).filter(Boolean).every((w) => titleWords.has(w)));
}

const isRunningMap = new Map<number, boolean>();
const lastRunResultMap = new Map<number, PipelineResult | null>();
const stopRequestedSet = new Set<number>();

/** Thrown at a checkpoint when the user asked to stop the run. Not a failure. */
export class RunStoppedError extends Error {
  constructor() { super('Run stopped by user'); this.name = 'RunStoppedError'; }
}

/** Returns false if there is no run to stop. */
export function requestStop(profileId: number): boolean {
  if (!isRunningMap.get(profileId)) return false;
  stopRequestedSet.add(profileId);
  return true;
}

export function isStopRequested(profileId: number): boolean {
  return stopRequestedSet.has(profileId);
}

/**
 * Cooperative cancellation: called at seams where no work is pending persistence, so a stop
 * never discards jobs we already paid to score. In-flight API calls are not aborted.
 */
function throwIfStopped(profileId: number): void {
  if (stopRequestedSet.has(profileId)) throw new RunStoppedError();
}

interface StageInfo {
  text: string; pct: number; totalSections: number;
  providerIdx?: number; providerCount?: number; providerName?: string;
  roleIdx?: number; roleCount?: number; roleLabel?: string; action?: string;
}
const runStageMap = new Map<number, StageInfo>();

function setStage(profileId: number, text: string, pct: number, totalSections: number, extra?: Partial<StageInfo>): void {
  runStageMap.set(profileId, { text, pct, totalSections, ...extra });
}

export function getIsRunning(profileId: number = 1): boolean {
  return isRunningMap.get(profileId) ?? false;
}

export function getRunStatus(profileId: number = 1) {
  return {
    isRunning: isRunningMap.get(profileId) ?? false,
    lastRun: lastRunResultMap.get(profileId) ?? null,
    stage: runStageMap.get(profileId) ?? null,
  };
}

export interface RunOptions {
  groupIds?: number[];    // if provided, only run these groups (by id)
  dateRange?: DateRange;  // defaults to '24h'
  providers?: string[];   // override settings.scraping_providers
}

export interface PipelineResult {
  ranAt: string;
  durationMs: number;
  jobsFetched: number;
  jobsScored: number;
  jobsStrongMatch: number;
  jobsWeakMatch: number;
  jobsNoMatch: number;
  jobsDuplicate: number;
  status: 'success' | 'partial_error' | 'failed' | 'running' | 'stopped';
  errorLog: string | null;
  trigger: 'scheduled' | 'manual';
}

export async function runPipeline(trigger: 'scheduled' | 'manual' = 'scheduled', profileId: number = 1, options: RunOptions = {}): Promise<PipelineResult> {
  if (isRunningMap.get(profileId)) {
    console.log(`[runner] Pipeline already running for profile ${profileId}; skipping trigger.`);
    return {
      ranAt: new Date().toISOString(),
      durationMs: 0,
      jobsFetched: 0,
      jobsScored: 0,
      jobsStrongMatch: 0,
      jobsWeakMatch: 0,
      jobsNoMatch: 0,
      jobsDuplicate: 0,
      status: 'failed',
      errorLog: 'Pipeline already running',
      trigger,
    };
  }

  isRunningMap.set(profileId, true);
  return enqueue(() => runPipelineInner(trigger, profileId, options));
}

/**
 * D14 label selector: picks the most relevant display label for a resolved job location.
 * Uses current_location when it's a preferred search location AND matches the job's country.
 */
function selectDisplayLabel(
  resolvedLabel: string | null,
  currentLocation: string,
  searchLocationsJson: string,
): string | null {
  if (!resolvedLabel) return null;
  if (!currentLocation) return resolvedLabel;
  let searchLocations: string[] = [];
  try { searchLocations = JSON.parse(searchLocationsJson || '[]'); } catch { /* keep empty */ }
  const curLower = currentLocation.toLowerCase().trim();
  const isPreferred = searchLocations.some((sl) => sl.toLowerCase().trim() === curLower);
  if (isPreferred && resolvedLabel.toLowerCase() === curLower) return currentLocation;
  return resolvedLabel;
}

function buildLocationData(label: string | null): { labels: string[]; countries: string[] } {
  if (!label) return { labels: [], countries: [] };
  const lower = label.toLowerCase();
  const countries = lookupCountry(lower) ? [lower] : expandRegionToCountries(label);
  return { labels: [label], countries };
}

async function runPipelineInner(trigger: 'scheduled' | 'manual', profileId: number, options: RunOptions): Promise<PipelineResult> {
  const overallStart = Date.now();
  const overallRanAt = new Date().toISOString();
  const sessionId = randomUUID();
  // Hoisted out of the try so the outer catch/finally can reach them on every exit path.
  let lastResult: PipelineResult | null = null;
  let deductCredits: () => void = () => {};

  try {
    throwIfStopped(profileId);   // stopped while still queued
    const db = getDb();

    // Load settings for this profile
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    if (!settings) throw new Error(`Settings not found for profile ${profileId}`);

    // Resolve API keys based on credit mode
    const useJhCredits = (settings.use_jh_credits ?? 1) !== 0;
    let apifyToken: string;
    let openAiKey: string;
    if (useJhCredits) {
      const adminProfile = db.prepare('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { id: number } | undefined;
      const adminSettings = adminProfile
        ? db.prepare('SELECT openai_api_key, apify_api_token FROM settings WHERE profile_id = ?').get(adminProfile.id) as { openai_api_key: string; apify_api_token: string } | undefined
        : undefined;
      apifyToken = adminSettings?.apify_api_token?.trim() || config.apifyApiToken || '';
      openAiKey = adminSettings?.openai_api_key?.trim() || config.openAiKey || '';
    } else {
      apifyToken = settings.user_apify_api_token?.trim() || config.apifyApiToken || '';
      openAiKey = settings.user_openai_api_key?.trim() || config.openAiKey || '';
    }
    const resendApiKey = settings.resend_api_key || config.resendApiKey;
    const emailFrom = settings.email_from || config.emailFrom;

    // Load all search groups for this profile
    const groups = db.prepare('SELECT * FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as SearchGroupRow[];
    if (groups.length === 0) throw new Error('No roles configured. Add at least one role in Settings.');

    // Load blacklist for this profile
    const blacklist = db
      .prepare('SELECT * FROM blacklisted_companies WHERE profile_id = ? ORDER BY company_name ASC')
      .all(profileId) as BlacklistedCompanyRow[];
    const blacklistNames = new Set(blacklist.map((b) => b.company_name.toLowerCase().trim()));

    const { groupIds, dateRange = '24h', providers: providersOverride } = options;
    const providers = (providersOverride && providersOverride.length > 0)
      ? providersOverride
      : JSON.parse(settings.scraping_providers || '["harvestapi"]') as string[];

    console.log(`[runner] Starting pipeline (${trigger}) — ${groups.length} group(s), ${blacklist.length} blacklisted company(ies), ${providers.length} provider(s)`);

    // Prepared statements (shared across groups and providers)
    const insertCanonicalJob = db.prepare(`
      INSERT OR IGNORE INTO jobs (
        linkedin_job_id, job_source, provider, title, company, location, country, work_mode,
        description, url, apply_url, posted_date, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)
    `);

    const selectJobId = db.prepare(
      `SELECT id FROM jobs WHERE linkedin_job_id = ? AND job_source = ?`
    );

    const upsertJobDescription = db.prepare(`
      INSERT INTO job_descriptions (job_id, description_text, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        description_text = excluded.description_text,
        updated_at       = excluded.updated_at
    `);

    const insertJobState = db.prepare(`
      INSERT OR IGNORE INTO job_profile_states (
        job_id, profile_id, group_id, fetched_at,
        ai_score, ai_verdict, original_ai_verdict, ai_rationale, ai_summary,
        rejection_category, is_duplicate, duplicate_of_job_id, seen, seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const updateApplyUrl = db.prepare(`
      UPDATE jobs SET apply_url = ?
      WHERE linkedin_job_id = ? AND job_source = ? AND apply_url IS NULL
    `);

    const upsertCompanyLogo = db.prepare(`
      INSERT INTO companies (company, logo_url, fetched_at) VALUES (?, ?, ?)
      ON CONFLICT(company) DO UPDATE SET
        logo_url   = COALESCE(excluded.logo_url, companies.logo_url),
        fetched_at = excluded.fetched_at
    `);

    const insertJobLog = db.prepare(`
      INSERT INTO run_job_logs (
        run_id, group_id, linkedin_job_id, job_source, title, company, location, url,
        ai_score, ai_verdict, ai_rationale, rejection_category, logged_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertPosting = db.prepare(`
      INSERT OR IGNORE INTO job_postings (job_id, job_source, posting_job_id, url, apply_url, location, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    // Shared across all providers — keyed as "source::jobId" to avoid cross-source collisions
    const seenInRunJobIds = new Set<string>();

    // Pre-compute active groups once (same filter for all providers) for global progress tracking
    const activeGroupsForProgress = groups.filter((g) =>
      groupIds && groupIds.length > 0 ? groupIds.includes(g.id) : g.is_active
    );
    // Total progress slots across ALL providers: (providers × groups × 2 stages) + 1 per provider start
    const globalTotalSections = providers.length * (activeGroupsForProgress.length * 2 + 1);
    let globalSectionOffset = 0;
    let totalRunCostOpenAiUsd = 0;
    let totalRunCostApifyUsd = 0;

    // Deduct JH credits for all providers combined. Called from the outer `finally`, so a run that
    // was stopped or that died on a fatal error still pays for the work it already did.
    let creditsDeducted = false;
    deductCredits = () => {
      if (creditsDeducted || !useJhCredits) return;
      creditsDeducted = true;
      const totalCost = totalRunCostOpenAiUsd + totalRunCostApifyUsd;
      if (totalCost <= 0) return;
      const row = db.prepare('SELECT credits_balance FROM settings WHERE profile_id = ?').get(profileId) as { credits_balance: number } | undefined;
      const currentBalance = row?.credits_balance ?? 0;
      const newBalance = Math.max(0, currentBalance - totalCost);
      db.prepare('UPDATE settings SET credits_balance = ? WHERE profile_id = ?').run(newBalance, profileId);
      console.log(`[runner] Deducted $${totalCost.toFixed(4)} from credits. New balance: $${newBalance.toFixed(4)}`);
      if (newBalance < 0.5) {
        // Cancel schedule — use dynamic import to avoid circular dep with scheduler
        import('./scheduler').then(({ stopSchedule }) => stopSchedule(profileId)).catch(() => {});
        const profileEmailRow = db.prepare('SELECT email FROM profiles WHERE id = ?').get(profileId) as { email: string } | undefined;
        const recipientEmail = profileEmailRow?.email || '';
        if (recipientEmail && resendApiKey && emailFrom) {
          sendLowCreditsEmail(recipientEmail, newBalance, resendApiKey, emailFrom).catch((err) => {
            console.warn('[runner] Failed to send low credits email:', (err as Error).message);
          });
        }
      }
    };

    // Session-wide state — accumulated across all providers, sent as one email after the loop
    const sessionStrongMatchJobIds = new Set<number>();
    let sessionFetched = 0;
    let sessionScored = 0;
    let sessionStrong = 0;
    let sessionWeak = 0;
    let sessionNoMatch = 0;
    let sessionDuplicate = 0;
    let sessionFiltered = 0;
    let sessionBlacklisted = 0;

    for (const scrapingProvider of providers) {
      const startedAt = Date.now();
      const ranAt = new Date().toISOString();
      const errors: string[] = [];
      let runId: number | null = null;

      let jobsFetched = 0;
      let jobsScored = 0;
      let jobsStrongMatch = 0;
      let jobsWeakMatch = 0;
      let jobsNoMatch = 0;
      let jobsDuplicate = 0;
      let totalInputTokens = 0;
      let totalCachedInputTokens = 0;
      let totalOutputTokens = 0;
      let hardInputTokens = 0;
      let hardCachedInputTokens = 0;
      let hardOutputTokens = 0;
      let totalApifyCostUsd = 0;
      let apifyRunCount = 0;

      // Tokens → dollars → run totals. Called on the clean path AND from the catch, so a provider
      // that crashed or was stopped is still billed for what it spent (it previously was not).
      let costAccounted = false;
      let costOpenAiUsd = 0;
      let costApifyUsd: number | null = null;
      const accountProviderCost = () => {
        if (costAccounted) return;   // idempotent — must never double-charge
        costAccounted = true;
        costOpenAiUsd =
          (calcOpenAiCost(settings.ai_model, totalInputTokens, totalCachedInputTokens, totalOutputTokens) ?? 0) +
          (calcOpenAiCost(settings.ai_model_hard, hardInputTokens, hardCachedInputTokens, hardOutputTokens) ?? 0);
        costApifyUsd = apifyRunCount > 0 ? totalApifyCostUsd : null;
        totalRunCostOpenAiUsd += costOpenAiUsd;
        if (costApifyUsd != null) totalRunCostApifyUsd += costApifyUsd;
      };

      // In-run semantic dedup context — reset per provider run
      const strongMatchesInRun = new Map<string, ExistingJob[]>();

      // Collects STRONG_MATCH non-duplicate jobs for hard-model re-scoring after all groups finish.
      const strongMatchesForReScoring: Array<{
        jobId: number;
        groupId: number;
        job: JobPosting;
        scoringSettings: SettingsRow;
      }> = [];

      try {
        // Pre-compute targeted groups for progress tracking.
        // When groupIds are specified (e.g. schedule snapshot), run those IDs regardless of is_active —
        // deleted groups are naturally absent from `groups` and will be silently skipped.
        // When no groupIds, fall back to is_active filtering (manual runs).
        const activeGroups = groups.filter((g) =>
          groupIds && groupIds.length > 0 ? groupIds.includes(g.id) : g.is_active
        );
        const providerIdx = providers.indexOf(scrapingProvider);
        const providerPrefix = providers.length > 1 ? `[${providerIdx + 1}/${providers.length}] ` : '';
        const sw = 100 / globalTotalSections;
        let activeGroupIdx = 0;
        setStage(profileId, `${providerPrefix}Starting`, Math.round(globalSectionOffset * sw), globalTotalSections,
          { providerIdx: providerIdx + 1, providerCount: providers.length, providerName: providerToSource(scrapingProvider), action: 'Starting' });

        // Insert search_runs row NOW to get a stable run_id for job logs
        runId = db.prepare(
          `INSERT INTO search_runs (profile_id, ran_at, status, trigger, scraping_provider, job_source, session_id) VALUES (?, ?, 'running', ?, ?, ?, ?)`
        ).run(profileId, ranAt, trigger, scrapingProvider, providerToSource(scrapingProvider), sessionId).lastInsertRowid as number;

        console.log(`[runner] Run ID: ${runId} (provider: ${scrapingProvider})`);

        // --- Per-group loop ---
        for (const group of groups) {
      if (groupIds && groupIds.length > 0) {
        // Running from a schedule snapshot (or explicit ID list): use IDs as-is, ignore is_active.
        // Deleted groups are already absent from `groups`; deactivated ones intentionally run.
        if (!groupIds.includes(group.id)) {
          console.log(`[runner] Group ${group.id} not in selected groupIds, skipping.`);
          continue;
        }
      } else {
        // Manual run without groupIds: respect is_active
        if (!group.is_active) {
          console.log(`[runner] Group ${group.id} is inactive, skipping.`);
          continue;
        }
      }

      throwIfStopped(profileId);   // before this role's first fetch

      const keywords: string[] = JSON.parse(group.keywords);
      const locations: string[] = JSON.parse(group.locations);
      const workModes: string[] = JSON.parse(group.work_modes);

      console.log(
        `[runner] Group ${group.id} [${locations.join(', ')}]: ${keywords.length} keywords × ${locations.length} locations`,
      );

      // 1. Fetch
      const roleLabel = group.group_name ? group.group_name : `Role ${activeGroupIdx + 1}`;
      setStage(profileId, `${providerPrefix}${roleLabel}: Searching`, Math.round((globalSectionOffset + activeGroupIdx * 2 + 1) * sw), globalTotalSections,
        { providerIdx: providerIdx + 1, providerCount: providers.length, providerName: providerToSource(scrapingProvider), roleIdx: activeGroupIdx + 1, roleCount: activeGroups.length, roleLabel, action: 'Searching' });
      let allFetched: JobPosting[] = [];
      try {
        const fetchResult = await fetchJobs({
          keywords,
          locations,
          workModes,
          jobType: parseJobTypes(group.job_type),
        }, apifyToken, dateRange, scrapingProvider);
        allFetched = fetchResult.jobs;
        if (fetchResult.apifyCostUsd != null) {
          totalApifyCostUsd += fetchResult.apifyCostUsd;
          apifyRunCount++;
        }
      } catch (err) {
        const msg = `Group ${group.id} fetch error: ${(err as Error).message}`;
        console.error('[runner]', msg);
        errors.push(msg);
        continue;
      }

      jobsFetched += allFetched.length;
      console.log(`[runner] Group ${group.id}: fetched ${allFetched.length} jobs`);

      // 2. Title filter
      if (group.title_filter && group.title_filter.trim()) {
        const titleFiltered = allFetched.filter((j) => !matchesTitleFilter(j.title, group.title_filter));
        allFetched = allFetched.filter((j) => matchesTitleFilter(j.title, group.title_filter));
        console.log(`[runner] Group ${group.id}: title filter removed ${titleFiltered.length} jobs (${allFetched.length} remain)`);
        sessionFiltered += titleFiltered.length;

        if (titleFiltered.length > 0) {
          const loggedAt = new Date().toISOString();
          db.transaction(() => {
            for (const job of titleFiltered) {
              insertJobLog.run(
                runId, group.id, job.jobId, job.jobSource ?? 'LinkedIn', job.title, job.company,
                job.location || null, job.url || null,
                null, 'FILTERED', null, null, loggedAt,
              );
            }
          });
        }
      }

      // 3. Blacklist filter — capture filtered jobs before removing them
      const blacklistedJobs = allFetched.filter((j) => blacklistNames.has(j.company.toLowerCase().trim()));
      allFetched = allFetched.filter((j) => !blacklistNames.has(j.company.toLowerCase().trim()));
      if (blacklistedJobs.length > 0) {
        console.log(`[runner] Group ${group.id}: removed ${blacklistedJobs.length} blacklisted job(s)`);
      }
      sessionBlacklisted += blacklistedJobs.length;

      // 3a. Within-run dedup — deduplicate within this batch first, then against earlier groups
      // The LinkedIn API can return the same jobId multiple times within one group's results
      const seenInBatch = new Set<string>();
      const batchDupes: typeof allFetched = [];
      const batchUnique: typeof allFetched = [];
      for (const j of allFetched) {
        if (seenInBatch.has(j.jobId)) batchDupes.push(j);
        else { seenInBatch.add(j.jobId); batchUnique.push(j); }
      }
      allFetched = batchUnique;

      const withinRunDupes = [
        ...batchDupes,
        ...allFetched.filter((j) => seenInRunJobIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`)),
      ];
      allFetched = allFetched.filter((j) => !seenInRunJobIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));
      for (const j of allFetched) seenInRunJobIds.add(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`);
      if (withinRunDupes.length > 0) {
        console.log(`[runner] Group ${group.id}: ${withinRunDupes.length} within-run duplicate(s) skipped`);
        jobsDuplicate += withinRunDupes.length;
      }

      // 3b. Provider-level dedup — filter jobs already stored in DB from previous runs
      const { newJobs, providerDupes } = filterNewJobs(allFetched, profileId);
      console.log(`[runner] Group ${group.id}: ${newJobs.length} new after provider dedup`);

      if (providerDupes.length > 0) {
        jobsDuplicate += providerDupes.length;
        const loggedAt = new Date().toISOString();
        db.transaction(() => {
          for (const job of providerDupes) {
            insertJobLog.run(
              runId, group.id, job.jobId, job.jobSource ?? 'LinkedIn', job.title, job.company,
              job.location || null, job.url || null,
              null, 'DUPLICATE', null, null, loggedAt,
            );
          }
        });
      }

      // 3c. URL-level dedup — cross-source repost detection (no LLM cost)
      const { uniqueJobs: newJobsToScore, urlDuplicates } = filterDuplicatesByUrl(newJobs, profileId);

      if (urlDuplicates.length > 0) {
        jobsDuplicate += urlDuplicates.length;
        const loggedAt = new Date().toISOString();
        db.transaction(() => {
          for (const { job } of urlDuplicates) {
            insertJobLog.run(
              runId, group.id, job.jobId, job.jobSource ?? 'LinkedIn', job.title, job.company,
              job.location || null, job.url || null,
              null, 'DUPLICATE', null, null, loggedAt,
            );
          }
        });
      }

      // 4. Score all new jobs (Call 1: scoring)
      const scoringSettings: SettingsRow = {
        ...settings,
        ai_system_prompt: buildScoringSystemPrompt(group, settings),
        score_no_match_max: group.score_no_match_max,
        score_weak_match_max: group.score_weak_match_max,
        score_strong_match_min: group.score_strong_match_min,
      };

      throwIfStopped(profileId);   // before the scoring call

      let scoredJobs: ScoredJob[] = [];
      if (newJobsToScore.length > 0) {
        setStage(profileId, `${providerPrefix}${roleLabel}: Scoring with AI`, Math.round((globalSectionOffset + activeGroupIdx * 2 + 2) * sw), globalTotalSections,
          { providerIdx: providerIdx + 1, providerCount: providers.length, providerName: providerToSource(scrapingProvider), roleIdx: activeGroupIdx + 1, roleCount: activeGroups.length, roleLabel, action: 'Scoring with AI' });
        const scoreResult = await scoreJobs(newJobsToScore, scoringSettings, openAiKey);
        scoredJobs = scoreResult.jobs;
        jobsScored += scoredJobs.length;
        totalInputTokens += scoreResult.tokenUsage.inputTokens;
        totalCachedInputTokens += scoreResult.tokenUsage.cachedInputTokens;
        totalOutputTokens += scoreResult.tokenUsage.outputTokens;
        if (scoreResult.rateLimited) {
          // Credit mode throttles the admin's shared key, so alert the admin. BYO-key mode
          // throttles the running user's own key, so alert that user instead.
          const alertEmail = (useJhCredits
            ? db.prepare('SELECT email FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { email?: string } | undefined
            : db.prepare('SELECT email FROM profiles WHERE id = ?').get(profileId) as { email?: string } | undefined
          )?.email;
          // Cooldown is per-recipient so one user's alert never suppresses another's.
          if (alertEmail && resendApiKey && emailFrom
              && Date.now() - (lastRateLimitAlert.get(alertEmail) ?? 0) > RATE_LIMIT_ALERT_COOLDOWN_MS) {
            lastRateLimitAlert.set(alertEmail, Date.now());
            sendRateLimitAlert(alertEmail, resendApiKey, emailFrom).catch((e) => console.error('[runner] rate-limit alert failed:', e));
          }
        }
      }

      // 4b. Dedup + summary for strong matches (Call 2: dedup + summary)
      const jobResults: Array<{
        scored: ScoredJob;
        isDuplicate: boolean;
        duplicateOfId: number | null;
        summary: string | null;
      }> = [];

      for (const scored of scoredJobs) {
        let isDuplicate = false;
        let duplicateOfId: number | null = null;
        let summary: string | null = null;

        if (scored.verdict === 'STRONG_MATCH') {
          const companyKey = normalizeCompany(scored.job.company);

          // Stage 1: gather all same-company saved jobs (any verdict, no title filter)
          const inRunEntries = strongMatchesInRun.get(companyKey) ?? [];
          // Assign temporary negative IDs to in-run entries (not yet in DB)
          const inRunWithIds: ExistingJob[] = inRunEntries.map((e, i) => ({ ...e, id: -(i + 1) }));
          // Match on normalized key (exact) OR on names that extend it with a legal suffix ("Every." → "Every. GmbH").
          const dbCandidates = db.prepare(`
            SELECT j.id, j.title, COALESCE(jd.description_text, j.description) AS description FROM jobs j
            JOIN job_profile_states jps ON jps.job_id = j.id
            LEFT JOIN job_descriptions jd ON jd.job_id = j.id
            WHERE (lower(j.company) = ? OR lower(j.company) LIKE ? || ' %')
              AND jps.is_duplicate = 0
              AND jps.profile_id = ?
            ORDER BY jps.fetched_at DESC
          `).all(companyKey, companyKey, profileId) as ExistingJob[];
          const allCandidates: ExistingJob[] = [...inRunWithIds, ...dbCandidates];

          if (allCandidates.length > 0) {
            // Stage 2: cheap titles-only pre-filter → returns plausible duplicate IDs
            const filteredIds = await preFilterDuplicateCandidates(
              scored.job.title,
              allCandidates.map((c) => ({ id: c.id, title: c.title })),
              settings.ai_model,
              openAiKey,
            );

            if (filteredIds.length > 0) {
              // Resolve IDs back to full entries, cap at 5
              const filteredSet = new Set(filteredIds);
              const dedupCandidates = allCandidates
                .filter((c) => filteredSet.has(c.id))
                .slice(0, 5);

              if (dedupCandidates.length > 0) {
                // Stage 3: full dedup with descriptions
                const dedup = await dedupAndSummarise(scored, dedupCandidates, settings, openAiKey);
                isDuplicate = dedup.isDuplicate;
                duplicateOfId = dedup.duplicateOfId && dedup.duplicateOfId > 0 ? dedup.duplicateOfId : null;
                hardInputTokens += dedup.tokenUsage.inputTokens;
                hardCachedInputTokens += dedup.tokenUsage.cachedInputTokens;
                hardOutputTokens += dedup.tokenUsage.outputTokens;
                if (isDuplicate) {
                  console.log(`[runner] Semantic duplicate: "${scored.job.title}" at "${scored.job.company}" → original ID ${duplicateOfId}`);
                }
              }
            }
            // filteredIds empty → pre-filter found no plausible duplicates; skip full dedup
          }
          // allCandidates empty → first job from this company; skip both stages

          if (!isDuplicate) {
            // Register in in-run map so subsequent same-company jobs can be compared against it.
            const entry: ExistingJob = { id: 0, title: scored.job.title, description: scored.job.description || '' };
            strongMatchesInRun.set(companyKey, [...(strongMatchesInRun.get(companyKey) ?? []), entry]);
            summary = scored.summary;  // from Call 1
          }
        }

        if (isDuplicate) jobsDuplicate++;
        else if (scored.verdict === 'STRONG_MATCH') jobsStrongMatch++;
        else if (scored.verdict === 'WEAK_MATCH') jobsWeakMatch++;
        else jobsNoMatch++;

        jobResults.push({ scored, isDuplicate, duplicateOfId, summary });
      }

      console.log(
        `[runner] Group ${group.id}: scored ${scoredJobs.length} — Strong=${jobsStrongMatch} Weak=${jobsWeakMatch} NoMatch=${jobsNoMatch} Dupes=${jobsDuplicate} (cumulative)`,
      );

      // Resolve countries for all jobs in this group. Multi-location strings are split
      // (';'/'|' + country-aware) and every element resolved cache-first (Nominatim
      // fallback), so a surfaced multi-country job gets its full country set, not just
      // the first segment. countryMap holds the primary (first) label per location.
      const allLocations = [
        ...blacklistedJobs.map(j => j.location).filter(Boolean) as string[],
        ...jobResults.map(r => r.scored.job.location).filter(Boolean) as string[],
        ...urlDuplicates.map(d => d.job.location).filter(Boolean) as string[],
      ];
      const locDataMap = new Map<string, { labels: string[]; countries: string[] }>();
      const countryMap = new Map<string, string | null>();
      for (const loc of new Set(allLocations)) {
        const data = await resolveLocationString(loc);
        locDataMap.set(loc, data);
        countryMap.set(loc, data.labels[0] ?? null);
      }

      // 5. Log all jobs from this group to run_job_logs
      const loggedAt = new Date().toISOString();
      db.transaction(() => {
        for (const job of blacklistedJobs) {
          const logLoc = selectDisplayLabel(
            countryMap.get(job.location ?? '') ?? job.location ?? null,
            settings.current_location ?? '',
            settings.search_locations ?? '',
          );
          insertJobLog.run(
            runId, group.id, job.jobId, job.jobSource ?? 'LinkedIn', job.title, job.company,
            logLoc, job.url || null,
            null, 'BLACKLISTED', null, null, loggedAt,
          );
        }
        for (const { scored, isDuplicate } of jobResults) {
          const logVerdict = isDuplicate ? 'DUPLICATE' : scored.verdict;
          const logLoc = selectDisplayLabel(
            countryMap.get(scored.job.location ?? '') ?? scored.job.location ?? null,
            settings.current_location ?? '',
            settings.search_locations ?? '',
          );
          insertJobLog.run(
            runId, group.id, scored.job.jobId, scored.job.jobSource ?? 'LinkedIn', scored.job.title, scored.job.company,
            logLoc, scored.job.url || null,
            scored.score, logVerdict, scored.rationale || null,
            scored.rejectionCategory || null, loggedAt,
          );
        }
      });

      // Store blacklisted jobs in jobs table (INSERT OR IGNORE — first encounter wins)
      if (blacklistedJobs.length > 0) {
        const now = new Date().toISOString();
        db.transaction(() => {
          for (const job of blacklistedJobs) {
            const country = job.location ? (countryMap.get(job.location) ?? null) : null;
            const jobSource = job.jobSource ?? 'LinkedIn';
            insertCanonicalJob.run(
              job.jobId, jobSource, job.provider || 'harvestapi',
              job.title, job.company, job.location || null, country, job.workMode || null,
              job.url || null, job.applyUrl || null,
              job.postedDate || null, now,
            );
            const { id: jobId } = selectJobId.get(job.jobId, jobSource) as { id: number };
            insertPosting.run(jobId, jobSource, job.jobId, job.url || null, job.applyUrl || null, job.location || null, now);
            groupOrDrop(jobId, locDataMap.get(job.location ?? '') ?? buildLocationData(country));
            if (job.description) upsertJobDescription.run(jobId, job.description, now);
            insertJobState.run(
              jobId, profileId, group.id, now,
              0, 'BLACKLISTED', 'BLACKLISTED', null, null, null,
              0, null, 0, null,
            );
            if (job.applyUrl) updateApplyUrl.run(job.applyUrl, job.jobId, jobSource);
            if (job.logoUrl) upsertCompanyLogo.run(job.company, job.logoUrl, now);
          }
        });
        console.log(`[runner] Group ${group.id}: stored ${blacklistedJobs.length} blacklisted job(s).`);
      }

      // 6. Store all scored jobs (strong/weak/no-match/duplicate) in one pass
      if (jobResults.length > 0 || urlDuplicates.length > 0) {
        const now = new Date().toISOString();
        const jobIdByKey = new Map<string, number>();
        db.transaction(() => {
          for (const { scored, isDuplicate, duplicateOfId, summary } of jobResults) {
            const { job } = scored;
            const country = job.location ? (countryMap.get(job.location) ?? null) : null;
            const jobSource = job.jobSource ?? 'LinkedIn';
            insertCanonicalJob.run(
              job.jobId, jobSource, job.provider || 'harvestapi',
              job.title, job.company, job.location || null, country, job.workMode || null,
              job.url || null, job.applyUrl || null,
              job.postedDate || null, now,
            );
            const { id: jobId } = selectJobId.get(job.jobId, jobSource) as { id: number };
            insertPosting.run(jobId, jobSource, job.jobId, job.url || null, job.applyUrl || null, job.location || null, now);
            const locationData = locDataMap.get(job.location ?? '') ?? buildLocationData(country);
            if (isDuplicate && duplicateOfId) {
              groupOrDrop(duplicateOfId, locationData);
            } else {
              groupOrDrop(jobId, locationData);
            }
            jobIdByKey.set(`${jobSource}::${job.jobId}`, jobId);
            if (job.description) upsertJobDescription.run(jobId, job.description, now);
            insertJobState.run(
              jobId, profileId, group.id, now,
              scored.score, scored.verdict, scored.verdict,
              scored.rationale || null, summary || null, scored.rejectionCategory || null,
              isDuplicate ? 1 : 0, isDuplicate && duplicateOfId ? duplicateOfId : null,
              isDuplicate ? 1 : 0, isDuplicate ? now : null,
            );
            if (job.applyUrl) updateApplyUrl.run(job.applyUrl, job.jobId, jobSource);
            if (job.logoUrl) upsertCompanyLogo.run(job.company, job.logoUrl, now);
          }
          // Store URL-duplicate jobs (cross-source reposts) — canonical entry written, state marked duplicate
          for (const { job, duplicateOfId } of urlDuplicates) {
            const country = job.location ? (countryMap.get(job.location) ?? null) : null;
            const jobSource = job.jobSource ?? 'LinkedIn';
            insertCanonicalJob.run(
              job.jobId, jobSource, job.provider || 'harvestapi',
              job.title, job.company, job.location || null, country, job.workMode || null,
              job.url || null, job.applyUrl || null,
              job.postedDate || null, now,
            );
            const { id: jobId } = selectJobId.get(job.jobId, jobSource) as { id: number };
            insertPosting.run(jobId, jobSource, job.jobId, job.url || null, job.applyUrl || null, job.location || null, now);
            groupOrDrop(duplicateOfId, locDataMap.get(job.location ?? '') ?? buildLocationData(country));
            if (job.description) upsertJobDescription.run(jobId, job.description, now);
            insertJobState.run(
              jobId, profileId, group.id, now,
              0, 'DUPLICATE', 'DUPLICATE', null, null, null,
              1, duplicateOfId, 1, now,
            );
            if (job.applyUrl) updateApplyUrl.run(job.applyUrl, job.jobId, jobSource);
            if (job.logoUrl) upsertCompanyLogo.run(job.company, job.logoUrl, now);
          }
        });
        console.log(`[runner] Group ${group.id}: stored ${jobResults.length} jobs.`);

        // Fire-and-forget Clearbit logo fetch for ATS jobs (Greenhouse/Ashby provide no logo)
        const atsForClearbit = [
          ...jobResults.map(({ scored }) => scored.job),
          ...urlDuplicates.map(({ job }) => job),
          ...blacklistedJobs,
        ].filter((j) => j.jobSource === 'Greenhouse' || j.jobSource === 'Ashby' || j.jobSource === 'Lever')
          .map((j) => ({ company: j.company, ats: j.jobSource.toLowerCase() }));
        if (atsForClearbit.length > 0) {
          fetchClearbitLogosForAts(db, atsForClearbit).catch(() => {});
        }

        // Collect non-duplicate STRONG_MATCHes for hard-model re-scoring after all groups finish
        for (const { scored, isDuplicate } of jobResults) {
          if (!isDuplicate && scored.verdict === 'STRONG_MATCH') {
            const jobSource = scored.job.jobSource ?? 'LinkedIn';
            const jobId = jobIdByKey.get(`${jobSource}::${scored.job.jobId}`);
            if (jobId !== undefined) {
              strongMatchesForReScoring.push({ jobId, groupId: group.id, job: scored.job, scoringSettings });
              sessionStrongMatchJobIds.add(jobId);
            }
          }
        }
      }

      activeGroupIdx++;
    } // end group loop

    // 7a. Re-score all STRONG_MATCH jobs from this run using the hard model
    throwIfStopped(profileId);   // before the re-scoring calls; all group results are persisted by now
    if (strongMatchesForReScoring.length > 0) {
      console.log(`[runner] Re-scoring ${strongMatchesForReScoring.length} strong match(es) with hard model (${settings.ai_model_hard})…`);
      setStage(profileId, 'Re-scoring strong matches', Math.round((globalSectionOffset + activeGroups.length * 2) * sw), globalTotalSections,
        { providerIdx: providerIdx + 1, providerCount: providers.length, providerName: providerToSource(scrapingProvider), action: 'Re-scoring' });

      const updateRescored = db.prepare(`
        UPDATE job_profile_states SET ai_score = ?, ai_verdict = ?, ai_rationale = ?, rejection_category = ?, ai_summary = ?
        WHERE job_id = ? AND profile_id = ?
      `);
      const updateRescoredLog = db.prepare(`
        UPDATE run_job_logs SET ai_score = ?, ai_verdict = ?, ai_rationale = ?, rejection_category = ?
        WHERE run_id = ? AND linkedin_job_id = ? AND group_id = ? AND ai_verdict = 'STRONG_MATCH'
      `);

      const rescoreLimit = pLimit(Number(process.env.SCORING_CONCURRENCY) || 5);
      await Promise.all(strongMatchesForReScoring.map((entry) => rescoreLimit(async () => {
        try {
          const hardSettings: SettingsRow = { ...entry.scoringSettings, ai_model: settings.ai_model_hard };
          const result = await scoreJobs([entry.job], hardSettings, openAiKey);
          const rescored = result.jobs[0];

          hardInputTokens += result.tokenUsage.inputTokens;
          hardCachedInputTokens += result.tokenUsage.cachedInputTokens;
          hardOutputTokens += result.tokenUsage.outputTokens;

          updateRescored.run(
            rescored.score, rescored.verdict, rescored.rationale,
            rescored.rejectionCategory, rescored.summary,
            entry.jobId, profileId,
          );
          updateRescoredLog.run(
            rescored.score, rescored.verdict, rescored.rationale,
            rescored.rejectionCategory,
            runId, entry.job.jobId, entry.groupId,
          );

          if (rescored.verdict !== 'STRONG_MATCH') {
            jobsStrongMatch--;
            sessionStrongMatchJobIds.delete(entry.jobId);
            if (rescored.verdict === 'WEAK_MATCH') jobsWeakMatch++;
            else jobsNoMatch++;
          }
        } catch (err) {
          console.warn(`[runner] Re-score failed for "${entry.job.title}" at "${entry.job.company}":`, (err as Error).message);
        }
      })));
    }

    // 7. Accumulate session totals (email is sent once after the providers loop)
    sessionFetched   += jobsFetched;
    sessionScored    += jobsScored;
    sessionStrong    += jobsStrongMatch;
    sessionWeak      += jobsWeakMatch;
    sessionNoMatch   += jobsNoMatch;
    sessionDuplicate += jobsDuplicate;

    // 8. Update the run row with final stats
    const durationMs = Date.now() - startedAt;
    const status = errors.length === 0 ? 'success' : 'partial_error';

    accountProviderCost();

    db.prepare(`
      UPDATE search_runs SET
        jobs_fetched = ?, jobs_scored = ?, jobs_strong_match = ?,
        jobs_weak_match = ?, jobs_no_match = ?, jobs_duplicate = ?,
        status = ?, error_log = ?, duration_ms = ?,
        cost_openai_usd = ?, cost_apify_usd = ?
      WHERE id = ?
    `).run(
      jobsFetched, jobsScored, jobsStrongMatch,
      jobsWeakMatch, jobsNoMatch, jobsDuplicate,
      status, errors.length > 0 ? errors.join('\n') : null, durationMs,
      costOpenAiUsd, costApifyUsd,
      runId,
    );

    console.log(`[runner] Pipeline complete in ${durationMs}ms — Status: ${status} (${trigger})`);

        const result: PipelineResult = {
          ranAt, durationMs, jobsFetched, jobsScored,
          jobsStrongMatch, jobsWeakMatch, jobsNoMatch, jobsDuplicate,
          status, errorLog: errors.length > 0 ? errors.join('\n') : null, trigger,
        };
        lastResult = result;
        lastRunResultMap.set(profileId, result);
        globalSectionOffset += activeGroups.length * 2 + 1;

      } catch (err) {
        // Bill what this provider spent before it died — on BOTH the error and the stop path.
        accountProviderCost();

        const stopped = err instanceof RunStoppedError;
        const durationMs = Date.now() - startedAt;
        const errorMsg = (err instanceof Error)
          ? (err.message || err.constructor.name || String(err))
          : String(err);
        if (stopped) console.log(`[runner] Stopped by user during provider ${scrapingProvider}.`);
        else console.error(`[runner] Provider pipeline error (${scrapingProvider}):`, err);

        try {
          if (runId !== null) {
            db.prepare(
              `UPDATE search_runs SET status = ?, error_log = ?, duration_ms = ?,
                 jobs_fetched = ?, jobs_scored = ?, jobs_strong_match = ?,
                 jobs_weak_match = ?, jobs_no_match = ?, jobs_duplicate = ?,
                 cost_openai_usd = ?, cost_apify_usd = ?
               WHERE id = ?`
            ).run(
              stopped ? 'stopped' : 'failed', stopped ? null : errorMsg, durationMs,
              jobsFetched, jobsScored, jobsStrongMatch, jobsWeakMatch, jobsNoMatch, jobsDuplicate,
              costOpenAiUsd, costApifyUsd,
              runId,
            );
          } else {
            db.prepare(`
              INSERT INTO search_runs (profile_id, ran_at, jobs_fetched, jobs_scored, jobs_strong_match,
                jobs_weak_match, jobs_no_match, jobs_duplicate, status, error_log, duration_ms, trigger, session_id)
              VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?, ?, ?, ?)
            `).run(profileId, ranAt, stopped ? 'stopped' : 'failed', stopped ? null : errorMsg, durationMs, trigger, sessionId);
          }
        } catch (_) { /* ignore DB logging failure */ }

        const result: PipelineResult = {
          ranAt, durationMs,
          jobsFetched: stopped ? jobsFetched : 0,
          jobsScored: stopped ? jobsScored : 0,
          jobsStrongMatch: stopped ? jobsStrongMatch : 0,
          jobsWeakMatch: stopped ? jobsWeakMatch : 0,
          jobsNoMatch: stopped ? jobsNoMatch : 0,
          jobsDuplicate: stopped ? jobsDuplicate : 0,
          status: stopped ? 'stopped' : 'failed',
          errorLog: stopped ? null : errorMsg,
          trigger,
        };
        lastResult = result;
        lastRunResultMap.set(profileId, result);

        // A stop is not a provider failure: do not swallow it, do not run the next provider.
        if (stopped) throw err;

        globalSectionOffset += activeGroupsForProgress.length * 2 + 1;
      }
    } // end providers loop

    // Send one session digest after all providers have run — scheduled only
    if (trigger === 'scheduled' && settings.email_enabled !== 0) {
      try {
        const profileEmailRow = db.prepare('SELECT email FROM profiles WHERE id = ?').get(profileId) as { email: string } | undefined;
        const recipientEmail = profileEmailRow?.email || '';
        if (!recipientEmail) {
          console.warn('[runner] No profile email configured, skipping email report.');
        } else {
          const adminProfile = db.prepare('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { id: number } | undefined;
          const appUrl = adminProfile
            ? ((db.prepare('SELECT app_url FROM settings WHERE profile_id = ?').get(adminProfile.id) as { app_url?: string } | undefined)?.app_url?.trim() ?? '')
            : '';
          const sessionStats: RunStats = {
            jobsFetched: sessionFetched,
            jobsScored: sessionScored,
            strongMatch: sessionStrong,
            weakMatch: sessionWeak,
            noMatch: sessionNoMatch,
            duplicates: sessionDuplicate,
            filtered: sessionFiltered,
            blacklisted: sessionBlacklisted,
          };
          await sendDailyReport({
            jobIds: [...sessionStrongMatchJobIds],
            stats: sessionStats,
            trigger,
            cronSchedule: settings.cron_schedule,
            appUrl,
            recipientEmail,
            resendApiKey,
            emailFrom,
            profileId,
          });
        }
      } catch (err) {
        console.error('[runner] Session email send error:', (err as Error).message);
      }
    } else {
      console.log('[runner] Email sending is disabled in settings. Skipping email report.');
    }

    // Credits are deducted in the outer `finally` — see deductCredits().

    return lastResult ?? {
      ranAt: overallRanAt, durationMs: Date.now() - overallStart,
      jobsFetched: 0, jobsScored: 0, jobsStrongMatch: 0, jobsWeakMatch: 0, jobsNoMatch: 0, jobsDuplicate: 0,
      status: 'failed', errorLog: 'No providers configured', trigger,
    };

  } catch (err) {
    const durationMs = Date.now() - overallStart;
    const stopped = err instanceof RunStoppedError;
    const errorMsg = (err instanceof Error)
      ? (err.message || err.constructor.name || String(err))
      : String(err);
    if (stopped) console.log('[runner] Pipeline stopped by user.');
    else console.error('[runner] Fatal pipeline error:', err);

    try {
      const db = getDb();
      if (stopped) {
        // The provider row was already marked 'stopped' by the provider catch. This covers a stop
        // that landed outside a provider (e.g. while the run was still queued): mark anything left
        // running, and make sure the session has at least one row so it shows up in the run log.
        db.prepare(`UPDATE search_runs SET status = 'stopped', duration_ms = ? WHERE session_id = ? AND status = 'running'`)
          .run(durationMs, sessionId);
        const { n } = db.prepare('SELECT COUNT(*) AS n FROM search_runs WHERE session_id = ?').get(sessionId) as { n: number };
        if (n === 0) {
          db.prepare(`
            INSERT INTO search_runs (profile_id, ran_at, jobs_fetched, jobs_scored, jobs_strong_match,
              jobs_weak_match, jobs_no_match, jobs_duplicate, status, error_log, duration_ms, trigger, session_id)
            VALUES (?, ?, 0, 0, 0, 0, 0, 0, 'stopped', NULL, ?, ?, ?)
          `).run(profileId, overallRanAt, durationMs, trigger, sessionId);
        }
      } else {
        db.prepare(`
          INSERT INTO search_runs (profile_id, ran_at, jobs_fetched, jobs_scored, jobs_strong_match,
            jobs_weak_match, jobs_no_match, jobs_duplicate, status, error_log, duration_ms, trigger, session_id)
          VALUES (?, ?, 0, 0, 0, 0, 0, 0, 'failed', ?, ?, ?, ?)
        `).run(profileId, overallRanAt, errorMsg, durationMs, trigger, sessionId);
      }
    } catch (_) { /* ignore DB logging failure */ }

    // On a stop, keep the partial result the provider catch recorded (job counts and all).
    const result: PipelineResult = (stopped && lastResult) ? lastResult : {
      ranAt: overallRanAt, durationMs, jobsFetched: 0, jobsScored: 0,
      jobsStrongMatch: 0, jobsWeakMatch: 0, jobsNoMatch: 0, jobsDuplicate: 0,
      status: stopped ? 'stopped' : 'failed', errorLog: stopped ? null : errorMsg, trigger,
    };
    lastRunResultMap.set(profileId, result);
    return result;

  } finally {
    // Every exit path pays for the work it did — clean finish, fatal error, or user stop.
    deductCredits();
    isRunningMap.set(profileId, false);
    stopRequestedSet.delete(profileId);   // a leaked flag would instantly stop the next run
    runStageMap.delete(profileId);
    invalidateJobsDatesCache(profileId);
  }
}
