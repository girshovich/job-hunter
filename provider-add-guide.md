# Adding a New Scraping Provider

This guide has two parts:
1. **What to gather first** — information to find or ask the PM for before writing any code.
2. **Implementation steps** — every file that must be changed, in order.

---

## Part 1 — Information to gather before starting

Do not start implementing until you have answers to everything below. Some answers come from the Apify actor page; others require asking the PM.

### Ask the PM

| Question | Why it matters |
|---|---|
| What is the Apify actor ID? | Needed for `ACTOR_ID` constant and UI labels. |
| What internal key should this provider use? (`<id>`, lowercase, no spaces) | Used as the `provider` field in the DB, URL params, and whitelist. |
| What is the human-readable platform name? (`<Source>`) | Used in badges, "View on X" buttons, email reports. |
| Which countries/regions should this provider cover? | Determines whether country-code mapping is needed (Step 1a). |
| What is the actor's **result cost** ($/1,000 results) and **actor start cost**? | Required to implement cost tracking. Find on the actor's Apify page under the Pricing tab — screenshot and share. Do not guess. |
| Does the actor have a separate external apply URL field (distinct from the job listing URL)? | Determines how `url` vs `applyUrl` are mapped. Getting this wrong shows the same URL for both "View on X" and "Apply on Website". |

### Find yourself on the Apify actor page / console

Run the actor once manually with representative inputs before writing any code. Confirm:

- **Exact input field names** — actors vary: `title` vs `query` vs `keyword`, `location` vs `city`, `country` vs `countryCode`.
- **Location format** — does it take a city name (`"Amsterdam"`), a country name (`"Netherlands"`), a country code (`"nl"`), or city + country code separately? The actor's own schema example is the ground truth.
- **Country code values** — if the actor uses codes, check the exact allowed values. They are not always standard ISO 3166-1 alpha-2. (Indeed uses `"uk"` not `"gb"`.)
- **Supported countries** — passing an unsupported country value causes a runtime error, not a graceful empty result. Get the full list.
- **Date filter parameter** — what values does it accept? (`"1"`, `"7"`, `"last24Hours"`, an integer, etc.)
- **Unique job ID field** — which output field uniquely identifies a job posting? (Used as `jobId` for deduplication.)
- **Work mode field** — how does the actor encode remote/hybrid/onsite? (Numeric code, string, separate boolean?)
- **Posted date field** — is it an ISO timestamp, a Unix epoch, a relative string? Does it need `.split('T')[0]`?

### Conventions used in this document

| Term | Meaning |
|---|---|
| `<id>` | Internal provider key, lowercase, no spaces. Examples: `glassdoor`, `xing` |
| `<Source>` | Human-readable job platform name. Examples: `Glassdoor`, `Xing` |
| `<Actor>` | Full Apify actor ID. Example: `apify/glassdoor-jobs-scraper` |

---

## Part 2 — Implementation steps

---

## Step 1 — Provider file

**Create** `src/pipeline/providers/<id>.ts`

Minimum required shape:

```ts
import { ApifyClient } from 'apify-client';
import type { JobPosting, SearchFilters, DateRange, FetchResult } from '../types';
import { filterByTimeWindow } from '../types';

const ACTOR_ID = '<Actor>';

// ... actor-specific interfaces and helpers ...

function mapToJobPosting(item: ActorItem): JobPosting | null {
  const jobId = String(item.id || '');
  if (!jobId) return null;
  return {
    jobId,
    title: item.title || 'Unknown Title',
    company: /* actor field */ '',
    location: /* actor field */ '',
    workMode: /* mapped */ 'onsite',
    url: /* actor field */ '',
    applyUrl: null,
    postedDate: /* actor field, split at 'T' if ISO */ null,
    postedDateConfidence: 'LOW',
    description: /* actor field, truncate to 20_000 */ '',
    provider: '<id>',
    jobSource: '<Source>',   // ← must match JobSource union type exactly
  };
}

export async function fetchWith<PascalId>(
  filters: SearchFilters,
  apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const client = new ApifyClient({ token: apifyToken });
  // ... build calls array (keyword × location) ...
  const seen = new Set<string>();
  const jobs: JobPosting[] = [];
  let totalItems = 0;
  // ... run actor, dedupe by jobId, filter by time window, count totalItems ...
  const apifyCostUsd = calls.length * 0.001 + totalItems * (RESULT_PRICE_PER_1K / 1000);
  return { jobs, apifyCostUsd };
}
```

