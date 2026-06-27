import { getDb } from '../db';

// ISO 3166-1 country names (lowercase) → canonical display name.
// Used to recognize country names directly without a Nominatim call.
export const COUNTRY_NAMES: Record<string, string> = {
  'afghanistan': 'Afghanistan', 'albania': 'Albania', 'algeria': 'Algeria',
  'andorra': 'Andorra', 'angola': 'Angola', 'argentina': 'Argentina',
  'armenia': 'Armenia', 'australia': 'Australia', 'austria': 'Austria',
  'azerbaijan': 'Azerbaijan', 'bahrain': 'Bahrain', 'bangladesh': 'Bangladesh',
  'belarus': 'Belarus', 'belgium': 'Belgium', 'belize': 'Belize',
  'benin': 'Benin', 'bolivia': 'Bolivia', 'bosnia and herzegovina': 'Bosnia and Herzegovina',
  'botswana': 'Botswana', 'brazil': 'Brazil', 'brunei': 'Brunei',
  'bulgaria': 'Bulgaria', 'burkina faso': 'Burkina Faso', 'cambodia': 'Cambodia',
  'cameroon': 'Cameroon', 'canada': 'Canada', 'chile': 'Chile',
  'china': 'China', 'colombia': 'Colombia', 'congo': 'Congo',
  'costa rica': 'Costa Rica', 'croatia': 'Croatia', 'cuba': 'Cuba',
  'cyprus': 'Cyprus', 'czech republic': 'Czech Republic', 'czechia': 'Czechia',
  'denmark': 'Denmark', 'dominican republic': 'Dominican Republic',
  'ecuador': 'Ecuador', 'egypt': 'Egypt', 'el salvador': 'El Salvador',
  'estonia': 'Estonia', 'ethiopia': 'Ethiopia', 'finland': 'Finland',
  'france': 'France', 'georgia': 'Georgia', 'germany': 'Germany',
  'ghana': 'Ghana', 'greece': 'Greece', 'guatemala': 'Guatemala',
  'honduras': 'Honduras', 'hong kong': 'Hong Kong', 'hungary': 'Hungary',
  'iceland': 'Iceland', 'india': 'India', 'indonesia': 'Indonesia',
  'iran': 'Iran', 'iraq': 'Iraq', 'ireland': 'Ireland',
  'israel': 'Israel', 'italy': 'Italy', 'ivory coast': 'Ivory Coast',
  'jamaica': 'Jamaica', 'japan': 'Japan', 'jordan': 'Jordan',
  'kazakhstan': 'Kazakhstan', 'kenya': 'Kenya', 'kosovo': 'Kosovo',
  'kuwait': 'Kuwait', 'kyrgyzstan': 'Kyrgyzstan', 'latvia': 'Latvia',
  'lebanon': 'Lebanon', 'libya': 'Libya', 'liechtenstein': 'Liechtenstein',
  'lithuania': 'Lithuania', 'luxembourg': 'Luxembourg', 'malaysia': 'Malaysia',
  'malta': 'Malta', 'mexico': 'Mexico', 'moldova': 'Moldova',
  'monaco': 'Monaco', 'mongolia': 'Mongolia', 'morocco': 'Morocco',
  'mozambique': 'Mozambique', 'myanmar': 'Myanmar', 'namibia': 'Namibia',
  'nepal': 'Nepal', 'netherlands': 'Netherlands', 'new zealand': 'New Zealand',
  'nicaragua': 'Nicaragua', 'nigeria': 'Nigeria', 'north korea': 'North Korea',
  'north macedonia': 'North Macedonia', 'norway': 'Norway', 'oman': 'Oman',
  'pakistan': 'Pakistan', 'panama': 'Panama', 'paraguay': 'Paraguay',
  'peru': 'Peru', 'philippines': 'Philippines', 'poland': 'Poland',
  'portugal': 'Portugal', 'qatar': 'Qatar', 'romania': 'Romania',
  'russia': 'Russia', 'rwanda': 'Rwanda', 'saudi arabia': 'Saudi Arabia',
  'senegal': 'Senegal', 'serbia': 'Serbia', 'singapore': 'Singapore',
  'slovakia': 'Slovakia', 'slovenia': 'Slovenia', 'somalia': 'Somalia',
  'south africa': 'South Africa', 'south korea': 'South Korea',
  'spain': 'Spain', 'sri lanka': 'Sri Lanka', 'sudan': 'Sudan',
  'sweden': 'Sweden', 'switzerland': 'Switzerland', 'syria': 'Syria',
  'taiwan': 'Taiwan', 'tanzania': 'Tanzania', 'thailand': 'Thailand',
  'tunisia': 'Tunisia', 'turkey': 'Turkey', 'turkiye': 'Turkey',
  'uganda': 'Uganda', 'ukraine': 'Ukraine',
  'united arab emirates': 'United Arab Emirates', 'uae': 'United Arab Emirates',
  'dubai': 'United Arab Emirates', 'abu dhabi': 'United Arab Emirates',
  'united kingdom': 'United Kingdom', 'uk': 'United Kingdom',
  'united states': 'United States', 'usa': 'United States',
  'united states of america': 'United States',
  'uruguay': 'Uruguay', 'uzbekistan': 'Uzbekistan', 'venezuela': 'Venezuela',
  'vietnam': 'Vietnam', 'yemen': 'Yemen', 'zambia': 'Zambia',
  'zimbabwe': 'Zimbabwe',
};

