# ATS Board Discovery & Validation — Implementation Guide

This document is written for a coding agent. Follow the steps in order. Verify with `npx tsc --noEmit` after each step that touches TypeScript files.

---

## Conventions

- `better-sqlite3` (synchronous) for all DB operations.
- Node `https`/`http` or `node-fetch` if already in package.json — do not add new HTTP libraries. Check existing provider files to see which fetch approach is already used and match it.
- Cron scheduling follows the same pattern as `src/pipeline/scheduler.ts` (uses `node-cron`).
- All new routes are admin-only: check `req.session.isAdmin` (or however the existing auth middleware exposes it — check `src/routes/api.ts` for the pattern).
- Migrations follow the `PRAGMA table_info` column-detection pattern already used in `src/db.ts`.

---

## Step 1 — Database migration

**File:** `src/db.ts`

### 1a. New table `ats_boards`

Add inside `initSchema()`, after the existing `CREATE TABLE IF NOT EXISTS` blocks:

```sql
CREATE TABLE IF NOT EXISTS ats_boards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ats           TEXT    NOT NULL,
  slug          TEXT    NOT NULL,
  company_name  TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  discovered_at TEXT    NOT NULL,
  validated_at  TEXT,
  UNIQUE (ats, slug)
);
CREATE INDEX IF NOT EXISTS idx_ats_boards_ats      ON ats_boards(ats);
CREATE INDEX IF NOT EXISTS idx_ats_boards_active   ON ats_boards(is_active);
```

### 1b. New columns on `settings`

Add a migration block (use the existing migration pattern with `_migrations` table and a unique migration name, e.g. `'v_ats_discovery'`):

