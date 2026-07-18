/**
 * ATS Pool Fetcher — pre-fetches all Greenhouse and Ashby jobs into the shared jobs pool.
 * Called by manual admin triggers and the daily cron. Providers then query the pool at run-time.
 */

import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';
import { parsePostedDate } from './types';
import { lookupCountry, canonicalRegion, resolveLabelLocal, cleanLocationForGeocoding, splitCountryAware, getCanonicalCountries } from './locationNormalizer';
import { resolveAshbyCompanyName } from './ashbyCompanyName';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT    = 'JobHunterApp/1.0 (self-hosted job search tool)';

// ISO-3166-1 alpha-2 → canonical country name (must match countries.json values).
// Lever postings expose `country` as an alpha-2 code; used to pre-resolve job countries
// without geocoding. Unmapped codes → null (job flows through resolvePoolCountries instead).
const ISO_ALPHA2_TO_COUNTRY: Record<string, string> = {
  US: 'United States', GB: 'United Kingdom', CA: 'Canada', IE: 'Ireland',
  DE: 'Germany', FR: 'France', ES: 'Spain', PT: 'Portugal', IT: 'Italy',
  NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', AT: 'Austria', CH: 'Switzerland',
  SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IS: 'Iceland',
  PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania',
  BG: 'Bulgaria', GR: 'Greece', HR: 'Croatia', SI: 'Slovenia', RS: 'Serbia',
  EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', UA: 'Ukraine',
  IN: 'India', SG: 'Singapore', AU: 'Australia', NZ: 'New Zealand',
  JP: 'Japan', KR: 'South Korea', CN: 'China', HK: 'Hong Kong', TW: 'Taiwan',
  IL: 'Israel', AE: 'United Arab Emirates', TR: 'Turkey', ZA: 'South Africa',
  BR: 'Brazil', MX: 'Mexico', AR: 'Argentina', CL: 'Chile', CO: 'Colombia',
  // Extend as needed; unmapped codes safely fall back to the resolve pipeline.
};

function countryFromCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return ISO_ALPHA2_TO_COUNTRY[code.toUpperCase().trim()] ?? null;
}

// Dev guard: warn if any mapped name isn't a canonical country (spelling drift → silent no-match).
if (process.env.NODE_ENV !== 'production') {
  const canon = new Set(getCanonicalCountries().map((c) => c.toLowerCase()));
  for (const name of Object.values(ISO_ALPHA2_TO_COUNTRY)) {
    if (!canon.has(name.toLowerCase())) console.warn(`[lever] ISO map value not canonical: "${name}"`);
  }
}

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
                      employment_type, description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Greenhouse', 'greenhouse', ?, ?, ?, ?, NULL, '', NULL, '', ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      fetched_at      = excluded.fetched_at,
      ats_slug        = excluded.ats_slug,
      title           = excluded.title,
      company         = excluded.company,
      location        = excluded.location,
      country         = CASE WHEN jobs.location IS NOT excluded.location THEN NULL ELSE jobs.country END,
      work_mode       = excluded.work_mode,
      employment_type = excluded.employment_type,
      url             = excluded.url,
      apply_url       = COALESCE(excluded.apply_url, jobs.apply_url),
      posted_date     = excluded.posted_date
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
  employmentType?: string | null;
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
  employment_type: string | null;
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

