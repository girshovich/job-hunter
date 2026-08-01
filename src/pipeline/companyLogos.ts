import type { Database } from '../db';
import { companyKey } from '../uiHelpers';

function deriveCompanyDomain(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com';
}

// The provider's own website beats guessing "<name>.com" — that guess fails for roughly half
// of all companies. Falls back to the guess when we have no website on file.
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
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return url;
  } catch { /* timeout or network error */ }
  return null;
}

/**
 * Favicon fallback for companies that have no logo yet. Runs for every source, not just ATS:
 * only harvestapi supplies a real logo, so Indeed/StepStone/valig/Telegram companies would
 * otherwise never get one.
 */
export async function fetchCompanyLogos(
  db: Database,
  companies: Array<{ company: string; ats: string }>,
): Promise<void> {
  const unique = [...new Map(companies.map((c) => [c.company, c])).values()];

  for (const { company, ats } of unique) {
    // Skip if a real logo is already stored (a provider logo must never be replaced by a
    // guessed favicon), or if a fetch was already attempted — a null result counts, so a
    // failed lookup isn't retried every run. Must not key off the row merely existing:
    // company enrichment creates that row first, which would skip every company forever.
    const existing = db.prepare(
      'SELECT logo_url, logo_attempted_at, website FROM companies WHERE company = ?',
    ).get(companyKey(company)) as { logo_url: string | null; logo_attempted_at: string | null; website: string | null } | undefined;
    if (existing?.logo_url || existing?.logo_attempted_at) continue;

    const boardRow = db.prepare(
      'SELECT slug FROM ats_boards WHERE ats = ? AND company_name = ? LIMIT 1',
    ).get(ats, company) as { slug: string } | undefined;

    const domain = domainFromWebsite(existing?.website)
      ?? (boardRow ? `${boardRow.slug}.com` : deriveCompanyDomain(company));

    const logoUrl = await fetchFaviconUrl(domain);
    const now = new Date().toISOString();

    try {
      // Upsert, not INSERT OR IGNORE: the row usually exists already (enrichment made it),
      // and OR IGNORE would silently drop the logo we just fetched.
      db.prepare(`
        INSERT INTO companies (company, display_name, logo_url, fetched_at, logo_attempted_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(company) DO UPDATE SET
          logo_url          = COALESCE(excluded.logo_url, companies.logo_url),
          display_name      = COALESCE(companies.display_name, excluded.display_name),
          logo_attempted_at = excluded.logo_attempted_at
      `).run(companyKey(company), company.trim(), logoUrl, now, now);
    } catch { /* ignore */ }
  }
}
