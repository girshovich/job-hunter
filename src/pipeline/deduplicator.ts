/**
 * Layer 1 Deduplicator — Provider-level dedup by (job_source, job_id).
 * Checks the database before any AI calls. Zero API cost.
 * IDs are scoped per source: a StepStone ID "12345" does not clash with a LinkedIn ID "12345".
 */

import { getDb } from '../db';
import type { JobPosting } from './fetcher';

/**
 * Filters out jobs whose (linkedin_job_id, job_source) pair already exists in the DB.
 * Returns new (unseen) jobs and the provider-level duplicates separately.
 */
export function filterNewJobs(jobs: JobPosting[]): { newJobs: JobPosting[]; providerDupes: JobPosting[] } {
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
    const rows = db
      .prepare(`SELECT linkedin_job_id FROM jobs WHERE job_source = ? AND linkedin_job_id IN (${placeholders})`)
      .all(source, ...group.map((j) => j.jobId)) as Array<{ linkedin_job_id: string }>;
    for (const row of rows) existingIds.add(`${source}::${row.linkedin_job_id}`);
  }

  const newJobs      = jobs.filter((j) => !existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));
  const providerDupes = jobs.filter((j) =>  existingIds.has(`${j.jobSource ?? 'LinkedIn'}::${j.jobId}`));

  if (providerDupes.length > 0) {
    console.log(`[deduplicator] Skipped ${providerDupes.length} already-stored jobs (provider-level dedup, source-scoped).`);
  }
  return { newJobs, providerDupes };
}
