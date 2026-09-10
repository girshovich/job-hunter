/**
 * Abandoned-schedule reaper (schedule_disable.md).
 *
 * One daily sweep stops the schedules of profiles whose owner has gone quiet, so Apify, OpenAI and
 * the box are not spent producing digests nobody opens. Two days before that it sends one warning.
 *
 * The signal is `profiles.last_active_at`, written by `touchProfileActivity` on authed human
 * requests only — a scheduled run never touches it, which is the whole point.
 */

import cron from 'node-cron';
import { getDb, type Database } from '../db';
import { stopScheduleAndPersist } from './runner';
import { sendScheduleInactivityWarning } from './emailReport';
import { config } from '../config';

/** Silence, in days, that ends a schedule. The short track is for accounts never seen after signup day. */
const PAUSE_SHORT_DAYS = 10;
const PAUSE_LONG_DAYS  = 30;
/** The warning goes out this many days before the pause. */
const WARN_LEAD_DAYS   = 2;

let reaperTask: ReturnType<typeof cron.schedule> | null = null;

interface Candidate {
  profile_id: number;
  email: string;
  active_days_count: number;
  last_active_at: string | null;
  activity_warned_at: string | null;
}

/**
 * Profiles with a live schedule whose owner has been silent for at least `shortDays` (never
 * returned after signup day) or `longDays` (everyone else).
 *
 * Both sides of the comparison go through `datetime()`. The app writes ISO-8601 while
 * `datetime('now', …)` returns `YYYY-MM-DD HH:MM:SS`, and a space sorts below 'T', so comparing
 * the two as raw strings inverts inside a single calendar day — the bug class PRD §11 records.
 */
function selectSilent(db: Database, shortDays: number, longDays: number): Candidate[] {
  return db.prepare<Candidate>(`
    SELECT s.profile_id, p.email, p.active_days_count, p.last_active_at, s.activity_warned_at
    FROM settings s
    JOIN profiles p ON p.id = s.profile_id
    WHERE s.schedule_active = 1
      AND p.last_active_at IS NOT NULL
      AND datetime(p.last_active_at) < datetime('now',
            CASE WHEN p.active_days_count <= 1 THEN ? ELSE ? END)
    ORDER BY s.profile_id
  `).all(`-${shortDays} days`, `-${longDays} days`);
}

/** Resend credentials and the site URL, all from the admin profile with the env vars as fallback. */
function adminMailContext(db: Database): { appUrl: string; resendApiKey: string; emailFrom: string } {
  const admin = db.prepare<{ id: number }>('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get();
  const s = admin
    ? db.prepare<{ app_url?: string; resend_api_key?: string; email_from?: string }>(
        'SELECT app_url, resend_api_key, email_from FROM settings WHERE profile_id = ?'
      ).get(admin.id)
    : undefined;
  return {
    appUrl: s?.app_url?.trim() || '',
    resendApiKey: s?.resend_api_key?.trim() || config.resendApiKey,
    emailFrom: s?.email_from?.trim() || config.emailFrom,
  };
}

/**
 * The sweep. Exported so it can be driven directly in a test or from a one-off script rather than
 * only by the cron.
 *
 * In shadow mode (the default — `SCHEDULE_REAPER_ENFORCE` unset) it logs what it *would* do and
 * changes nothing: no pause, no email. That is the rollout plan in schedule_disable.md §9.
 */
export async function runScheduleReaperSweep(enforce = config.scheduleReaperEnforce): Promise<void> {
  const db = getDb();
  const label = enforce ? '[schedule-reaper]' : '[schedule-reaper][shadow]';

  // One SELECT per pass, then one transaction: `node:sqlite` is synchronous and the server is a
  // single fork, so every statement here blocks the event loop.
  const toPause = selectSilent(db, PAUSE_SHORT_DAYS, PAUSE_LONG_DAYS);
  // `activity_warned_at` holds the warning to one per silence streak; touchProfileActivity clears
  // it the moment the user comes back.
  const toWarn = selectSilent(db, PAUSE_SHORT_DAYS - WARN_LEAD_DAYS, PAUSE_LONG_DAYS - WARN_LEAD_DAYS)
    .filter((c) => !c.activity_warned_at && !toPause.some((p) => p.profile_id === c.profile_id));

  for (const c of toPause) {
    console.log(`${label} pause profile ${c.profile_id} (${c.email}) — silent since ${c.last_active_at}, ${c.active_days_count} active day(s)`);
  }
  for (const c of toWarn) {
    console.log(`${label} warn profile ${c.profile_id} (${c.email}) — silent since ${c.last_active_at}, ${c.active_days_count} active day(s)`);
  }
  if (!enforce) {
    console.log(`${label} sweep complete: ${toPause.length} would pause, ${toWarn.length} would be warned (enforcement off)`);
    return;
  }

  // Warn first: a profile that crosses into the pause window mid-sweep would otherwise be stopped
  // in the same pass that promised it two more days.
  const { appUrl, resendApiKey, emailFrom } = adminMailContext(db);
  for (const c of toWarn) {
    if (!resendApiKey || !emailFrom || !c.email) {
      console.warn(`${label} no Resend config — warning for profile ${c.profile_id} skipped`);
      break;
    }
    try {
      await sendScheduleInactivityWarning(c.email, c.active_days_count <= 1 ? 'new' : 'lapsed', appUrl, resendApiKey, emailFrom);
      db.prepare('UPDATE settings SET activity_warned_at = ? WHERE profile_id = ?').run(new Date().toISOString(), c.profile_id);
    } catch (err) {
      // A failed send never blocks the pause — it just means this profile gets no notice.
      console.error(`${label} warning email failed for profile ${c.profile_id}:`, (err as Error).message);
    }
  }

  const now = new Date().toISOString();
  for (const c of toPause) {
    // Both halves, via the same helper the credits path uses: cancelling the in-memory cron without
    // writing schedule_active = 0 would let the next boot resurrect the schedule (index.ts).
    stopScheduleAndPersist(db, c.profile_id);
    db.prepare('UPDATE settings SET schedule_paused_at = ?, schedule_paused_reason = ? WHERE profile_id = ?')
      .run(now, 'inactivity', c.profile_id);
  }
  console.log(`${label} sweep complete: paused ${toPause.length}, warned ${toWarn.length}`);
}

/**
 * Always-on daily sweep at midday in the admin's own timezone, so anything it does lands in working
 * hours. Away from pool cleanup (03:00 UTC) and the pool chain (05:00–05:45).
 *
 * If the process is down at cron time the sweep is simply skipped: it is idempotent and catches up
 * the next day, so no missed-run catcher is needed.
 */
export function startScheduleReaperCron(): void {
  reaperTask?.stop();
  const db = getDb();
  const admin = db.prepare<{ id: number }>('SELECT id FROM profiles WHERE is_admin = 1 LIMIT 1').get();
  const timezone = (admin
    ? db.prepare<{ timezone?: string }>('SELECT timezone FROM settings WHERE profile_id = ?').get(admin.id)?.timezone
    : undefined) || 'UTC';

  reaperTask = cron.schedule('0 12 * * *', () => {
    runScheduleReaperSweep().catch((err) => console.error('[schedule-reaper] Sweep failed:', err));
  }, { timezone });
  console.log(`[schedule-reaper] Cron scheduled: daily at 12:00 (${timezone})` +
    (config.scheduleReaperEnforce ? '' : ' — shadow mode, enforcement off'));
}
