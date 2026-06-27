/**
 * Ashby provider — queries the pre-fetched job pool stored in the jobs table.
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
  ats_slug: string | null;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  url: string | null;
  apply_url: string | null;
  posted_date: string | null;
  description: string;
}

interface AshbyJobRaw {
  id: string;
  descriptionHtml: string | null;
  descriptionPlain: string | null;
}

interface AshbyApiResponse { jobs: AshbyJobRaw[] }

async function hydrateDescriptions(rows: JobRow[]): Promise<JobRow[]> {
  const bySlug = new Map<string, JobRow[]>();
  for (const row of rows) {
    if (!row.description && row.ats_slug) {
      const bucket = bySlug.get(row.ats_slug) ?? [];
      bucket.push(row);
      bySlug.set(row.ats_slug, bucket);
    }
  }

  await Promise.all([...bySlug.entries()].map(async ([slug, slugRows]) => {
    let res: Response;
    try {
      res = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch { return; }
    if (!res.ok) return;

    let data: AshbyApiResponse;
    try { data = await res.json() as AshbyApiResponse; } catch { return; }

    const descriptions = new Map(
      (data.jobs ?? []).map((job) => [
        job.id,
        (job.descriptionHtml || job.descriptionPlain || '').substring(0, 20_000),
      ]),
    );
    for (const row of slugRows) {
      row.description = descriptions.get(row.linkedin_job_id) || row.description;
    }
  }));

  return rows;
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
    provider:             'ashby',
    jobSource:            'Ashby',
  };
}

export async function fetchWithAshby(
  filters: SearchFilters,
  _apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const db = getDb();

  // Resolve target countries from hardcoded map + DB cache — no HTTP requests.
  // If any location can't be resolved this way, throw: the caller should run a
  // standard LinkedIn/Indeed provider first to populate the location cache, rather
  // than risk passing thousands of unfiltered jobs to the (paid) AI scorer.
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

  // Date cutoff (same logic as filterByTimeWindow)
  const bufferHours = dateRange === '24h' ? 48 : dateRange === '7d' ? 8 * 24 : 35 * 24;
  const cutoff = new Date();
  cutoff.setUTCHours(cutoff.getUTCHours() - bufferHours);
  const cutoffISO = cutoff.toISOString();

  // Keyword filter: title must contain at least one keyword (OR)
  const keywordClauses = filters.keywords.map(() => `LOWER(j.title) LIKE ?`).join(' OR ');
  const keywordParams  = filters.keywords.map((k) => `%${k.toLowerCase()}%`);

  // Work mode filter: Ashby provides usable workplace type data in the pool.
  const workModes = filters.workModes.map((m) => m.toLowerCase()).filter(Boolean);
  const workModeClause = workModes.length > 0
    ? `AND LOWER(COALESCE(j.work_mode, 'onsite')) IN (${workModes.map(() => '?').join(', ')})`
    : '';

  // Primary: match via job_countries (expanded region members included).
  // Fallback: LIKE on raw location text for any target country — also covers
  // partially-resolved jobs whose searched country isn't in job_countries yet.
  let locationClause = '';
  let locationParams: string[] = [];
  if (targetCountries.size > 0) {
    const countryList    = [...targetCountries];
    const inPlaceholders = countryList.map(() => '?').join(', ');
    const likeClauses    = countryList.map(() => `LOWER(COALESCE(j.location, '')) LIKE ?`).join(' OR ');
    locationClause = `AND (
      EXISTS (SELECT 1 FROM job_countries jc WHERE jc.job_id = j.id AND jc.country IN (${inPlaceholders}))
      OR (${likeClauses})
    )`;
    locationParams = [
      ...countryList,
      ...countryList.map((c) => `%${c}%`),
    ];
  }

  const sql = `
    SELECT j.linkedin_job_id, j.ats_slug, j.title, j.company, j.location, j.work_mode,
           j.url, j.apply_url, j.posted_date, COALESCE(jd.description_text, j.description) AS description
    FROM jobs j
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    WHERE j.job_source = 'Ashby'
      AND (j.posted_date IS NULL OR j.posted_date >= ?)
      AND (${keywordClauses || '1=1'})
      ${workModeClause}
      ${locationClause}
  `;

  const rows = await hydrateDescriptions(
    db.prepare(sql).all(cutoffISO, ...keywordParams, ...workModes, ...locationParams) as JobRow[],
  );
  const jobs = rows.map(rowToPosting);

  console.log(`[ashby] ${jobs.length} pool jobs matched via SQL (${filters.keywords.join(', ')} / ${filters.locations.join(', ')})`);
  return { jobs, apifyCostUsd: 0 };
}
