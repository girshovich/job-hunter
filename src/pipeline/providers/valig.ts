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

async function runSingleCall(
  client: ApifyClient,
  keyword: string,
  location: string,
  datePosted: string,
  remote: string[],
  contractType: string[],
): Promise<{ items: ValigJob[]; costUsd: number | null }> {
  const actorInput: Record<string, unknown> = {
    title: `"${keyword}"`,
    location,
    datePosted,
    limit: LIMIT_PER_CALL,
  };
  if (remote.length > 0) actorInput.remote = remote;
  if (contractType.length > 0) actorInput.contractType = contractType;

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
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const datePosted = getDatePosted(dateRange);
  const remote = mapWorkModes(filters.workModes);
  const contractType = mapContractTypes(filters.jobType);

  const calls: Array<{ keyword: string; location: string }> = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      calls.push({ keyword, location });
    }
  }

  console.log(`[valig] ${calls.length} actor call(s) — ${filters.keywords.length} keywords × ${filters.locations.length} locations`);

  const results = await Promise.all(
    calls.map(({ keyword, location }) => runSingleCall(client, keyword, location, datePosted, remote, contractType)),
  );

  let totalCost = 0;
  let hasCost = false;
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];

  for (const { items, costUsd } of results) {
    if (costUsd != null) { totalCost += costUsd; hasCost = true; }
    for (const item of items) {
      const job = mapToJobPosting(item);
      if (job.jobId && !seen.has(job.jobId) && filterByTimeWindow(job, dateRange)) {
        seen.add(job.jobId);
        jobs.push(job);
      }
    }
  }

  console.log(`[valig] Total unique jobs after time-window filter: ${jobs.length}`);

  return { jobs, apifyCostUsd: hasCost ? totalCost : null };
}
