/**
 * ATS Pool Fetcher — pre-fetches all Greenhouse and Ashby jobs into the shared jobs pool.
 * Called by manual admin triggers and the daily cron. Providers then query the pool at run-time.
 */

import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';
import { parsePostedDate } from './types';

export interface PoolFetchResult {
  fetched: number;
  boards: number;
  durationMs: number;
}

async function withConcurrencyMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const { item, i } = queue.shift()!;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Greenhouse ────────────────────────────────────────────────────────────────

interface GhJobRaw {
  id: number;
  title: string;
  absolute_url: string;
  location: { name: string } | null;
  updated_at: string;
  content: string;
}

interface GhApiResponse { jobs: GhJobRaw[] }

interface GhJobToInsert {
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  url: string;
  apply_url: string;
  posted_date: string | null;
  description: string;
}

async function fetchGhBoard(slug: string, companyName: string): Promise<GhJobToInsert[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch { return []; }
  if (!res.ok) return [];
  let data: GhApiResponse;
  try { data = await res.json() as GhApiResponse; } catch { return []; }
  return (data.jobs ?? []).map((job): GhJobToInsert => {
    const { date: postedDate } = parsePostedDate(job.updated_at);
    return {
      linkedin_job_id: String(job.id),
      title:           job.title || '',
      company:         companyName || slug,
      location:        job.location?.name || null,
      url:             job.absolute_url || '',
      apply_url:       job.absolute_url || '',
      posted_date:     postedDate,
      description:     (job.content || '').substring(0, 20_000),
    };
  });
}

export async function fetchGreenhousePool(db: Database, runId?: string): Promise<PoolFetchResult> {
  const start = Date.now();
  const slugs = db.prepare(
    `SELECT slug, company_name FROM ats_boards WHERE ats = 'greenhouse' AND is_active = 1`,
  ).all() as Array<{ slug: string; company_name: string | null }>;

  emitToRun(runId ?? '', { msg: `Fetching jobs from ${slugs.length} Greenhouse boards…`, total: slugs.length });

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO jobs (linkedin_job_id, job_source, provider, title, company, location, country, work_mode,
                      description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Greenhouse', 'greenhouse', ?, ?, ?, NULL, 'onsite', ?, ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET fetched_at = excluded.fetched_at
  `);

  let fetched = 0;
  let processed = 0;

  await withConcurrencyMap(slugs, 10, async ({ slug, company_name }) => {
    if (isCancelled(runId ?? '')) return;
    const jobs = await fetchGhBoard(slug, company_name || slug);
    db.transaction(() => {
      for (const j of jobs) {
        upsert.run(j.linkedin_job_id, j.title, j.company, j.location, j.description, j.url, j.apply_url, j.posted_date, now);
        fetched++;
      }
    });
    processed++;
    if (processed % 100 === 0 || processed === slugs.length) {
      emitToRun(runId ?? '', { msg: `${processed}/${slugs.length} boards`, processed, total: slugs.length });
    }
  });

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Greenhouse jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  return { fetched, boards: slugs.length, durationMs };
}

// ── Ashby ─────────────────────────────────────────────────────────────────────

interface AshbyJobRaw {
  id: string;
  title: string;
  jobUrl: string;
  applyUrl: string | null;
  location: string | null;
  secondaryLocations: string[] | null;
  descriptionHtml: string | null;
  descriptionPlain: string | null;
  publishedAt: string | null;
  isRemote: boolean | null;
}

interface AshbyApiResponse {
  jobs: AshbyJobRaw[];
  organization?: { name?: string };
}

interface AshbyJobToInsert {
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string;
  url: string;
  apply_url: string | null;
  posted_date: string | null;
  description: string;
}

async function fetchAshbyBoard(slug: string, storedName: string): Promise<AshbyJobToInsert[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch { return []; }
  if (!res.ok) return [];
  let data: AshbyApiResponse;
  try { data = await res.json() as AshbyApiResponse; } catch { return []; }
  const companyName = data.organization?.name || storedName || slug;
  return (data.jobs ?? []).map((job): AshbyJobToInsert => {
    const { date: postedDate } = parsePostedDate(job.publishedAt ?? undefined);
    const allLocs = [job.location, ...(job.secondaryLocations ?? [])].filter(Boolean) as string[];
    return {
      linkedin_job_id: job.id,
      title:           job.title || '',
      company:         companyName,
      location:        allLocs.join('; ') || null,
      work_mode:       job.isRemote ? 'remote' : 'onsite',
      url:             job.jobUrl || '',
      apply_url:       job.applyUrl || null,
      posted_date:     postedDate,
      description:     (job.descriptionHtml || job.descriptionPlain || '').substring(0, 20_000),
    };
  });
}

export async function fetchAshbyPool(db: Database, runId?: string): Promise<PoolFetchResult> {
  const start = Date.now();
  const slugs = db.prepare(
    `SELECT slug, company_name FROM ats_boards WHERE ats = 'ashby' AND is_active = 1`,
  ).all() as Array<{ slug: string; company_name: string | null }>;

  emitToRun(runId ?? '', { msg: `Fetching jobs from ${slugs.length} Ashby boards…`, total: slugs.length });

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO jobs (linkedin_job_id, job_source, provider, title, company, location, country, work_mode,
                      description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Ashby', 'ashby', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET fetched_at = excluded.fetched_at
  `);

  let fetched = 0;
  let processed = 0;

  await withConcurrencyMap(slugs, 10, async ({ slug, company_name }) => {
    if (isCancelled(runId ?? '')) return;
    const jobs = await fetchAshbyBoard(slug, company_name || slug);
    db.transaction(() => {
      for (const j of jobs) {
        upsert.run(j.linkedin_job_id, j.title, j.company, j.location, j.work_mode, j.description, j.url, j.apply_url, j.posted_date, now);
        fetched++;
      }
    });
    processed++;
    if (processed % 100 === 0 || processed === slugs.length) {
      emitToRun(runId ?? '', { msg: `${processed}/${slugs.length} boards`, processed, total: slugs.length });
    }
  });

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Ashby jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  return { fetched, boards: slugs.length, durationMs };
}