```ts
// inside initDb(), after all existing migration blocks:
{
  const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'v_ats_discovery'`).get();
  if (!done) {
    const cols = (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map(c => c.name);
    if (!cols.includes('ats_discovery_enabled'))
      db.exec(`ALTER TABLE settings ADD COLUMN ats_discovery_enabled INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('ats_discovery_cron'))
      db.exec(`ALTER TABLE settings ADD COLUMN ats_discovery_cron TEXT NOT NULL DEFAULT '0 3 1 * *'`);
    if (!cols.includes('ats_validation_enabled'))
      db.exec(`ALTER TABLE settings ADD COLUMN ats_validation_enabled INTEGER NOT NULL DEFAULT 0`);
    if (!cols.includes('ats_validation_cron'))
      db.exec(`ALTER TABLE settings ADD COLUMN ats_validation_cron TEXT NOT NULL DEFAULT '0 4 * * 1'`);
    db.exec(`INSERT INTO _migrations VALUES ('v_ats_discovery')`);
  }
}
```

**Verify:** `npx tsc --noEmit` passes.

---

## Step 2 — CDX Discovery module

**Create:** `src/pipeline/atsDiscovery.ts`

### Responsibilities

1. Fetch `https://index.commoncrawl.org/collinfo.json` to get available snapshots.
2. Take the 3 most recent by `from` date (the field is an ISO-ish string like `"20260401000000"`).
3. For each of the 3 snapshots × 3 ATS domains, page through CDX results and collect URLs.
4. Extract slugs and upsert into `ats_boards`.

### CDX query details

Endpoint pattern:
```
GET https://index.commoncrawl.org/{id}-index?url={domain}/*&output=json&fl=url&limit=50000&offset={N}
```

Response format: **NDJSON** (one JSON object per line). Each line is `{ "url": "..." }`. An empty response (no lines, or HTTP 404 from the CDX server) means no more results.

Pagination: increment `offset` by `limit` until you get an empty response or fewer rows than `limit`.

### Slug extraction rules

```ts
function extractSlug(url: string, atsDomain: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname !== atsDomain) return null;
    const seg = u.pathname.split('/').filter(Boolean)[0];
    if (!seg) return null;
    if (seg.includes('.')) return null;         // favicon.ico, robots.txt, etc.
    if (seg.startsWith('_') || seg.startsWith('v')) return null;  // _next, v1, etc.
    if (['api', 'embed', 'static', 'assets', 'images', 'js', 'css'].includes(seg)) return null;
    return seg.toLowerCase();
  } catch {
    return null;
  }
}
```

Domains to map to ATS keys:
```ts
const ATS_DOMAINS: Record<string, string> = {
  'boards.greenhouse.io': 'greenhouse',
  'jobs.lever.co':        'lever',
  'jobs.ashbyhq.com':     'ashby',
};
```

### Upsert

```ts
const upsert = db.prepare(`
  INSERT INTO ats_boards (ats, slug, is_active, discovered_at)
  VALUES (?, ?, 1, ?)
  ON CONFLICT (ats, slug) DO NOTHING
`);
```

### Exported function signature

```ts
export async function runDiscovery(db: Database): Promise<{ inserted: number; skipped: number }>;
```

Log progress to console: snapshot name, domain, page number, slugs found per page. Return total inserted (new rows) and skipped (already existed).

---

## Step 3 — Validation module

**Create:** `src/pipeline/atsValidation.ts`

### Responsibilities

Iterate all rows in `ats_boards` where `is_active = 1` (and also rows where `is_active = 0` that haven't been validated in the past 30 days — they may have come back online). For each, hit the ATS endpoint, update `is_active`, `company_name`, and `validated_at`.

### Endpoint map

```ts
const ENDPOINTS: Record<string, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever:      (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  ashby:      (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
};
```

### Company name extraction per ATS

```ts
async function extractCompanyName(ats: string, slug: string, body: any): Promise<string | null> {
  if (ats === 'ashby') {
    return body?.organization?.name ?? null;
  }
  if (ats === 'greenhouse') {
    // body is { jobs: [...], meta: {...} } — no company name. Make a second call.
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`);
      if (res.ok) {
        const board = await res.json();
        return board?.name ?? null;
      }
    } catch { /* ignore */ }
    return null;
  }
  if (ats === 'lever') {
    // Derive from slug: hyphens/underscores → spaces, title case
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }
  return null;
}
```

### Concurrency control

Use a simple semaphore (manual promise queue) capped at **10 concurrent** requests. Do NOT use any new library — implement it as:

```ts
async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
```

### Per-slug logic

```ts
async function validateSlug(row: AtsBoard): Promise<void> {
  const url = ENDPOINTS[row.ats](row.slug);
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return; // transient network error, skip
  }

  const now = new Date().toISOString();

  if (res.status === 404) {
    db.prepare(`UPDATE ats_boards SET is_active = 0, validated_at = ? WHERE id = ?`)
      .run(now, row.id);
    return;
  }

  if (res.status === 429) {
    await new Promise(r => setTimeout(r, 5_000));
    // retry once
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch { return; }
    if (res.status === 429) return; // give up for this cycle
  }

  if (!res.ok) return; // other error, leave is_active unchanged

  const body = await res.json().catch(() => null);
  const companyName = await extractCompanyName(row.ats, row.slug, body);

  db.prepare(`
    UPDATE ats_boards
    SET is_active = 1, company_name = COALESCE(?, company_name), validated_at = ?
    WHERE id = ?
  `).run(companyName, now, row.id);
}
```

### Exported function signature

```ts
export async function runValidation(db: Database): Promise<{ active: number; dead: number; errors: number }>;
```

Query rows to validate:
```sql
SELECT * FROM ats_boards
WHERE is_active = 1
   OR (is_active = 0 AND (validated_at IS NULL OR validated_at < datetime('now', '-30 days')))
```

Log progress every 100 slugs processed. Return final counts.

**Verify:** `npx tsc --noEmit` passes.

---

## Step 4 — ATS cron scheduler

**Create:** `src/pipeline/atsScheduler.ts`

Pattern: mirror `src/pipeline/scheduler.ts` exactly, but for two independent cron jobs (discovery and validation).

```ts
import cron from 'node-cron';
import { runDiscovery } from './atsDiscovery';
import { runValidation } from './atsValidation';
import { getDb } from '../db';

let discoveryTask: cron.ScheduledTask | null = null;
let validationTask: cron.ScheduledTask | null = null;

export function startAtsDiscoveryCron(expression: string): void {
  discoveryTask?.stop();
  discoveryTask = cron.schedule(expression, async () => {
    console.log('[ats-discovery] Starting scheduled discovery run');
    try {
      const result = await runDiscovery(getDb());
      console.log('[ats-discovery] Done:', result);
    } catch (err) {
      console.error('[ats-discovery] Error:', err);
    }
  });
}

export function stopAtsDiscoveryCron(): void {
  discoveryTask?.stop();
  discoveryTask = null;
}

export function startAtsValidationCron(expression: string): void {
  validationTask?.stop();
  validationTask = cron.schedule(expression, async () => {
    console.log('[ats-validation] Starting scheduled validation run');
    try {
      const result = await runValidation(getDb());
      console.log('[ats-validation] Done:', result);
    } catch (err) {
      console.error('[ats-validation] Error:', err);
    }
  });
}

