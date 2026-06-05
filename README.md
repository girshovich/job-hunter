# Job Hunter

A self-hosted job search dashboard. Pulls listings from multiple job boards and ATS platforms, scores them with AI against your criteria, and surfaces only the strong matches — daily, in your inbox or on the web UI.

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
| **Hosted / Buy Credits** | Use the hosted service; purchase a prepaid credits balance; shared infrastructure handles the pipeline at API cost + fee. |
| **Own Keys** | Supply your own API keys (job discovery provider + OpenAI); no credits required; no service fee. |
| **Self-hosted** | Run the open-source code yourself; no charge; commercial use not permitted. |

Credit packages (hosted): $4 / $8 / $15 / $29. Cost per run varies by provider selection, number of roles, location breadth, and model choice.

---

## Stack

- **Runtime** — Node.js 22.5+ / TypeScript
- **Web** — Express 4 + EJS + Tailwind CSS
- **Database** — SQLite via built-in `node:sqlite`
- **AI** — OpenAI Responses API (soft model: `gpt-5.4-mini`; hard model: `gpt-5.4`; both configurable)
- **Job sources** — HarvestAPI, Valig, Indeed, StepStone, Greenhouse, Ashby, Lever
- **Email** — Resend (OTP login + digests)
- **Scheduler** — node-cron (in-process, survives restarts)

---

## Setup

**1. Clone and install**
```bash
git clone https://github.com/girshovich/Job-Hunter.git
cd Job-Hunter/linkedin-job-hunter
npm install
```

**2. Create `.env`**
```env
# Optional — API keys can also be set in the dashboard UI
APIFY_API_TOKEN=
OPENAI_API_KEY=
RESEND_API_KEY=
EMAIL_FROM=jobs@yourdomain.com
PORT=3000
```

Resend is required for login (email OTP) as well as digests. All API keys can be entered in the Settings page instead of `.env`.

**3. Build and run**
```bash
npm run build
node dist/index.js
```

> **Node version note:** `node:sqlite` is available unflagged from Node.js **23.4+**. On Node 22.5–23.3 pass the flag explicitly:
> ```bash
> node --experimental-sqlite dist/index.js
> ```

Open `http://localhost:3000` — first login bootstraps your admin account.

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

---

## API keys needed

| Service | Purpose | Free tier |
|---|---|---|
| [Apify](https://apify.com) | Job discovery (HarvestAPI, Valig, Indeed, StepStone actors) | Pay as you go |
| [OpenAI](https://platform.openai.com) | AI scoring, dedup & summaries | Pay as you go (~$0.50/day typical) |
| [Resend](https://resend.com) | OTP login + email digests | 100 emails/day free |

---

## Features

- **Multiple job sources** — HarvestAPI, Valig, Indeed, StepStone, Greenhouse, Ashby, Lever; mix providers per run
- **Roles** — multiple search profiles per account, each with its own keywords, locations, work modes, and AI prompt
- **Structured AI prompts** — each role has six configurable prompt fields: profile description, scoring criteria, scoring guide, no-match criteria, industries list, and other expectations
- **Profile description** — a top-level background/CV context field injected into every AI scoring call; can be shared across all roles or overridden per role
- **Languages + current location** — preferred posting languages and your current country, used in no-match criteria evaluation
- **Dual AI model configuration** — a fast soft model for batch scoring and a separate hard model for semantic dedup, re-scoring, and CV comparison; both configurable independently
- **Score thresholds** — scores run 0–100; thresholds for Strong (default ≥71), Weak (51–70), and No Match (≤50) are configurable per Role
- **Title word filter** — narrow results without changing search keywords
- **Company blacklist** — permanently skip companies across all Roles
- **Company logos** — automatically fetched and cached for Greenhouse and Ashby listings
- **Country flags** — location strings are resolved to country labels and shown alongside listing data
- **Jobs Match** — review strong matches, mark Applied, add notes, fix AI verdicts inline
- **CV comparison** — upload your CV (PDF, TXT, or MD) and run a per-job AI analysis against your background
- **Email address change** — update your login email via a verified token link sent to the new address
- **Run Logs** — full audit log of every pipeline run, including filter decisions, scores, and outcomes
- **Last Session card** — the home dashboard aggregates all providers from a single run trigger into one summary (jobs found, strong/weak counts, duration, combined status)
- **Analytics** — daily and monthly trend charts, per-role and per-country breakdowns
- **Run Diff** — compare job deltas between the two most recent runs
- **Scheduling** — per-profile cron with timezone support; schedule state survives server restarts
- **Preflight checks** — validates config before running
- **Location normalisation** — resolved via a local cache backed by [Nominatim](https://nominatim.openstreetmap.org/) (no API key required); EMEA, DACH, EU, EEA are hardcoded
