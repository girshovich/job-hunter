/**
 * Greenhouse provider — queries the pre-fetched job pool stored in the jobs table.
 * Jobs must be populated first via the ATS Pool fetch (admin settings or daily cron).
 */

import { getDb } from '../../db';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow } from '../types';
import { resolveCountries } from '../locationNormalizer';

interface JobRow {
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  url: string | null;
  apply_url: string | null;
  posted_date: string | null;
  description: string;
}

function rowToPosting(row: JobRow): JobPosting {
  return {
    jobId:                row.linkedin_job_id,
    title:                row.title,
    company:              row.company,
    location:             row.location || '',
    workMode:             row.work_mode || 'onsite',
    url:                  row.url || '',
    applyUrl:             row.apply_url || null,
    postedDate:           row.posted_date || null,
    postedDateConfidence: 'HIGH',
    description:          row.description || '',
    provider:             'greenhouse',
    jobSource:            'Greenhouse',
  };
}

export async function fetchWithGreenhouse(
  filters: SearchFilters,
  _apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const db = getDb();
  const rows = db.prepare(
    `SELECT linkedin_job_id, title, company, location, work_mode, url, apply_url, posted_date, description
     FROM jobs WHERE job_source = 'Greenhouse'`,
  ).all() as JobRow[];

  const countryNames = await resolveCountries(filters.locations);
  const targetCountries = new Set<string>();
  for (const country of countryNames.values()) {
    if (country) targetCountries.add(country.toLowerCase());
  }

  const keywordsLower = filters.keywords.map((k) => k.toLowerCase());

  const filtered = rows.map(rowToPosting).filter((job) => {
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

  console.log(`[greenhouse] ${filtered.length}/${rows.length} pool jobs matched (${filters.keywords.join(', ')} / ${filters.locations.join(', ')})`);
  return { jobs: filtered, apifyCostUsd: 0 };
}
