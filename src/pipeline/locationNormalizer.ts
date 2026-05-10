import { getDb } from '../db';

// Strings Nominatim can't resolve — regional labels and LinkedIn-specific metro area names
const HARDCODED: Record<string, string> = {
  'emea': 'EMEA',
  'dach': 'DACH',
  'european union': 'European Union',
  'european economic area': 'European Economic Area',
  'greater alicante area': 'Spain',
  'greater barcelona metropolitan area': 'Spain',
  'greater bilbao metropolitan area': 'Spain',
  'greater madrid metropolitan area': 'Spain',
  'greater málaga metropolitan area': 'Spain',
  'greater orense area': 'Spain',
  'greater santander metropolitan area': 'Spain',
  'greater san sebastian area': 'Spain',
  'greater cádiz metropolitan area': 'Spain',
  'greater munich metropolitan area': 'Germany',
  'greater hamburg area': 'Germany',
  'greater dusseldorf area': 'Germany',
  'frankfurt rhine-main metropolitan area': 'Germany',
  'berlin metropolitan area': 'Germany',
  'berlin area': 'Germany',
  'greater paris metropolitan region': 'France',
  'greater marseille metropolitan area': 'France',
  'greater chicago area': 'United States',
  'greater houston': 'United States',
  'greater philadelphia': 'United States',
  'dallas-fort worth metroplex': 'United States',
  'greater hyderabad area': 'India',
  'greater johor bahru': 'Malaysia',
  'greater kempten area': 'Germany',
  'amsterdam area': 'Netherlands',
  'the randstad, netherlands': 'Netherlands',
};

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'JobHunterApp/1.0 (self-hosted job search tool)';

async function nominatimLookup(location: string): Promise<string | null> {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(location)}&format=json&addressdetails=1&limit=1`;
  const resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' } });
  if (!resp.ok) return null;
  const data = await resp.json() as Array<{ address?: { country?: string } }>;
  return data[0]?.address?.country ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolves a list of raw LinkedIn location strings to country/region labels.
 * Order of resolution: hardcoded map → DB cache → Nominatim API (1 req/sec).
 * Returns a Map from input location string to resolved country (or null if unknown).
 */
export async function resolveCountries(locations: string[]): Promise<Map<string, string | null>> {
  const db = getDb();
  const result = new Map<string, string | null>();
  const unique = [...new Set(locations.filter(Boolean))];

  // 1. Hardcoded regional labels
  for (const loc of unique) {
    const h = HARDCODED[loc.toLowerCase().trim()];
    if (h) result.set(loc, h);
  }

  // 2. DB cache
  const uncached = unique.filter(loc => !result.has(loc));
  if (uncached.length > 0) {
    const placeholders = uncached.map(() => '?').join(',');
    const rows = db.prepare<{ location: string; country: string }>(
      `SELECT location, country FROM location_country WHERE location IN (${placeholders})`,
    ).all(...uncached);
    for (const row of rows) {
      result.set(row.location, row.country || null);
    }
  }

  // 3. Nominatim for anything still unresolved
  const toFetch = unique.filter(loc => !result.has(loc));
  for (const loc of toFetch) {
    let country: string | null = null;
    try {
      country = await nominatimLookup(loc);
    } catch (err) {
      console.warn(`[locationNormalizer] Nominatim failed for "${loc}":`, (err as Error).message);
    }
    result.set(loc, country);
    db.prepare(
      `INSERT OR REPLACE INTO location_country (location, country, created_at) VALUES (?, ?, ?)`,
    ).run(loc, country ?? '', new Date().toISOString());
    if (toFetch.indexOf(loc) < toFetch.length - 1) {
      await sleep(1100); // Nominatim rate limit: 1 req/sec
    }
  }

  return result;
}