// Strings Nominatim can't resolve — regional labels and LinkedIn-specific metro area names
export const HARDCODED: Record<string, string> = {
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

/**
 * Words that are not place names and mislead geocoding (work-mode, facility,
 * scope, company/school leakage). Stripped whole-word, case-insensitive, from a
 * query before it is sent to Nominatim. Hardcoded for now; an admin-editable
 * list can replace this later.
 */
export const POISON_WORDS = new Set<string>([
  'remote', 'hybrid', 'office', 'home', 'based', 'hq', 'academy', 'site',
  'only', 'preparatory', 'multiple', 'locations', 'onsite', 'college',
  'federal', 'time', 'campus', 'blvd', 'headquarters', 'virtual', 'location',
  'офис',
]);

function stripPoisonWords(s: string): string {
  const out = s.replace(/\p{L}+/gu, (w) => (POISON_WORDS.has(w.toLowerCase()) ? '' : w));
  return out
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,\s*)+/g, ', ')
    .replace(/^[\s,;/\-]+|[\s,;/\-]+$/g, '')
    .trim();
}

/**
 * Prepares a raw location string for geocoding. Shared by the per-run resolver
 * (nominatimLookup) and the manual ATS pool sweep (resolvePoolCountries).
 * Returns a country resolved directly from a parenthetical hint (e.g.
 * "Remote (United States)") if present, plus a cleaned query with structural
 * noise and poison words removed (may be empty → caller treats it as unknown).
 */
export function cleanLocationForGeocoding(raw: string): { parenCountry: string | null; query: string } {
  // Country hint inside parentheses, e.g. "San Francisco or Remote (United States)"
  const parenCountry = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map((m) => COUNTRY_NAMES[m[1].trim().toLowerCase()])
    .find(Boolean) ?? null;

  // Structural cleaning: drop [object Object] + parentheticals, take first segment,
  // strip work-mode suffixes / "or …" alternatives, cap at two comma parts.
  const cleaned  = raw.replace(/\[object Object\]/gi, '').replace(/\([^)]*\)/g, '').trim();
  const firstSeg = cleaned.split(/[;|]/)[0].trim();
  let base: string;
  const anywhereMatch = firstSeg.match(/^anywhere\s+in\s+(.*)/i);
  if (anywhereMatch) {
    base = anywhereMatch[1].split(',')[0].trim();
  } else {
    const dashParts = firstSeg.split(/\s*[–—]\s*|\s+-\s+|\s+\/\s+/);
    const candidate = dashParts[0].trim().replace(/\s+or\s+.*/i, '').replace(/,\s*$/, '');
    const parts = candidate.split(',').map((s) => s.trim()).filter(Boolean);
    base = parts.length > 2 ? parts.slice(0, 2).join(', ') : candidate;
  }

  return { parenCountry, query: stripPoisonWords(base) };
}

// Short geo aliases absent from COUNTRY_NAMES (which holds full ISO names) plus
// macro-regions — used only by the country-aware and/or splitter below.
const GEO_ALIASES: Record<string, string> = {
  'us': 'United States', 'usa': 'United States', 'u.s.': 'United States', 'u.s.a.': 'United States',
  'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
  'uae': 'United Arab Emirates',
  'eu': 'EU', 'eea': 'EEA', 'emea': 'EMEA', 'apac': 'APAC', 'latam': 'LATAM', 'anz': 'ANZ',
  'europe': 'Europe', 'africa': 'Africa', 'asia': 'Asia', 'americas': 'Americas', 'oceania': 'Oceania',
  'north america': 'North America', 'south america': 'South America', 'middle east': 'Middle East',
  'nordics': 'Nordics', 'benelux': 'Benelux', 'dach': 'DACH',
};

// Multi-word geo phrases (longest first) for spotting a country embedded in a
// part like "Remote United States".
const MULTIWORD_GEO: Array<[string, string]> = [...Object.entries(COUNTRY_NAMES), ...Object.entries(GEO_ALIASES)]
  .filter(([k]) => k.includes(' '))
  .sort((a, b) => b[0].length - a[0].length);

