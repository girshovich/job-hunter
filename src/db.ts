/**
 * Database layer — uses Node.js built-in `node:sqlite` (available Node 22.5+, unflagged Node 23.4+).
 * No native compilation required.
 */

// node:sqlite types not fully in @types/node yet, so we declare what we need.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string, options?: { open?: boolean }) => NodeSQLiteDatabase;
};

import * as fs from 'fs';
import * as path from 'path';
import { config } from './config';

// Minimal type surface for node:sqlite
interface NodeSQLiteStatement {
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

interface NodeSQLiteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSQLiteStatement;
  close(): void;
}

// ---- Type-safe wrapper ----

export type PreparedStatement<T = unknown> = {
  run(...params: unknown[]): { lastInsertRowid: number; changes: number };
  get(...params: unknown[]): T | undefined;
  all(...params: unknown[]): T[];
};

export type Database = {
  exec(sql: string): void;
  prepare<T = unknown>(sql: string): PreparedStatement<T>;
  transaction<T>(fn: () => T): T;
};

function wrapDatabase(raw: NodeSQLiteDatabase): Database {
  return {
    exec: (sql) => raw.exec(sql),
    prepare: <T>(sql: string) => raw.prepare(sql) as unknown as PreparedStatement<T>,
    transaction: <T>(fn: () => T): T => {
      raw.prepare('BEGIN').run();
      try {
        const result = fn();
        raw.prepare('COMMIT').run();
        return result;
      } catch (err) {
        raw.prepare('ROLLBACK').run();
        throw err;
      }
    },
  };
}

// ---- Seed data ----

export const DEFAULT_DEDUP_SYSTEM_PROMPT = `You are a job posting deduplication engine. Your task is to determine whether a NEW job posting is effectively the same position as any of the EXISTING postings from the same company. Two postings are duplicates if they describe the same role even if the text has been slightly reworded, reformatted, or reposted with a new ID.`;

export const DEFAULT_CV_COMPARISON_PROMPT = `analyze and answer these questions in a very brief manner so i can read it in 1 min:
- what's the area or product this role owns?
- does it openly say about supporting or not supporting with visa / relocation / remote work from everywhere?
- do I have what's needed for this role, based on my CV?
- would it be a fun new challenge?
1-2 lines for each question
be critical-minded, don't try to please me`;

export const DEFAULT_AI_SYSTEM_PROMPT = `You are evaluating LinkedIn job postings for a senior product professional with 8+ years of experience. Assess how well each job matches this ideal profile:

IDEAL CANDIDATE:
- Senior IC or leadership PM roles (Senior PM, Lead PM, Group PM, Head of Product, Director/VP of Product)
- Experience with B2B SaaS, marketplace, fintech, or consumer tech products
- Comfortable in fast-paced, high-growth environments
- Values strong team culture, real ownership, and strategic influence

SCORING GUIDE (0–100):
90–100: Exceptional match — senior/leadership role, strong domain fit, top-tier company, compelling scope
80–89: Strong match — good seniority level, relevant domain, clear ownership and impact
71–79: Solid match — reasonable fit but some gaps (seniority, domain, or location)
51–70: Weak match — missing key elements; worth noting but not compelling
0–50: No match — junior level, unrelated field, or clearly unsuitable

SCORING CRITERIA:
- Role seniority and title (40% weight): Is this IC senior/lead or people-manager level?
- Domain and product type (30% weight): Relevant industry and product complexity?
- Scope and impact (20% weight): Team size, user base, strategic vs. feature PM?
- Company quality (10% weight): Stage, brand, growth trajectory?

IMPORTANT: Evaluate only what is stated. If information is missing, be conservative.`;

const DEFAULT_LOCATIONS = JSON.stringify([
  'London',
  'Berlin',
  'Cyprus',
  'Netherlands',
  'Spain',
  'Armenia',
]);

const DEFAULT_KEYWORDS = JSON.stringify([
  'Product Manager',
  'Product Lead',
  'Head of Product',
  'Product Director',
  'Group Product Manager',
]);

// ---- Singleton ----

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;

  const dbDir = path.dirname(path.resolve(config.dbPath));
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const raw = new DatabaseSync(path.resolve(config.dbPath));
  _db = wrapDatabase(raw);

  // WAL mode and foreign keys (node:sqlite uses PRAGMA via exec)
  _db.exec(`PRAGMA journal_mode = WAL`);
  _db.exec(`PRAGMA foreign_keys = ON`);

  initSchema(_db);
  runMigrations(_db);
  seedSettings(_db);
  ensureProfileIndexes(_db);

  return _db;
}

