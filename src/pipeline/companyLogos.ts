import type { Database } from '../db';

function deriveCompanyDomain(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9-]/g, '') + '.com';
}

async function fetchFaviconUrl(domain: string): Promise<string | null> {
  const url = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return url;
  } catch { /* timeout or network error */ }
  return null;
}

export async function fetchClearbitLogosForAts(
  db: Database,
  companies: Array<{ company: string; ats: string }>,
): Promise<void> {
  const unique = [...new Map(companies.map((c) => [c.company, c])).values()];

  for (const { company, ats } of unique) {
    const existing = db.prepare(
      'SELECT logo_url FROM companies WHERE company = ?',
    ).get(company) as { logo_url: string | null } | undefined;
    if (existing !== undefined) continue; // already attempted (even null = don't retry)

    const boardRow = db.prepare(
      'SELECT slug FROM ats_boards WHERE ats = ? AND company_name = ? LIMIT 1',
    ).get(ats, company) as { slug: string } | undefined;

    const domain = boardRow
      ? `${boardRow.slug}.com`
      : deriveCompanyDomain(company);

    const logoUrl = await fetchFaviconUrl(domain);

    try {
      db.prepare(
        'INSERT OR IGNORE INTO companies (company, logo_url, fetched_at) VALUES (?, ?, ?)',
      ).run(company, logoUrl, new Date().toISOString());
    } catch { /* ignore */ }
  }
}
