/**
 * ATS Pool Fetcher — pre-fetches all Greenhouse and Ashby jobs into the shared jobs pool.
 * Called by manual admin triggers and the daily cron. Providers then query the pool at run-time.
 */

import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';
import { parsePostedDate } from './types';
import { HARDCODED } from './locationNormalizer';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT    = 'JobHunterApp/1.0 (self-hosted job search tool)';

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

  populateCountriesFromCache(db, 'Greenhouse');

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
    const allLocs = [job.location, ...(job.secondaryLocations ?? [])]
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
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

  populateCountriesFromCache(db, 'Ashby');

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Ashby jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  return { fetched, boards: slugs.length, durationMs };
}

// ── Country resolution ────────────────────────────────────────────────────────

/**
 * Sync, cache-only: populates jobs.country for pool jobs whose location is
 * already known (hardcoded map or location_country cache). Called automatically
 * after each pool fetch so incremental new locations are resolved instantly.
 */
function populateCountriesFromCache(db: Database, jobSource: 'Ashby' | 'Greenhouse'): void {
  const locs = db.prepare(
    `SELECT DISTINCT location FROM jobs WHERE job_source = ? AND location IS NOT NULL AND country IS NULL`,
  ).all(jobSource) as { location: string }[];
  if (locs.length === 0) return;

  const resolved = new Map<string, string>();

  for (const { location } of locs) {
    const h = HARDCODED[location.toLowerCase().trim()];
    if (h) { resolved.set(location, h); }
  }

  const uncached = locs.map((r) => r.location).filter((l) => !resolved.has(l));
  if (uncached.length > 0) {
    const placeholders = uncached.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT location, country FROM location_country WHERE location IN (${placeholders})`,
    ).all(...uncached) as { location: string; country: string }[];
    for (const row of rows) {
      if (row.country) resolved.set(row.location, row.country);
    }
  }

  if (resolved.size === 0) return;
  const update = db.prepare(
    `UPDATE jobs SET country = ? WHERE job_source = ? AND location = ? AND country IS NULL`,
  );
  db.transaction(() => {
    for (const [loc, country] of resolved) update.run(country, jobSource, loc);
  });
  console.log(`[pool] Populated country for ${resolved.size} ${jobSource} location(s) from cache`);
}

/**
 * Manual resolve: finds all pool jobs with country IS NULL and resolves their
 * locations via hardcoded map → DB cache → Nominatim (1 req/sec).
 * Updates both jobs.country and the location_country cache.
 */
export async function resolvePoolCountries(
  db: Database,
  runId?: string,
): Promise<{ resolved: number; total: number; durationMs: number }> {
  const start = Date.now();

  const locs = db.prepare(
    `SELECT DISTINCT location FROM jobs
     WHERE job_source IN ('Ashby', 'Greenhouse') AND location IS NOT NULL AND country IS NULL`,
  ).all() as { location: string }[];

  const total = locs.length;
  emitToRun(runId ?? '', { msg: `Found ${total} unique unresolved location(s)…`, total });

  if (total === 0) {
    emitToRun(runId ?? '', { msg: 'All pool job locations already resolved.', done: true, inserted: 0 });
    return { resolved: 0, total: 0, durationMs: Date.now() - start };
  }

  const updateJobs   = db.prepare(
    `UPDATE jobs SET country = ? WHERE job_source IN ('Ashby', 'Greenhouse') AND location = ? AND country IS NULL`,
  );
  const cacheUpsert  = db.prepare(
    `INSERT OR REPLACE INTO location_country (location, country, created_at) VALUES (?, ?, ?)`,
  );

  let resolved  = 0;
  let nominatimCalls = 0;

  for (let i = 0; i < locs.length; i++) {
    if (isCancelled(runId ?? '')) break;
    const loc = locs[i].location;

    // 1. Hardcoded map
    const hardcoded = HARDCODED[loc.toLowerCase().trim()];
    if (hardcoded) {
      updateJobs.run(hardcoded, loc);
      cacheUpsert.run(loc, hardcoded, new Date().toISOString());
      resolved++;
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${hardcoded}`, processed: i + 1, total });
      continue;
    }

    // 2. DB cache
    const cached = db.prepare(
      `SELECT country FROM location_country WHERE location = ?`,
    ).get(loc) as { country: string } | undefined;
    if (cached !== undefined) {
      if (cached.country) { updateJobs.run(cached.country, loc); resolved++; }
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${cached.country || 'unknown'} (cached)`, processed: i + 1, total });
      continue;
    }

    // 3. Nominatim — clean up compound/multi-city location strings before querying:
    //    a) strip "[object Object]" noise from old bad rows
    //    b) take the first ';'-delimited segment
    //    c) if an em/en-dash separates a country prefix from a city list
    //       (e.g. "US – Seattle, San Jose, Portland"), take just the prefix ("US")
    //    d) if still a 3+-part comma list (e.g. "Seattle, Portland, NY"), take first 2
    let country: string | null = null;
    const locForQuery = (() => {
      const cleaned  = loc.replace(/\[object Object\]/gi, '').trim();
      const firstSeg = cleaned.split(';')[0].trim();
      const dashParts = firstSeg.split(/\s*[–—]\s*/); // em-dash or en-dash
      const candidate = dashParts[0].trim().replace(/,\s*$/, '');
      const parts = candidate.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.length > 2 ? parts.slice(0, 2).join(', ') : candidate;
    })();
    try {
      if (!locForQuery) throw new Error('empty query');
      const url = `${NOMINATIM_URL}?q=${encodeURIComponent(locForQuery)}&format=json&addressdetails=1&limit=1`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const data = await resp.json() as Array<{ address?: { country?: string } }>;
        country = data[0]?.address?.country ?? null;
      }
    } catch { /* timeout/network error — leave as null */ }

    cacheUpsert.run(loc, country ?? '', new Date().toISOString());
    if (country) { updateJobs.run(country, loc); resolved++; }
    nominatimCalls++;
    emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${country || 'unknown'}`, processed: i + 1, total });

    if (i < locs.length - 1) await new Promise((r) => setTimeout(r, 1100));
  }

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${resolved}/${total} resolved (${nominatimCalls} Nominatim calls, ${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: resolved,
  });
  return { resolved, total, durationMs };
}
