/**
 * Greenhouse provider — queries the pre-fetched job pool stored in the jobs table.
 * Jobs must be populated first via the ATS Pool fetch (admin settings or daily cron).
 *
 * All filtering (keyword, date, country) is pushed into SQL so only matching rows
 * are loaded into memory — the pool can be very large (tens of thousands of jobs).
 */

import { getDb } from '../../db';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { resolveCountriesFromCache } from '../locationNormalizer';

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

  const { countries: targetCountries, hasUnresolved } = resolveCountriesFromCache(filters.locations);
  if (hasUnresolved) {
    const unresolved = filters.locations.filter((loc) => {
      const lower = loc.toLowerCase().trim();
      return !targetCountries.has(lower) && ![...targetCountries].some((c) => c === lower);
    });
    throw new Error(
      `Cannot resolve search location(s) to countries: ${unresolved.join(', ')}. ` +
      `Run a standard (LinkedIn/Indeed) provider once to populate the location cache, then retry.`,
    );
  }

  const bufferHours = dateRange === '24h' ? 48 : dateRange === '7d' ? 8 * 24 : 35 * 24;
  const cutoff = new Date();
  cutoff.setUTCHours(cutoff.getUTCHours() - bufferHours);
  const cutoffISO = cutoff.toISOString();

  const keywordClauses = filters.keywords.map(() => `LOWER(title) LIKE ?`).join(' OR ');
  const keywordParams  = filters.keywords.map((k) => `%${k.toLowerCase()}%`);

  // Primary: match jobs.country (populated by resolve-countries / post-fetch sweep).
  // Fallback: LIKE on raw location string for jobs whose country is still NULL.
  let locationClause = '';
  let locationParams: string[] = [];
  if (targetCountries.size > 0) {
    const countryList    = [...targetCountries];
    const inPlaceholders = countryList.map(() => '?').join(', ');
    const likeClauses    = countryList.map(() => `LOWER(COALESCE(location, '')) LIKE ?`).join(' OR ');
    locationClause = `AND (
      LOWER(country) IN (${inPlaceholders})
      OR (country IS NULL AND (${likeClauses}))
    )`;
    locationParams = [
      ...countryList,
      ...countryList.map((c) => `%${c}%`),
    ];
  }

  const sql = `
    SELECT linkedin_job_id, title, company, location, work_mode, url, apply_url, posted_date, description
    FROM jobs
    WHERE job_source = 'Greenhouse'
      AND (posted_date IS NULL OR posted_date >= ?)
      AND (${keywordClauses || '1=1'})
      ${locationClause}
  `;

  const rows = db.prepare(sql).all(cutoffISO, ...keywordParams, ...locationParams) as JobRow[];
  const jobs = rows.map(rowToPosting);

  console.log(`[greenhouse] ${jobs.length} pool jobs matched via SQL (${filters.keywords.join(', ')} / ${filters.locations.join(', ')})`);
  return { jobs, apifyCostUsd: 0 };
}
