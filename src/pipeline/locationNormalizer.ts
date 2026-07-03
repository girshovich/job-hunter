import { getDb } from '../db';
import ALL_COUNTRIES from './countries.json';

// Lowercase recognition map: { lowercase country name | synonym → canonical display name }.
// Canonical names come from countries.json (the source of truth); synonyms/folds come from
// the admin-editable country_synonyms table. Built lazily on first use and rebuilt in place
// via loadCountryNames() after an admin edit. Used to recognize a country without a Nominatim call.
export const COUNTRY_NAMES: Record<string, string> = {};
let _countryNamesLoaded = false;

function buildCountryNames(): void {
  const db = getDb();
  let synonyms: Array<{ synonym: string; country: string }> = [];
  try {
    synonyms = db.prepare<{ synonym: string; country: string }>(
      `SELECT synonym, country FROM country_synonyms`,
    ).all();
  } catch { synonyms = []; } // table may not exist yet during early migrations
  const synonymKeys = new Set(synonyms.map((s) => s.synonym.toLowerCase()));

  for (const k of Object.keys(COUNTRY_NAMES)) delete COUNTRY_NAMES[k];
  // Canonical self-names, except those shadowed by a synonym (i.e. folded into another country).
  for (const name of ALL_COUNTRIES as string[]) {
    const lower = name.toLowerCase();
    if (!synonymKeys.has(lower)) COUNTRY_NAMES[lower] = name;
  }
  // Synonyms / folds resolve to their canonical country.
  for (const { synonym, country } of synonyms) {
    COUNTRY_NAMES[synonym.toLowerCase()] = country;
  }
  rebuildMultiwordGeo();
  _countryNamesLoaded = true;
}

function ensureCountryNames(): void {
  if (!_countryNamesLoaded) buildCountryNames();
}

/** Rebuilds the in-memory country map from countries.json + DB synonyms. Call after edits. */
export function loadCountryNames(): void {
  buildCountryNames();
}

// In-memory region caches, rebuilt by loadRegionData() from the DB (mirrors COUNTRY_NAMES).
//  REGION_MEMBERS:            canonicalLower → member countries (lowercase), from region_definitions.
//  REGION_ALIAS_TO_CANONICAL: aliasLower → canonical region display name, from region_aliases,
//                             plus an identity entry per canonical so the canonical resolves too.
export const REGION_MEMBERS: Record<string, string[]> = {};
export const REGION_ALIAS_TO_CANONICAL: Record<string, string> = {};
let _regionDataLoaded = false;

function buildRegionData(): void {
  const db = getDb();
  let members: Array<{ name: string; country: string }> = [];
  let aliases: Array<{ alias: string; region_name: string }> = [];
  try {
    members = db.prepare<{ name: string; country: string }>(
      `SELECT name, country FROM region_definitions WHERE is_active = 1`,
    ).all();
  } catch { members = []; } // table may not exist yet during early migrations
  try {
    aliases = db.prepare<{ alias: string; region_name: string }>(
      `SELECT alias, region_name FROM region_aliases`,
    ).all();
  } catch { aliases = []; }

  for (const k of Object.keys(REGION_MEMBERS)) delete REGION_MEMBERS[k];
  for (const k of Object.keys(REGION_ALIAS_TO_CANONICAL)) delete REGION_ALIAS_TO_CANONICAL[k];

  for (const { name, country } of members) {
    (REGION_MEMBERS[name.toLowerCase()] ??= []).push(country.toLowerCase());
  }
  // Canonical region set = region_aliases.region_name ∪ region_definitions.name, so an
  // empty (member-less) region still resolves and lists via its alias/identity entry.
  const canonicals = new Set<string>([
    ...aliases.map((a) => a.region_name),
    ...members.map((m) => m.name),
  ]);
  for (const name of canonicals) REGION_ALIAS_TO_CANONICAL[name.toLowerCase()] = name;
  for (const { alias, region_name } of aliases) REGION_ALIAS_TO_CANONICAL[alias.toLowerCase()] = region_name;

  rebuildMultiwordGeo();
  _regionDataLoaded = true;
}

