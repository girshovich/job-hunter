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
 * Filters out jobs this profile has already processed, by (job_source, posting_job_id).
 * Scoped per profile: `jobs` is a shared catalogue and the decision lives in
 * job_profile_states, so a posting another profile stored is still new to this one and
 * must be scored for it. Keying on the state row rather than on job_postings alone also
 * keeps unscored ATS-pool rows visible — they carry no state row, by design (`db.ts`).
 * Returns new (unseen) jobs and the provider-level duplicates separately.
 */
export function filterNewJobs(jobs: JobPosting[], profileId: number): { newJobs: JobPosting[]; providerDupes: JobPosting[] } {
  if (jobs.length === 0) return { newJobs: [], providerDupes: [] };

  const db = getDb();
  const existingIds = new Set<string>();

  const bySource = new Map<string, JobPosting[]>();
  for (const job of jobs) {
    const src = job.jobSource ?? 'LinkedIn';
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(job);
  }

  for (const [source, group] of bySource) {
    const placeholders = group.map(() => '?').join(',');
    const rows = db.prepare<{ posting_job_id: string }>(
      `SELECT jp.posting_job_id
         FROM job_postings jp
         JOIN job_profile_states jps ON jps.job_id = jp.job_id AND jps.profile_id = ?
        WHERE jp.job_source = ? AND jp.posting_job_id IN (${placeholders})`,
    ).all(profileId, source, ...group.map((j) => j.jobId));
    for (const row of rows) existingIds.add(`${source}::${row.posting_job_id}`);
  }

  const newJobs       = jobs.filter((j) => !existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));
  const providerDupes = jobs.filter((j) =>  existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));

  if (providerDupes.length > 0) {
    console.log(`[deduplicator] Skipped ${providerDupes.length} already-processed jobs (provider-level dedup, profile-scoped).`);
  }
  return { newJobs, providerDupes };
}

/**
 * URL-level dedup — checks whether a job's url or applyUrl matches any existing job
 * that this profile has already encountered.  Runs after provider-level dedup so the
 * new job's jobId is one this profile has not processed before; the URL match indicates
 * a cross-source repost (e.g. same job on LinkedIn and Greenhouse).
 */
export function filterDuplicatesByUrl(
  jobs: JobPosting[],
  profileId: number,
): { uniqueJobs: JobPosting[]; urlDuplicates: UrlDuplicate[] } {
  if (jobs.length === 0) return { uniqueJobs: [], urlDuplicates: [] };

  const db = getDb();

  // Load url/apply_url values from job_postings for jobs this profile has already seen
  const existingRows = db.prepare(`
    SELECT jp.job_id AS id, jp.url, jp.apply_url
    FROM job_postings jp
    JOIN job_profile_states jps ON jps.job_id = jp.job_id AND jps.profile_id = ?
    WHERE jp.url IS NOT NULL OR jp.apply_url IS NOT NULL
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
