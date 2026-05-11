/**
 * Greenhouse provider — fetches jobs from all active Greenhouse boards stored in ats_boards.
 * Results are cached for 30 minutes so multiple search-group calls within one run share the fetch.
 */

import { getDb } from '../../db';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow, parsePostedDate } from '../types';
import { resolveCountries } from '../locationNormalizer';

interface GhJobRaw {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string } | null;
  updated_at: string;
  content: string;
}

interface GhApiResponse {
  jobs: GhJobRaw[];
}

let _cachedJobs: JobPosting[] | null = null;
let _cacheExpiresAt = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;
const CONCURRENCY = 10;

async function withConcurrencyMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const { item, i } = queue.shift()!;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchCompanyJobs(slug: string, companyName: string): Promise<JobPosting[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let data: GhApiResponse;
  try { data = await res.json() as GhApiResponse; } catch { return []; }

  return (data.jobs ?? []).map((job): JobPosting => {
    const { date: postedDate, confidence } = parsePostedDate(job.updated_at);
    return {
      jobId: String(job.id),
      title: job.title || '',
      company: companyName || slug,
      location: job.location?.name || '',
      workMode: 'onsite',
      url: job.absolute_url || '',
      applyUrl: job.absolute_url || null,
      postedDate,
      postedDateConfidence: confidence,
      description: (job.content || '').substring(0, 20_000),
      provider: 'greenhouse',
      jobSource: 'Greenhouse',
    };
  });
}

async function getAllGreenhouseJobs(): Promise<JobPosting[]> {
  const now = Date.now();
  if (_cachedJobs && now < _cacheExpiresAt) return _cachedJobs;

  const db = getDb();
  const slugs = db.prepare(
    `SELECT slug, company_name FROM ats_boards WHERE ats = 'greenhouse' AND is_active = 1`,
  ).all() as Array<{ slug: string; company_name: string | null }>;

  console.log(`[greenhouse] Fetching from ${slugs.length} active boards…`);

  const results = await withConcurrencyMap(slugs, CONCURRENCY, ({ slug, company_name }) =>
    fetchCompanyJobs(slug, company_name || slug),
  );

  _cachedJobs = results.flat();
  _cacheExpiresAt = now + CACHE_TTL_MS;
  console.log(`[greenhouse] Cached ${_cachedJobs.length} total jobs.`);
  return _cachedJobs;
}

export async function fetchWithGreenhouse(
  filters: SearchFilters,
  _apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const allJobs = await getAllGreenhouseJobs();

  const countryNames = await resolveCountries(filters.locations);
  const targetCountries = new Set<string>();
  for (const country of countryNames.values()) {
    if (country) targetCountries.add(country.toLowerCase());
  }

  const keywordsLower = filters.keywords.map((k) => k.toLowerCase());

  const filtered = allJobs.filter((job) => {
    const titleLower = job.title.toLowerCase();
    if (!keywordsLower.some((kw) => titleLower.includes(kw))) return false;

    if (targetCountries.size > 0) {
      const locLower = job.location.toLowerCase();
      const pass =
        locLower.includes('remote') ||
        locLower.includes('anywhere') ||
        Array.from(targetCountries).some((c) => locLower.includes(c));
      if (!pass) return false;
    }

    return filterByTimeWindow(job, dateRange);
  });

  console.log(`[greenhouse] ${filtered.length} jobs matched (${filters.keywords.join(', ')} / ${filters.locations.join(', ')})`);
  return { jobs: filtered, apifyCostUsd: 0 };
}
