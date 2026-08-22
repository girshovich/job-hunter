/**
 * Valig LinkedIn jobs scraper provider.
 * Actor: valig/linkedin-jobs-scraper
 * Makes one call per keyword × location, runs all in parallel.
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow } from '../types';

const ACTOR_ID = 'valig/linkedin-jobs-scraper';
const LIMIT_PER_CALL = 1000;
// Largest skipJobId array verified against the actor (63.6 KB of input JSON, accepted).
const MAX_SKIP_IDS = 5000;
const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5_000;

interface ValigJob {
  id?: string;
  url?: string;
  title?: string;
  location?: string;
  companyName?: string; // actor returns no company object — nothing to feed company enrichment
  applyUrl?: string;
  postedDate?: string; // "YYYY-MM-DD"
  description?: string;
  descriptionHtml?: string;
  logo?: string;
  salary?: string; // already display-ready, e.g. "$250,000.00/yr - $800,000.00/yr"
}

function getDatePosted(dateRange: DateRange): string {
  if (dateRange === '24h') return 'r86400';
  if (dateRange === '7d') return 'r604800';
  return 'r2592000';
}

function mapToJobPosting(item: ValigJob): JobPosting {
  const jobId = String(item.id || '');
  const url = item.url || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '');
  const applyUrl = (item.applyUrl && item.applyUrl !== url) ? item.applyUrl : null;
  const postedDate = item.postedDate || null;
  const description = item.descriptionHtml || item.description || '';

  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: item.companyName || 'Unknown Company',
    location: item.location || '',
    workMode: '',
    url,
    applyUrl,
    postedDate,
    postedDateConfidence: postedDate ? 'HIGH' : 'LOW',
    description: description.substring(0, 20_000),
    provider: 'valig',
    jobSource: 'LinkedIn',
    logoUrl: item.logo || undefined,
    salary: item.salary?.trim().substring(0, 100) || undefined,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Actor's `remote` filter codes: 1 = On-site, 2 = Remote, 3 = Hybrid
const WORK_MODE_MAP: Record<string, string> = {
  onsite: '1',
  remote: '2',
  hybrid: '3',
};

function mapWorkModes(workModes: string[]): string[] {
  return workModes.map((m) => WORK_MODE_MAP[m]).filter(Boolean);
}

// Actor `contractType` codes (verified schema enum): F=Full-time, P=Part-time, C=Contract,
// T=Temporary, I=Internship, O=Other. Our "fixedterm" bucket = contract + temporary.
const CONTRACT_TYPE_MAP: Record<string, string[]> = {
  fulltime: ['F'],
  parttime: ['P'],
  fixedterm: ['C', 'T'],
};

function mapContractTypes(jobTypes: string[]): string[] {
  return [...new Set(jobTypes.flatMap((t) => CONTRACT_TYPE_MAP[t] || []))];
}

export interface ValigFetchOptions {
  /**
   * LinkedIn ids this profile already fetched. Omit to keep the pre-wave behaviour: one
   * parallel batch of every keyword × location, no `skipJobId` sent.
   */
  skipJobIds?: string[];
  /** Run at each wave boundary, so a stopped run ends between calls instead of after all of them. */
  onWaveBoundary?: () => void;
}

async function runSingleCall(
  client: ApifyClient,
  keyword: string,
  location: string,
  datePosted: string,
  remote: string[],
  contractType: string[],
  skipJobIds: string[] | undefined,
): Promise<{ items: ValigJob[]; costUsd: number | null }> {
  const actorInput: Record<string, unknown> = {
    title: `"${keyword}"`,
    location,
    datePosted,
    limit: LIMIT_PER_CALL,
  };
  if (remote.length > 0) actorInput.remote = remote;
  if (contractType.length > 0) actorInput.contractType = contractType;
  // Filtered out before the actor pushes them, so they are never billed (charging is per
  // dataset item). Verified: 5000 ids accepted, zero leakage, the call runs slightly faster.
  if (skipJobIds && skipJobIds.length > 0) actorInput.skipJobId = skipJobIds;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const run = await client.actor(ACTOR_ID).call(actorInput, { waitSecs: 900 });
      const { items } = await client.dataset(run.defaultDatasetId).listItems();
      const costUsd = 0.001 + items.length * 0.0004;
      return { items: items as ValigJob[], costUsd };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const isTransient = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      if (isTransient && attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(`[valig] "${keyword}"@"${location}" attempt ${attempt} failed (${code}), retrying…`);
        await sleep(FETCH_RETRY_DELAY_MS);
      } else {
        break;
      }
    }
  }
  throw lastErr;
}

export async function fetchWithValig(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
  options: ValigFetchOptions = {},
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const datePosted = getDatePosted(dateRange);
  const remote = mapWorkModes(filters.workModes);
  const contractType = mapContractTypes(filters.jobType);

  // One wave per keyword, the locations still parallel inside it. Cross-keyword overlap is the
  // only overlap there is — the same job is never returned for two locations — so each wave can
  // skip what the earlier ones returned. Without a seed list there is nothing to skip against on
  // the first wave and splitting would be pure slowdown, so it stays a single wave.
  const seeded = options.skipJobIds;
  const waves: string[][] = seeded ? filters.keywords.map((k) => [k]) : [filters.keywords];

  console.log(
    `[valig] ${filters.keywords.length * filters.locations.length} actor call(s) in ${waves.length} wave(s)` +
    ` — ${filters.keywords.length} keywords × ${filters.locations.length} locations`,
  );

  let totalCost = 0;
  let hasCost = false;
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  // Every id the actor handed back, including ones the time-window filter drops: refetching
  // those next wave would be billed and discarded again.
  const returnedIds = new Set<string>();

  for (const [waveIdx, waveKeywords] of waves.entries()) {
    options.onWaveBoundary?.();

    // This run's ids first — they are the ones this grid is actually colliding with — then the
    // seeded history, truncated to what the actor is known to accept.
    const skipJobIds = seeded
      ? [...returnedIds, ...seeded.filter((id) => !returnedIds.has(id))].slice(0, MAX_SKIP_IDS)
      : undefined;

    const calls = waveKeywords.flatMap((keyword) =>
      filters.locations.map((location) => ({ keyword, location })));

    const results = await Promise.all(
      calls.map(({ keyword, location }) =>
        runSingleCall(client, keyword, location, datePosted, remote, contractType, skipJobIds)),
    );

    let waveItems = 0;
    for (const { items, costUsd } of results) {
      if (costUsd != null) { totalCost += costUsd; hasCost = true; }
      waveItems += items.length;
      for (const item of items) {
        const job = mapToJobPosting(item);
        if (!job.jobId) continue;
        returnedIds.add(job.jobId);
        if (!seen.has(job.jobId) && filterByTimeWindow(job, dateRange)) {
          seen.add(job.jobId);
          jobs.push(job);
        }
      }
    }

    if (seeded) {
      console.log(
        `[valig] wave ${waveIdx + 1}/${waves.length} "${waveKeywords.join(', ')}": ` +
        `sent ${skipJobIds!.length} skipJobId(s), ${waveItems} item(s) billed`,
      );
    }
  }

  console.log(`[valig] Total unique jobs after time-window filter: ${jobs.length}`);

  return { jobs, apifyCostUsd: hasCost ? totalCost : null };
}
