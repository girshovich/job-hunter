/**
 * Layer 1 Deduplicator — Provider-level dedup by (job_source, job_id).
 * Checks the database before any AI calls. Zero API cost.
 * IDs are scoped per source: a StepStone ID "12345" does not clash with a LinkedIn ID "12345".
 */

import { getDb } from '../db';
import type { JobPosting } from './fetcher';

export interface UrlDuplicate {
  job: JobPosting;
  duplicateOfId: number;
}

/**
 * Filters out jobs already scored for this profile by checking job_profile_states.
 * Profile-scoped so each user independently scores any job, even if another profile
 * has already processed it.
 * Returns new (unseen) jobs and the provider-level duplicates separately.
 */
export function filterNewJobs(jobs: JobPosting[], profileId: number): { newJobs: JobPosting[]; providerDupes: JobPosting[] } {
  if (jobs.length === 0) return { newJobs: [], providerDupes: [] };

  const db = getDb();
  const existingIds = new Set<string>();

  // Group by jobSource to query only within the same source namespace
  const bySource = new Map<string, JobPosting[]>();
  for (const job of jobs) {
    const src = job.jobSource ?? 'LinkedIn';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(job);
  }

  for (const [source, group] of bySource) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT j.linkedin_job_id
      FROM jobs j
      JOIN job_profile_states jps ON jps.job_id = j.id AND jps.profile_id = ?
      WHERE j.job_source = ? AND j.linkedin_job_id IN (${placeholders})
    `).all(profileId, source, ...group.map((j) => j.jobId)) as Array<{ linkedin_job_id: string }>;
    for (const row of rows) existingIds.add(`${source}::${row.linkedin_job_id}`);
  }

  const newJobs       = jobs.filter((j) => !existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));
  const providerDupes = jobs.filter((j) =>  existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));

  if (providerDupes.length > 0) {
    console.log(`[deduplicator] Skipped ${providerDupes.length} already-stored jobs (provider-level dedup, source-scoped).`);
  }
  return { newJobs, providerDupes };
}

/**
 * URL-level dedup — checks whether a job's url or applyUrl matches any existing job
 * that this profile has already encountered.  Runs after provider-level dedup so the
 * new job's jobId is guaranteed to be unique; the URL match indicates a cross-source
 * repost (e.g. same role on LinkedIn and Greenhouse).
 */
export function filterDuplicatesByUrl(
  jobs: JobPosting[],
  profileId: number,
): { uniqueJobs: JobPosting[]; urlDuplicates: UrlDuplicate[] } {
  if (jobs.length === 0) return { uniqueJobs: [], urlDuplicates: [] };

  const db = getDb();

  // Load all url/apply_url values for jobs this profile has already seen
  const existingRows = db.prepare(`
    SELECT j.id, j.url, j.apply_url
    FROM jobs j
    JOIN job_profile_states jps ON jps.job_id = j.id
    WHERE jps.profile_id = ? AND (j.url IS NOT NULL OR j.apply_url IS NOT NULL)
  `).all(profileId) as Array<{ id: number; url: string | null; apply_url: string | null }>;

  const urlToId = new Map<string, number>();
  for (const row of existingRows) {
    if (row.url)       urlToId.set(row.url, row.id);
    if (row.apply_url) urlToId.set(row.apply_url, row.id);
  }

  const uniqueJobs: JobPosting[] = [];
  const urlDuplicates: UrlDuplicate[] = [];

  for (const job of jobs) {
    const matchId =
      (job.url       && urlToId.get(job.url))      ||
      (job.applyUrl  && urlToId.get(job.applyUrl))  ||
      null;

    if (matchId) {
      urlDuplicates.push({ job, duplicateOfId: matchId });
    } else {
      uniqueJobs.push(job);
    }
  }

  if (urlDuplicates.length > 0) {
    console.log(`[deduplicator] ${urlDuplicates.length} URL-duplicate(s) detected (cross-source repost).`);
  }
  return { uniqueJobs, urlDuplicates };
}