function runMigrations(db: Database): void {
  // v29: profiles / sessions / otp_codes tables + seed from settings.email_recipient
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL UNIQUE,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS otp_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      code       TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    )`);

    // Seed profiles from settings.email_recipient (existing installs only)
    const profileCount = (db.prepare('SELECT COUNT(*) as c FROM profiles').get() as { c: number }).c;
    if (profileCount === 0) {
      const rows = db.prepare(
        `SELECT profile_id, email_recipient FROM settings
         WHERE email_recipient != '' ORDER BY profile_id ASC`
      ).all() as Array<{ profile_id: number; email_recipient: string }>;
      for (const row of rows) {
        const isAdmin = row.profile_id === 1 ? 1 : 0;
        try {
          db.prepare(
            'INSERT OR IGNORE INTO profiles (id, email, is_admin) VALUES (?, ?, ?)'
          ).run(row.profile_id, row.email_recipient.trim().toLowerCase(), isAdmin);
          console.log(`[db] Migration v29: seeded profile id=${row.profile_id} (${row.email_recipient})`);
        } catch (_) {}
      }
    }
  } catch (err) {
    console.warn('[db] Migration v29 (profiles/sessions/otp) failed:', (err as Error).message);
  }

  // vDEFAULT: seed default scoring_criteria and no_match_criteria for groups that have none
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'vDEFAULT_scoring'`).get();
    if (!done) {
      const defaultScoringCriteria = [
        'Profile matches expected experience (up to 40): domain, complexity, results, skills;',
        'Role description matches any of the Desired roles (up to 40): compelling scope and responsibilities, seniority, title, team size;',
        'Preferred industry (up to 10);',
        'Company quality (up to 10): known brand, growth trajectory.',
      ].join('\n');
      const defaultNoMatchCriteria = [
        'a) job location isn\'t one of the preferred location areas',
        'b) current location isn\'t one of the preferred location areas, and the job description explicitly says no visa or relocation help provided',
        'c) job posting mostly written in any language besides the "preferred languages"',
        'd) knowledge of any language besides the "preferred languages" is stated as mandatory',
        'e) job is in online gambling or betting industry',
        'f) job is a fixed-term contract',
      ].join('\n');
      db.prepare(`UPDATE search_groups SET scoring_criteria = ? WHERE scoring_criteria = ''`).run(defaultScoringCriteria);
      db.prepare(`UPDATE search_groups SET no_match_criteria = ? WHERE no_match_criteria = ''`).run(defaultNoMatchCriteria);
      db.exec(`INSERT INTO _migrations VALUES ('vDEFAULT_scoring')`);
      console.log('[db] Migration vDEFAULT_scoring: seeded default scoring_criteria and no_match_criteria');
    }
  } catch (err) {
    console.warn('[db] Migration vDEFAULT_scoring failed (non-fatal):', (err as Error).message);
  }

  // v6→v7: rename search_geocodes → search_locations, convert [{geocode,label}] → [string]
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    const hasGeocodes = cols.some((c) => c.name === 'search_geocodes');
    const hasLocations = cols.some((c) => c.name === 'search_locations');

    if (hasGeocodes && !hasLocations) {
      db.exec(`ALTER TABLE settings RENAME COLUMN search_geocodes TO search_locations`);
      // Convert stored JSON from [{geocode, label}] to ["label", ...]
      const row = db.prepare(`SELECT search_locations FROM settings WHERE id = 1`).get() as
        { search_locations: string } | undefined;
      if (row) {
        try {
          const parsed: Array<{ geocode?: string; label?: string } | string> =
            JSON.parse(row.search_locations);
          const strings = parsed.map((e) =>
            typeof e === 'string' ? e : (e.label || e.geocode || ''),
          ).filter(Boolean);
          db.prepare(`UPDATE settings SET search_locations = ? WHERE id = 1`).run(
            JSON.stringify(strings),
          );
        } catch {
          // If parse fails, set sensible default
          db.prepare(`UPDATE settings SET search_locations = ? WHERE id = 1`).run(DEFAULT_LOCATIONS);
        }
      }
      console.log('[db] Migration applied: search_geocodes → search_locations');
    }
  } catch (err) {
    console.warn('[db] Migration check failed (non-fatal):', (err as Error).message);
  }

  // v6→v7: add trigger column to search_runs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_runs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'trigger')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN trigger TEXT NOT NULL DEFAULT 'scheduled'`);
      console.log('[db] Migration applied: search_runs.trigger column added');
    }
  } catch (err) {
    console.warn('[db] Migration (trigger column) failed (non-fatal):', (err as Error).message);
  }

  // v8: add score threshold columns to search_groups if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'score_no_match_max')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_no_match_max INTEGER NOT NULL DEFAULT 50`);
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_weak_match_max INTEGER NOT NULL DEFAULT 70`);
      db.exec(`ALTER TABLE search_groups ADD COLUMN score_strong_match_min INTEGER NOT NULL DEFAULT 71`);
      console.log('[db] Migration applied: search_groups score threshold columns added');
    }
  } catch (err) {
    console.warn('[db] Migration (group score thresholds) failed (non-fatal):', (err as Error).message);
  }

  // v8: add group_id to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'group_id')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN group_id INTEGER REFERENCES search_groups(id)`);
      console.log('[db] Migration applied: jobs.group_id column added');
    }
  } catch (err) {
    console.warn('[db] Migration (group_id column) failed (non-fatal):', (err as Error).message);
  }

  // v9: add dedup_system_prompt to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'dedup_system_prompt')) {
      db.exec(`ALTER TABLE settings ADD COLUMN dedup_system_prompt TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE settings SET dedup_system_prompt = ? WHERE id = 1`).run(DEFAULT_DEDUP_SYSTEM_PROMPT);
      console.log('[db] Migration applied: settings.dedup_system_prompt column added');
    }
  } catch (err) {
    console.warn('[db] Migration (dedup_system_prompt) failed (non-fatal):', (err as Error).message);
  }

  // v9: add ai_summary to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'ai_summary')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ai_summary TEXT`);
      console.log('[db] Migration applied: jobs.ai_summary column added');
    }
  } catch (err) {
    console.warn('[db] Migration (ai_summary column) failed (non-fatal):', (err as Error).message);
  }

  // v10: add rejection_category to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'rejection_category')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN rejection_category TEXT`);
      console.log('[db] Migration applied: jobs.rejection_category column added');
    }
  } catch (err) {
    console.warn('[db] Migration (rejection_category column) failed (non-fatal):', (err as Error).message);
  }

  // v11: add group_name, is_active, title_filter to search_groups if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'group_name')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN group_name TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.group_name column added');
    }
    if (!cols.some((c) => c.name === 'is_active')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1`);
      console.log('[db] Migration applied: search_groups.is_active column added');
    }
    if (!cols.some((c) => c.name === 'title_filter')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN title_filter TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.title_filter column added');
    }
  } catch (err) {
    console.warn('[db] Migration (search_groups v11 columns) failed (non-fatal):', (err as Error).message);
  }

  // v11: add summary_prompt to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'summary_prompt')) {
      db.exec(`ALTER TABLE settings ADD COLUMN summary_prompt TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE settings SET summary_prompt = ? WHERE id = 1`).run(
        'Analyze the job description and write a 1-line summary of what product this role owns:',
      );
      console.log('[db] Migration applied: settings.summary_prompt column added');
    }
  } catch (err) {
    console.warn('[db] Migration (summary_prompt column) failed (non-fatal):', (err as Error).message);
  }

  // v13: add timezone to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'timezone')) {
      db.exec(`ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'`);
      console.log('[db] Migration applied: settings.timezone column added');
    }
  } catch (err) {
    console.warn('[db] Migration (timezone) failed (non-fatal):', (err as Error).message);
  }

  // v12: add API keys to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'apify_api_token')) {
      db.exec(`ALTER TABLE settings ADD COLUMN apify_api_token TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN openai_api_key TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN resend_api_key TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN email_from TEXT NOT NULL DEFAULT ''`);
      db.exec(`ALTER TABLE settings ADD COLUMN email_enabled INTEGER NOT NULL DEFAULT 1`);
      // Seed from env so existing users don't lose their keys
      db.prepare(
        `UPDATE settings SET apify_api_token = ?, openai_api_key = ?, resend_api_key = ?, email_from = ? WHERE id = 1`,
      ).run(
        process.env.APIFY_API_TOKEN || '',
        process.env.OPENAI_API_KEY || '',
        process.env.RESEND_API_KEY || '',
        process.env.EMAIL_FROM || '',
      );
      console.log('[db] Migration applied: settings API key columns added, seeded from env.');
    }
  } catch (err) {
    console.warn('[db] Migration (API keys) failed (non-fatal):', (err as Error).message);
  }

  // v14: add applied and user_notes to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'applied')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN applied INTEGER NOT NULL DEFAULT 0`);
      console.log('[db] Migration applied: jobs.applied column added');
    }
    if (!cols.some((c) => c.name === 'user_notes')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN user_notes TEXT`);
      console.log('[db] Migration applied: jobs.user_notes column added');
    }
  } catch (err) {
    console.warn('[db] Migration (applied/user_notes) failed (non-fatal):', (err as Error).message);
  }

  // v15: add apply_url to jobs if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'apply_url')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN apply_url TEXT`);
      console.log('[db] Migration applied: jobs.apply_url column added');
    }
  } catch (err) {
    console.warn('[db] Migration (apply_url column) failed (non-fatal):', (err as Error).message);
  }

  // v21: add scraping_provider to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'scraping_provider')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scraping_provider TEXT NOT NULL DEFAULT 'harvestapi'`);
      console.log('[db] Migration v21: settings.scraping_provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v21 (scraping_provider) failed (non-fatal):', (err as Error).message);
  }

  // v21: add provider to jobs
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'provider')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN provider TEXT NOT NULL DEFAULT 'harvestapi'`);
      console.log('[db] Migration v21: jobs.provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v21 (jobs.provider) failed (non-fatal):', (err as Error).message);
  }

  // v22: add scraping_provider to search_runs
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'scraping_provider')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN scraping_provider TEXT`);
      console.log('[db] Migration v22: search_runs.scraping_provider column added');
    }
  } catch (err) {
    console.warn('[db] Migration v22 (search_runs.scraping_provider) failed (non-fatal):', (err as Error).message);
  }

  // v27: add scraping_providers (JSON array) to settings, migrating from single scraping_provider
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'scraping_providers')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scraping_providers TEXT NOT NULL DEFAULT '["harvestapi"]'`);
      db.exec(`UPDATE settings SET scraping_providers = '["' || scraping_provider || '"]' WHERE scraping_provider IS NOT NULL AND scraping_provider != ''`);
      console.log('[db] Migration v27: settings.scraping_providers column added');
    }
  } catch (err) {
    console.warn('[db] Migration v27 (scraping_providers) failed (non-fatal):', (err as Error).message);
  }

  // v28: add per-tab last-saved timestamps to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_updated_at')) {
      db.exec(`ALTER TABLE settings ADD COLUMN profile_updated_at TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration v28: settings.profile_updated_at column added');
    }
    if (!cols.some((c) => c.name === 'ai_updated_at')) {
      db.exec(`ALTER TABLE settings ADD COLUMN ai_updated_at TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration v28: settings.ai_updated_at column added');
    }
  } catch (err) {
    console.warn('[db] Migration v28 (profile/ai updated_at) failed (non-fatal):', (err as Error).message);
  }

  // v16: add structured prompt fields to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_description')) {
      db.exec(`ALTER TABLE settings ADD COLUMN profile_description TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.profile_description column added');
    }
    if (!cols.some((c) => c.name === 'scoring_criteria')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scoring_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.scoring_criteria column added');
    }
    if (!cols.some((c) => c.name === 'scoring_guide')) {
      db.exec(`ALTER TABLE settings ADD COLUMN scoring_guide TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.scoring_guide column added');
    }
    if (!cols.some((c) => c.name === 'no_match_criteria')) {
      db.exec(`ALTER TABLE settings ADD COLUMN no_match_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.no_match_criteria column added');
    }
  } catch (err) {
    console.warn('[db] Migration (structured prompt settings fields) failed (non-fatal):', (err as Error).message);
  }

  // v16: add per-group prompt fields to search_groups
  try {
    const cols = db.prepare(`PRAGMA table_info(search_groups)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'industries_list')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN industries_list TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.industries_list column added');
    }
    if (!cols.some((c) => c.name === 'other_expectations')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN other_expectations TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.other_expectations column added');
    }
    if (!cols.some((c) => c.name === 'profile_description')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN profile_description TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.profile_description column added');
    }
    if (!cols.some((c) => c.name === 'scoring_criteria')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN scoring_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.scoring_criteria column added');
    }
    if (!cols.some((c) => c.name === 'scoring_guide')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN scoring_guide TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.scoring_guide column added');
    }
    if (!cols.some((c) => c.name === 'no_match_criteria')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN no_match_criteria TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: search_groups.no_match_criteria column added');
    }
  } catch (err) {
    console.warn('[db] Migration (search_groups prompt fields) failed (non-fatal):', (err as Error).message);
  }

  // v20: add cost columns to search_runs
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cost_openai_usd')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN cost_openai_usd REAL`);
      db.exec(`ALTER TABLE search_runs ADD COLUMN cost_apify_usd REAL`);
      console.log('[db] Migration v20: search_runs cost columns added');
    }
  } catch (err) {
    console.warn('[db] Migration v20 (cost columns) failed (non-fatal):', (err as Error).message);
  }

  // v19: add schedule_group_ids to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schedule_group_ids')) {
      db.exec(`ALTER TABLE settings ADD COLUMN schedule_group_ids TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration applied: settings.schedule_group_ids column added');
    }
  } catch (err) {
    console.warn('[db] Migration (schedule_group_ids) failed (non-fatal):', (err as Error).message);
  }

  // v18: add schedule_date_range to settings if missing
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'schedule_date_range')) {
      db.exec(`ALTER TABLE settings ADD COLUMN schedule_date_range TEXT NOT NULL DEFAULT '24h'`);
      console.log('[db] Migration applied: settings.schedule_date_range column added');
    }
  } catch (err) {
    console.warn('[db] Migration (schedule_date_range) failed (non-fatal):', (err as Error).message);
  }

  // v17: multi-profile — add profile_id to all major tables

  // settings: recreate without CHECK(id=1) constraint, add profile_id, seed Arina's row
  try {
    const cols = db.prepare('PRAGMA table_info(settings)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      // Create new table without CHECK constraint
      db.exec(`
        CREATE TABLE settings_v17 (
          id                     INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id             INTEGER NOT NULL DEFAULT 1,
          search_keywords        TEXT    NOT NULL DEFAULT '',
          search_locations       TEXT    NOT NULL DEFAULT '',
          search_work_modes      TEXT    NOT NULL DEFAULT '',
          search_job_type        TEXT    NOT NULL DEFAULT 'fullTime',
          cron_schedule          TEXT    NOT NULL DEFAULT '0 7 * * *',
          ai_system_prompt       TEXT    NOT NULL DEFAULT '',
          ai_model               TEXT    NOT NULL DEFAULT 'gpt-5.4',
          dedup_system_prompt    TEXT    NOT NULL DEFAULT '',
          score_no_match_max     INTEGER NOT NULL DEFAULT 50,
          score_weak_match_max   INTEGER NOT NULL DEFAULT 70,
          score_strong_match_min INTEGER NOT NULL DEFAULT 71,
          email_recipient        TEXT    NOT NULL DEFAULT '',
          email_send_time        TEXT    NOT NULL DEFAULT '07:00',
          summary_prompt         TEXT    NOT NULL DEFAULT '',
          apify_api_token        TEXT    NOT NULL DEFAULT '',
          openai_api_key         TEXT    NOT NULL DEFAULT '',
          resend_api_key         TEXT    NOT NULL DEFAULT '',
          email_from             TEXT    NOT NULL DEFAULT '',
          email_enabled          INTEGER NOT NULL DEFAULT 1,
          timezone               TEXT    NOT NULL DEFAULT 'UTC',
          profile_description    TEXT    NOT NULL DEFAULT '',
          scoring_criteria       TEXT    NOT NULL DEFAULT '',
          scoring_guide          TEXT    NOT NULL DEFAULT '',
          no_match_criteria      TEXT    NOT NULL DEFAULT '',
          updated_at             TEXT    NOT NULL DEFAULT ''
        )
      `);
      db.exec(`
        INSERT INTO settings_v17
          SELECT id, 1,
            COALESCE(search_keywords,''), COALESCE(search_locations,''),
            COALESCE(search_work_modes,''), COALESCE(search_job_type,'fullTime'),
            COALESCE(cron_schedule,'0 7 * * *'), COALESCE(ai_system_prompt,''),
            COALESCE(ai_model,'gpt-5.4'), COALESCE(dedup_system_prompt,''),
            COALESCE(score_no_match_max,50), COALESCE(score_weak_match_max,70),
            COALESCE(score_strong_match_min,71),
            COALESCE(email_recipient,''), COALESCE(email_send_time,'07:00'),
            COALESCE(summary_prompt,''), COALESCE(apify_api_token,''),
            COALESCE(openai_api_key,''), COALESCE(resend_api_key,''),
            COALESCE(email_from,''), COALESCE(email_enabled,1),
            COALESCE(timezone,'UTC'), COALESCE(profile_description,''),
            COALESCE(scoring_criteria,''), COALESCE(scoring_guide,''),
            COALESCE(no_match_criteria,''), COALESCE(updated_at,'')
          FROM settings WHERE id = 1
      `);
      db.exec(`DROP TABLE settings`);
      db.exec(`ALTER TABLE settings_v17 RENAME TO settings`);
      // Seed Arina's row: clone API keys but clear email_recipient and profile prompts
      db.exec(`
        INSERT INTO settings
          SELECT NULL, 2,
            search_keywords, search_locations, search_work_modes, search_job_type,
            cron_schedule, ai_system_prompt, ai_model, dedup_system_prompt,
            score_no_match_max, score_weak_match_max, score_strong_match_min,
            '', email_send_time, summary_prompt,
            apify_api_token, openai_api_key, resend_api_key, email_from,
            email_enabled, timezone,
            '', '', '', '', updated_at
          FROM settings WHERE profile_id = 1
      `);
      console.log('[db] Migration v17: settings recreated with profile_id, Arina row seeded');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (settings) failed (non-fatal):', (err as Error).message);
  }

  // search_groups: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(search_groups)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE search_groups ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      // Assign "Head of marketing" group to Arina
      db.prepare(`UPDATE search_groups SET profile_id = 2 WHERE group_name = 'Head of marketing'`).run();
      console.log('[db] Migration v17: search_groups.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (search_groups.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // jobs: add profile_id, populate from group
  try {
    const cols = db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      // Jobs whose group belongs to Arina → set profile_id=2
      db.exec(`
        UPDATE jobs SET profile_id = 2
        WHERE group_id IN (SELECT id FROM search_groups WHERE profile_id = 2)
      `);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_profile_id ON jobs(profile_id)`);
      console.log('[db] Migration v17: jobs.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (jobs.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // search_runs: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(search_runs)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_profile ON search_runs(profile_id)`);
      console.log('[db] Migration v17: search_runs.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (search_runs.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // blacklisted_companies: add profile_id
  try {
    const cols = db.prepare('PRAGMA table_info(blacklisted_companies)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'profile_id')) {
      db.exec(`ALTER TABLE blacklisted_companies ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_profile ON blacklisted_companies(profile_id)`);
      console.log('[db] Migration v17: blacklisted_companies.profile_id added');
    }
  } catch (err) {
    console.warn('[db] Migration v17 (blacklisted_companies.profile_id) failed (non-fatal):', (err as Error).message);
  }

  // v23: add original_ai_verdict to jobs (tracks AI's first verdict before user overrides)
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'original_ai_verdict')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN original_ai_verdict TEXT`);
      // Backfill: treat current ai_verdict as the original for pre-existing rows
      db.exec(`UPDATE jobs SET original_ai_verdict = ai_verdict WHERE original_ai_verdict IS NULL`);
      console.log('[db] Migration v23: jobs.original_ai_verdict column added and backfilled');
    }
  } catch (err) {
    console.warn('[db] Migration v23 (original_ai_verdict) failed (non-fatal):', (err as Error).message);
  }

  // v23b: re-backfill original_ai_verdict from run_job_logs (the simple backfill above used
  // the current ai_verdict, which loses history for jobs the user had already promoted/demoted.
  // The earliest run_job_logs entry has the AI's true original verdict.)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'v23b'`).get();
    if (!done) {
      db.exec(`
        UPDATE jobs SET original_ai_verdict = (
          SELECT rjl.ai_verdict FROM run_job_logs rjl
          WHERE rjl.linkedin_job_id = jobs.linkedin_job_id
          ORDER BY rjl.logged_at ASC LIMIT 1
        )
        WHERE original_ai_verdict = ai_verdict
          AND EXISTS (SELECT 1 FROM run_job_logs rjl2 WHERE rjl2.linkedin_job_id = jobs.linkedin_job_id)
      `);
      db.exec(`INSERT INTO _migrations VALUES ('v23b')`);
      console.log('[db] Migration v23b: original_ai_verdict re-backfilled from run_job_logs');
    }
  } catch (err) {
    console.warn('[db] Migration v23b (original_ai_verdict re-backfill) failed (non-fatal):', (err as Error).message);
  }

  // vCV: add cv_comparison_prompt to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cv_comparison_prompt')) {
      db.exec(`ALTER TABLE settings ADD COLUMN cv_comparison_prompt TEXT NOT NULL DEFAULT ''`);
      db.prepare(`UPDATE settings SET cv_comparison_prompt = ? WHERE cv_comparison_prompt = ''`).run(DEFAULT_CV_COMPARISON_PROMPT);
      console.log('[db] Migration vCV: settings.cv_comparison_prompt column added');
    }
  } catch (err) {
    console.warn('[db] Migration vCV (cv_comparison_prompt) failed (non-fatal):', (err as Error).message);
  }

  // vCV: add cv_assessment to jobs
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'cv_assessment')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN cv_assessment TEXT`);
      console.log('[db] Migration vCV: jobs.cv_assessment column added');
    }
  } catch (err) {
    console.warn('[db] Migration vCV (cv_assessment) failed (non-fatal):', (err as Error).message);
  }

  // vLANG: add languages and current_location to settings
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'languages')) {
      db.exec(`ALTER TABLE settings ADD COLUMN languages TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration vLANG: settings.languages column added');
    }
    if (!cols.some((c) => c.name === 'current_location')) {
      db.exec(`ALTER TABLE settings ADD COLUMN current_location TEXT NOT NULL DEFAULT ''`);
      console.log('[db] Migration vLANG: settings.current_location column added');
    }
  } catch (err) {
    console.warn('[db] Migration vLANG (languages/current_location) failed (non-fatal):', (err as Error).message);
  }

  // v24: composite covering index for strong-match page + job-detail prev/next queries
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_match_fetch
             ON jobs(profile_id, ai_verdict, is_duplicate, fetched_at, ai_score, id)`);
    console.log('[db] Migration v24: idx_jobs_match_fetch created');
  } catch (err) {
    console.warn('[db] Migration v24 (idx_jobs_match_fetch) failed (non-fatal):', (err as Error).message);
  }

  // v25: add country column to jobs + location_country cache table
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'country')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN country TEXT`);
      console.log('[db] Migration v25: jobs.country column added');
    }
  } catch (err) {
    console.warn('[db] Migration v25 (jobs.country) failed (non-fatal):', (err as Error).message);
  }

  // v25: seed hardcoded regional labels into location_country cache
  try {
    const hardcoded: Array<[string, string]> = [
      ['EMEA', 'EMEA'],
      ['DACH', 'DACH'],
      ['European Union', 'European Union'],
      ['European Economic Area', 'European Economic Area'],
    ];
    const upsert = db.prepare(
      `INSERT OR IGNORE INTO location_country (location, country, created_at) VALUES (?, ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const [loc, country] of hardcoded) {
      upsert.run(loc, country, now);
    }
  } catch (err) {
    console.warn('[db] Migration v25 (location_country seed) failed (non-fatal):', (err as Error).message);
  }

  // v26: add ai_model_hard to settings (hard-task model: full dedup, re-scoring, CV compare)
  try {
    const cols = db.prepare(`PRAGMA table_info(settings)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'ai_model_hard')) {
      db.exec(`ALTER TABLE settings ADD COLUMN ai_model_hard TEXT NOT NULL DEFAULT 'gpt-5.4'`);
      console.log('[db] Migration v26: settings.ai_model_hard column added');
    }
  } catch (err) {
    console.warn('[db] Migration v26 (ai_model_hard) failed (non-fatal):', (err as Error).message);
  }

  // vNEW: add job_source to jobs, update unique index to (linkedin_job_id, job_source)
  try {
    const cols = db.prepare(`PRAGMA table_info(jobs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'job_source')) {
      db.exec(`ALTER TABLE jobs ADD COLUMN job_source TEXT NOT NULL DEFAULT 'LinkedIn'`);
      db.exec(`UPDATE jobs SET job_source = 'Indeed'    WHERE provider = 'indeed'`);
      db.exec(`UPDATE jobs SET job_source = 'StepStone' WHERE provider = 'stepstone'`);
      db.exec(`DROP INDEX IF EXISTS idx_jobs_linkedin_id`);
      db.exec(`CREATE UNIQUE INDEX idx_jobs_source_job_id ON jobs(linkedin_job_id, job_source)`);
      console.log('[db] vNEW: jobs.job_source added, unique index updated to (linkedin_job_id, job_source)');
    }
  } catch (err) {
    console.warn('[db] Migration vNEW (job_source) failed (non-fatal):', (err as Error).message);
  }

  // vNEW: add job_source to search_runs
  try {
    const cols = db.prepare(`PRAGMA table_info(search_runs)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'job_source')) {
      db.exec(`ALTER TABLE search_runs ADD COLUMN job_source TEXT`);
      db.exec(`UPDATE search_runs SET job_source = 'Indeed'    WHERE scraping_provider = 'indeed'`);
      db.exec(`UPDATE search_runs SET job_source = 'StepStone' WHERE scraping_provider = 'stepstone'`);
      db.exec(`UPDATE search_runs SET job_source = 'LinkedIn'  WHERE job_source IS NULL`);
      console.log('[db] vNEW: search_runs.job_source added');
    }
  } catch (err) {
    console.warn('[db] Migration vNEW (search_runs.job_source) failed (non-fatal):', (err as Error).message);
  }

  // v_ats_discovery: add ATS discovery/validation settings columns
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'v_ats_discovery'`).get();
    if (!done) {
      const cols = (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('ats_discovery_enabled'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_discovery_enabled INTEGER NOT NULL DEFAULT 0`);
      if (!cols.includes('ats_discovery_cron'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_discovery_cron TEXT NOT NULL DEFAULT '0 3 1 * *'`);
      if (!cols.includes('ats_validation_enabled'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_validation_enabled INTEGER NOT NULL DEFAULT 0`);
      if (!cols.includes('ats_validation_cron'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_validation_cron TEXT NOT NULL DEFAULT '0 4 * * 1'`);
      db.exec(`INSERT INTO _migrations VALUES ('v_ats_discovery')`);
      console.log('[db] Migration v_ats_discovery: ATS settings columns added');
    }
  } catch (err) {
    console.warn('[db] Migration v_ats_discovery failed (non-fatal):', (err as Error).message);
  }

  // v_lever_discovery: add Lever-specific discovery settings column + one-time CSV import
  try {
    const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'v_lever_discovery'`).get();
    if (!done) {
      const cols = (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('ats_lever_disc_enabled'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_lever_disc_enabled INTEGER NOT NULL DEFAULT 0`);
      if (!cols.includes('ats_lever_disc_cron'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_lever_disc_cron TEXT NOT NULL DEFAULT '0 8 1 * *'`);

      // One-time import from lever_companies.csv if it exists and no Lever rows are present
      const leverCount = (db.prepare(`SELECT COUNT(*) AS c FROM ats_boards WHERE ats = 'lever'`).get() as { c: number }).c;
      if (leverCount === 0) {
        const fs = require('fs') as typeof import('fs');
        const path = require('path') as typeof import('path');
        // Check app root first, then parent dir for legacy local layout
        const csvPath = fs.existsSync(path.resolve(process.cwd(), 'lever_companies.csv'))
          ? path.resolve(process.cwd(), 'lever_companies.csv')
          : path.resolve(process.cwd(), '..', 'lever_companies.csv');
        if (fs.existsSync(csvPath)) {
          const lines = fs.readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
          const headers = lines[0].split(',').map((h: string) => h.trim());
          const slugIdx    = headers.indexOf('lever_slug');
          const nameIdx    = headers.indexOf('company_name');
          const statusIdx  = headers.indexOf('validation_status');
          const valAtIdx   = headers.indexOf('validated_at');
          const insert = db.prepare(`
            INSERT INTO ats_boards (ats, slug, company_name, is_active, discovered_at, validated_at)
            VALUES ('lever', ?, ?, ?, ?, ?)
            ON CONFLICT (ats, slug) DO NOTHING
          `);
          const now = new Date().toISOString();
          let imported = 0;
          for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            const slug    = cols[slugIdx]?.trim();
            const name    = cols[nameIdx]?.trim() || null;
            const status  = cols[statusIdx]?.trim();
            const valAt   = cols[valAtIdx]?.trim() || null;
            if (!slug) continue;
            const isActive = status === 'valid' ? 1 : 0;
            const result = insert.run(slug, name, isActive, now, valAt) as { changes: number };
            if (result.changes > 0) imported++;
          }
          console.log(`[db] Migration v_lever_discovery: imported ${imported} Lever companies from CSV`);
        }
      }

      db.exec(`INSERT INTO _migrations VALUES ('v_lever_discovery')`);
      console.log('[db] Migration v_lever_discovery: Lever settings columns added');
    }
  } catch (err) {
    console.warn('[db] Migration v_lever_discovery failed (non-fatal):', (err as Error).message);
  }

  // vMT_repair: if job_profile_states is empty but jobs_backup_vMT has data, restore from backup
  try {
    const jpsCount = (db.prepare(`SELECT COUNT(*) AS c FROM job_profile_states`).get() as { c: number }).c;
    const backupExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='jobs_backup_vMT'`).get();
    if (jpsCount === 0 && backupExists) {
      const backupCount = (db.prepare(`SELECT COUNT(*) AS c FROM jobs_backup_vMT`).get() as { c: number }).c;
      if (backupCount > 0) {
        const result = db.prepare(`
          INSERT OR IGNORE INTO job_profile_states (
            job_id, profile_id, group_id, fetched_at,
            ai_score, ai_verdict, original_ai_verdict, ai_rationale, ai_summary,
            rejection_category, cv_assessment,
            is_duplicate, duplicate_of_job_id,
            seen, seen_at, applied, user_notes
          )
          SELECT
            b.id, b.profile_id, b.group_id, b.fetched_at,
            COALESCE(b.ai_score, 0),
            COALESCE(b.ai_verdict, 'PENDING'),
            b.original_ai_verdict, b.ai_rationale, b.ai_summary,
            b.rejection_category, b.cv_assessment,
            COALESCE(b.is_duplicate, 0), b.duplicate_of_job_id,
            COALESCE(b.seen, 0), b.seen_at,
            COALESCE(b.applied, 0), b.user_notes
          FROM jobs_backup_vMT b
          WHERE EXISTS (SELECT 1 FROM jobs j WHERE j.id = b.id)
            AND b.profile_id IS NOT NULL
        `).run() as { changes: number };
        console.log(`[db] vMT_repair: restored ${result.changes} job_profile_states rows from backup`);
      }
    }
  } catch (err) {
    console.warn('[db] vMT_repair failed (non-fatal):', (err as Error).message);
  }

  // v_ats_pool: add pool fetch toggle columns to settings
  try {
    const done = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'v_ats_pool'`).get();
    if (!done) {
      const cols = (db.prepare(`PRAGMA table_info(settings)`).all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes('ats_pool_gh_enabled'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_pool_gh_enabled INTEGER NOT NULL DEFAULT 0`);
      if (!cols.includes('ats_pool_ashby_enabled'))
        db.exec(`ALTER TABLE settings ADD COLUMN ats_pool_ashby_enabled INTEGER NOT NULL DEFAULT 0`);
      db.exec(`INSERT INTO _migrations VALUES ('v_ats_pool')`);
      console.log('[db] Migration v_ats_pool: ATS pool settings columns added');
    }
  } catch (err) {
    console.warn('[db] Migration v_ats_pool failed (non-fatal):', (err as Error).message);
  }

  // v8: seed default search group from settings row if groups table is empty
  try {
    const groupCount = (
      db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }
    ).c;
    if (groupCount === 0) {
      const settings = db
        .prepare('SELECT * FROM settings WHERE id = 1')
        .get() as SettingsRow | undefined;
      if (settings) {
        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO search_groups (locations, keywords, job_type, work_modes, ai_system_prompt, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          settings.search_locations,
          settings.search_keywords,
          settings.search_job_type,
          settings.search_work_modes,
          settings.ai_system_prompt,
          now,
          now,
        );
        console.log('[db] Migration applied: default search group seeded from settings.');
      }
    }
  } catch (err) {
    console.warn('[db] Migration (seed default group) failed (non-fatal):', (err as Error).message);
  }

  // vMT: split jobs into canonical jobs + per-user job_profile_states
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY)`);
    const vmtDone = db.prepare(`SELECT 1 FROM _migrations WHERE name = 'vMT_job_profile_states'`).get();
    if (!vmtDone) {
      db.transaction(() => {
        db.exec(`CREATE TABLE jobs_backup_vMT AS SELECT * FROM jobs`);
        db.exec(`CREATE TABLE IF NOT EXISTS job_profile_states (
          job_id              INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
          profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
          group_id            INTEGER REFERENCES search_groups(id),
          fetched_at          TEXT    NOT NULL,
          ai_score            INTEGER NOT NULL DEFAULT 0,
          ai_verdict          TEXT    NOT NULL DEFAULT 'PENDING',
          original_ai_verdict TEXT,
          ai_rationale        TEXT,
          ai_summary          TEXT,
          rejection_category  TEXT,
          cv_assessment       TEXT,
          is_duplicate        INTEGER NOT NULL DEFAULT 0,
          duplicate_of_job_id INTEGER REFERENCES jobs(id),
          seen                INTEGER NOT NULL DEFAULT 0,
          seen_at             TEXT,
          applied             INTEGER NOT NULL DEFAULT 0,
          user_notes          TEXT,
          PRIMARY KEY (job_id, profile_id)
        )`);
        db.exec(`INSERT OR IGNORE INTO job_profile_states (
            job_id, profile_id, group_id, fetched_at,
            ai_score, ai_verdict, original_ai_verdict, ai_rationale, ai_summary,
            rejection_category, cv_assessment,
            is_duplicate, duplicate_of_job_id,
            seen, seen_at, applied, user_notes
          )
          SELECT
            id, profile_id, group_id, fetched_at,
            COALESCE(ai_score, 0),
            COALESCE(ai_verdict, 'PENDING'),
            original_ai_verdict, ai_rationale, ai_summary,
            rejection_category, cv_assessment,
            COALESCE(is_duplicate, 0), duplicate_of_job_id,
            COALESCE(seen, 0), seen_at,
            COALESCE(applied, 0), user_notes
          FROM jobs`);
        db.exec(`CREATE TABLE jobs_new (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          linkedin_job_id TEXT    NOT NULL,
          job_source      TEXT    NOT NULL DEFAULT 'LinkedIn',
          provider        TEXT    NOT NULL DEFAULT 'harvestapi',
          title           TEXT    NOT NULL,
          company         TEXT    NOT NULL,
          location        TEXT,
          work_mode       TEXT,
          description     TEXT    NOT NULL,
          url             TEXT,
          apply_url       TEXT,
          posted_date     TEXT,
          country         TEXT,
          fetched_at      TEXT    NOT NULL
        )`);
        db.exec(`INSERT INTO jobs_new
          SELECT id, linkedin_job_id, job_source, provider,
                 title, company, location, work_mode, description,
                 url, apply_url, posted_date, country, fetched_at
          FROM jobs`);
        db.exec(`DROP TABLE jobs`);
        db.exec(`ALTER TABLE jobs_new RENAME TO jobs`);
        db.exec(`CREATE UNIQUE INDEX idx_jobs_source_job_id ON jobs(linkedin_job_id, job_source)`);
        db.exec(`CREATE INDEX idx_jobs_company ON jobs(company)`);
        db.exec(`CREATE INDEX idx_jobs_fetched_at ON jobs(fetched_at)`);
        db.exec(`INSERT INTO _migrations VALUES ('vMT_job_profile_states')`);
      });
      console.log('[db] Migration vMT_job_profile_states: jobs split into canonical + job_profile_states');
    }
  } catch (err) {
    console.warn('[db] Migration vMT_job_profile_states failed:', (err as Error).message);
  }
}

function initSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_groups (
      id                      INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id              INTEGER NOT NULL DEFAULT 1,
      locations               TEXT    NOT NULL,
      keywords                TEXT    NOT NULL,
      job_type                TEXT    NOT NULL DEFAULT 'fullTime',
      work_modes              TEXT    NOT NULL,
      ai_system_prompt        TEXT    NOT NULL,
      score_no_match_max      INTEGER NOT NULL DEFAULT 50,
      score_weak_match_max    INTEGER NOT NULL DEFAULT 70,
      score_strong_match_min  INTEGER NOT NULL DEFAULT 71,
      created_at              TEXT    NOT NULL,
      updated_at              TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id            INTEGER NOT NULL DEFAULT 1,
      linkedin_job_id       TEXT    UNIQUE NOT NULL,
      title                 TEXT    NOT NULL,
      company               TEXT    NOT NULL,
      location              TEXT,
      work_mode             TEXT,
      description           TEXT    NOT NULL,
      url                   TEXT,
      posted_date           TEXT,
      fetched_at            TEXT    NOT NULL,
      ai_score              INTEGER NOT NULL,
      ai_rationale          TEXT,
      ai_summary            TEXT,
      ai_verdict            TEXT    NOT NULL,
      is_duplicate          INTEGER NOT NULL DEFAULT 0,
      duplicate_of_job_id   INTEGER,
      seen                  INTEGER NOT NULL DEFAULT 0,
      seen_at               TEXT,
      group_id              INTEGER REFERENCES search_groups(id),
      provider              TEXT    NOT NULL DEFAULT 'harvestapi',
      original_ai_verdict   TEXT,
      FOREIGN KEY (duplicate_of_job_id) REFERENCES jobs(id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_linkedin_id ON jobs(linkedin_job_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_company       ON jobs(company);
    CREATE INDEX IF NOT EXISTS idx_jobs_fetched_at    ON jobs(fetched_at);

    CREATE TABLE IF NOT EXISTS job_profile_states (
      job_id              INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      profile_id          INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      group_id            INTEGER REFERENCES search_groups(id),
      fetched_at          TEXT    NOT NULL,
      ai_score            INTEGER NOT NULL DEFAULT 0,
      ai_verdict          TEXT    NOT NULL DEFAULT 'PENDING',
      original_ai_verdict TEXT,
      ai_rationale        TEXT,
      ai_summary          TEXT,
      rejection_category  TEXT,
      cv_assessment       TEXT,
      is_duplicate        INTEGER NOT NULL DEFAULT 0,
      duplicate_of_job_id INTEGER REFERENCES jobs(id),
      seen                INTEGER NOT NULL DEFAULT 0,
      seen_at             TEXT,
      applied             INTEGER NOT NULL DEFAULT 0,
      user_notes          TEXT,
      PRIMARY KEY (job_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS search_runs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id          INTEGER NOT NULL DEFAULT 1,
      ran_at              TEXT    NOT NULL,
      jobs_fetched        INTEGER NOT NULL DEFAULT 0,
      jobs_scored         INTEGER NOT NULL DEFAULT 0,
      jobs_strong_match   INTEGER NOT NULL DEFAULT 0,
      jobs_weak_match     INTEGER NOT NULL DEFAULT 0,
      jobs_no_match       INTEGER NOT NULL DEFAULT 0,
      jobs_duplicate      INTEGER NOT NULL DEFAULT 0,
      status              TEXT    NOT NULL DEFAULT 'success',
      error_log           TEXT,
      duration_ms         INTEGER,
      trigger             TEXT    NOT NULL DEFAULT 'scheduled'
    );

    CREATE INDEX IF NOT EXISTS idx_runs_ran_at ON search_runs(ran_at);

    CREATE TABLE IF NOT EXISTS run_job_logs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER NOT NULL,
      group_id            INTEGER,
      linkedin_job_id     TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      company             TEXT    NOT NULL,
      location            TEXT,
      url                 TEXT,
      ai_score            INTEGER,
      ai_verdict          TEXT    NOT NULL,
      ai_rationale        TEXT,
      rejection_category  TEXT,
      logged_at           TEXT    NOT NULL,
      FOREIGN KEY (run_id)   REFERENCES search_runs(id),
      FOREIGN KEY (group_id) REFERENCES search_groups(id)
    );

    CREATE INDEX IF NOT EXISTS idx_run_job_logs_run_id ON run_job_logs(run_id);

    CREATE TABLE IF NOT EXISTS blacklisted_companies (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL DEFAULT 1,
      company_name TEXT    NOT NULL,
      notes        TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL,
      UNIQUE (profile_id, company_name)
    );

    CREATE TABLE IF NOT EXISTS location_country (
      location   TEXT PRIMARY KEY,
      country    TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS company_notes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL DEFAULT 1,
      company    TEXT    NOT NULL,
      note       TEXT    NOT NULL DEFAULT '',
      updated_at TEXT    NOT NULL,
      UNIQUE (profile_id, company)
    );

    CREATE TABLE IF NOT EXISTS cvs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id   INTEGER NOT NULL DEFAULT 1,
      filename     TEXT    NOT NULL,
      mime_type    TEXT    NOT NULL DEFAULT 'application/pdf',
      content_b64  TEXT    NOT NULL,
      file_size    INTEGER NOT NULL,
      uploaded_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      id                     INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id             INTEGER NOT NULL DEFAULT 1,
      search_keywords        TEXT    NOT NULL DEFAULT '',
      search_locations       TEXT    NOT NULL DEFAULT '',
      search_work_modes      TEXT    NOT NULL DEFAULT '',
      search_job_type        TEXT    NOT NULL DEFAULT 'fullTime',
      cron_schedule          TEXT    NOT NULL DEFAULT '0 7 * * *',
      ai_system_prompt       TEXT    NOT NULL DEFAULT '',
      ai_model               TEXT    NOT NULL DEFAULT 'gpt-5.4-mini',
      ai_model_hard          TEXT    NOT NULL DEFAULT 'gpt-5.4',
      dedup_system_prompt    TEXT    NOT NULL DEFAULT '',
      score_no_match_max     INTEGER NOT NULL DEFAULT 50,
      score_weak_match_max   INTEGER NOT NULL DEFAULT 70,
      score_strong_match_min INTEGER NOT NULL DEFAULT 71,
      email_recipient        TEXT    NOT NULL DEFAULT '',
      email_send_time        TEXT    NOT NULL DEFAULT '07:00',
      summary_prompt         TEXT    NOT NULL DEFAULT '',
      apify_api_token        TEXT    NOT NULL DEFAULT '',
      openai_api_key         TEXT    NOT NULL DEFAULT '',
      resend_api_key         TEXT    NOT NULL DEFAULT '',
      email_from             TEXT    NOT NULL DEFAULT '',
      email_enabled          INTEGER NOT NULL DEFAULT 1,
      timezone               TEXT    NOT NULL DEFAULT 'UTC',
      profile_description    TEXT    NOT NULL DEFAULT '',
      scoring_criteria       TEXT    NOT NULL DEFAULT '',
      scoring_guide          TEXT    NOT NULL DEFAULT '',
      no_match_criteria      TEXT    NOT NULL DEFAULT '',
      scraping_provider      TEXT    NOT NULL DEFAULT 'harvestapi',
      scraping_providers     TEXT    NOT NULL DEFAULT '["harvestapi","valig"]',
      profile_updated_at     TEXT    NOT NULL DEFAULT '',
      ai_updated_at          TEXT    NOT NULL DEFAULT '',
      updated_at             TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      is_admin   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      token       TEXT NOT NULL UNIQUE,
      profile_id  INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      last_active TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS otp_codes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL,
      code       TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_change_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      new_email  TEXT NOT NULL,
      token      TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

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
    CREATE INDEX IF NOT EXISTS idx_ats_boards_ats    ON ats_boards(ats);
    CREATE INDEX IF NOT EXISTS idx_ats_boards_active ON ats_boards(is_active);
  `);
}

// Create profile_id indexes after migrations have added the columns (safe with IF NOT EXISTS)
function ensureProfileIndexes(db: Database): void {
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_profile_id ON jobs(profile_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_seen ON jobs(seen)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jobs_verdict ON jobs(ai_verdict)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_profile ON search_runs(profile_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_blacklist_profile ON blacklisted_companies(profile_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jps_match_fetch ON job_profile_states(profile_id, ai_verdict, is_duplicate, fetched_at, ai_score, job_id)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jps_dedup ON job_profile_states(profile_id, is_duplicate)`); } catch (_) {}
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_jps_job_id ON job_profile_states(job_id)`); } catch (_) {}
}

function seedSettings(db: Database): void {
  const now = new Date().toISOString();

  // Seed Mikhail's settings (profile_id=1)
  const existing1 = db.prepare('SELECT id FROM settings WHERE profile_id = 1').get();
  if (!existing1) {
    db.prepare(`
      INSERT INTO settings (
        profile_id, search_keywords, search_locations, search_work_modes,
        search_job_type, cron_schedule, ai_system_prompt, ai_model,
        dedup_system_prompt,
        score_no_match_max, score_weak_match_max, score_strong_match_min,
        email_recipient, email_send_time, updated_at
      ) VALUES (
        1, ?, ?, ?,
        'fullTime', '0 7 * * *', ?, 'gpt-5.4',
        ?,
        50, 70, 71,
        '', '07:00', ?
      )
    `).run(
      DEFAULT_KEYWORDS,
      DEFAULT_LOCATIONS,
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      DEFAULT_DEDUP_SYSTEM_PROMPT,
      now,
    );
    console.log('[db] Settings seeded for Mikhail (profile_id=1).');
  }

  // Seed Arina's settings (profile_id=2)
  const existing2 = db.prepare('SELECT id FROM settings WHERE profile_id = 2').get();
  if (!existing2) {
    db.prepare(`
      INSERT INTO settings (
        profile_id, search_keywords, search_locations, search_work_modes,
        search_job_type, cron_schedule, ai_system_prompt, ai_model,
        dedup_system_prompt,
        score_no_match_max, score_weak_match_max, score_strong_match_min,
        email_recipient, email_send_time, updated_at
      ) VALUES (
        2, ?, ?, ?,
        'fullTime', '0 7 * * *', ?, 'gpt-5.4',
        ?,
        50, 70, 71,
        '', '07:00', ?
      )
    `).run(
      DEFAULT_KEYWORDS,
      DEFAULT_LOCATIONS,
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      DEFAULT_DEDUP_SYSTEM_PROMPT,
      now,
    );
    console.log('[db] Settings seeded for Arina (profile_id=2).');
  }

  // Also seed the first search group for brand-new installs (under Mikhail)
  const groupCount = (
    db.prepare('SELECT COUNT(*) as c FROM search_groups').get() as { c: number }
  ).c;
  if (groupCount === 0) {
    db.prepare(`
      INSERT INTO search_groups (profile_id, locations, keywords, job_type, work_modes, ai_system_prompt, created_at, updated_at)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      DEFAULT_LOCATIONS,
      DEFAULT_KEYWORDS,
      'fullTime',
      JSON.stringify(['remote', 'hybrid', 'onsite']),
      DEFAULT_AI_SYSTEM_PROMPT,
      now,
      now,
    );
  }
}

