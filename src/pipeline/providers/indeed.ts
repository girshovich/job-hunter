/**
 * Indeed jobs scraper provider.
 * Actor: valig/indeed-jobs-scraper
 * Makes one call per keyword × location, runs all in parallel.
 * Country resolution: location string → Nominatim (cached in DB) → Indeed country code.
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult, ProviderCompanyData } from '../types';
import { filterByTimeWindow } from '../types';
import { resolveCountries } from '../locationNormalizer';

const ACTOR_ID = 'valig/indeed-jobs-scraper';

// All countries supported by the Indeed actor, keyed by lowercase country name as returned by Nominatim.
export
const INDEED_CODE: Record<string, string> = {
  argentina: 'ar',
  australia: 'au',
  austria: 'at',
  bahrain: 'bh',
  belgium: 'be',
  brazil: 'br',
  canada: 'ca',
  chile: 'cl',
  china: 'cn',
  colombia: 'co',
  'costa rica': 'cr',
  'czech republic': 'cz', czechia: 'cz',
  denmark: 'dk',
  ecuador: 'ec',
  egypt: 'eg',
  finland: 'fi',
  france: 'fr',
  germany: 'de',
  greece: 'gr',
  'hong kong': 'hk',
  hungary: 'hu',
  india: 'in',
  indonesia: 'id',
  ireland: 'ie',
  israel: 'il',
  italy: 'it',
  japan: 'jp',
  kuwait: 'kw',
  luxembourg: 'lu',
  malaysia: 'my',
  mexico: 'mx',
  morocco: 'ma',
  netherlands: 'nl',
  'new zealand': 'nz',
  nigeria: 'ng',
  norway: 'no',
  oman: 'om',
  pakistan: 'pk',
  panama: 'pa',
  peru: 'pe',
  philippines: 'ph',
  poland: 'pl',
  portugal: 'pt',
  qatar: 'qa',
  romania: 'ro',
  'saudi arabia': 'sa',
  singapore: 'sg',
  'south africa': 'za',
  'south korea': 'kr',
  spain: 'es',
  sweden: 'se',
  switzerland: 'ch',
  taiwan: 'tw',
  thailand: 'th',
  turkey: 'tr', türkiye: 'tr',
  ukraine: 'ua',
  'united arab emirates': 'ae',
  'united kingdom': 'uk',
  'united states': 'us',
  uruguay: 'uy',
  venezuela: 've',
  vietnam: 'vn',
};

function datePostedParam(dateRange: DateRange): string {
  if (dateRange === '24h') return '1';
  if (dateRange === '7d')  return '7';
  return '';
}

interface IndeedJob {
  key?: string;
  url?: string;
  jobUrl?: string;
  title?: string;
  datePublished?: string;
  location?: { city?: string; admin1Code?: string; countryName?: string };
  employer?: { name?: string; briefDescription?: string; employeesCount?: string };
  attributes?: Record<string, string>;
  description?: { text?: string; html?: string };
  logoUrl?: string;
}

function toIndeedLocation(location: string): string {
  return location
    .replace(/\bgreater\b/gi, '')
    .replace(/\bmetropolitan area\b/gi, '')
    .replace(/\bmetro area\b/gi, '')
    .replace(/\barea\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLocation(loc: IndeedJob['location']): string {
  if (!loc) return '';
  const parts = [loc.city, loc.admin1Code, loc.countryName].filter(Boolean);
  return parts.join(', ');
}

// employeesCount arrives as a band string ("10,000+"), never an exact number — map it to
// employeeRange so enrichment doesn't report it as a precise headcount.
function getCompanyData(item: IndeedJob): ProviderCompanyData | undefined {
  const e = item.employer;
  if (!e) return undefined;
  const data: ProviderCompanyData = {
    description: e.briefDescription ? e.briefDescription.substring(0, 2000) : undefined,
    employeeRange: e.employeesCount || undefined,
  };
  return (data.description || data.employeeRange) ? data : undefined;
}

function mapToJobPosting(item: IndeedJob): JobPosting | null {
  const jobId = item.key || '';
  if (!jobId) return null;
  const url = item.url || item.jobUrl || '';
  const applyUrl = (item.jobUrl && item.jobUrl !== item.url) ? item.jobUrl : null;
  const description = (item.description?.html || item.description?.text || '').substring(0, 20_000);

  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: item.employer?.name || 'Unknown Company',
    location: buildLocation(item.location),
    workMode: '', // Indeed exposes no reliable work-mode signal — leave unknown

    url,
    applyUrl,
    postedDate: item.datePublished ? item.datePublished.split('T')[0] : null,
    postedDateConfidence: item.datePublished ? 'HIGH' : 'LOW',
    description,
    provider: 'indeed',
    jobSource: 'Indeed',
    logoUrl: item.logoUrl || undefined,
    companyData: getCompanyData(item),
  };
}

export async function fetchWithIndeed(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  const datePosted = datePostedParam(dateRange);

  // Resolve all unique locations to country names via Nominatim (DB-cached).
  const countryNames = await resolveCountries(filters.locations);

  const calls: Array<{ keyword: string; location: string; country: string }> = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      const countryName = countryNames.get(location);
      const code = countryName ? INDEED_CODE[countryName.toLowerCase().trim()] : undefined;
      if (!code) {
        console.log(`[indeed] Skipping "${location}" (resolved: "${countryName ?? 'unknown'}") — not in Indeed's supported countries`);
        continue;
      }
      calls.push({ keyword, location, country: code });
    }
  }
  console.log(`[indeed] ${calls.length} actor call(s)`);

  const results = await Promise.all(calls.map(async ({ keyword, location, country }) => {
    const actorLocation = toIndeedLocation(location);
    console.log(`[indeed] Searching: "${keyword}" in "${actorLocation}" (${country})`);
    const run = await client.actor(ACTOR_ID).call({
      title: keyword,
      location: actorLocation,
      country,
      limit: 100,
      datePosted,
    }, { waitSecs: 900 });
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items as IndeedJob[];
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

  console.log(`[indeed] ${jobs.length} unique jobs after time-window filter (from ${totalItems} raw)`);
  const apifyCostUsd = calls.length * 0.001 + totalItems * (0.10 / 1000);
  return { jobs, apifyCostUsd };
}
