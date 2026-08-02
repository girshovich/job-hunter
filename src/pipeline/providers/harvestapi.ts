/**
 * HarvestAPI LinkedIn scraper provider.
 * Actor: harvestapi/linkedin-job-search
 */

import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult, ProviderCompanyData } from '../types';
import { parsePostedDate, filterByTimeWindow } from '../types';

interface HarvestJobLocation {
  linkedinText?: string;
  parsed?: { city?: string; state?: string; country?: string };
}

interface HarvestJob {
  id?: string;
  jobId?: string;
  title?: string;
  companyName?: string;
  company?: {
    name?: string;
    description?: string;
    employeeCount?: number;
    employeeCountRange?: { start?: number; end?: number };
    logo?: string;
    website?: string;
  } | string;
  location?: HarvestJobLocation | string;
  workplaceType?: string;
  descriptionText?: string;
  description?: string;
  descriptionHtml?: string;
  linkedinUrl?: string;
  applyUrl?: string;
  applyMethod?: { companyApplyUrl?: string; easyApplyUrl?: string };
  url?: string;
  postedDate?: string;
  listedAt?: string | number;
  logo?: string;
  salary?: { text?: string; payPeriod?: string };
}

function normalizeWorkMode(raw: string | undefined): string {
  const val = (raw || '').toLowerCase().replace(/[_\s-]/g, '');
  if (val.includes('remote')) return 'remote';
  if (val.includes('hybrid')) return 'hybrid';
  return 'onsite';
}

function getCompanyName(item: HarvestJob): string {
  if (item.companyName) return item.companyName;
  if (typeof item.company === 'string') return item.company;
  if (item.company?.name) return item.company.name;
  return 'Unknown Company';
}

// The actor nests the logo under `company`, not at the top level. Reading `item.logo` silently
// returned undefined on every job, which is why no LinkedIn logo ever reached the DB.
function getCompanyLogo(item: HarvestJob): string | undefined {
  const c = item.company;
  if (c && typeof c === 'object' && c.logo) return c.logo;
  return item.logo || undefined;
}

// The actor's top band is open-ended (`{ start: 10001 }` with no `end`), so a both-bounds-only
// rule would silently drop the size of every enterprise company.
function formatEmployeeRange(range: { start?: number; end?: number } | undefined): string | undefined {
  if (!range) return undefined;
  if (range.start != null && range.end != null) return `${range.start}-${range.end}`;
  if (range.start != null) return `${range.start}+`;
  if (range.end != null) return `1-${range.end}`;
  return undefined;
}

function getCompanyData(item: HarvestJob): ProviderCompanyData | undefined {
  const c = item.company;
  if (!c || typeof c === 'string') return undefined;
  const data: ProviderCompanyData = {
    description: c.description ? c.description.substring(0, 2000) : undefined,
    employeeCount: typeof c.employeeCount === 'number' ? c.employeeCount : undefined,
    employeeRange: formatEmployeeRange(c.employeeCountRange),
    website: c.website || undefined,
  };
  return (data.description || data.employeeCount || data.employeeRange || data.website) ? data : undefined;
}

// `salary.text` already carries the amounts and currency ("80,000 - 85,000 USD"); only the period
// is missing from it. payPeriod is an enum — YEARLY/MONTHLY/HOURLY/… — so it is spelled out rather
// than shown shouting. No text means no salary line: the structured amounts alone are not worth
// re-assembling into a second format.
const PAY_PERIOD_LABEL: Record<string, string> = {
  YEARLY: 'year', MONTHLY: 'month', WEEKLY: 'week', DAILY: 'day', HOURLY: 'hour',
};

function getSalary(item: HarvestJob): string | undefined {
  const text = item.salary?.text?.trim();
  if (!text) return undefined;
  const period = PAY_PERIOD_LABEL[(item.salary?.payPeriod || '').toUpperCase()];
  return (period ? `${text} / ${period}` : text).substring(0, 100);
}

function getLocationText(loc: HarvestJobLocation | string | undefined): string {
  if (!loc) return '';
  if (typeof loc === 'string') return loc;
  return loc.linkedinText || loc.parsed?.city || '';
}