// ---- Row types ----

export interface ProfileRow {
  id: number;
  email: string;
  is_admin: number;   // 1 = admin, 0 = regular
  created_at: string;
}

export interface SessionRow {
  id: number;
  token: string;
  profile_id: number;
  created_at: string;
  expires_at: string;
  last_active: string;
}

export interface OtpCodeRow {
  id: number;
  email: string;
  code: string;
  attempts: number;
  created_at: string;
  expires_at: string;
  used: number;  // 0 = active, 1 = consumed/invalidated
}

export interface EmailChangeRequestRow {
  id: number;
  profile_id: number;
  new_email: string;
  token: string;
  created_at: string;
  expires_at: string;
  used: number;  // 0 = pending, 1 = confirmed/cancelled
}

export interface JobRow {
  id: number;
  linkedin_job_id: string;
  job_source: string;
  provider: string;
  title: string;
  company: string;
  location: string | null;
  work_mode: string | null;
  description: string;
  url: string | null;
  apply_url: string | null;
  posted_date: string | null;
  country: string | null;
  fetched_at: string;
}

export interface JobProfileStateRow {
  job_id: number;
  profile_id: number;
  group_id: number | null;
  fetched_at: string;
  ai_score: number;
  ai_verdict: string;
  original_ai_verdict: string | null;
  ai_rationale: string | null;
  ai_summary: string | null;
  rejection_category: string | null;
  cv_assessment: string | null;
  is_duplicate: number;
  duplicate_of_job_id: number | null;
  seen: number;
  seen_at: string | null;
  applied: number;
  user_notes: string | null;
}