**Rules:**
- `jobSource` must be a string literal matching the `JobSource` union (`'LinkedIn' | 'Indeed' | 'StepStone' | …`). If adding a new source, update the union first (see Step 2).
- Always call `filterByTimeWindow(job, dateRange)` before adding to results.
- Always truncate `description` to `20_000` chars.
- Set `waitSecs: 900` on all `.call()` invocations.
- **Never return `apifyCostUsd: null`** unless the actor's run object exposes `usageTotalUsd` reliably (HarvestAPI does; valig actors do not). For valig-based actors, calculate cost manually: `calls.length * 0.001 + totalItems * (pricePerResult / 1000)`. Find the actor's pricing on its Apify page — look for "Result" ($/1,000) and "Actor start" costs. `totalItems` is the raw item count before dedup/filtering, and `calls.length` is the number of `.call()` invocations.

**Verify:** `npx tsc --noEmit` passes with no errors.

---

## Step 1a — Location normalization (country-gated actors)

Skip this step if the actor accepts raw location strings (city names, country names) directly without needing a country code.

If the actor requires a separate country code (like Indeed's `country: "nl"`), the raw locations from the user's search groups are LinkedIn-specific labels — they cannot be passed directly to the actor.

**Why this matters:** LinkedIn uses labels like `"Amsterdam Area"`, `"Berlin Area"`, `"Greater Munich Metropolitan Area"` that most job platforms don't recognize. Passing them verbatim will either error or silently return wrong results (e.g., Indeed returning only one country's jobs because it fell back to a default).

**Pattern to follow:**

```ts
import { resolveCountries } from '../locationNormalizer';

// Map of lowercase English country name → actor-specific country code.
// Only include countries the actor actually supports.
const ACTOR_COUNTRY_CODE: Record<string, string> = {
  netherlands: 'nl',
  germany: 'de',
  // ...
};

// Strip LinkedIn-specific location label decorations before passing to the actor.
function toActorLocation(location: string): string {
  return location
    .replace(/\bgreater\b/gi, '')
    .replace(/\bmetropolitan area\b/gi, '')
    .replace(/\bmetro area\b/gi, '')
    .replace(/\barea\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchWith<PascalId>(...) {
  // Resolve all location strings to country names via Nominatim (DB-cached).
  const countryNames = await resolveCountries(filters.locations);

  const calls = [];
  for (const keyword of filters.keywords) {
    for (const location of filters.locations) {
      const countryName = countryNames.get(location);
      const code = countryName ? ACTOR_COUNTRY_CODE[countryName.toLowerCase().trim()] : undefined;
      if (!code) {
        console.log(`[<id>] Skipping "${location}" (resolved: "${countryName ?? 'unknown'}") — not supported`);
        continue;
      }
      calls.push({ keyword, location, country: code });
    }
  }

  // Use toActorLocation() when building the actor call, not the raw location string.
  const results = await Promise.all(calls.map(async ({ keyword, location, country }) => {
    const actorLocation = toActorLocation(location);
    console.log(`[<id>] Searching: "${keyword}" in "${actorLocation}" (${country})`);
    const run = await client.actor(ACTOR_ID).call({
      title: keyword,
      location: actorLocation,
      country,
      // ...
    }, { waitSecs: 900 });
    // ...
  }));
}
```

**Also check `locationNormalizer.ts`:** If user-configured locations include LinkedIn metro labels that Nominatim resolves incorrectly (e.g., `"Berlin Area"` resolving to Colombia), add them to the `HARDCODED` map at the top of that file:

