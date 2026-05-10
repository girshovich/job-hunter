# Adding a New Scraping Provider

This guide covers every file that must be changed when adding a new Apify-based job provider. Follow the steps in order. Each step has a "verify" note — do not skip them.

---

## Conventions

| Term | Meaning |
|---|---|
| `<id>` | Internal provider key, lowercase, no spaces. Examples: `glassdoor`, `xing` |
| `<Source>` | Human-readable job platform name. Examples: `Glassdoor`, `Xing` |
| `<Actor>` | Full Apify actor ID. Example: `apify/glassdoor-jobs-scraper` |
| `<Letter>` | Single uppercase letter for the source badge. Examples: `G`, `X` |

Decide all four before starting.

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
  // ... run actor, dedupe by jobId, filter by time window ...
  return { jobs, apifyCostUsd: null };
}
```

**Rules:**
- `jobSource` must be a string literal matching the `JobSource` union (`'LinkedIn' | 'Indeed' | 'StepStone' | …`). If adding a new source, update the union first (see Step 2).
- Always call `filterByTimeWindow(job, dateRange)` before adding to results.
- Always truncate `description` to `20_000` chars.
- Set `waitSecs: 900` on all `.call()` invocations.

**Verify:** `npx tsc --noEmit` passes with no errors.

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

Also add the new source colour to the badge `class` expression if it needs a distinct colour (otherwise it falls through to the LinkedIn default):

```ejs
<%= runSrc === 'Indeed'    ? 'bg-blue-50 text-blue-700'   :
    runSrc === 'StepStone' ? 'bg-orange-50 text-orange-700':
    runSrc === '<Source>'  ? 'bg-???-50 text-???-700'      :   // ← add if new colour
    'bg-sky-50 text-sky-700' %>
```

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

```
[ ] src/pipeline/providers/<id>.ts — created, jobSource set correctly
[ ] src/pipeline/types.ts — JobSource union updated, providerToSource updated
[ ] src/pipeline/fetcher.ts — new import + route added
[ ] src/routes/api.ts — <id> added to validProviders array
[ ] src/views/layout.ejs — checkbox in BOTH Schedule and Run Now modals, providerLabels updated
[ ] src/views/reports.ejs — _pmap updated, runSrc fallback updated (×2), badge colour added
[ ] src/views/job-detail.ejs — sourceBadgeColor updated
[ ] src/views/history.ejs — source badge colour updated
[ ] npx tsc --noEmit passes
[ ] End-to-end test: run appears, dedup works, badges correct
```