export function stopAtsValidationCron(): void {
  validationTask?.stop();
  validationTask = null;
}
```

Check if `node-cron` is already in `package.json` (it is, since the main scheduler uses it). Do not add it again.

**Verify:** `npx tsc --noEmit` passes.

---

## Step 5 — App startup: boot cron from saved settings

**File:** `src/index.ts` (or wherever the main scheduler is started on boot — check existing code)

After the existing scheduler boot logic, add:

```ts
import { startAtsDiscoveryCron, startAtsValidationCron } from './pipeline/atsScheduler';

// Boot ATS crons from admin settings
const adminProfile = db.prepare(`SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1`).get() as { id: number } | undefined;
if (adminProfile) {
  const atsSettings = db.prepare(`
    SELECT ats_discovery_enabled, ats_discovery_cron, ats_validation_enabled, ats_validation_cron
    FROM settings WHERE profile_id = ?
  `).get(adminProfile.id) as {
    ats_discovery_enabled: number;
    ats_discovery_cron: string;
    ats_validation_enabled: number;
    ats_validation_cron: string;
  } | undefined;

  if (atsSettings?.ats_discovery_enabled) {
    startAtsDiscoveryCron(atsSettings.ats_discovery_cron || '0 3 1 * *');
  }
  if (atsSettings?.ats_validation_enabled) {
    startAtsValidationCron(atsSettings.ats_validation_cron || '0 4 * * 1');
  }
}
```

**Verify:** `npx tsc --noEmit` passes.

---

## Step 6 — API routes (admin-only)

**File:** `src/routes/api.ts`

Add the following routes. Find the existing admin-check pattern in this file and apply it consistently.

### GET `/api/ats/status`

Returns stats for the admin UI:

```ts
router.get('/api/ats/status', requireAdmin, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ats,
           COUNT(*) AS total,
           SUM(is_active) AS active,
           MAX(discovered_at) AS last_discovered,
           MAX(validated_at) AS last_validated
    FROM ats_boards
    GROUP BY ats
  `).all() as Array<{ ats: string; total: number; active: number; last_discovered: string; last_validated: string }>;

  const adminSettings = db.prepare(`
    SELECT ats_discovery_enabled, ats_discovery_cron, ats_validation_enabled, ats_validation_cron
    FROM settings WHERE profile_id = ?
  `).get(req.session.profileId) as any;

  res.json({ boards: rows, settings: adminSettings });
});
```

### POST `/api/ats/discover`

Triggers discovery immediately. Runs async, returns immediately with `{ started: true }`. Log output goes to server console.

```ts
router.post('/api/ats/discover', requireAdmin, (req, res) => {
  res.json({ started: true });
  runDiscovery(getDb())
    .then(r => console.log('[ats-discovery] Manual run complete:', r))
    .catch(e => console.error('[ats-discovery] Manual run error:', e));
});
```

### POST `/api/ats/validate`

Same pattern as above.

### POST `/api/ats/settings`

Save cron settings and restart crons:

```ts
router.post('/api/ats/settings', requireAdmin, (req, res) => {
  const { discovery_enabled, discovery_cron, validation_enabled, validation_cron } = req.body;

  // Validate cron expressions before saving
  if (discovery_cron && !cron.validate(discovery_cron))
    return res.status(400).json({ error: 'Invalid discovery cron expression' });
  if (validation_cron && !cron.validate(validation_cron))
    return res.status(400).json({ error: 'Invalid validation cron expression' });

  getDb().prepare(`
    UPDATE settings
    SET ats_discovery_enabled = ?, ats_discovery_cron = ?,
        ats_validation_enabled = ?, ats_validation_cron = ?
    WHERE profile_id = ?
  `).run(
    discovery_enabled ? 1 : 0, discovery_cron || '0 3 1 * *',
    validation_enabled ? 1 : 0, validation_cron || '0 4 * * 1',
    req.session.profileId,
  );

  // Restart crons
  if (discovery_enabled) startAtsDiscoveryCron(discovery_cron);
  else stopAtsDiscoveryCron();

  if (validation_enabled) startAtsValidationCron(validation_cron);
  else stopAtsValidationCron();

  res.json({ success: true });
});
```

Import the scheduler functions at the top of the routes file.

**Verify:** `npx tsc --noEmit` passes.

---

## Step 7 — Admin UI

**File:** `src/views/settings/_tab-profile.ejs`

Add a new card inside the `<% if (isAdmin) { %>` block, **after** the existing Email Delivery card.

The card needs three sections:

### Section A — Stats table

Display a 4-row table (Greenhouse / Lever / Ashby / Total) with columns: ATS, Total boards, Active, Last discovery, Last validation. Load data via `fetch('/api/ats/status')` on page load.

### Section B — Actions

Two buttons side by side:
- "Run Discovery Now" — calls `POST /api/ats/discover`, shows a spinner, then refreshes stats after 3 seconds with a "Started — check server logs" message (since the run is async and can take minutes).
- "Run Validation Now" — same pattern for `POST /api/ats/validate`.

### Section C — Cron config (two sub-sections, same pattern each)

**Discovery cron:**
- Toggle (checkbox): Enable monthly discovery
- Text input: Cron expression (pre-filled from current settings)
- Save button → calls `POST /api/ats/settings`

**Validation cron:**
- Toggle: Enable weekly validation
- Text input: Cron expression
- Save button (can be shared with discovery in one form)

### Full card skeleton

```html
<!-- ── ATS Board Discovery ── -->
<div class="bg-white rounded-xl border border-amber-200 shadow-sm p-6 mt-6">
  <h2 class="text-base font-semibold text-gray-900 mb-1">ATS Board Discovery</h2>
  <p class="text-xs text-gray-500 mb-4">
    Discovers company job boards on Greenhouse, Lever, and Ashby via Common Crawl.
    Validates boards weekly to keep the list current.
  </p>

  <!-- Stats table (populated by JS) -->
  <div id="ats-stats" class="mb-4">
    <p class="text-xs text-gray-400">Loading stats…</p>
  </div>

  <!-- Action buttons -->
  <div class="flex gap-2 mb-5">
    <button id="ats-discover-btn" type="button" onclick="atsRunDiscovery()"
            class="px-3 py-2 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg transition-colors">
      Run Discovery Now
    </button>
    <button id="ats-validate-btn" type="button" onclick="atsRunValidation()"
            class="px-3 py-2 text-sm font-medium text-emerald-600 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors">
      Run Validation Now
    </button>
    <span id="ats-action-status" class="text-xs text-gray-500 self-center hidden"></span>
  </div>

  <!-- Cron settings form -->
  <form id="ats-cron-form" class="space-y-4">
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
      <!-- Discovery cron -->
      <div>
        <label class="flex items-center gap-2 mb-2 cursor-pointer">
          <input type="checkbox" id="ats-discovery-enabled" name="discovery_enabled"
                 class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
          <span class="text-sm font-medium text-gray-700">Enable monthly discovery</span>
        </label>
        <input type="text" id="ats-discovery-cron" name="discovery_cron"
               placeholder="0 3 1 * *"
               class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500">
        <p class="text-xs text-gray-400 mt-1">Default: 3 AM on the 1st of each month</p>
      </div>
      <!-- Validation cron -->
      <div>
        <label class="flex items-center gap-2 mb-2 cursor-pointer">
          <input type="checkbox" id="ats-validation-enabled" name="validation_enabled"
                 class="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500">
          <span class="text-sm font-medium text-gray-700">Enable weekly validation</span>
        </label>
        <input type="text" id="ats-validation-cron" name="validation_cron"
               placeholder="0 4 * * 1"
               class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:ring-2 focus:ring-blue-500">
        <p class="text-xs text-gray-400 mt-1">Default: 4 AM every Monday</p>
      </div>
    </div>
    <button type="button" onclick="atsSaveCron()"
            class="px-4 py-2 text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors">
      Save cron settings
    </button>
    <p id="ats-cron-status" class="text-xs mt-1 hidden"></p>
  </form>
</div>
```

### JavaScript (add inside the existing `<script>` block for this tab, or inline below the card)

```js
async function loadAtsStats() {
  const res = await fetch('/api/ats/status');
  const data = await res.json();

  // Populate cron form from saved settings
  if (data.settings) {
    document.getElementById('ats-discovery-enabled').checked = !!data.settings.ats_discovery_enabled;
    document.getElementById('ats-discovery-cron').value = data.settings.ats_discovery_cron || '0 3 1 * *';
    document.getElementById('ats-validation-enabled').checked = !!data.settings.ats_validation_enabled;
    document.getElementById('ats-validation-cron').value = data.settings.ats_validation_cron || '0 4 * * 1';
  }

  // Build stats table
  const atsList = ['greenhouse', 'lever', 'ashby'];
  const statsEl = document.getElementById('ats-stats');
  if (!data.boards.length) {
    statsEl.innerHTML = '<p class="text-xs text-gray-400">No boards discovered yet.</p>';
    return;
  }
  const map = Object.fromEntries(data.boards.map(r => [r.ats, r]));
  const fmt = t => t ? new Date(t).toLocaleDateString() : '—';
  statsEl.innerHTML = `
    <table class="w-full text-xs text-left border-collapse">
      <thead><tr class="text-gray-400 border-b">
        <th class="pb-1 pr-4 font-medium">ATS</th>
        <th class="pb-1 pr-4 font-medium">Total</th>
        <th class="pb-1 pr-4 font-medium">Active</th>
        <th class="pb-1 pr-4 font-medium">Last discovery</th>
        <th class="pb-1 font-medium">Last validation</th>
      </tr></thead>
      <tbody>
        ${atsList.map(ats => {
          const r = map[ats] || {};
          return `<tr class="border-b border-gray-50">
            <td class="py-1 pr-4 font-medium capitalize">${ats}</td>
            <td class="py-1 pr-4">${r.total || 0}</td>
            <td class="py-1 pr-4">${r.active || 0}</td>
            <td class="py-1 pr-4">${fmt(r.last_discovered)}</td>
            <td class="py-1">${fmt(r.last_validated)}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;
}

async function atsRunDiscovery() {
  const btn = document.getElementById('ats-discover-btn');
  const status = document.getElementById('ats-action-status');
  btn.disabled = true;
  status.textContent = 'Discovery started — check server logs…';
  status.classList.remove('hidden');
  await fetch('/api/ats/discover', { method: 'POST' });
  setTimeout(() => loadAtsStats(), 3000);
  setTimeout(() => { btn.disabled = false; }, 10000);
}

async function atsRunValidation() {
  const btn = document.getElementById('ats-validate-btn');
  const status = document.getElementById('ats-action-status');
  btn.disabled = true;
  status.textContent = 'Validation started — check server logs…';
  status.classList.remove('hidden');
  await fetch('/api/ats/validate', { method: 'POST' });
  setTimeout(() => loadAtsStats(), 3000);
  setTimeout(() => { btn.disabled = false; }, 10000);
}

async function atsSaveCron() {
  const status = document.getElementById('ats-cron-status');
  const body = {
    discovery_enabled: document.getElementById('ats-discovery-enabled').checked,
    discovery_cron: document.getElementById('ats-discovery-cron').value.trim(),
    validation_enabled: document.getElementById('ats-validation-enabled').checked,
    validation_cron: document.getElementById('ats-validation-cron').value.trim(),
  };
  const res = await fetch('/api/ats/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  status.textContent = data.error || 'Saved.';
  status.classList.remove('hidden');
  setTimeout(() => status.classList.add('hidden'), 3000);
}

// Load on page init (only runs when admin is on the profile tab)
loadAtsStats();
```

**Verify:** Open the settings page as admin, Profile tab. The ATS Board Discovery card appears. Stats load (empty if no discovery run yet). Cron fields are populated from DB.

---

## Step 8 — Final TypeScript check and smoke test

```bash
npx tsc --noEmit
```

Then restart the dev server and:

1. Open Settings → Profile tab as admin. Confirm the ATS Board Discovery card is visible and stats load.
2. Click "Run Discovery Now". Confirm server logs show CDX queries starting. After it completes, refresh stats — board counts should appear.
3. Click "Run Validation Now". Confirm server logs show per-slug validation. After completion, some boards should show `is_active = 0` (dead slugs) and `company_name` populated.
4. Enable both crons, set expressions, save. Restart the server. Confirm crons are re-loaded from DB on startup (check console logs).
5. Query the DB directly: `SELECT ats, COUNT(*), SUM(is_active) FROM ats_boards GROUP BY ats;` — confirm reasonable counts.

---

## Checklist

```
[ ] Step 1: ats_boards table + 4 new settings columns, migration guard in place
[ ] Step 2: atsDiscovery.ts — fetches collinfo.json, picks 3 latest, paginates CDX, slugs filtered, upsert on conflict do nothing
[ ] Step 3: atsValidation.ts — concurrency-10, 404→dead, 200→active+company_name, 429 retry-once, other errors skipped
[ ] Step 4: atsScheduler.ts — start/stop functions for both crons
[ ] Step 5: index.ts — boot crons from admin settings on startup
[ ] Step 6: api.ts — GET /api/ats/status, POST /api/ats/discover, POST /api/ats/validate, POST /api/ats/settings (all admin-only)
[ ] Step 7: _tab-profile.ejs — ATS card renders, stats load, actions call correct endpoints, cron form saves and reloads
[ ] Step 8: npx tsc --noEmit passes, end-to-end smoke test passes
```
