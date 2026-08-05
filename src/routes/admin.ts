/**
 * Admin Routes — the admin-only control surface, split out of Settings into its own page.
 * General / Sources / Locations tabs render from one route; long-job and CRUD actions
 * still post to their existing /api and /settings endpoints.
 */

import { Router, type Request, type Response } from 'express';
import { getDb, type SettingsRow } from '../db';
import { getCanonicalCountries } from '../pipeline/locationNormalizer';
import { getAtsSchedules } from '../pipeline/atsScheduler';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    res.status(403).send('Forbidden');
    return;
  }

  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(req.profile.id) as SettingsRow;

  const validTabs = ['general', 'sources', 'locations'];
  const adminTab = validTabs.includes(String(req.query.tab)) ? String(req.query.tab) : 'general';

  // has_own_keys is a storage fact, not a mode: it says both BYO columns are filled, not that the
  // profile runs on them — `use_jh_credits` decides that, and a profile (the admin's typically) can
  // have keys saved while spending credits. The app stores no validation result either, so the badge
  // cannot claim the keys work. credits_overspent_usd is the leak alarm: anything above zero is
  // spend that reached the operator's keys unpaid (see MONEYLEAK.md).
  const allProfiles = db.prepare(`
    SELECT p.id, p.email, p.is_admin, p.created_at,
           COALESCE(s.credits_balance, 0) AS credits_balance,
           COALESCE(s.credits_overspent_usd, 0) AS credits_overspent_usd,
           (TRIM(COALESCE(s.user_openai_api_key, '')) != ''
            AND TRIM(COALESCE(s.user_apify_api_token, '')) != '') AS has_own_keys
    FROM profiles p
    LEFT JOIN settings s ON s.profile_id = p.id
    ORDER BY p.id ASC
  `).all() as Array<{ id: number; email: string; is_admin: number; created_at: string; credits_balance: number; credits_overspent_usd: number; has_own_keys: number }>;

  res.render('admin', {
    title: 'Admin',
    adminTab,
    saved: req.query.saved === '1',
    settings,
    allProfiles,
    locationCountries: getCanonicalCountries(),
    atsSchedules: getAtsSchedules(),
    pageMaxWidth: '48rem',
  });
});

router.get('/unresolved-locations', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    res.status(403).send('Forbidden');
    return;
  }

  const db = getDb();
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const perPage = 50;
  const q = String(req.query.q || '').trim();
  const offset = (page - 1) * perPage;
  const whereSearch = q ? `AND LOWER(j.location) LIKE ?` : '';
  const params = q ? [`%${q.toLowerCase()}%`] : [];

  const total = (db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT j.location
      FROM jobs j
      JOIN location_country lc ON lc.location = j.location AND lc.country = ''
      WHERE j.job_source IN ('Greenhouse', 'Ashby')
        AND j.location IS NOT NULL
        AND j.country IS NULL
        ${whereSearch}
      GROUP BY j.location
    )
  `).get(...params) as { c: number }).c;

  const rows = db.prepare(`
    SELECT j.location,
           COUNT(*) AS job_count,
           GROUP_CONCAT(DISTINCT j.job_source) AS providers,
           MAX(lc.created_at) AS last_checked
    FROM jobs j
    JOIN location_country lc ON lc.location = j.location AND lc.country = ''
    WHERE j.job_source IN ('Greenhouse', 'Ashby')
      AND j.location IS NOT NULL
      AND j.country IS NULL
      ${whereSearch}
    GROUP BY j.location
    ORDER BY job_count DESC, j.location ASC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset) as Array<{
    location: string;
    job_count: number;
    providers: string;
    last_checked: string;
  }>;

  const exampleStmt = db.prepare(`
    SELECT company, title, job_source
    FROM jobs
    WHERE job_source IN ('Greenhouse', 'Ashby')
      AND location = ?
      AND country IS NULL
    ORDER BY fetched_at DESC
    LIMIT 3
  `);
  const locations = rows.map((row) => ({
    ...row,
    examples: exampleStmt.all(row.location) as Array<{ company: string; title: string; job_source: string }>,
  }));

  res.render('unresolved-locations', {
    title: 'Unresolved Locations',
    locations,
    total,
    page,
    perPage,
    q,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
  });
});

// Telegram posts ingested in the last run, grouped by channel, with the jobs scraped from each
router.get('/telegram-posts', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    res.status(403).send('Forbidden');
    return;
  }

  const db = getDb();
  const adminTimezone = (db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(req.profile.id) as { timezone?: string } | undefined)?.timezone || 'UTC';
  const lastRun = db.prepare(
    `SELECT started_at FROM telegram_ingest_runs ORDER BY id DESC LIMIT 1`,
  ).get() as { started_at: string } | undefined;

  type PostRow = {
    channel_username: string;
    post_url: string;
    published_at: string | null;
    text: string | null;
  };
  const posts: PostRow[] = lastRun
    ? db.prepare(`
        SELECT channel_username, post_url, published_at, text
        FROM telegram_posts
        WHERE is_repost_of IS NULL
          AND (first_seen_at >= ? OR edited_at >= ?)
        ORDER BY channel_username ASC, published_at DESC, id DESC
      `).all(lastRun.started_at, lastRun.started_at) as PostRow[]
    : [];

  const jobStmt = db.prepare(`
    SELECT company, title, location
    FROM jobs
    WHERE job_source = 'Telegram' AND url = ?
    ORDER BY id ASC
  `);

  const repostCount = lastRun
    ? (db.prepare(`
        SELECT COUNT(*) AS c FROM telegram_posts
        WHERE is_repost_of IS NOT NULL AND (first_seen_at >= ? OR edited_at >= ?)
      `).get(lastRun.started_at, lastRun.started_at) as { c: number }).c
    : 0;

  const byChannel = new Map<string, Array<PostRow & { jobs: Array<{ company: string; title: string; location: string | null }> }>>();
  for (const p of posts) {
    const jobs = jobStmt.all(p.post_url) as Array<{ company: string; title: string; location: string | null }>;
    if (!byChannel.has(p.channel_username)) byChannel.set(p.channel_username, []);
    byChannel.get(p.channel_username)!.push({ ...p, jobs });
  }
  const channels = [...byChannel.entries()].map(([channel, channelPosts]) => ({ channel, posts: channelPosts }));

  res.render('telegram-posts', {
    title: 'Telegram — Last Ingest',
    channels,
    postCount: posts.length,
    repostCount,
    lastRunAt: lastRun?.started_at ?? null,
    timezone: adminTimezone,
  });
});

export { router as adminRouter };
