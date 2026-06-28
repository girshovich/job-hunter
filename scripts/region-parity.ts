/*
 * Region/country resolution parity harness (regions.md §8 step 0).
 *
 * Snapshots the synchronous, network-free resolution surface that the
 * region-aliases refactor touches, so the seed-split can be proven behavior-
 * preserving. Run against a throwaway DB before AND after the refactor and diff:
 *
 *   DATABASE_PATH=/tmp/parity-before.db npx ts-node --transpile-only scripts/region-parity.ts > before.json
 *   DATABASE_PATH=/tmp/parity-after.db  npx ts-node --transpile-only scripts/region-parity.ts > after.json
 *   diff before.json after.json   # must be empty
 *
 * The corpus is deliberately restricted to strings that resolve offline
 * (countries, synonyms, metros, region labels, country-aware and/or strings) so
 * no Nominatim call is made and output is deterministic.
 */
import * as fs from 'fs';
import {
  resolveCountriesFromCache,
  splitCountryAware,
  expandRegionToCountries,
  isRegionLabel,
} from '../src/pipeline/locationNormalizer';

const CORPUS: string[] = [
  // plain country names
  'Germany', 'United States', 'United Kingdom', 'Netherlands', 'France',
  // country synonyms / folds
  'us', 'usa', 'u.s.', 'uk', 'britain', 'england', 'uae', 'dubai', 'guam',
  'czech republic', 'turkiye',
  // metros (HARDCODED → country)
  'greater munich metropolitan area', 'berlin metropolitan area',
  'amsterdam area', 'the randstad, netherlands', 'greater madrid metropolitan area',
  'greater chicago area', 'dallas-fort worth metroplex', 'greater hyderabad area',
  // region labels (HARDCODED / GEO_ALIASES → region)
  'emea', 'EMEA', 'dach', 'DACH', 'eu', 'EU', 'european union',
  'european economic area', 'eea', 'apac', 'latam', 'anz', 'nordics',
  'benelux', 'europe', 'middle east', 'north america',
  // country-aware and/or strings
  'Canada and US', 'Germany or France', 'United States, Canada',
  'Bosnia and Herzegovina', 'Berlin, Germany',
  // noise / unresolved
  'remote', 'Mars', '',
];

const out: Record<string, unknown> = {};
for (const s of CORPUS) {
  const fromCache = resolveCountriesFromCache([s]);
  out[JSON.stringify(s)] = {
    fromCache: { countries: [...fromCache.countries].sort(), hasUnresolved: fromCache.hasUnresolved },
    split: splitCountryAware(s),
    isRegion: isRegionLabel(s),
    expand: expandRegionToCountries(s).slice().sort(),
  };
}
const dest = process.env.PARITY_OUT;
if (!dest) { console.error('Set PARITY_OUT to the output file path'); process.exit(1); }
fs.writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`[parity] wrote ${Object.keys(out).length} entries to ${dest}`);