// Normalize Ashby's raw employmentType (FullTime/PartTime/Contract/Intern/Temporary) to a
// lowercase token stored in jobs.employment_type; null when the API omits it. The runtime
// filter maps our canonical job-type buckets onto these values.
function mapAshbyEmploymentType(job: AshbyJobRaw): string | null {
  const raw = (job.employmentType || '').toLowerCase().replace(/[^a-z]/g, '');
  return raw || null;
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
      employment_type: mapAshbyEmploymentType(job),
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
                      employment_type, description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Ashby', 'ashby', ?, ?, ?, ?, NULL, ?, ?, '', ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      fetched_at      = excluded.fetched_at,
      ats_slug        = excluded.ats_slug,
      title           = excluded.title,
      company         = excluded.company,
      location        = excluded.location,
      country         = CASE WHEN jobs.location IS NOT excluded.location THEN NULL ELSE jobs.country END,
      work_mode       = excluded.work_mode,
      employment_type = excluded.employment_type,
      url             = excluded.url,
      apply_url       = COALESCE(excluded.apply_url, jobs.apply_url),
      posted_date     = excluded.posted_date
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
          upsert.run(j.linkedin_job_id, j.ats_slug, j.title, j.company, j.location, j.work_mode, j.employment_type, j.url, j.apply_url, j.posted_date, now);
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

// ── Lever ─────────────────────────────────────────────────────────────────────

interface LeverPostingRaw {
  id: string;
  text: string;
  createdAt: number | null;
  workplaceType: string | null;
  country: string | null;
  hostedUrl: string;
  applyUrl: string | null;
  categories: { location?: string | null; allLocations?: string[] | null } | null;
}

interface LeverJobToInsert {
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;        // allLocations joined with '; '
  locationLabels: string[];       // individual labels (for job_locations)
  work_mode: string;
  url: string;
  apply_url: string | null;
  posted_date: string | null;
  ats_slug: string;
  countryName: string | null;     // resolved from ISO code, or null
}

function mapLeverWorkMode(job: LeverPostingRaw): string {
  const wt = (job.workplaceType || '').toLowerCase();
  if (wt === 'hybrid') return 'hybrid';
  if (wt === 'remote') return 'remote';
  return 'onsite';
}

async function fetchLeverBoard(slug: string, companyName: string): Promise<LeverJobToInsert[]> {
  let res: Response;
  try {
    res = await fetch(
      `https://api.lever.co/v0/postings/${slug}?mode=json`,
      { signal: AbortSignal.timeout(15_000) },
    );
  } catch { return []; }
  if (!res.ok) return [];
  let data: LeverPostingRaw[];
  try { data = await res.json() as LeverPostingRaw[]; } catch { return []; }
  if (!Array.isArray(data)) return [];

  return data.map((job): LeverJobToInsert => {
    const { date: postedDate } = parsePostedDate(job.createdAt ?? undefined);
    const labels = (job.categories?.allLocations && job.categories.allLocations.length > 0
      ? job.categories.allLocations
      : [job.categories?.location].filter(Boolean) as string[])
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0);
    return {
      linkedin_job_id: job.id,
      title:           job.text || '',
      company:         companyName || slug,
      location:        labels.join('; ') || null,
      locationLabels:  labels,
      work_mode:       mapLeverWorkMode(job),
      url:             job.hostedUrl || '',
      apply_url:       job.applyUrl || null,
      posted_date:     postedDate,
      ats_slug:        slug,
      // Trust Lever's single country code ONLY for single-location postings.
      // Multi-location postings (>1 location) get one code for the whole posting,
      // which can't describe multiple countries — leave null so the resolve
      // pipeline resolves each location element correctly.
      countryName:     labels.length <= 1 ? countryFromCode(job.country) : null,
    };
  });
}

