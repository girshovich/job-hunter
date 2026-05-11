# ATS Pool — Greenhouse & Ashby Pre-fetch

---

## User Story

**As an admin**, I want to pre-fetch all open jobs from every known Greenhouse and Ashby company board into a shared pool once a day, so that profile runs can filter and score relevant jobs instantly — without hammering thousands of external APIs on every run.

### Acceptance criteria

- The **ATS Board Discovery** block in admin settings gains:
  - "Fetch Greenhouse jobs" and "Fetch Ashby jobs" manual trigger buttons with live progress feedback
  - Cached job counts per provider (total rows in the pool)
  - A daily auto-fetch toggle (runs at 08:00 in the admin's timezone) per provider
  - A hint paragraph explaining how the pool works and how filters are applied at run-time
- After a manual or scheduled fetch, new Greenhouse/Ashby jobs are saved to the shared `jobs` table with no `job_profile_states` row — invisible to all profiles until a run claims them
- When a profile run includes Greenhouse or Ashby, the runner queries the pool (no API call) and applies the role's keyword / location / date filters; matched jobs proceed through the normal score → store pipeline
- Pool jobs older than 30 days that no profile has ever processed are deleted by a daily cleanup cron

---

## Implementation Guide

### 1. Schema migrations (`src/db.ts`)

No new table. Two new `settings` columns and one new `jobs` column.

**`settings` table** — add via `ALTER TABLE … ADD COLUMN IF NOT EXISTS` migration block:
```sql
ats_pool_gh_enabled     INTEGER NOT NULL DEFAULT 0   -- daily auto-fetch toggle for Greenhouse
ats_pool_ashby_enabled  INTEGER NOT NULL DEFAULT 0   -- daily auto-fetch toggle for Ashby
```

**`jobs` table** — `linkedin_job_id` already stores the provider's native job ID and the unique index `idx_jobs_source_job_id ON jobs(linkedin_job_id, job_source)` already exists. No column change needed — upserts will use this index.

Update the `Settings` TypeScript interface at the bottom of `db.ts`:
```ts
ats_pool_gh_enabled:    number;
ats_pool_ashby_enabled: number;
```

---

### 2. Pool fetcher (`src/pipeline/atsPoolFetcher.ts`) — new file

Responsible for hitting the Greenhouse/Ashby APIs and writing results into the `jobs` table. This is the only place that talks to external APIs for these two providers.

```ts
export interface PoolFetchResult {
  inserted: number;   // net-new rows
  updated:  number;   // rows that already existed (upsert hit)
  total:    number;   // total jobs fetched from API across all companies
  durationMs: number;
}

export async function fetchGreenhousePool(db: Database): Promise<PoolFetchResult>
export async function fetchAshbyPool(db: Database): Promise<PoolFetchResult>
```

**Logic (same shape for both):**
1. Query `ats_boards WHERE ats = 'greenhouse' AND is_active = 1` → slug list
2. Fetch all boards with `withConcurrencyMap(slugs, 10, fetchBoard)` — same pattern as the current live provider
3. For each job returned: run `INSERT OR REPLACE INTO jobs (linkedin_job_id, job_source, …) VALUES (?, ?, …)` using the provider's native job ID as `linkedin_job_id` and set `fetched_at = now()`. The unique index on `(linkedin_job_id, job_source)` prevents duplicates on re-fetch (merge behaviour).
4. Do **not** insert any `job_profile_states` row — pool jobs are profile-neutral.
5. Return counts: track inserts vs. replacements via `changes` from the statement result.

**Important:** `fetched_at` on the `jobs` row is refreshed on every upsert. The cleanup cron uses this timestamp to expire stale pool rows.

---

### 3. Redesign the provider modules

**`src/pipeline/providers/greenhouse.ts`** and **`src/pipeline/providers/ashby.ts`** — replace the API-fetching logic with a DB pool query.

```ts
export async function fetchWithGreenhouse(
  filters: SearchFilters,
  _apifyToken: string,
  dateRange: DateRange,
): Promise<FetchResult> {
  const db = getDb();

  // Pull all pool rows for this source
  const rows = db.prepare(`
    SELECT * FROM jobs WHERE job_source = 'Greenhouse'
  `).all() as JobRow[];

  // Map DB rows → JobPosting[], then apply the same keyword / location / date filters
  // as the old live provider used. filterByTimeWindow filters on postedDate (posted_date col).
  const jobs = rows.map(rowToJobPosting);
  const filtered = applyFilters(jobs, filters, dateRange);

  return { jobs: filtered, apifyCostUsd: 0 };
}
```

`rowToJobPosting` maps a `jobs` DB row back to the `JobPosting` shape — the inverse of what the pool fetcher writes. Both providers share this helper in a local `poolUtils.ts` or inline it.

`applyFilters` is the same logic already in the live providers: keyword substring match on title, country-level location match, `filterByTimeWindow` on `postedDate`.

---

### 4. Cron — pool refresh and cleanup (`src/pipeline/atsScheduler.ts`)

Add two new task slots alongside the existing discovery/validation tasks:

```ts
let ghPoolTask:    ReturnType<typeof cron.schedule> | null = null;
let ashbyPoolTask: ReturnType<typeof cron.schedule> | null = null;

export function startGhPoolCron(expression: string, timezone = 'UTC'): void { … }
export function stopGhPoolCron(): void { … }

export function startAshbyPoolCron(expression: string, timezone = 'UTC'): void { … }
export function stopAshbyPoolCron(): void { … }
```

Each cron calls the matching `fetchGreenhousePool` / `fetchAshbyPool` from `atsPoolFetcher.ts`.

**Cleanup cron** — add a single always-on task started at boot (no toggle, no UI knob):
```ts
// runs daily at 03:00 UTC
cron.schedule('0 3 * * *', () => {
  db.exec(`
    DELETE FROM jobs
    WHERE job_source IN ('Greenhouse', 'Ashby')
      AND fetched_at < datetime('now', '-30 days')
      AND id NOT IN (SELECT job_id FROM job_profile_states)
  `);
}, { timezone: 'UTC' });
```

---

### 5. Boot sequence (`src/index.ts`)

In the ATS settings boot block (around line 120), add after existing crons:
```ts
if (atsSettings?.ats_pool_gh_enabled) {
  startGhPoolCron('0 8 * * *', atsTz);
}
if (atsSettings?.ats_pool_ashby_enabled) {
  startAshbyPoolCron('0 8 * * *', atsTz);
}
startPoolCleanupCron(); // always-on, no toggle
```

---

### 6. API endpoints (`src/routes/api.ts`)

Add to the existing admin API surface:

```
POST /api/admin/ats-pool/fetch
  body: { provider: 'greenhouse' | 'ashby' }
  → calls fetchGreenhousePool or fetchAshbyPool
  → returns PoolFetchResult

GET  /api/admin/ats-pool/counts
  → returns { greenhouse: number, ashby: number }
  → query: SELECT COUNT(*) FROM jobs WHERE job_source = 'Greenhouse'  (repeat for Ashby)
  → counts ALL pool rows (claimed or not) — shows total cached jobs

PATCH /api/admin/ats-pool/settings
  body: { provider: 'greenhouse' | 'ashby', enabled: boolean }
  → UPDATE settings SET ats_pool_gh_enabled = ? (or ashby)
  → restart or stop the matching cron via start/stopGhPoolCron
```

---

### 7. UI — settings page (`src/views/settings.ejs` + `src/public/js/settings.js`)

In the **ATS Board Discovery** admin block, add a new sub-section below the existing Greenhouse/Ashby company counts:

**Hint text** (always visible):
> Greenhouse and Ashby are fetched differently from LinkedIn or Indeed. Because their public APIs return every open job for a company with no search filters, jobs are pre-fetched into a shared pool once a day. When a profile run includes Greenhouse or Ashby, it queries this pool locally and applies your keyword, location, and date filters — no external API call is made during the run.

**Per-provider row** (repeat for Greenhouse and Ashby):
```
[Greenhouse]  3,241 jobs cached   [Fetch now]  Auto-fetch daily at 08:00 [toggle]
```
- "Fetch now" → `POST /api/admin/ats-pool/fetch` with spinner and result toast ("Inserted 142, updated 3,099")
- Toggle → `PATCH /api/admin/ats-pool/settings`; optimistic UI, reverts on error
- Counts loaded on page render via the settings route (pass `ghPoolCount`, `ashbyPoolCount` as template vars) and refreshed after a manual fetch

---

### 8. Run Once / Schedule modals (`src/views/layout.ejs`)

No structural change. Greenhouse and Ashby checkboxes remain. Add a single tooltip or `title` attribute on each checkbox label:
```
"Uses pre-fetched pool — no live API call"
```

The hint block in the settings page (step 7) is the primary explanation.

---

### File change summary

| File | Change |
|---|---|
| `src/db.ts` | Migration: add `ats_pool_gh_enabled`, `ats_pool_ashby_enabled` to `settings` |
| `src/pipeline/atsPoolFetcher.ts` | **New** — `fetchGreenhousePool`, `fetchAshbyPool` |
| `src/pipeline/providers/greenhouse.ts` | Replace API fetch with pool DB query |
| `src/pipeline/providers/ashby.ts` | Replace API fetch with pool DB query |
| `src/pipeline/atsScheduler.ts` | Add pool cron tasks + always-on cleanup cron |
| `src/index.ts` | Boot pool crons; start cleanup cron |
| `src/routes/api.ts` | Add `/api/admin/ats-pool/*` endpoints |
| `src/views/settings.ejs` | Add pool sub-section with hint, counts, fetch buttons, toggles |
| `src/public/js/settings.js` | Fetch-now handler, toggle handler, count refresh |
| `src/views/layout.ejs` | Tooltip on Greenhouse/Ashby checkbox labels |