export type JobWithState = JobRow & JobProfileStateRow;

export interface SearchRunRow {
  id: number;
  profile_id: number;
  ran_at: string;
  jobs_fetched: number;
  jobs_scored: number;
  jobs_strong_match: number;
  jobs_weak_match: number;
  jobs_no_match: number;
  jobs_duplicate: number;
  status: string;
  error_log: string | null;
  duration_ms: number | null;
  trigger: string;
  cost_openai_usd: number | null;
  cost_apify_usd: number | null;
  scraping_provider: string | null;
  job_source: string | null;
}

export interface SettingsRow {
  id: number;
  profile_id: number;
  search_keywords: string;
  search_locations: string;
  search_work_modes: string;
  search_job_type: string;
  cron_schedule: string;
  ai_system_prompt: string;
  ai_model: string;
  ai_model_hard: string;
  dedup_system_prompt: string;
  summary_prompt: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
  email_recipient: string;
  email_send_time: string;
  apify_api_token: string;
  openai_api_key: string;
  resend_api_key: string;
  email_from: string;
  email_enabled: number;  // 1 = send email, 0 = skip
  timezone: string;       // IANA timezone, e.g. 'Europe/London'
  profile_description: string;
  scoring_criteria: string;
  scoring_guide: string;
  no_match_criteria: string;
  schedule_date_range: string;  // '24h' | '7d' | 'month'
  schedule_group_ids: string;   // JSON number[] | '' for all active
  scraping_provider: string;    // 'harvestapi' | 'valig' (legacy single value)
  scraping_providers: string;  // JSON string[] e.g. '["harvestapi","valig"]'
  cv_comparison_prompt: string;
  languages: string;            // comma-separated professional languages
  current_location: string;    // user's current country
  profile_updated_at: string;
  ai_updated_at: string;
  updated_at: string;
  ats_discovery_enabled: number;
  ats_discovery_cron: string;
  ats_validation_enabled: number;
  ats_validation_cron: string;
  ats_pool_gh_enabled: number;
  ats_pool_ashby_enabled: number;
}

export interface CvRow {
  id: number;
  profile_id: number;
  filename: string;
  mime_type: string;
  content_b64: string;
  file_size: number;
  uploaded_at: string;
}

export interface RunJobLogRow {
  id: number;
  run_id: number;
  group_id: number | null;
  linkedin_job_id: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  ai_score: number | null;
  ai_verdict: string;
  ai_rationale: string | null;
  rejection_category: string | null;
  logged_at: string;
}

export interface BlacklistedCompanyRow {
  id: number;
  profile_id: number;
  company_name: string;
  notes: string;
  created_at: string;
}

export interface SearchGroupRow {
  id: number;
  profile_id: number;
  group_name: string;
  locations: string;         // JSON string[]
  keywords: string;          // JSON string[]
  job_type: string;
  work_modes: string;        // JSON string[]
  ai_system_prompt: string;
  title_filter: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
  profile_description: string;
  industries_list: string;
  other_expectations: string;
  scoring_criteria: string;
  scoring_guide: string;
  no_match_criteria: string;
  is_active: number;         // 1 = active, 0 = inactive
  created_at: string;
  updated_at: string;
}