function mapToJobPosting(item: HarvestJob): JobPosting {
  const jobId = String(item.id || item.jobId || '');
  const rawDate = item.postedDate ?? item.listedAt;
  const parsedDate = parsePostedDate(rawDate);
  const description = item.descriptionHtml || item.descriptionText || item.description || '';
  const url = item.linkedinUrl || item.url
    || (jobId ? `https://www.linkedin.com/jobs/view/${jobId}/` : '');
  const rawApplyUrl = item.applyMethod?.companyApplyUrl || item.applyUrl || null;
  const applyUrl = (rawApplyUrl && rawApplyUrl !== url) ? rawApplyUrl : null;

  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: getCompanyName(item),
    location: getLocationText(item.location),
    workMode: normalizeWorkMode(item.workplaceType),
    url,
    applyUrl,
    postedDate: parsedDate.date,
    postedDateConfidence: parsedDate.confidence,
    description: description.substring(0, 20_000),
    provider: 'harvestapi',
    jobSource: 'LinkedIn',
    logoUrl: getCompanyLogo(item),
    companyData: getCompanyData(item),
    salary: getSalary(item),
  };
}

const WORK_MODE_MAP: Record<string, string> = {
  onsite: 'office',
  hybrid: 'hybrid',
  remote: 'remote',
};

function mapWorkModes(workModes: string[]): string[] {
  return workModes.map((m) => WORK_MODE_MAP[m]).filter(Boolean);
}

// Actor `employmentType` accepts lowercase values (verified): full-time, part-time,
// contract, internship, temporary. Our "fixedterm" bucket = contract + temporary.
const EMPLOYMENT_TYPE_MAP: Record<string, string[]> = {
  fulltime: ['full-time'],
  parttime: ['part-time'],
  fixedterm: ['contract', 'temporary'],
};

function mapEmploymentTypes(jobTypes: string[]): string[] {
  return [...new Set(jobTypes.flatMap((t) => EMPLOYMENT_TYPE_MAP[t] || []))];
}

// Actor enum is exactly "1h" | "24h" | "week" | "month" — anything else is a 400 on run start.
function getPostedLimit(dateRange: DateRange): string {
  if (dateRange === '24h') return '24h';
  if (dateRange === '7d') return 'week';
  return 'month';
}

const FETCH_MAX_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 5_000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithHarvestApi(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });

  const workplaceType = mapWorkModes(filters.workModes);
  const employmentType = mapEmploymentTypes(filters.jobType);

  const actorInput: Record<string, unknown> = {
    jobTitles: filters.keywords,
    locations: filters.locations,
    postedLimit: getPostedLimit(dateRange),
    sortBy: 'date',
    maxItems: 1000,
    ...(workplaceType.length > 0 && { workplaceType }),
    ...(employmentType.length > 0 && { employmentType }),
  };

  const keywordsStr = filters.keywords.map((k) => `"${k}"`).join(', ');
  console.log(`[harvestapi] Starting actor run — ${filters.keywords.length} keywords × ${filters.locations.length} locations: ${keywordsStr}`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      const run = await client.actor('harvestapi/linkedin-job-search').call(actorInput, { waitSecs: 900 });

      console.log(`[harvestapi] Actor run complete (${run.id}), fetching dataset items…`);

      const apifyCostUsd = typeof (run as unknown as Record<string, unknown>).usageTotalUsd === 'number'
        ? (run as unknown as Record<string, unknown>).usageTotalUsd as number
        : null;

      const { items } = await client.dataset(run.defaultDatasetId).listItems();

      console.log(`[harvestapi] Raw items from actor: ${items.length}`);

      const jobs = (items as HarvestJob[])
        .map(mapToJobPosting)
        .filter((j) => j.jobId)
        .filter((j) => filterByTimeWindow(j, dateRange));

      console.log(`[harvestapi] Jobs after time-window filter: ${jobs.length}`);

      return { jobs, apifyCostUsd };
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      const isTransient = code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
      if (isTransient && attempt < FETCH_MAX_ATTEMPTS) {
        console.warn(`[harvestapi] Attempt ${attempt} failed (${code}), retrying in ${FETCH_RETRY_DELAY_MS / 1000}s…`);
        await sleep(FETCH_RETRY_DELAY_MS);
      } else {
        break;
      }
    }
  }

  throw lastErr;
}
