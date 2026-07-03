/**
 * Telegram LLM extraction — parses raw Telegram posts into structured job records.
 * Called from telegramIngest after scraping. Uses the soft model (settings.ai_model)
 * and admin OpenAI key. Extraction cost is admin/operational — not user-charged.
 */

import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import pLimit from 'p-limit';
import type { Database } from '../db';
import { populateCountriesFromCache } from './atsPoolFetcher';
import { resolveLocationSet } from './locationNormalizer';
import { groupOrDrop } from './locationGrouping';

export interface ExtractedJob {
  title: string;
  company: string | null;
  workMode: string;
  locations: string[];
  applyUrl: string | null;
}

// Editable instructions — admin-tunable via the settings UI. The field schema below
// is appended at runtime and is intentionally NOT part of this editable text.
const DEFAULT_EXTRACT_PROMPT = `Extract job openings from this Telegram post. Return jobs: [] for ads, news, or posts with no vacancy.`;

// Fixed field schema — always appended to the editable instructions. Kept out of the
// admin-editable prompt so the field rules that drive extraction and country
// resolution (notably: work mode is its own field, never a location) can't be
// accidentally removed.
const FIXED_SCHEMA_PROMPT = `One object per job. Fields:
- title: job title in English — translate it if the post is written in another language. Skip the job if absent.
- company: real employer named in the text (not the channel). Keep it exactly as written in the post — do not translate or transliterate it. null if missing.
- workMode: one of "remote", "hybrid", "onsite". Infer from the post; use "onsite" if unstated.
- locations: array of real places in English (e.g. "Berlin", "Germany", "EU"). Empty array if not mentioned. Never split one location into multiple elements.
- applyUrl: best available link — prefer an application/careers page, then a t.me post, then a recruiter contact. Capture as-is. null if none.

The full post text is stored as the job description — do not repeat or summarise it.`;


function normalizeForHash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function canonicalUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

export function computeJobHash(title: string, company: string | null, applyUrl: string | null): string {
  const raw = [
    normalizeForHash(title),
    normalizeForHash(company ?? ''),
    applyUrl ? canonicalUrl(applyUrl) : '',
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

export async function extractJobsFromPost(
  postText: string,
  prompt: string,
  model: string,
  openAiKey: string,
): Promise<ExtractedJob[]> {
  const client = new OpenAI({ apiKey: openAiKey });
  const response = await client.responses.create({
    model,
    input: [
      { role: 'system', content: prompt },
      { role: 'user', content: postText },
    ],
    temperature: 0.1,
    max_output_tokens: 1000,
    text: {
      format: {
        type: 'json_schema',
        name: 'telegram_jobs',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            jobs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  title:     { type: 'string' },
                  company:   { type: ['string', 'null'] },
                  workMode:  { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
                  locations: { type: 'array', items: { type: 'string' } },
                  applyUrl:  { type: ['string', 'null'] },
                },
                required: ['title', 'company', 'workMode', 'locations', 'applyUrl'],
              },
            },
          },
          required: ['jobs'],
        },
      },
    },
  });

  const text = response.output_text;
  if (!text) return [];
  const parsed = JSON.parse(text) as { jobs: ExtractedJob[] };
  return (parsed.jobs ?? []).filter((j) => j.title?.trim()).map((j) => ({
    ...j,
    workMode: ['remote', 'hybrid', 'onsite'].includes(j.workMode) ? j.workMode : 'onsite',
    locations: Array.isArray(j.locations) ? j.locations.filter(Boolean) : [],
  }));
}

interface PostRow {
  id: number;
  channel_username: string;
  post_id: string;
  post_url: string;
  published_at: string | null;
  text: string | null;
  post_hash: string;
}

