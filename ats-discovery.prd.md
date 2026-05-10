# ATS Board Discovery & Validation — Product Requirements

> v1.0 — May 2026

## User Story

As the admin of Job Hunter, I want the system to automatically discover and maintain a database of active company job boards on Greenhouse, Lever, and Ashby, so that future job-fetching features can query these boards directly rather than relying solely on LinkedIn/Indeed scraping.

---

## 1. Scope

This document covers two new background processes only. **Job fetching from ATS boards is out of scope** and will be designed separately.

| Process | Trigger | Cadence |
|---|---|---|
| Discovery | Manual or cron | Monthly |
| Validation | Manual or cron | Weekly |

---

## 2. Discovery

The system queries the Common Crawl CDX index to find known URLs under three ATS domains, extracts company slugs, and stores them in a new `ats_boards` table.

### 2.1 Data source

Common Crawl CDX API. The implementation must:
- Fetch the list of available crawl snapshots from `https://index.commoncrawl.org/collinfo.json` at runtime (not hardcoded).
- Query the **3 most recent** snapshots by date.
- For each snapshot × each ATS domain, page through all CDX results.

Domains to query:
- `boards.greenhouse.io/*`
- `jobs.lever.co/*`
- `jobs.ashbyhq.com/*`

### 2.2 Slug extraction

From each returned URL, extract the **first non-empty path segment** as the slug. Examples:
- `boards.greenhouse.io/stripe/jobs` → slug `stripe`
- `jobs.lever.co/airbnb` → slug `airbnb`
- `jobs.ashbyhq.com/notion/` → slug `notion`

Discard any URL where the first path segment is absent, is a known generic path (e.g. `favicon.ico`, `robots.txt`), contains a dot, or starts with `_` or `v`.

### 2.3 Storage

Store each valid `(ats, slug)` pair in `ats_boards`. If the pair already exists, do not overwrite — only insert new rows. Discovery never marks boards inactive (that is validation's job).

### 2.4 Admin UI

A new card in the Administrator Area of the Profile settings tab. It shows:
- Count of stored boards per ATS (Greenhouse / Lever / Ashby)
- Timestamp of the last discovery run
- A "Run Discovery Now" button that triggers the process immediately and shows a live progress indicator
- A toggle to enable/disable the monthly discovery cron
- A cron expression field (pre-filled with `0 3 1 * *` — 3 AM on the 1st of each month) for admins who want a custom schedule

---

## 3. Validation

Weekly process that hits the public job-board endpoint for every stored slug to determine whether it is still active. A slug is active if the endpoint returns HTTP 200; it is dead if it returns HTTP 404. Any other status code is treated as a transient error and the existing `is_active` value is left unchanged.

### 3.1 Endpoints

| ATS | Endpoint |
|---|---|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs` |
| Lever | `GET https://api.lever.co/v0/postings/{slug}?mode=json` |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{slug}` |

### 3.2 Company name extraction

On a 200 response, save the company name using the following rules per ATS:

- **Greenhouse**: the `/jobs` endpoint does not include company name — make a separate lightweight call to `GET https://boards-api.greenhouse.io/v1/boards/{slug}` and read the `name` field.
- **Lever**: no company name in the postings array. Derive from slug: replace hyphens/underscores with spaces, title-case each word (e.g. `open-ai` → `Open Ai`). This is a best-effort approximation.
- **Ashby**: read `response.organization.name` directly from the `/job-board/{slug}` response.

### 3.3 Concurrency & rate limiting

Run at most **10 requests concurrently**. On HTTP 429, back off with a 5-second delay before retrying that slug once. On any other non-200/404 response, skip the slug for this cycle.

### 3.4 Admin UI

In the same ATS admin card:
- Count of active vs. dead boards per ATS
- Timestamp of the last validation run
- A "Run Validation Now" button
- A toggle to enable/disable the weekly validation cron
- A cron expression field (pre-filled with `0 4 * * 1` — 4 AM every Monday)

---

## 4. Database

New table `ats_boards`:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto |
| `ats` | TEXT NOT NULL | `'greenhouse'` \| `'lever'` \| `'ashby'` |
| `slug` | TEXT NOT NULL | First path segment from CDX URL |
| `company_name` | TEXT | Populated by validation; NULL until first validation |
| `is_active` | INTEGER DEFAULT 1 | 1 = active, 0 = dead |
| `discovered_at` | TEXT NOT NULL | ISO timestamp of first discovery |
| `validated_at` | TEXT | ISO timestamp of last validation attempt |
| UNIQUE | `(ats, slug)` | No duplicate slugs per ATS |

New columns on the admin's `settings` row:

| Column | Default | Purpose |
|---|---|---|
| `ats_discovery_enabled` | `0` | Whether the monthly cron is active |
| `ats_discovery_cron` | `'0 3 1 * *'` | Cron expression for discovery |
| `ats_validation_enabled` | `0` | Whether the weekly cron is active |
| `ats_validation_cron` | `'0 4 * * 1'` | Cron expression for validation |

---

## 5. Out of Scope

- Fetching actual job listings from ATS boards (future feature)
- Per-user access to ATS board data
- Sitemap-based discovery (CDX only)
- Alerting when board counts drop significantly
- Deduplication across ATS platforms (same company may appear on multiple ATS)
