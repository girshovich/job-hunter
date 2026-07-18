/**
 * Shared types and utilities for scraping providers.
 */

export type JobSource = 'LinkedIn' | 'Indeed' | 'StepStone' | 'Greenhouse' | 'Ashby' | 'Lever' | 'Telegram';

export function providerToSource(provider: string): JobSource {
  if (provider === 'indeed')      return 'Indeed';
  if (provider === 'stepstone')   return 'StepStone';
  if (provider === 'greenhouse')  return 'Greenhouse';
  if (provider === 'ashby')       return 'Ashby';
  if (provider === 'lever')       return 'Lever';
  if (provider === 'telegram')    return 'Telegram';
  return 'LinkedIn';
}

export interface JobPosting {
  jobId: string;
  title: string;
  company: string;
  location: string;
  workMode: string;
  url: string;
  applyUrl: string | null;
  postedDate: string | null;
  postedDateConfidence: 'HIGH' | 'LOW';
  description: string;
  provider: string;
  jobSource: JobSource;
  logoUrl?: string;
}

export interface SearchFilters {
  keywords: string[];
  locations: string[];
  workModes: string[];
  jobType: string[];
}

// Canonical job-type tokens stored in search_groups.job_type as a JSON array.
export const JOB_TYPES = ['fulltime', 'parttime', 'fixedterm'] as const;

// Parse the stored search_groups.job_type into canonical tokens. Handles the
// current JSON-array form and the legacy single-string values ('fullTime' etc.).
export function parseJobTypes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x).toLowerCase()).filter((x) => (JOB_TYPES as readonly string[]).includes(x));
    }
  } catch { /* fall through to legacy single-string handling */ }
  const legacy: Record<string, string> = { fulltime: 'fulltime', parttime: 'parttime', contract: 'fixedterm' };
  const key = String(raw).toLowerCase();
  return legacy[key] ? [legacy[key]] : [];
}

export type DateRange = '24h' | '7d' | 'month';

export interface FetchResult {
  jobs: JobPosting[];
  apifyCostUsd: number | null;
}

export function parsePostedDate(raw: string | number | undefined): { date: string | null; confidence: 'HIGH' | 'LOW' } {
  if (!raw) return { date: null, confidence: 'LOW' };
  const ts = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!isNaN(ts) && ts > 1_000_000_000) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    return { date: new Date(ms).toISOString().split('T')[0], confidence: 'HIGH' };
  }
  const d = new Date(String(raw));
  if (!isNaN(d.getTime())) {
    return { date: d.toISOString().split('T')[0], confidence: 'HIGH' };
  }
  return { date: null, confidence: 'LOW' };
}

export function filterByTimeWindow(job: JobPosting, dateRange: DateRange = '24h'): boolean {
  if (!job.postedDate) {
    console.warn(`[fetcher] Job ${job.jobId}: missing postedDate, accepting with LOW confidence`);
    return true;
  }
  const posted = new Date(job.postedDate);
  const bufferHours = dateRange === '24h' ? 48 : dateRange === '7d' ? 8 * 24 : 35 * 24;
  const cutoff = new Date();
  cutoff.setUTCHours(cutoff.getUTCHours() - bufferHours);
  return posted >= cutoff;
}