```ts
'berlin area': 'Germany',
'amsterdam area': 'Netherlands',
```

Run the app once and check the `location_country` table for bad cache entries. Delete any rows where the country is clearly wrong before relying on the cache.

---

## Step 2 — Shared types

**File:** `src/pipeline/types.ts`

1. Add the new source name to the `JobSource` union:

```ts
export type JobSource = 'LinkedIn' | 'Indeed' | 'StepStone' | '<Source>';
```

2. Add the provider → source mapping to `providerToSource`:

```ts
export function providerToSource(provider: string): JobSource {
  if (provider === 'indeed')    return 'Indeed';
  if (provider === 'stepstone') return 'StepStone';
  if (provider === '<id>')      return '<Source>';   // ← add this line
  return 'LinkedIn';
}
```

**Verify:** `npx tsc --noEmit` passes.

---

## Step 3 — Fetcher

**File:** `src/pipeline/fetcher.ts`

```ts
import { fetchWith<PascalId> } from './providers/<id>';

export async function fetchJobs(...): Promise<FetchResult> {
  if (provider === 'valig')     return fetchWithValig(...);
  if (provider === 'indeed')    return fetchWithIndeed(...);
  if (provider === 'stepstone') return fetchWithStepStone(...);
  if (provider === '<id>')      return fetchWith<PascalId>(...);  // ← add
  return fetchWithHarvestApi(...);
}
```

**Verify:** `npx tsc --noEmit` passes.

---

## Step 4 — API route whitelist

**File:** `src/routes/api.ts`

Find the `validProviders` array (around line 79) and add the new id:

```ts
const validProviders = ['harvestapi', 'valig', 'indeed', 'stepstone', '<id>'];
```

**Critical:** If this line is missed, the provider will be silently stripped from every request and the pipeline will run without it, with no error message. This is the most common mistake.

**Verify:** Search the file for `validProviders` — there is exactly one occurrence. Confirm `<id>` is in the array.

---

## Step 5 — UI: provider checkboxes

**File:** `src/views/layout.ejs`

There are **two** provider checkbox lists in this file — one for the Schedule modal (`.sched-provider-check`) and one for the Run Now modal (`.run-provider-check`). Add the new provider to **both**.

Search for `sched-provider-check` and `run-provider-check` to locate each block.

```html
<!-- Schedule modal -->
<label class="flex items-center gap-2.5 cursor-pointer">
  <input type="checkbox" class="sched-provider-check w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" value="<id>">
  <span class="text-sm text-gray-700"><Source>: <Actor></span>
</label>

<!-- Run Now modal (identical structure, different CSS class) -->
<label class="flex items-center gap-2.5 cursor-pointer">
  <input type="checkbox" class="run-provider-check w-4 h-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500" value="<id>">
  <span class="text-sm text-gray-700"><Source>: <Actor></span>
</label>
```

Note: new providers should **not** have `checked` — they are opt-in.

Also update the `providerLabels` JS object (used in the schedule status display, around line 823):

```js
const providerLabels = {
  harvestapi: 'LinkedIn: harvestapi',
  valig:      'LinkedIn: valig (L)',
  indeed:     'Indeed: valig (I)',
  stepstone:  'StepStone: valig (S)',
  '<id>':     '<Source>: <Actor>',   // ← add
};
```

**Verify:** Open the Run Now modal and the Schedule modal — the new provider appears in both lists.

---

## Step 6 — UI: run log provider display

**File:** `src/views/reports.ejs`

Find the `_pmap` object in the provider badge block and add the new entry:

```js
const _pmap = {
  harvestapi: 'LinkedIn: harvestapi',
  valig:      'LinkedIn: valig (L)',
  indeed:     'Indeed: valig (I)',
  stepstone:  'StepStone: valig (S)',
  '<id>':     '<Source>: <Actor>',   // ← add
};
```

Also update the `runSrc` fallback expression that derives the source from `scraping_provider`:

