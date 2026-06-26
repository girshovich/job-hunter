/**
 * ATS Pool Fetcher — pre-fetches all Greenhouse and Ashby jobs into the shared jobs pool.
 * Called by manual admin triggers and the daily cron. Providers then query the pool at run-time.
 */

import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';
import { parsePostedDate } from './types';
import { HARDCODED, COUNTRY_NAMES } from './locationNormalizer';
import COUNTRIES_LIST from './countries.json';
import { resolveAshbyCompanyName } from './ashbyCompanyName';

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
  ats_slug: string;
}

async function fetchGhBoard(slug: string, companyName: string): Promise<GhJobToInsert[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
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
      ats_slug:        slug,
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
    INSERT INTO jobs (linkedin_job_id, job_source, provider, ats_slug, title, company, location, country, work_mode,
                      description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Greenhouse', 'greenhouse', ?, ?, ?, ?, NULL, 'onsite', '', ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      fetched_at = excluded.fetched_at,
      company    = excluded.company,
      ats_slug   = excluded.ats_slug
  `);

  let fetched = 0;
  let processed = 0;

  await withConcurrencyMap(slugs, 10, async ({ slug, company_name }) => {
    if (isCancelled(runId ?? '')) return;
    const jobs = await fetchGhBoard(slug, company_name || slug);
    db.transaction(() => {
      for (const j of jobs) {
        upsert.run(j.linkedin_job_id, j.ats_slug, j.title, j.company, j.location, j.url, j.apply_url, j.posted_date, now);
        fetched++;
      }
    });
    processed++;
    if (processed % 100 === 0 || processed === slugs.length) {
      emitToRun(runId ?? '', { msg: `${processed}/${slugs.length} boards`, processed, total: slugs.length });
    }
    if (processed % 200 === 0) {
      db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  populateCountriesFromCache(db, 'Greenhouse');
  clearUnclaimedPoolDescriptions(db, 'Greenhouse');
  db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Greenhouse jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  db.prepare(
    `UPDATE settings SET ats_pool_gh_last_fetch = ? WHERE profile_id = (SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1)`,
  ).run(new Date().toISOString());
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
  workplaceType?: string | null;
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
  ats_slug: string;
}

interface AshbyBoardFetchResult {
  companyName: string;
  jobs: AshbyJobToInsert[];
}

function mapAshbyWorkMode(job: AshbyJobRaw): string {
  const workplaceType = (job.workplaceType || '').toLowerCase();
  if (workplaceType.includes('hybrid')) return 'hybrid';
  if (workplaceType.includes('remote') || job.isRemote) return 'remote';
  return 'onsite';
}

async function fetchAshbyBoard(slug: string, storedName: string | null): Promise<AshbyBoardFetchResult | null> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch { return null; }
  if (!res.ok) return null;
  let data: AshbyApiResponse;
  try { data = await res.json() as AshbyApiResponse; } catch { return null; }
  const companyName = await resolveAshbyCompanyName(slug, data, storedName);
  const jobs = (data.jobs ?? []).map((job): AshbyJobToInsert => {
    const { date: postedDate } = parsePostedDate(job.publishedAt ?? undefined);
    const allLocs = [job.location, ...(job.secondaryLocations ?? [])]
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
    return {
      linkedin_job_id: job.id,
      title:           job.title || '',
      company:         companyName,
      location:        allLocs.join('; ') || null,
      work_mode:       mapAshbyWorkMode(job),
      url:             job.jobUrl || '',
      apply_url:       job.applyUrl || null,
      posted_date:     postedDate,
      ats_slug:        slug,
    };
  });
  return { companyName, jobs };
}

export async function fetchAshbyPool(db: Database, runId?: string): Promise<PoolFetchResult> {
  const start = Date.now();
  const slugs = db.prepare(
    `SELECT slug, company_name FROM ats_boards WHERE ats = 'ashby' AND is_active = 1`,
  ).all() as Array<{ slug: string; company_name: string | null }>;

  emitToRun(runId ?? '', { msg: `Fetching jobs from ${slugs.length} Ashby boards…`, total: slugs.length });

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO jobs (linkedin_job_id, job_source, provider, ats_slug, title, company, location, country, work_mode,
                      description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Ashby', 'ashby', ?, ?, ?, ?, NULL, ?, '', ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      fetched_at  = excluded.fetched_at,
      ats_slug     = excluded.ats_slug,
      title       = excluded.title,
      company     = excluded.company,
      location    = excluded.location,
      country     = CASE WHEN jobs.location IS NOT excluded.location THEN NULL ELSE jobs.country END,
      url         = excluded.url,
      apply_url   = COALESCE(excluded.apply_url, jobs.apply_url),
      posted_date = excluded.posted_date
  `);
  const updateBoardName = db.prepare(`
    UPDATE ats_boards SET company_name = ?
    WHERE ats = 'ashby' AND slug = ? AND (company_name IS NULL OR company_name != ?)
  `);

  let fetched = 0;
  let processed = 0;

  await withConcurrencyMap(slugs, 10, async ({ slug, company_name }) => {
    if (isCancelled(runId ?? '')) return;
    const result = await fetchAshbyBoard(slug, company_name);
    if (result) {
      db.transaction(() => {
        updateBoardName.run(result.companyName, slug, result.companyName);
        for (const j of result.jobs) {
          upsert.run(j.linkedin_job_id, j.ats_slug, j.title, j.company, j.location, j.work_mode, j.url, j.apply_url, j.posted_date, now);
          fetched++;
        }
      });
    }
    processed++;
    if (processed % 100 === 0 || processed === slugs.length) {
      emitToRun(runId ?? '', { msg: `${processed}/${slugs.length} boards`, processed, total: slugs.length });
    }
    if (processed % 200 === 0) {
      db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  populateCountriesFromCache(db, 'Ashby');
  clearUnclaimedPoolDescriptions(db, 'Ashby');
  db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Ashby jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  db.prepare(
    `UPDATE settings SET ats_pool_ashby_last_fetch = ? WHERE profile_id = (SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1)`,
  ).run(new Date().toISOString());
  return { fetched, boards: slugs.length, durationMs };
}

// ── Country resolution ────────────────────────────────────────────────────────

/**
 * Sync, cache-only: populates jobs.country for pool jobs whose location is
 * already known (hardcoded map or location_country cache). Called automatically
 * after each pool fetch so incremental new locations are resolved instantly.
 * Also writes job_locations + job_countries child tables for resolved jobs.
 * Change-guard: only jobs with country IS NULL (new or location-changed) are processed.
 */
export function populateCountriesFromCache(db: Database, jobSource: 'Ashby' | 'Greenhouse' | 'Telegram'): void {
  const jobs = db.prepare<{ id: number; location: string }>(
    `SELECT id, location FROM jobs WHERE job_source = ? AND location IS NOT NULL AND country IS NULL`,
  ).all(jobSource);
  if (jobs.length === 0) return;

  // For Ashby: split joined "loc1; loc2" into per-element arrays. Others: single element.
  const jobElements = new Map<number, string[]>();
  const allElements = new Set<string>();
  for (const { id, location } of jobs) {
    const elements = jobSource === 'Ashby'
      ? location.split('; ').map((s) => s.trim()).filter(Boolean)
      : [location];
    jobElements.set(id, elements);
    for (const e of elements) allElements.add(e);
  }

  // Resolve unique elements from HARDCODED and DB cache
  const resolved = new Map<string, string>();
  for (const e of allElements) {
    const h = HARDCODED[e.toLowerCase().trim()];
    if (h) resolved.set(e, h);
  }
  const uncached = [...allElements].filter((e) => !resolved.has(e));
  if (uncached.length > 0) {
    const placeholders = uncached.map(() => '?').join(',');
    const rows = db.prepare<{ location: string; country: string }>(
      `SELECT location, country FROM location_country WHERE location IN (${placeholders})`,
    ).all(...uncached);
    for (const row of rows) {
      if (row.country) resolved.set(row.location, row.country);
    }
  }

  if (resolved.size === 0) return;

  const updateCountry = db.prepare<unknown>(
    `UPDATE jobs SET country = ? WHERE id = ? AND country IS NULL`,
  );
  const deleteLocs     = db.prepare<unknown>(`DELETE FROM job_locations WHERE job_id = ?`);
  const deleteCountries = db.prepare<unknown>(`DELETE FROM job_countries WHERE job_id = ?`);
  const insertLoc      = db.prepare<unknown>(`INSERT OR IGNORE INTO job_locations (job_id, label) VALUES (?, ?)`);
  const checkRegion    = db.prepare<{ c: number }>(
    `SELECT COUNT(*) as c FROM region_definitions WHERE name = ? COLLATE NOCASE AND is_active = 1`,
  );
  const insertCountryDirect = db.prepare<unknown>(
    `INSERT OR IGNORE INTO job_countries (job_id, country) VALUES (?, LOWER(?))`,
  );
  const insertCountryRegion = db.prepare<unknown>(
    `INSERT OR IGNORE INTO job_countries (job_id, country)
     SELECT ?, rd.country FROM region_definitions rd WHERE rd.name = ? COLLATE NOCASE AND rd.is_active = 1`,
  );

  let updatedCount = 0;
  db.transaction(() => {
    for (const [jobId, elements] of jobElements) {
      const labels = elements.map((e) => resolved.get(e)).filter((l): l is string => l !== undefined);
      if (labels.length === 0) continue;
      updateCountry.run(labels[0], jobId);
      deleteLocs.run(jobId);
      deleteCountries.run(jobId);
      for (const label of labels) {
        insertLoc.run(jobId, label);
        const regionRow = checkRegion.get(label);
        if (regionRow && regionRow.c > 0) {
          insertCountryRegion.run(jobId, label);
        } else {
          insertCountryDirect.run(jobId, label);
        }
      }
      updatedCount++;
    }
  });
  console.log(`[pool] Populated country/child tables for ${updatedCount} ${jobSource} job(s) from cache`);
}

function clearUnclaimedPoolDescriptions(db: Database, jobSource: 'Ashby' | 'Greenhouse'): void {
  const result = db.prepare(`
    DELETE FROM job_descriptions
    WHERE job_id IN (
      SELECT id FROM jobs
      WHERE job_source = ?
        AND id NOT IN (SELECT job_id FROM job_profile_states)
    )
  `).run(jobSource) as { changes: number };

  if (result.changes > 0) {
    console.log(`[pool] Removed ${result.changes} unclaimed ${jobSource} description(s)`);
  }
}

/**
 * Manual resolve: finds all pool jobs with country IS NULL and resolves their
 * locations via hardcoded map → DB cache → Nominatim (1 req/sec).
 * Updates both jobs.country and the location_country cache.
 */
export async function resolvePoolCountries(
  db: Database,
  runId?: string,
  options: { recheckUnknowns?: boolean } = {},
): Promise<{ resolved: number; total: number; durationMs: number }> {
  const start = Date.now();
  const recheckUnknowns = !!options.recheckUnknowns;

  const locs = recheckUnknowns
    ? db.prepare(
      `SELECT DISTINCT j.location FROM jobs j
       JOIN location_country lc ON lc.location = j.location AND lc.country = ''
       WHERE j.job_source IN ('Ashby', 'Greenhouse', 'Telegram') AND j.location IS NOT NULL AND j.country IS NULL`,
    ).all() as { location: string }[]
    : db.prepare(
      `SELECT DISTINCT j.location FROM jobs j
       LEFT JOIN location_country lc ON lc.location = j.location
       WHERE j.job_source IN ('Ashby', 'Greenhouse', 'Telegram')
         AND j.location IS NOT NULL
         AND j.country IS NULL
         AND (lc.location IS NULL OR lc.country != '')`,
    ).all() as { location: string }[];

  const total = locs.length;
  emitToRun(runId ?? '', {
    msg: recheckUnknowns
      ? `Found ${total} previously unknown location(s)…`
      : `Found ${total} new/cacheable unresolved location(s)…`,
    total,
  });

  if (total === 0) {
    emitToRun(runId ?? '', {
      msg: recheckUnknowns ? 'No cached unknown locations to re-check.' : 'No new pool job locations to resolve.',
      done: true,
      inserted: 0,
    });
    return { resolved: 0, total: 0, durationMs: Date.now() - start };
  }

  const updateJobs   = db.prepare(
    `UPDATE jobs SET country = ? WHERE job_source IN ('Ashby', 'Greenhouse', 'Telegram') AND location = ? AND country IS NULL`,
  );
  const cacheUpsert  = db.prepare(
    `INSERT OR REPLACE INTO location_country (location, country, created_at) VALUES (?, ?, ?)`,
  );

  let resolved  = 0;
  let nominatimCalls = 0;

  for (let i = 0; i < locs.length; i++) {
    if (isCancelled(runId ?? '')) break;
    const loc = locs[i].location;

    // 1. Country-name substring scan — find the first known country mentioned in the string
    const locLower = loc.toLowerCase();
    const containedCountry = COUNTRIES_LIST.find(name => locLower.includes(name.toLowerCase())) ?? null;
    if (containedCountry) {
      updateJobs.run(containedCountry, loc);
      cacheUpsert.run(loc, containedCountry, new Date().toISOString());
      resolved++;
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${containedCountry}`, processed: i + 1, total });
      continue;
    }

    // 2. Hardcoded map
    const hardcoded = HARDCODED[loc.toLowerCase().trim()];
    if (hardcoded) {
      updateJobs.run(hardcoded, loc);
      cacheUpsert.run(loc, hardcoded, new Date().toISOString());
      resolved++;
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${hardcoded}`, processed: i + 1, total });
      continue;
    }

    // 3. DB cache
    const cached = recheckUnknowns ? undefined : db.prepare(
      `SELECT country FROM location_country WHERE location = ?`,
    ).get(loc) as { country: string } | undefined;
    if (cached !== undefined) {
      if (cached.country) { updateJobs.run(cached.country, loc); resolved++; }
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${cached.country || 'unknown'} (cached)`, processed: i + 1, total });
      continue;
    }

    // 4. Resolve via direct country-name lookup or Nominatim.
    let country: string | null = null;

    // 4a. Extract country from parenthetical hints, e.g. "San Francisco or Remote (United States)"
    const parenCountry = [...loc.matchAll(/\(([^)]+)\)/g)]
      .map(m => COUNTRY_NAMES[m[1].trim().toLowerCase()])
      .find(Boolean) ?? null;

    // 4b. Build cleaned query for Nominatim.
    const locForQuery = (() => {
      const cleaned  = loc.replace(/\[object Object\]/gi, '').replace(/\([^)]*\)/g, '').trim();
      const firstSeg = cleaned.split(';')[0].trim();
      // "Anywhere in France, Belgium, Spain" → take first country after prefix
      const anywhereMatch = firstSeg.match(/^anywhere\s+in\s+(.*)/i);
      if (anywhereMatch) return anywhereMatch[1].split(',')[0].trim();
      // split on em/en-dash, space-hyphen-space, or space-slash-space (work-mode suffixes)
      const dashParts = firstSeg.split(/\s*[–—]\s*|\s+-\s+|\s+\/\s+/);
      // strip "or …" alternatives e.g. "New York City or San Francisco"
      const candidate = dashParts[0].trim().replace(/\s+or\s+.*/i, '').replace(/,\s*$/, '');
      const parts = candidate.split(',').map((s) => s.trim()).filter(Boolean);
      return parts.length > 2 ? parts.slice(0, 2).join(', ') : candidate;
    })();

    // 4c. Direct country-name recognition (avoids a Nominatim round-trip)
    const directCountry = parenCountry ?? COUNTRY_NAMES[locForQuery.toLowerCase().trim()];
    if (directCountry) {
      country = directCountry;
    } else {
      // 4d. Nominatim
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
      nominatimCalls++;
      if (i < locs.length - 1) await new Promise((r) => setTimeout(r, 1100));
    }

    if (country) {
      cacheUpsert.run(loc, country, new Date().toISOString());
      updateJobs.run(country, loc);
      resolved++;
    } else {
      cacheUpsert.run(loc, '', new Date().toISOString());
    }
    emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${loc}" → ${country || 'unknown'}`, processed: i + 1, total });
  }

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${resolved}/${total} resolved (${nominatimCalls} Nominatim calls, ${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: resolved,
  });
  return { resolved, total, durationMs };
}
