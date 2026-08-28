# Job Search

A self-hosted job search dashboard. Pulls listings from multiple job boards, ATS platforms, and Telegram channels, scores them with AI against your criteria, and surfaces only the strong matches — daily, in your inbox or on the web UI.

![Node.js](https://img.shields.io/badge/Node.js-22.5%2B-green) ![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)

---

## How it works

Each pipeline run (scheduled or manual):

1. **Fetch** — retrieves listings from your configured providers for each Role's keywords × locations
2. **Title filter** — drops jobs whose title doesn't match your filter words
3. **Blacklist** — drops jobs from companies you've blocked
4. **Dedup** — skips jobs already seen in previous runs (matched by source job ID and URL)
5. **AI scoring** — rates each job 0–100 against your prompt → Strong / Weak / No Match
6. **Semantic dedup** — for each new Strong Match, runs a two-stage LLM check against same-company jobs: a cheap titles-only pre-filter, then a full description comparison if needed. Catches reposts and cross-search duplicates. Writes a one-line summary for each accepted strong match.
7. **Hard-model re-score** — all non-duplicate Strong Matches are re-evaluated by a second, more capable model after all roles finish. Can promote or demote the final verdict.
8. **Store** — saves everything locally (all verdicts, rationale, summaries)
9. **Email digest** — sends strong matches to your inbox (optional)

---

## Usage modes

| Mode | How it works |
|---|---|
| **Hosted** | Use the hosted service against shared keys; runs draw from a prepaid credits balance managed by the operator. |
| **Own Keys** | Supply your own API keys (job discovery provider + OpenAI); no credits balance involved. |
| **Self-hosted** | Run the open-source code yourself; commercial use not permitted. |

Resource use per run varies by provider selection, number of roles, location breadth, and model choice.

---

## Stack

- **Runtime** — Node.js 22.5+ / TypeScript
- **Web** — Express 4 + EJS + Tailwind CSS
- **Database** — SQLite via built-in `node:sqlite`
- **AI** — OpenAI Responses API (soft model: `gpt-5.4-mini`; hard model: `gpt-5.6-terra`; both configurable per profile)
- **Job sources** — HarvestAPI, Valig, Indeed, StepStone, Greenhouse, Ashby, Lever, Telegram
- **Email** — Resend (OTP login + digests)
- **Scheduler** — node-cron (in-process, survives restarts)

---

## Setup

**1. Clone and install**
```bash
git clone https://github.com/girshovich/job-hunter.git
cd job-hunter
npm install
```

**2. Create `.env`**
```bash
cp .env.example .env
```
```env
# Apify/OpenAI here serve hosted-credits mode only — see the note below
APIFY_API_TOKEN=
OPENAI_API_KEY=
RESEND_API_KEY=
EMAIL_FROM=jobs@yourdomain.com
PORT=3000
DATABASE_PATH=./data/jobs.db   # created on first boot
```

> `.env.example` still lists `DASHBOARD_USER` / `DASHBOARD_PASS`. Basic auth was replaced by
> email OTP — those two are read by nothing and can be deleted.

Resend is required for login as well as digests, but the two resolve differently: **digests** read
`settings.resend_api_key` and fall back to `.env`; **login OTP** reads the *admin profile's* saved
Resend key only, with **no `.env` fallback**. Save it in Settings or nobody but the first account
can sign in.

> **Self-hosting: put your Apify and OpenAI keys in Settings, not `.env`.**
> Each profile picks a payment mode in **Settings → AI Setup**. On **"Use your own API keys"** — the normal choice when self-hosting — those two keys are read **only** from that profile's saved settings; `.env` is not consulted. If a run is refused with *"Own API keys are not set"*, paste them there.
> The `.env` values back **hosted-credits** mode instead, where one operator's keys are shared and billed against a credit balance.

**3. Build and run**
```bash
npm run build
node dist/index.js
```

> **Node version note:** `node:sqlite` is available unflagged from Node.js **23.4+**. On Node 22.5–23.3 pass the flag explicitly:
> ```bash
> node --experimental-sqlite dist/index.js
> ```

Or `npm start` (same thing) / `npm run dev` for ts-node without a build.

Open `http://localhost:3000`. The **first** email entered on `/welcome` becomes profile 1 with
`is_admin = 1` and is signed in immediately — no OTP, no Resend key needed for that one login.
Every later sign-in, including the admin's own, goes through an emailed code.

**4. Fill the free job pool (otherwise 4 of the 5 default sources return nothing)**

Greenhouse, Ashby, Lever and Telegram do not call an API during a run — they query a shared pool
that global admin crons populate, and on a fresh install that pool is empty. In **Admin → General**
save the global Apify/OpenAI/Resend keys, then in **Admin → Sources → ATS Job Pool Fill** run
discovery and "Fetch now" per source, and enable the crons you want. All cron toggles default to
**off**.

Cron times (admin timezone): Greenhouse/Ashby discovery `30 0 1 * *`, Lever discovery `0 2 1 * *`,
board validation `0 4 * * 0`, then daily pool fills at `05:00` Greenhouse, `05:15` Ashby,
`05:30` Telegram ingest, `05:45` Lever. Pool cleanup runs `03:00` daily and is always on.

**Lever discovery needs Python.** It spawns `build_lever_company_base.py` (repo root) to pull a
HuggingFace dataset. It looks for `uv` first — `uv run --with duckdb --with pandas --with aiohttp
--with tqdm` — then falls back to bare `python3`, which needs those four packages installed
yourself. Override with `LEVER_PYTHON_CMD`, `UV_PATH`, or `LEVER_SCRIPT_PATH`.

### Optional tuning

| Variable | Default | Effect |
|---|---|---|
| `SCORING_CONCURRENCY` | `5` | Parallel OpenAI scoring calls. Lower it on 429s. |
| `APIFY_CONCURRENCY` | `24` | Account-wide cap on concurrent Apify actor runs (free tier allows 25). `0` falls through to the default — to loosen it, set a large number. |
| `MAX_CONCURRENT_RUNS` | `6` | Pipelines in flight at once. |
| `VALIG_SKIP_JOB_IDS` | on | Set `0` to stop sending already-seen job ids to the valig actor. Does not disable the `titleInclude` filter. |

Both limiters are **in-process** — a second Node process (pm2 cluster mode, blue/green overlap) gets
its own budget.

---

## Maintenance scripts

```bash
# Resolve country for all existing jobs that predate the location normaliser.
node scripts/backfill-countries.js

# Regenerate AI summaries for all Strong Match jobs (e.g. after changing the summary prompt).
node scripts/backfill-summaries.js
```

**To keep it running with PM2:**
```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
```

> **Upgrading a deployment made before the `job-hunter` rename:** the pm2 app was called
> `linkedin-job-hunter`, and pm2 identifies apps by name — `pm2 start ecosystem.config.js` would
> launch a *second* app that then crash-loops on `EADDRINUSE`. Retire the old entry once:
> ```bash
> pm2 delete linkedin-job-hunter
> pm2 start ecosystem.config.js
> pm2 save
> ```
> `pm2 save` matters: without it the old name is still in `~/.pm2/dump.pm2` and comes back on the
> next reboot. Log files are unaffected — the paths in `ecosystem.config.js` are explicit, not
> derived from the app name.

---

## API keys needed

| Service | Purpose | Free tier |
|---|---|---|
| [Apify](https://apify.com) | Job discovery (HarvestAPI, Valig, Indeed, StepStone actors) | Pay as you go |
| [OpenAI](https://platform.openai.com) | AI scoring, dedup & summaries | Pay as you go (~$0.50/day typical) |
| [Resend](https://resend.com) | OTP login + email digests | 100 emails/day free |

---

## Features

- **Multiple job sources** — HarvestAPI, Valig, Indeed, StepStone, Greenhouse, Ashby, Lever, Telegram; mix providers per run
- **Roles** — multiple search profiles per account, each with its own keywords, titles, locations, work modes, job types, and AI prompt
- **Structured AI prompts** — each role configures profile description, scoring criteria, extra rejection rules, priority industries, and 100%-rejected industries; several rejection rules are derived automatically from your fields (country, language, job type)
- **Profile description** — a top-level background/CV context field injected into every AI scoring call; can be shared across all roles or overridden per role
- **Languages + current location** — preferred posting languages drive the language disqualifier; your current country gates the visa/relocation rejection rule
- **Dual AI model configuration** — a fast soft model for batch scoring and a separate hard model for semantic dedup, re-scoring, and CV comparison; both configurable independently
- **Score thresholds** — scores run 0–100; thresholds for Strong (default ≥71), Weak (51–70), and No Match (≤50) are configurable per Role
- **Work mode & job type filters** — filter by remote/hybrid/onsite and full/part/fixed-term, honored per provider (some sources skip filters they can't support)
- **Title word filter** — narrow results without changing search keywords
- **Company blacklist** — permanently skip companies across all Roles
- **Company logos** — HarvestAPI supplies real logos; every other source falls back to a cached Google favicon lookup
- **Country flags** — location strings are resolved to country labels and shown alongside listing data
- **Matches** — two-pane list + detail; review strong matches, mark Applied, add notes, fix AI verdicts inline
- **Multi-country jobs** — the same role in several countries is grouped into one opportunity, with duplicates folded
- **CV comparison** — upload your CV (PDF, TXT, or MD) and run a per-job AI analysis against your background
- **Email address change** — update your login email via a verified token link sent to the new address
- **Run Logs** — full audit log of every pipeline run, including filter decisions, scores, and outcomes; filter by source, verdict, and company
- **Stoppable runs** — a manual or scheduled run in progress can be stopped; work already scored is kept and billed, no digest is sent
- **Last Session card** — the home dashboard aggregates all providers from a single run trigger into one summary (jobs found, strong/weak counts, duration, combined status)
- **Analytics** — daily and monthly trend charts, per-role and per-country breakdowns
- **Run Diff** — compare job deltas between the two most recent runs
- **Scheduling** — per-profile cron with timezone support; schedule state survives server restarts
- **Preflight checks** — validates config before running
- **Location normalisation** — resolved via a local cache backed by [Nominatim](https://nominatim.openstreetmap.org/) (no API key required); countries, synonyms, and regions (DACH plus ~13 macro-regions like EMEA, EU, MENA, APAC, Worldwide) are DB-backed and admin-editable