export async function fetchLeverPool(db: Database, runId?: string): Promise<PoolFetchResult> {
  const start = Date.now();
  const slugs = db.prepare(
    `SELECT slug, company_name FROM ats_boards WHERE ats = 'lever' AND is_active = 1`,
  ).all() as Array<{ slug: string; company_name: string | null }>;

  emitToRun(runId ?? '', { msg: `Fetching jobs from ${slugs.length} Lever boards…`, total: slugs.length });

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO jobs (linkedin_job_id, job_source, provider, ats_slug, title, company, location, country, work_mode,
                      employment_type, description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Lever', 'lever', ?, ?, ?, ?, NULL, ?, NULL, '', ?, ?, ?, ?)
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      fetched_at      = excluded.fetched_at,
      ats_slug        = excluded.ats_slug,
      title           = excluded.title,
      company         = excluded.company,
      location        = excluded.location,
      -- Q1: reset country when the location set changes so it is re-resolved (matches Ashby's
      -- upsert). Single-location jobs are re-set from the ISO code below; multi-location jobs
      -- fall to populateCountriesFromCache/resolvePoolCountries. Without this, a job whose
      -- location changed (esp. single→multi) would keep a stale country + job_countries forever.
      country         = CASE WHEN jobs.location IS NOT excluded.location THEN NULL ELSE jobs.country END,
      work_mode       = excluded.work_mode,
      employment_type = excluded.employment_type,
      url             = excluded.url,
      apply_url       = COALESCE(excluded.apply_url, jobs.apply_url),
      posted_date     = excluded.posted_date
    RETURNING id
  `);
  // Inline country-from-code assembly (mirrors populateCountriesFromCache output).
  // Q3-B: the upsert uses RETURNING id (verified working in this project's node:sqlite on both
  // insert and conflict-update paths), so no separate SELECT id is needed.
  const setCountry  = db.prepare(`UPDATE jobs SET country = ? WHERE id = ?`);
  const delLoc      = db.prepare(`DELETE FROM job_locations WHERE job_id = ?`);
  const delCty      = db.prepare(`DELETE FROM job_countries WHERE job_id = ?`);
  const insLoc      = db.prepare(`INSERT OR IGNORE INTO job_locations (job_id, label) VALUES (?, ?)`);
  const insCty      = db.prepare(`INSERT OR IGNORE INTO job_countries (job_id, country) VALUES (?, LOWER(?))`);

  let fetched = 0;
  let processed = 0;

  await withConcurrencyMap(slugs, 10, async ({ slug, company_name }) => {
    if (isCancelled(runId ?? '')) return;
    const jobs = await fetchLeverBoard(slug, company_name || slug);
    db.transaction(() => {
      for (const j of jobs) {
        const row = upsert.get(
          j.linkedin_job_id, j.ats_slug, j.title, j.company, j.location, j.work_mode, j.url, j.apply_url, j.posted_date, now,
        ) as { id: number } | undefined;
        fetched++;
        if (j.countryName && row) {
          setCountry.run(j.countryName, row.id);
          delLoc.run(row.id);
          delCty.run(row.id);
          for (const label of j.locationLabels) insLoc.run(row.id, label);
          insCty.run(row.id, j.countryName);
        }
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

  // Jobs whose ISO code was missing/unmappable still have country = NULL — let the
  // shared cache resolver fill them (same path as Greenhouse/Ashby).
  populateCountriesFromCache(db, 'Lever');
  clearUnclaimedPoolDescriptions(db, 'Lever');
  db.exec(`PRAGMA wal_checkpoint(PASSIVE)`);

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${fetched} Lever jobs stored (${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: fetched,
  });
  db.prepare(
    `UPDATE settings SET ats_pool_lever_last_fetch = ? WHERE profile_id = (SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1)`,
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
export function populateCountriesFromCache(db: Database, jobSource: 'Ashby' | 'Greenhouse' | 'Lever' | 'Telegram'): void {
  const jobs = db.prepare<{ id: number; location: string }>(
    `SELECT id, location FROM jobs WHERE job_source = ? AND location IS NOT NULL AND country IS NULL`,
  ).all(jobSource);
  if (jobs.length === 0) return;

  // Split multi-location strings on ';' or '|' — both are list delimiters used by ATS
  // feeds (Ashby joins with '; '; Greenhouse uses ';' and/or '|', sometimes mixed).
  // Each element is then run through a country-aware and/or split ("Canada and US"
  // → two pre-resolved country labels) before falling back to cache resolution.
  const jobElements = new Map<number, string[]>();
  const allElements = new Set<string>();
  const resolved = new Map<string, string>();
  for (const { id, location } of jobs) {
    const elements: string[] = [];
    for (const raw of location.split(/\s*[;|]\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean)) {
      const caLabels = splitCountryAware(raw);
      if (caLabels) {
        for (const lbl of caLabels) { elements.push(lbl); resolved.set(lbl, lbl); }
      } else {
        elements.push(raw);
      }
    }
    jobElements.set(id, elements);
    for (const e of elements) allElements.add(e);
  }

  // Resolve remaining unique elements by direct recognition (country/synonym/metro
  // + region label) then DB cache
  for (const e of allElements) {
    if (resolved.has(e)) continue;
    const h = lookupCountry(e) ?? canonicalRegion(e);
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

function clearUnclaimedPoolDescriptions(db: Database, jobSource: 'Ashby' | 'Greenhouse' | 'Lever'): void {
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
 * Distinct pool location *elements* still needing resolution. Each unresolved job
 * location is split on ';'/'|'/' or '; country-aware and/or strings are skipped (they
 * self-resolve without geocoding); the rest are keyed individually against the
 * location_country cache. Normal mode returns elements never looked at (uncached);
 * recheck mode returns those cached as unknown (''). Shared by the resolver (the work
 * to geocode) and the admin badge (how many chunks are left to resolve).
 */
export function unresolvedPoolElements(db: Database, recheckUnknowns = false): string[] {
  const jobLocs = db.prepare(
    `SELECT DISTINCT location FROM jobs
     WHERE job_source IN ('Ashby', 'Greenhouse', 'Lever', 'Telegram')
       AND location IS NOT NULL AND country IS NULL`,
  ).all() as { location: string }[];

  const cache = new Map<string, string>();
  for (const r of db.prepare(`SELECT location, country FROM location_country`).all() as { location: string; country: string }[]) {
    cache.set(r.location, r.country);
  }

  const work = new Set<string>();
  for (const { location } of jobLocs) {
    for (const raw of location.split(/\s*[;|]\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean)) {
      if (splitCountryAware(raw)) continue;
      const cached = cache.get(raw);
      if (recheckUnknowns ? cached === '' : cached === undefined) work.add(raw);
    }
  }
  return [...work];
}

/**
 * Manual resolve: warms the location cache for every distinct UNRESOLVED pool
 * location *element* (each whole string split on ';'/'|'; country-aware and/or
 * strings are skipped — they self-resolve), via substring scan → hardcoded →
 * Nominatim (1 req/sec). Each element is geocoded at most once and cached, so
 * cost scales with distinct places, not jobs. Assembly of jobs.country +
 * job_locations/job_countries is then delegated to populateCountriesFromCache.
 */
export async function resolvePoolCountries(
  db: Database,
  runId?: string,
  options: { recheckUnknowns?: boolean } = {},
): Promise<{ resolved: number; total: number; durationMs: number }> {
  const start = Date.now();
  const recheckUnknowns = !!options.recheckUnknowns;

  const elements = unresolvedPoolElements(db, recheckUnknowns);
  const total = elements.length;
  emitToRun(runId ?? '', {
    msg: recheckUnknowns
      ? `Found ${total} previously unknown location element(s)…`
      : `Found ${total} new location element(s) to resolve…`,
    total,
  });

  const cacheUpsert = db.prepare(
    `INSERT OR REPLACE INTO location_country (location, country, created_at) VALUES (?, ?, ?)`,
  );

  let resolved = 0;
  let nominatimCalls = 0;

  for (let i = 0; i < elements.length; i++) {
    if (isCancelled(runId ?? '')) break;
    const el = elements[i];

    // 1. Local recognition (no HTTP): exact key, then whole-token n-gram over
    //    countries/synonyms then regions/aliases. Replaces the old country substring
    //    scan — token matching is word-boundary safe and synonym/region aware.
    const direct = lookupCountry(el) ?? canonicalRegion(el) ?? resolveLabelLocal(el);
    if (direct) {
      cacheUpsert.run(el, direct, new Date().toISOString());
      resolved++;
      emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${el}" → ${direct}`, processed: i + 1, total });
      continue;
    }

    // 2. Clean + parenthetical/exact country recognition (avoids a Nominatim round-trip)
    const { parenCountry, query } = cleanLocationForGeocoding(el);
    let country: string | null = parenCountry ?? lookupCountry(query) ?? null;

    // 4. Nominatim
    if (!country) {
      try {
        if (!query) throw new Error('empty query');
        const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1`;
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
      if (i < elements.length - 1) await new Promise((r) => setTimeout(r, 1100));
    }

    cacheUpsert.run(el, country ?? '', new Date().toISOString());
    if (country) resolved++;
    emitToRun(runId ?? '', { msg: `[${i + 1}/${total}] "${el}" → ${country || 'unknown'}`, processed: i + 1, total });
  }

  // Assemble jobs.country + child tables from the now-warm cache.
  for (const src of ['Ashby', 'Greenhouse', 'Lever', 'Telegram'] as const) {
    populateCountriesFromCache(db, src);
  }

  const durationMs = Date.now() - start;
  emitToRun(runId ?? '', {
    msg: `Done — ${resolved}/${total} element(s) resolved (${nominatimCalls} Nominatim calls, ${Math.round(durationMs / 1000)}s)`,
    done: true,
    inserted: resolved,
  });
  return { resolved, total, durationMs };
}
