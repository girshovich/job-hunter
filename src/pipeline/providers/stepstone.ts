/**
 * StepStone jobs scraper provider.
 * Actor: valig/stepstone-jobs-scraper
 * Makes one call per keyword × location, runs all in parallel.
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow } from '../types';

const ACTOR_ID = 'valig/stepstone-jobs-scraper';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function mapWorkMode(wfh: string | undefined): string {
  if (wfh === '2') return 'remote';
  if (wfh === '1') return 'hybrid';
  return 'onsite';
}

function agParam(dateRange: DateRange): string | undefined {
  if (dateRange === '24h') return 'age_1';
  if (dateRange === '7d')  return 'age_7';
  return undefined; // 'month' → omit for all dates
}

function wfhParam(workModes: string[]): string | undefined {
  const hasRemote = workModes.includes('remote');
  const hasHybrid = workModes.includes('hybrid');
  if (hasRemote && !hasHybrid) return '2';
  if (hasHybrid && !hasRemote) return '1';
  return undefined; // both or onsite-only → omit filter, return all
}

interface StepStoneLocation {
  location?: string;
  postCode?: string | null;
}

interface StepStoneCompany {
  name?: string;
  url?: string;
}

interface StepStoneSection {
  name?: string;
  title?: string;
  content?: string;
}

interface StepStoneJob {
  id?: number | string;
  title?: string;
  url?: string;
  datePosted?: string;
  workFromHome?: string;
  location?: StepStoneLocation;
  company?: StepStoneCompany;
  textSections?: StepStoneSection[];
  textSnippet?: string;
}

function buildDescription(sections: StepStoneSection[] | undefined, snippet: string | undefined): string {
  if (sections && sections.length > 0) {
    return sections
      .map((s) => `${s.title ? `## ${s.title}\n` : ''}${stripHtml(s.content || '')}`)
      .join('\n\n')
      .substring(0, 20_000);
  }
  return snippet ? stripHtml(snippet).substring(0, 2_000) : '';
}

function mapToJobPosting(item: StepStoneJob): JobPosting | null {
  const rawId = String(item.id || '');
  if (!rawId) return null;

  return {
    jobId: rawId,
    title: item.title || 'Unknown Title',
    company: item.company?.name || 'Unknown Company',
    location: item.location?.location || '',
    workMode: mapWorkMode(item.workFromHome),
    url: item.url || '',
    applyUrl: null,
    postedDate: item.datePosted ? item.datePosted.split('T')[0] : null,
    postedDateConfidence: item.datePosted ? 'HIGH' : 'LOW',
    description: buildDescription(item.textSections, item.textSnippet),
    provider: 'stepstone',
    jobSource: 'StepStone',
  };
}

export async function fetchWithStepStone(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const ag  = agParam(dateRange);
  const wfh = wfhParam(filters.workModes);

  const calls: Array<{ keyword: string; location: string }> = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      calls.push({ keyword, location });
    }
  }
  console.log(`[stepstone] ${calls.length} actor call(s)`);

  const results = await Promise.all(calls.map(async ({ keyword, location }) => {
    const input: Record<string, unknown> = {
      keywords: keyword,
      location,
      sort: '2',   // newest first
      limit: 100,
    };
    if (ag)  input.ag  = ag;
    if (wfh) input.wfh = wfh;
    if (filters.jobType?.toLowerCase().includes('full')) input.wt = '80001';

    const run = await client.actor(ACTOR_ID).call(input, { waitSecs: 900 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as StepStoneJob[];
  }));

  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  let totalItems = 0;

  for (const items of results) {
    for (const item of items) {
      totalItems++;
      const job = mapToJobPosting(item);
      if (!job || seen.has(job.jobId)) continue;
      if (filterByTimeWindow(job, dateRange)) {
        seen.add(job.jobId);
        jobs.push(job);
      }
    }
  }

  console.log(`[stepstone] ${jobs.length} unique jobs after time-window filter (from ${totalItems} raw)`);
  const apifyCostUsd = calls.length * 0.001 + totalItems * (1.00 / 1000);
  return { jobs, apifyCostUsd };
}