```ejs
<% const runSrc = run.job_source || (
  run.scraping_provider === 'indeed'    ? 'Indeed'    :
  run.scraping_provider === 'stepstone' ? 'StepStone' :
  run.scraping_provider === '<id>'      ? '<Source>'  :   // ← add
  'LinkedIn'
); %>
```

And update the same expression inside the cost popup (search for the second `job_source ||` in the file):

```ejs
<%= run.job_source || (
  run.scraping_provider === 'harvestapi' ? 'LinkedIn' :
  run.scraping_provider === 'indeed'     ? 'Indeed'   :
  run.scraping_provider === 'stepstone'  ? 'StepStone':
  run.scraping_provider === '<id>'       ? '<Source>' :   // ← add
  run.scraping_provider
) %>
```

Provider badges in the run log use a **uniform style** (`bg-gray-100 text-gray-800`) for all providers — no per-source colour is needed here.

---

## Step 7 — UI: job detail page badge colour

**File:** `src/views/job-detail.ejs`

Find the `sourceBadgeColor` expression and add the new source:

```ejs
<% const sourceBadgeColor =
     sourceLabel === 'Indeed'    ? 'bg-blue-50 text-blue-700 border-blue-200'   :
     sourceLabel === 'StepStone' ? 'bg-orange-50 text-orange-700 border-orange-200' :
     sourceLabel === '<Source>'  ? 'bg-???-50 text-???-700 border-???-200'      :  // ← add
                                   'bg-sky-50 text-sky-700 border-sky-200'; %>
```

---

## Step 8 — UI: history page source badge colour

**File:** `src/views/history.ejs`

Find the source badge `class` expression in the table body and add the new source:

```ejs
<span class="px-1.5 py-0.5 rounded text-xs font-medium
  <%= src === 'Indeed'    ? 'bg-blue-50 text-blue-700'    :
      src === 'StepStone' ? 'bg-orange-50 text-orange-700' :
      src === '<Source>'  ? 'bg-???-50 text-???-700'       :   // ← add
      'bg-sky-50 text-sky-700' %>">
```

---

## Step 9 — Final check

Run the full TypeScript check:

```bash
npx tsc --noEmit
```

Then restart the server and:

1. Open **Settings → Run Now** — confirm the new provider checkbox appears.
2. Enable only the new provider, run — confirm a `search_runs` row appears with the correct `scraping_provider` and `job_source`.
3. Run again — confirm jobs from the first run are skipped (dedup working).
4. Check the run log — confirm the provider badge shows the correct label and colour.
5. Open a job from the new provider — confirm the source badge shows on the detail page.

---

## Checklist

**Before coding**
```
[ ] Actor ID confirmed
[ ] Internal <id> and <Source> name agreed with PM
[ ] Result cost ($/1,000) and actor start cost confirmed from Apify pricing tab
[ ] Actor input schema verified by manual test run: field names, location format, country codes, date filter
[ ] Unique job ID field identified
[ ] Work mode field format understood
[ ] External apply URL field clarified (is it separate from the listing URL?)
[ ] Supported countries listed (if country-gated)
```

**Implementation**
```
[ ] src/pipeline/providers/<id>.ts — created, jobSource set correctly, apifyCostUsd calculated (not null)
[ ] Step 1a (if country-gated): resolveCountries() wired up, toActorLocation() strips LinkedIn labels, unsupported countries skipped with log, HARDCODED map updated if needed, bad DB cache entries deleted
[ ] src/pipeline/types.ts — JobSource union updated, providerToSource updated
[ ] src/pipeline/fetcher.ts — new import + route added
[ ] src/routes/api.ts — <id> added to validProviders array
[ ] src/views/layout.ejs — checkbox in BOTH Schedule and Run Now modals, providerLabels updated
[ ] src/views/reports.ejs — _pmap updated, runSrc fallback updated (×2)
[ ] src/views/job-detail.ejs — sourceBadgeColor updated
[ ] src/views/history.ejs — source badge colour updated
[ ] npx tsc --noEmit passes
[ ] End-to-end test: run appears, jobs from expected countries present, dedup works, badges correct
```
