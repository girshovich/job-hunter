/**
 * Telegram raw ingestion — scrapes https://t.me/s/<channel> for active channels
 * and upserts posts into telegram_posts with hash-based edit/repost detection.
 * Called by the 05:00 daily cron and the admin "Fetch now" button.
 */

import { createHash } from 'node:crypto';
import type { Database } from '../db';
import { runExtraction } from './telegramExtract';

const USER_AGENT = 'Mozilla/5.0 (compatible; JobHunterApp/1.0; +https://github.com/self-hosted)';

export interface TelegramIngestResult {
  channels: number;
  posts: number;
  inserted: number;
  edited: number;
  extracted: number;
  jobsCreated: number;
  durationMs: number;
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Decode HTML entities, looping to undo double-encoding (e.g. "&amp;amp;").
function decodeHtmlEntities(s: string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    out = out
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  } while (out !== prev);
  return out;
}

function canonicalLink(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return url.toLowerCase().trim();
  }
}

// ── HTML parsing (Telegram /s/ page) ─────────────────────────────────────────

interface ParsedPost {
  postId: string;
  postUrl: string;
  text: string;
  links: string[];
  publishedAt: string | null;
}

function parseTelegramPage(html: string, channelUsername: string): ParsedPost[] {
  const posts: ParsedPost[] = [];

  // Split on message blocks; each block starts with data-post attribute
  const blockRe = /<div[^>]+data-post="([^"]+)"[^>]*>([\s\S]*?)(?=<div[^>]+data-post="|$)/g;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = blockRe.exec(html)) !== null) {
    const dataPost = blockMatch[1]; // e.g. "channelname/12345"
    const blockHtml = blockMatch[2];

    const parts = dataPost.split('/');
    const postId = parts[parts.length - 1];
    if (!postId) continue;

    const postUrl = `https://t.me/${channelUsername}/${postId}`;

    // Extract text from .tgme_widget_message_text — strip tags
    let text = '';
    const textMatch = blockHtml.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (textMatch) {
      text = textMatch[1]
        // Preserve links: turn <a href="X">label</a> into inline markdown [label](X)
        // so both bare URLs and "click here"-style links survive tag stripping and
        // reach the LLM and the rendered description. Skip Telegram nav/mention links.
        .replace(/<a\b[^>]*?\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, rawHref, rawLabel) => {
          const href = decodeHtmlEntities(rawHref).trim();
          const label = rawLabel.replace(/<[^>]+>/g, '').trim();
          if (!/^https?:\/\//i.test(href)) return label;            // tg://, #, mailto, etc.
          if (/^https?:\/\/t\.me\/s\//i.test(href)) return label;   // hashtag/search links
          if (/^https?:\/\/t\.me\/[^/]+$/i.test(href)) return label; // @mention / channel root
          if (!label || /^https?:\/\//i.test(label)) return href;   // bare URL (label is the url)
          return `[${label}](${href})`;
        })
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    // Extract links from message body, exclude t.me navigation links
    const links: string[] = [];
    const linkRe = /href="([^"]+)"/g;
    let linkMatch: RegExpExecArray | null;
    // Restrict to within message text block if possible; otherwise scan whole block
    const textBlock = textMatch ? textMatch[0] : blockHtml;
    while ((linkMatch = linkRe.exec(textBlock)) !== null) {
      const href = linkMatch[1];
      // Skip internal Telegram nav/share anchors
      if (href.startsWith('#') || href.startsWith('tg://')) continue;
      // Skip Telegram web app navigation that aren't content links
      if (/^https?:\/\/t\.me\/[^/]+$/.test(href) && !href.includes('/')) continue;
      links.push(href);
    }

    // Extract published_at from <time datetime="...">
    let publishedAt: string | null = null;
    const timeMatch = blockHtml.match(/class="tgme_widget_message_date"[^>]*>[\s\S]*?<time[^>]+datetime="([^"]+)"/);
    if (timeMatch) {
      try {
        publishedAt = new Date(timeMatch[1]).toISOString().split('T')[0];
      } catch {
        publishedAt = null;
      }
    }

    posts.push({ postId, postUrl, text, links, publishedAt });
  }

  return posts;
}

// ── Main ingest function ──────────────────────────────────────────────────────