function ensureRegionData(): void {
  if (!_regionDataLoaded) buildRegionData();
}

/** Ensures both the country map and the region caches are loaded. */
function ensureLocationData(): void {
  ensureCountryNames();
  ensureRegionData();
}

/** Rebuilds the region caches from region_definitions + region_aliases. Call after edits. */
export function loadRegionData(): void {
  buildRegionData();
}

/** Single entry point: rebuilds the country map and region caches together. Call after any
 *  country-synonym or region/alias edit so one save refreshes all recognition. */
export function loadLocationData(): void {
  buildCountryNames();
  buildRegionData();
}

/** alias/canonical region name (any case) → canonical region display name, or undefined. */
export function canonicalRegion(label: string): string | undefined {
  ensureRegionData();
  return REGION_ALIAS_TO_CANONICAL[label.toLowerCase().trim()];
}

/** Lowercase name/synonym → canonical country, or undefined. Ensures the map is loaded. */
export function lookupCountry(s: string): string | undefined {
  ensureCountryNames();
  return COUNTRY_NAMES[s.toLowerCase().trim()];
}

/** Sorted canonical country list (countries.json minus folded), for pickers/dropdowns. */
export function getCanonicalCountries(): string[] {
  ensureCountryNames();
  return [...new Set(Object.values(COUNTRY_NAMES))].sort((a, b) => a.localeCompare(b));
}

// Immutable source-of-truth country set from countries.json, independent of the
// editable synonym/fold table. Used to forbid a synonym/alias from shadowing a country.
const SOURCE_COUNTRY_SET = new Set((ALL_COUNTRIES as string[]).map((n) => n.toLowerCase()));
/** True if s is a canonical country name in the source-of-truth list (countries.json). */
export function isSourceCountry(s: string): boolean {
  return SOURCE_COUNTRY_SET.has(s.toLowerCase().trim());
}

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
  ensureCountryNames();
  // Country hint inside parentheses, e.g. "San Francisco or Remote (United States)"
  const parenCountry = [...raw.matchAll(/\(([^)]+)\)/g)]
    .map((m) => COUNTRY_NAMES[m[1].trim().toLowerCase()])
    .find(Boolean) ?? null;

  // Structural cleaning: drop [object Object] + parentheticals, take the first ';'/'|'
  // segment, strip "or …" alternatives, cap at two comma parts. Work-mode words are
  // removed by stripPoisonWords below (position-agnostic), so we no longer split on
  // dashes/slashes — that dropped the place whenever the work-mode came first.
  const cleaned  = raw.replace(/\[object Object\]/gi, '').replace(/\([^)]*\)/g, '').trim();
  const firstSeg = cleaned.split(/[;|]/)[0].trim();
  let base: string;
  const anywhereMatch = firstSeg.match(/^anywhere\s+in\s+(.*)/i);
  if (anywhereMatch) {
    base = anywhereMatch[1].split(',')[0].trim();
  } else {
    const candidate = firstSeg.replace(/\s+or\s+.*/i, '').replace(/,\s*$/, '');
    const parts = candidate.split(',').map((s) => s.trim()).filter(Boolean);
    base = parts.length > 2 ? parts.slice(0, 2).join(', ') : candidate;
  }

  return { parenCountry, query: stripPoisonWords(base) };
}

// Multi-word geo phrases (longest first) for spotting a country/region embedded in a
// part like "Remote United States". Rebuilt by buildCountryNames()/buildRegionData()
// since COUNTRY_NAMES and the region alias map are dynamic. Country aliases and macro-
// regions now live in country_synonyms / region_aliases (seeded from the old hardcoded maps).
let MULTIWORD_GEO: Array<[string, string]> = [];
function rebuildMultiwordGeo(): void {
  MULTIWORD_GEO = [...Object.entries(COUNTRY_NAMES), ...Object.entries(REGION_ALIAS_TO_CANONICAL)]
    .filter(([k]) => k.includes(' '))
    .sort((a, b) => b[0].length - a[0].length);
}

