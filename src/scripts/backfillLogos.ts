/**
 * One-time backfill: fetch Google favicons for all companies in the jobs table.
 * Run with: npx ts-node --transpile-only src/scripts/backfillLogos.ts
 *
 * - For Ashby companies: uses ats_boards.slug as domain base (slug.com)
 * - For all others: derives domain from company name
 * - Skips companies that already have a non-null logo_url
 * - Retries companies with logo_url = null (e.g., from a previous failed run)
 * - Runs 10 requests concurrently
 */

import { getDb } from '../db';
import { companyKey } from '../uiHelpers';

const CONCURRENCY = 10;

function deriveCompanyDomain(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com';
}

function domainFromWebsite(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return url.hostname.replace(/^www\./i, '') || null;
  } catch { return null; }
}

async function fetchFaviconUrl(domain: string): Promise<string | null> {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (res.ok) return url;
  } catch { /* timeout or network error */ }
  return null;
}

async function runBatch(
  batch: Array<{ company: string; domain: string }>,
  db: ReturnType<typeof getDb>,
  now: string,
): Promise<{ found: number; notFound: number }> {
  const results = await Promise.all(
    batch.map(async ({ company, domain }) => {
      const logoUrl = await fetchFaviconUrl(domain);
      return { company, logoUrl };
    }),
  );

  const upsert = db.prepare(`
    INSERT INTO companies (company, display_name, logo_url, fetched_at, logo_attempted_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(company) DO UPDATE SET
      logo_url          = COALESCE(excluded.logo_url, companies.logo_url),
      display_name      = COALESCE(companies.display_name, excluded.display_name),
      fetched_at        = excluded.fetched_at,
      logo_attempted_at = excluded.logo_attempted_at
  `);

  let found = 0, notFound = 0;
  for (const { company, logoUrl } of results) {
    upsert.run(companyKey(company), company.trim(), logoUrl, now, now);
    if (logoUrl) found++; else notFound++;
  }
  return { found, notFound };
}

async function main() {
  const db = getDb();

  // Fetch companies not yet attempted OR previously attempted with null result
  const rows = db.prepare(`
    SELECT j.company, MIN(j.job_source) AS job_source, MAX(c.website) AS website
    FROM jobs j
    LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
    WHERE c.logo_url IS NULL
    GROUP BY j.company
    ORDER BY j.company
  `).all() as Array<{ company: string; job_source: string; website: string | null }>;

  console.log(`Found ${rows.length} companies to process.`);
  if (rows.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  // Pre-load Ashby slug map (company_name → slug)
  const slugMap = new Map<string, string>();
  const slugRows = db.prepare(
    `SELECT company_name, slug FROM ats_boards WHERE ats = 'ashby'`,
  ).all() as Array<{ company_name: string; slug: string }>;
  for (const r of slugRows) slugMap.set(r.company_name, r.slug);

  const work = rows.map(({ company, job_source, website }) => {
    const slug = job_source === 'Ashby' ? slugMap.get(company) : undefined;
    // Provider website first — guessing "<name>.com" is what makes half of these lookups fail.
    const domain = domainFromWebsite(website) ?? (slug ? `${slug}.com` : deriveCompanyDomain(company));
    return { company, domain };
  });

  let totalFound = 0, totalNotFound = 0, done = 0;
  const now = new Date().toISOString();

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const { found, notFound } = await runBatch(batch, db, now);
    totalFound += found;
    totalNotFound += notFound;
    done += batch.length;
    process.stdout.write(`\r${done}/${work.length} processed — ${totalFound} logos found`);
  }

  console.log(`\nDone. ${totalFound} logos found, ${totalNotFound} not found.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
