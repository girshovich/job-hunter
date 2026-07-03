/**
 * Telegram provider — queries the Telegram job pool (job_source='Telegram').
 * Descriptions are stored inline at ingestion; no external API call at run-time.
 */

import { getDb } from '../../db';
import { resolveCountriesFromCache } from '../locationNormalizer';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';

interface JobRow {
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  country: string | null;
  work_mode: string | null;
  url: string | null;
  apply_url: string | null;
  posted_date: string | null;
  description: string | null;
}

export async function fetchWithTelegram(
  filters: SearchFilters,
  _apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const db = getDb();

  const bufferHours = dateRange === '24h' ? 48 : dateRange === '7d' ? 8 * 24 : 35 * 24;
  const cutoff = new Date();
  cutoff.setUTCHours(cutoff.getUTCHours() - bufferHours);
  const cutoffISO = cutoff.toISOString();

  const keywordClauses = filters.keywords.map(() => `(LOWER(j.title) LIKE ? OR LOWER(j.description) LIKE ?)`).join(' OR ');
  const keywordParams  = filters.keywords.flatMap((k) => [`%${k.toLowerCase()}%`, `%${k.toLowerCase()}%`]);

  // Location filter for Telegram — mirrors the Ashby/Greenhouse pool filters so the
  // full resolved country set is checked (not just the first). Keep a job if any of:
  //   • a target country is in its job_countries (region members already expanded), or
  //   • its raw location text mentions a target country (partially-resolved fallback), or
  //   • it has no resolved country at all (unknown → the AI scorer judges it downstream).
  let locationClause = '';
  let locationParams: string[] = [];

  if (filters.locations.length > 0) {
    const { countries: targetCountries } = resolveCountriesFromCache(filters.locations);
    if (targetCountries.size > 0) {
      const countryList    = [...targetCountries];
      const inPlaceholders = countryList.map(() => '?').join(', ');
      const likeClauses    = countryList.map(() => `LOWER(COALESCE(j.location, '')) LIKE ?`).join(' OR ');
      locationClause = `AND (
        EXISTS (SELECT 1 FROM job_countries jc WHERE jc.job_id = j.id AND jc.country IN (${inPlaceholders}))
        OR NOT EXISTS (SELECT 1 FROM job_countries jc WHERE jc.job_id = j.id)
        OR (${likeClauses})
      )`;
      locationParams = [...countryList, ...countryList.map((c) => `%${c}%`)];
    }
    // If no countries resolved yet, skip location filter so Telegram still returns keyword matches.
  }

  const sql = `
    SELECT j.linkedin_job_id, j.title, j.company, j.location, j.country, j.work_mode,
           j.url, j.apply_url, j.posted_date, j.description
    FROM jobs j
    WHERE j.job_source = 'Telegram'
      AND (j.posted_date IS NULL OR j.posted_date >= ?)
      AND (${keywordClauses || '1=1'})
      ${locationClause}
  `;

  const rows = db.prepare(sql).all(cutoffISO, ...keywordParams, ...locationParams) as JobRow[];

  const jobs: JobPosting[] = rows.map((row) => ({
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
    provider:             'telegram',
    jobSource:            'Telegram',
  }));

  console.log(`[telegram] ${jobs.length} pool jobs matched (${filters.keywords.join(', ')} / ${filters.locations.join(', ')})`);
  return { jobs, apifyCostUsd: 0 };
}