function resolveGeoPart(part: string): string | null {
  ensureLocationData();
  const s = part.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (COUNTRY_NAMES[s]) return COUNTRY_NAMES[s];
  if (REGION_ALIAS_TO_CANONICAL[s]) return REGION_ALIAS_TO_CANONICAL[s];
  for (const [phrase, label] of MULTIWORD_GEO) {
    if (s.includes(phrase)) return label;
  }
  for (const tok of s.split(/[\s,\-]+/)) {
    if (COUNTRY_NAMES[tok]) return COUNTRY_NAMES[tok];
    if (REGION_ALIAS_TO_CANONICAL[tok]) return REGION_ALIAS_TO_CANONICAL[tok];
  }
  return null;
}

/**
 * Local, network-free resolution of a location string to a single country or region
 * label via whole-token n-gram matching (longest span first): **countries — including
 * synonyms — first, then regions — including aliases**. Whole-token spans give word-
 * boundary safety (no "us" inside "Houston") and handle multiword names. Returns the
 * canonical label, or null if nothing matches. Does NOT resolve bare cities (those
 * need Nominatim); resolves an ambiguous token like "Georgia" to the country (a known
 * limitation — see PRD §7.14). Shared first pass for both the live and pool resolvers.
 */
export function resolveLabelLocal(text: string): string | null {
  ensureLocationData();
  const toks = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  if (toks.length === 0) return null;
  const maxN = Math.min(toks.length, 6);
  for (const map of [COUNTRY_NAMES, REGION_ALIAS_TO_CANONICAL]) {
    for (let n = maxN; n >= 1; n--) {
      for (let i = 0; i + n <= toks.length; i++) {
        const hit = map[toks.slice(i, i + n).join(' ')];
        if (hit) return hit;
      }
    }
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
 * Returns lowercased member countries for a region label. The label is resolved
 * through the alias map to its canonical region first, then expanded to members.
 * Returns [] if the region has no members or the label is not a known region.
 */
export function expandRegionToCountries(label: string): string[] {
  ensureRegionData();
  const canonical = REGION_ALIAS_TO_CANONICAL[label.toLowerCase().trim()];
  if (!canonical) return [];
  return REGION_MEMBERS[canonical.toLowerCase()] ?? [];
}

/**
 * Returns true if label is a known region (resolves via the alias/canonical map),
 * including member-less regions (e.g. EMEA before an admin populates it).
 */
export function isRegionLabel(label: string): boolean {
  ensureRegionData();
  return label.toLowerCase().trim() in REGION_ALIAS_TO_CANONICAL;
}

/**
 * Synchronous version — direct recognition (country names/synonyms/metros + region
 * labels) and the DB cache only, no HTTP. Returns resolved countries and a flag
 * indicating whether any locations could not be resolved (caller decides how to
 * handle unknowns). A genuinely unknown string stays unresolved (the ATS gate
 * throws on it to warm the cache); known countries/regions resolve directly.
 */
export function resolveCountriesFromCache(
  locations: string[],
): { countries: Set<string>; hasUnresolved: boolean } {
  ensureLocationData();
  const db = getDb();
  const resolved = new Map<string, string | null>();
  const unique = [...new Set(locations.filter(Boolean))];

  for (const loc of unique) {
    const direct = lookupCountry(loc) ?? canonicalRegion(loc);
    if (direct) resolved.set(loc, direct);
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
 * A profile's preferred locations for display: the union of all its roles' search
 * locations resolved to a lowercased country set, plus its current_location. Used to
 * pick which of a multi-country job's labels leads the card + flag (§ display primary).
 */
export function getPreferredCountries(profileId: number): { preferred: Set<string>; currentLocation: string } {
  const db = getDb();
  const rows = db.prepare<{ locations: string }>(
    `SELECT locations FROM search_groups WHERE profile_id = ?`,
  ).all(profileId);
  const locs: string[] = [];
  for (const r of rows) { try { locs.push(...JSON.parse(r.locations || '[]')); } catch { /* skip bad JSON */ } }
  const { countries } = resolveCountriesFromCache(locs);
  const s = db.prepare<{ current_location: string }>(
    `SELECT current_location FROM settings WHERE profile_id = ?`,
  ).get(profileId);
  return { preferred: countries, currentLocation: (s?.current_location || '').toLowerCase().trim() };
}

/**
 * Resolves a list of raw location strings to a de-duped label set and expanded country set.
 * Labels are display strings (e.g. "Germany", "DACH"); countries are lowercased members.
 * Regions expand to their member countries ([] if unpopulated).
 */
// Expands display labels (country names or region names) to a lowercased country set.
// Region labels resolve via the alias map, so an alias label expands to its canonical's members.
export function labelsToCountrySet(labels: Iterable<string>): Set<string> {
  ensureLocationData();
  const countries = new Set<string>();
  for (const label of labels) {
    const lower = label.toLowerCase();
    if (COUNTRY_NAMES[lower]) countries.add(lower);
    else for (const c of expandRegionToCountries(label)) countries.add(c);
  }
  return countries;
}

export async function resolveLocationSet(
  locations: string[],
): Promise<{ labels: string[]; countries: string[] }> {
  const resolved = await resolveCountries(locations);
  const labels = new Set<string>();
  for (const label of resolved.values()) if (label) labels.add(label);
  return { labels: [...labels], countries: [...labelsToCountrySet(labels)] };
}

/**
 * Resolves a single raw location string that may pack several locations (joined
 * by ';'/'|' or natural and/or) into its full label + expanded country set.
 * Structured delimiters are split, country-aware and/or strings expanded, and the
 * remaining elements geocoded cache-first (Nominatim fallback). Used by the runner
 * so surfaced multi-location jobs resolve every country live, not just the first.
 */
export async function resolveLocationString(raw: string): Promise<{ labels: string[]; countries: string[] }> {
  const toResolve: string[] = [];
  const labels = new Set<string>();
  // Split on structured delimiters ';'/'|' and on ' or ' (safe — no place name
  // contains it), so city-based alternatives like "London or Paris" resolve each.
  for (const el of raw.split(/\s*[;|]\s*|\s+or\s+/i).map((s) => s.trim()).filter(Boolean)) {
    const ca = splitCountryAware(el);
    if (ca) for (const l of ca) labels.add(l);
    else toResolve.push(el);
  }
  const resolved = await resolveCountries(toResolve);
  for (const v of resolved.values()) if (v) labels.add(v);
  return { labels: [...labels], countries: [...labelsToCountrySet(labels)] };
}

/**
 * Resolves a list of raw LinkedIn location strings to country/region labels.
 * Order of resolution: local recognition (exact, then token n-gram over countries/
 * synonyms then regions/aliases) → DB cache → Nominatim API (1 req/sec). The local
 * pass resolves any string that *names* a country/region without a network call;
 * only bare places (cities) fall through to Nominatim. Region aliases resolve to
 * their canonical name, so the stored label is normalized at write time.
 * Returns a Map from input location string to resolved country (or null if unknown).
 */
export async function resolveCountries(locations: string[]): Promise<Map<string, string | null>> {
  ensureLocationData();
  const db = getDb();
  const result = new Map<string, string | null>();
  const unique = [...new Set(locations.filter(Boolean))];

  // 1. Local recognition (no HTTP): exact key, then token n-gram (countries/synonyms
  //    first, then regions/aliases).
  for (const loc of unique) {
    const direct = lookupCountry(loc) ?? canonicalRegion(loc) ?? resolveLabelLocal(loc);
    if (direct) result.set(loc, direct);
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