export async function runExtraction(
  db: Database,
  model: string,
  openAiKey: string,
  prompt: string,
): Promise<{ jobsCreated: number; postsProcessed: number }> {
  if (!openAiKey) {
    console.warn('[telegram-extract] No OpenAI key — skipping extraction');
    return { jobsCreated: 0, postsProcessed: 0 };
  }

  const editablePrompt  = prompt?.trim() || DEFAULT_EXTRACT_PROMPT;
  const effectivePrompt = `${editablePrompt}\n\n${FIXED_SCHEMA_PROMPT}`;

  const posts = db.prepare(`
    SELECT id, channel_username, post_id, post_url, published_at, text, post_hash
    FROM telegram_posts
    WHERE is_repost_of IS NULL
      AND text IS NOT NULL
      AND (extracted_hash IS NULL OR extracted_hash != post_hash)
  `).all() as PostRow[];

  if (posts.length === 0) return { jobsCreated: 0, postsProcessed: 0 };
  console.log(`[telegram-extract] ${posts.length} post(s) to extract`);

  const upsertJob = db.prepare(`
    INSERT INTO jobs (linkedin_job_id, job_source, provider, title, company, location, country,
                      work_mode, description, url, apply_url, posted_date, fetched_at)
    VALUES (?, 'Telegram', 'telegram', ?, ?, ?, NULL, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(linkedin_job_id, job_source) DO UPDATE SET
      title        = excluded.title,
      company      = excluded.company,
      location     = excluded.location,
      country      = CASE WHEN jobs.location IS NOT excluded.location THEN NULL ELSE jobs.country END,
      work_mode    = excluded.work_mode,
      description  = excluded.description,
      url          = excluded.url,
      apply_url    = excluded.apply_url,
      posted_date  = excluded.posted_date,
      fetched_at   = excluded.fetched_at
  `);
  const selectJobId = db.prepare<{ id: number }>(
    `SELECT id FROM jobs WHERE linkedin_job_id = ? AND job_source = 'Telegram'`,
  );

  const markExtracted = db.prepare(`
    UPDATE telegram_posts SET extracted_hash = ? WHERE id = ?
  `);

  let jobsCreated = 0;
  let postsProcessed = 0;

  const limit = pLimit(5);

  await Promise.all(posts.map((post) => limit(async () => {
    const postText = post.text?.trim() || '';
    if (!postText) {
      markExtracted.run(post.post_hash, post.id);
      postsProcessed++;
      return;
    }

    let jobs: ExtractedJob[];
    try {
      jobs = await extractJobsFromPost(postText, effectivePrompt, model, openAiKey);
    } catch (err) {
      console.error(`[telegram-extract] Failed for post ${post.channel_username}/${post.post_id}:`, (err as Error).message);
      return;
    }

    // Resolve location sets before entering the sync transaction
    const locationSets = await Promise.all(
      jobs.map((j) => j.locations.length > 0 ? resolveLocationSet(j.locations) : Promise.resolve({ labels: [], countries: [] })),
    );

    const channelUsername = post.channel_username;
    const postId = post.post_id;

    db.transaction(() => {
      for (let i = 0; i < jobs.length; i++) {
        const job = jobs[i];
        const locationSet = locationSets[i];
        const locationStr = job.locations.length > 0 ? job.locations.join('; ') : null;
        const jobHash = computeJobHash(job.title, job.company, job.applyUrl);
        const jobId = `${channelUsername}_${postId}_${jobHash}`;
        upsertJob.run(
          jobId,
          job.title,
          job.company ?? channelUsername,
          locationStr,
          job.workMode,
          postText,
          post.post_url,
          job.applyUrl ?? null,
          post.published_at ?? null,
        );
        const row = selectJobId.get(jobId);
        if (row && locationSet.labels.length > 0) {
          groupOrDrop(row.id, locationSet);
        }
        jobsCreated++;
      }
      markExtracted.run(post.post_hash, post.id);
    });

    postsProcessed++;
  })));

  populateCountriesFromCache(db, 'Telegram');

  console.log(`[telegram-extract] Done — ${jobsCreated} job(s) from ${postsProcessed} post(s)`);
  return { jobsCreated, postsProcessed };
}

export { DEFAULT_EXTRACT_PROMPT, FIXED_SCHEMA_PROMPT };