export async function runTelegramIngest(db: Database): Promise<TelegramIngestResult> {
  const start = Date.now();
  const startedAt = (db.prepare(`SELECT datetime('now') AS t`).get() as { t: string }).t;

  const channels = db.prepare(
    `SELECT channel_username FROM telegram_channels WHERE is_active = 1`,
  ).all() as { channel_username: string }[];

  let totalPosts = 0;
  let inserted = 0;
  let edited = 0;

  const upsert = db.prepare(`
    INSERT INTO telegram_posts
      (channel_username, post_id, post_url, published_at, text, links,
       text_hash, links_hash, post_hash, canonical_link_hash, is_repost_of,
       first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
    ON CONFLICT(channel_username, post_id) DO UPDATE SET
      last_seen_at = datetime('now'),
      text         = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.text ELSE telegram_posts.text END,
      links        = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.links ELSE telegram_posts.links END,
      text_hash    = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.text_hash ELSE telegram_posts.text_hash END,
      links_hash   = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.links_hash ELSE telegram_posts.links_hash END,
      post_hash    = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.post_hash ELSE telegram_posts.post_hash END,
      canonical_link_hash = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN excluded.canonical_link_hash ELSE telegram_posts.canonical_link_hash END,
      edited_at    = CASE WHEN excluded.post_hash != telegram_posts.post_hash THEN datetime('now') ELSE telegram_posts.edited_at END
  `);

  const findCanon = db.prepare(
    `SELECT id FROM telegram_posts WHERE canonical_link_hash = ? AND id < (SELECT id FROM telegram_posts WHERE channel_username = ? AND post_id = ?) LIMIT 1`,
  );
  const setRepost = db.prepare(
    `UPDATE telegram_posts SET is_repost_of = ? WHERE channel_username = ? AND post_id = ?`,
  );
  const getPostHash = db.prepare(
    `SELECT post_hash FROM telegram_posts WHERE channel_username = ? AND post_id = ?`,
  );

  for (const { channel_username } of channels) {
    let html: string;
    try {
      const res = await fetch(`https://t.me/s/${channel_username}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        console.warn(`[telegram-ingest] HTTP ${res.status} for channel ${channel_username} — skipping`);
        continue;
      }
      html = await res.text();
    } catch (err) {
      console.warn(`[telegram-ingest] Fetch error for ${channel_username}:`, (err as Error).message);
      continue;
    }

    const posts = parseTelegramPage(html, channel_username);
    totalPosts += posts.length;

    for (const post of posts) {
      const normText = normalizeText(post.text);
      const sortedLinks = [...post.links].sort().join('\n');
      const textHash = sha256(normText);
      const linksHash = post.links.length > 0 ? sha256(sortedLinks) : null;
      const postHash = sha256(normText + '\n' + sortedLinks);
      const firstCanon = post.links.length > 0 ? canonicalLink(post.links[0]) : null;
      const canonHash = firstCanon ? sha256(firstCanon) : null;

      const prevRow = getPostHash.get(channel_username, post.postId) as { post_hash: string } | undefined;
      const isNew = !prevRow;
      const isEdited = prevRow && prevRow.post_hash !== postHash;

      db.transaction(() => {
        upsert.run(
          channel_username, post.postId, post.postUrl,
          post.publishedAt,
          post.text || null,
          post.links.length > 0 ? JSON.stringify(post.links) : null,
          textHash, linksHash, postHash, canonHash,
        );

        if (canonHash) {
          const earlier = findCanon.get(canonHash, channel_username, post.postId) as { id: number } | undefined;
          if (earlier) {
            setRepost.run(earlier.id, channel_username, post.postId);
          }
        }
      });

      if (isNew) inserted++;
      else if (isEdited) edited++;
    }
  }

  // Resolve admin key + model for extraction
  const adminProfile = db.prepare(`SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1`).get() as { id: number } | undefined;
  const adminSettings = adminProfile
    ? db.prepare(`SELECT openai_api_key, ai_model, telegram_extract_prompt FROM settings WHERE profile_id = ?`).get(adminProfile.id) as {
        openai_api_key: string; ai_model: string; telegram_extract_prompt: string;
      } | undefined
    : undefined;

  const openAiKey = adminSettings?.openai_api_key?.trim() || '';
  const model = adminSettings?.ai_model?.trim() || '';
  const prompt = adminSettings?.telegram_extract_prompt?.trim() || '';

  const { jobsCreated, postsProcessed: extracted } = await runExtraction(db, model, openAiKey, prompt);

  const durationMs = Date.now() - start;
  console.log(`[telegram-ingest] Done — ${channels.length} channels, ${totalPosts} posts, ${inserted} new, ${edited} edited, ${jobsCreated} jobs (${Math.round(durationMs / 1000)}s)`);

  db.prepare(`
    INSERT INTO telegram_ingest_runs
      (started_at, channels, posts, inserted, edited, jobs_created, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(startedAt, channels.length, totalPosts, inserted, edited, jobsCreated, durationMs);

  return { channels: channels.length, posts: totalPosts, inserted, edited, extracted, jobsCreated, durationMs };
}
