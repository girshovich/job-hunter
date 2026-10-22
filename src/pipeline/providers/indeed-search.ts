/**
 * Optional Indeed search. Off unless a run selects the `indeed-search` provider.
 * Actor: johnvc/indeed-jobs-api
 * One call per keyword × location, same grid as the default Indeed provider.
 * Country codes come from that provider, then `uk` is sent as `GB`.
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult, FetchOptions } from '../types';
import { filterByTimeWindow, parsePostedDate } from '../types';
import { resolveCountries } from '../locationNormalizer';
import { apifyGate, apifyOutstandingCount } from './apifyGate';
import { APIFY_FALLBACK_CONCURRENCY } from '../limitTables';
import { INDEED_CODE } from './indeed';

const ACTOR_ID = 'johnvc/indeed-jobs-api';
const RESULT_LIMIT = 100;
// Free-plan fee per job returned. A run that returns jobs has a 10-job minimum.
// A run that returns none is not charged.
const JOB_FEE_USD = 0.004;
const MIN_BILLED_JOBS = 10;

const SALARY_PERIOD: Record<string, string> = {
  YEAR: 'year', YEARLY: 'year',
  MONTH: 'month', MONTHLY: 'month',
  WEEK: 'week', WEEKLY: 'week',
  DAY: 'day', DAILY: 'day',
  HOUR: 'hour', HOURLY: 'hour',
};

export function actorCountry(repoCode: string): string {
  const code = repoCode.trim().toLowerCase();
  if (code === 'uk') return 'GB';
  return code.toUpperCase();
}

export function actorDatePosted(dateRange: DateRange): string {
  if (dateRange === '24h') return 'Last 24 hours';
  if (dateRange === '7d') return 'Last 7 days';
  return '';
}

export function toIndeedSearchLocation(location: string): string {
  return location
    .replace(/\bgreater\b/gi, '')
    .replace(/\bmetropolitan area\b/gi, '')
    .replace(/\bmetro area\b/gi, '')
    .replace(/\barea\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildIndeedSearchInput(
  keyword: string,
  location: string,
  countryCode: string,
  dateRange: DateRange,
): Record<string, unknown> {
  return {
    mode: 'search',
    keywords: [keyword],
    location: toIndeedSearchLocation(location),
    country: actorCountry(countryCode),
    datePosted: actorDatePosted(dateRange),
    maxResultsPerInput: RESULT_LIMIT,
    uniqueJobsOnly: true,
  };
}

function locationLine(item: Record<string, unknown>): string {
  if (typeof item.location === 'string' && item.location.trim()) return item.location.trim();
  const parts = [item.city, item.state, item.region, item.country].filter((part) => typeof part === 'string' && part);
  return parts.join(', ');
}

function workMode(item: Record<string, unknown>): string {
  if (typeof item.workModel === 'string' && item.workModel.trim()) return item.workModel.trim();
  if (item.isRemote === true) return 'Remote';
  return '';
}

function salaryLine(item: Record<string, unknown>): string | undefined {
  const amounts = [item.salaryMin, item.salaryMax].filter((n): n is number => typeof n === 'number');
  const unique = [...new Set(amounts)];
  if (unique.length === 0) {
    return typeof item.salaryText === 'string' && item.salaryText.trim()
      ? item.salaryText.trim().substring(0, 100)
      : undefined;
  }
  const parts = [unique.map((n) => n.toLocaleString('en-US')).join(' - ')];
  if (typeof item.salaryCurrency === 'string' && item.salaryCurrency) parts.push(item.salaryCurrency);
  const period = SALARY_PERIOD[String(item.salaryPeriod || '').toUpperCase()];
  if (period) parts.push(`/ ${period}`);
  return parts.join(' ').substring(0, 100);
}

export function mapIndeedSearchItem(item: Record<string, unknown>): JobPosting | null {
  const kind = typeof item.result_type === 'string' ? item.result_type : '';
  if (kind !== '' && kind !== 'job') return null;
  const jobId = typeof item.jobId === 'string' ? item.jobId : '';
  if (!jobId) return null;
  const jobUrl = typeof item.jobUrl === 'string' ? item.jobUrl : '';
  const applyRaw = typeof item.applyUrl === 'string' ? item.applyUrl : '';
  const posted = parsePostedDate(typeof item.datePosted === 'string' ? item.datePosted : undefined);
  const description = (typeof item.descriptionMarkdown === 'string' ? item.descriptionMarkdown : '').substring(0, 20_000);
  return {
    jobId,
    title: typeof item.jobTitle === 'string' && item.jobTitle ? item.jobTitle : 'Unknown Title',
    company: typeof item.companyName === 'string' && item.companyName ? item.companyName : 'Unknown Company',
    location: locationLine(item),
    workMode: workMode(item),
    url: jobUrl,
    applyUrl: applyRaw && applyRaw !== jobUrl ? applyRaw : null,
    postedDate: posted.date,
    postedDateConfidence: posted.confidence,
    description,
    provider: 'indeed-search',
    jobSource: 'Indeed',
    logoUrl: typeof item.companyLogo === 'string' ? item.companyLogo : undefined,
    salary: salaryLine(item),
  };
}

function callCost(itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.max(itemCount, MIN_BILLED_JOBS) * JOB_FEE_USD;
}

export async function fetchWithIndeedSearch(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const apifyLimit = options.apifyConcurrency ?? APIFY_FALLBACK_CONCURRENCY;
  const countryNames = await resolveCountries(filters.locations);

  const calls: Array<{ keyword: string; location: string; country: string }> = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      const countryName = countryNames.get(location);
      const code = countryName ? INDEED_CODE[countryName.toLowerCase().trim()] : undefined;
      if (!code) {
        console.log(`[indeed-search] Skipping "${location}" (resolved: "${countryName ?? 'unknown'}") — not in Indeed's supported countries`);
        continue;
      }
      calls.push({ keyword, location, country: code });
    }
  }
  console.log(`[indeed-search] ${calls.length} actor call(s)`);

  const outstanding = apifyOutstandingCount(apifyToken);
  const promises = calls.map(({ keyword, location, country }) => apifyGate(apifyToken, apifyLimit, async () => {
    options.checkAborted?.();
    const input = buildIndeedSearchInput(keyword, location, country, dateRange);
    console.log(`[indeed-search] Searching: "${keyword}" in "${input.location}" (${input.country})`);
    const run = await client.actor(ACTOR_ID).call(input, { waitSecs: 900 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as Record<string, unknown>[];
  }));

  const queued = Math.max(0, outstanding + calls.length - apifyLimit);
  if (queued > 0) {
    console.log(`[indeed-search] gate: ${queued} of ${calls.length} call(s) queued (limit ${apifyLimit})`);
  }

  const results = await Promise.all(promises);
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  let totalItems = 0;
  let apifyCostUsd = 0;

  for (const items of results) {
    apifyCostUsd += callCost(items.length);
    for (const item of items) {
      totalItems++;
      const job = mapIndeedSearchItem(item);
      if (!job || seen.has(job.jobId)) continue;
      if (filterByTimeWindow(job, dateRange)) {
        seen.add(job.jobId);
        jobs.push(job);
      }
    }
  }

  console.log(`[indeed-search] ${jobs.length} unique jobs after time-window filter (from ${totalItems} raw)`);
  return { jobs, apifyCostUsd };
}