function resolveGeoPart(part: string): string | null {
  const s = part.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (COUNTRY_NAMES[s]) return COUNTRY_NAMES[s];
  if (GEO_ALIASES[s]) return GEO_ALIASES[s];
  for (const [phrase, label] of MULTIWORD_GEO) {
    if (s.includes(phrase)) return label;
  }
  for (const tok of s.split(/[\s,\-]+/)) {
    if (COUNTRY_NAMES[tok]) return COUNTRY_NAMES[tok];
    if (GEO_ALIASES[tok]) return GEO_ALIASES[tok];
  }
  return null;
}

/**
 * Country-aware "and"/"or" split. Splits one location element on and/or (and
 * Oxford commas) ONLY when ≥2 parts resolve to DISTINCT known countries/regions,
 * so real names ("Bosnia and Herzegovina") and single locations ("Berlin,
 * Germany") stay intact. Returns the resolved labels, or null when it is not a
 * confident multi-country string.
 */
export function splitCountryAware(text: string): string[] | null {
  if (!/\b(?:and|or)\b|,/i.test(text)) return null;
  const parts = text.split(/\s*,\s*|\s+and\s+|\s+or\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const labels: string[] = [];
  for (const p of parts) {
    const g = resolveGeoPart(p);
    if (g && !labels.includes(g)) labels.push(g);
  }
  return labels.length >= 2 ? labels : null;
}

async function nominatimLookup(location: string): Promise<string | null> {
  const { parenCountry, query } = cleanLocationForGeocoding(location);
  const direct = parenCountry ?? COUNTRY_NAMES[query.toLowerCase().trim()];
  if (direct) return direct;
  if (!query) return null;
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!resp.ok) return null;
  const data = await resp.json() as Array<{ address?: { country?: string } }>;
  return data[0]?.address?.country ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns lowercased member countries for a region (from region_definitions).
 * Returns [] if the region has no members or is not found.
 */
export function expandRegionToCountries(label: string): string[] {
  const db = getDb();
  const rows = db.prepare<{ country: string }>(
    `SELECT country FROM region_definitions WHERE name = ? COLLATE NOCASE AND is_active = 1`,
  ).all(label);
  return rows.map((r) => r.country);
}

/**
 * Returns true if label is a known region (has at least one row in region_definitions).
 */
export function isRegionLabel(label: string): boolean {
  const db = getDb();
  const row = db.prepare(
    `SELECT 1 FROM region_definitions WHERE name = ? COLLATE NOCASE LIMIT 1`,
  ).get(label);
  return row !== undefined;
}

/**
 * Synchronous version — hardcoded map + DB cache only, no HTTP.
 * Returns resolved countries and a flag indicating whether any locations
 * could not be resolved (caller decides how to handle unknowns).
 */
export function resolveCountriesFromCache(
  locations: string[],
): { countries: Set<string>; hasUnresolved: boolean } {
  const db = getDb();
  const resolved = new Map<string, string | null>();
  const unique = [...new Set(locations.filter(Boolean))];

  for (const loc of unique) {
    const h = HARDCODED[loc.toLowerCase().trim()];
    if (h) resolved.set(loc, h);
  }

  const uncached = unique.filter((loc) => !resolved.has(loc));
  if (uncached.length > 0) {
    const placeholders = uncached.map(() => '?').join(',');
    const rows = db
      .prepare<{ location: string; country: string }>(
        `SELECT location, country FROM location_country WHERE location IN (${placeholders})`,
      )
      .all(...uncached);
    for (const row of rows) resolved.set(row.location, row.country || null);
  }

  const countries = new Set<string>();
  for (const label of resolved.values()) {
    if (!label) continue;
    const lower = label.toLowerCase();
    if (COUNTRY_NAMES[lower]) {
      countries.add(lower);
    } else {
      // Not a recognized country — treat as region label; expand to member countries (may be [])
      for (const c of expandRegionToCountries(label)) {
        countries.add(c);
      }
    }
  }

  return {
    countries,
    hasUnresolved: unique.some((loc) => !resolved.has(loc)),
  };
}

/**
 * Resolves a list of raw location strings to a de-duped label set and expanded country set.
 * Labels are display strings (e.g. "Germany", "DACH"); countries are lowercased members.
 * Regions expand to their member countries ([] if unpopulated).
 */
export async function resolveLocationSet(
  locations: string[],
): Promise<{ labels: string[]; countries: string[] }> {
  const resolved = await resolveCountries(locations);
  const seenLabels = new Set<string>();
  const seenCountries = new Set<string>();

  for (const label of resolved.values()) {
    if (!label) continue;
    seenLabels.add(label);
    const lower = label.toLowerCase();
    if (COUNTRY_NAMES[lower]) {
      seenCountries.add(lower);
    } else {
      for (const c of expandRegionToCountries(label)) {
        seenCountries.add(c);
      }
    }
  }

  return {
    labels: [...seenLabels],
    countries: [...seenCountries],
  };
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
