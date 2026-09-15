/**
 * Presence-column snapshot/restore for the whole suite.
 *
 * The auth gate calls `touchProfileActivity` on any authed request (`src/index.ts`), and a real
 * login does too (`src/routes/auth.ts`). Every spec here browses as a **real** profile, so simply
 * running the suite writes `profiles.last_active_at` / `active_day_last` / `active_days_count` and
 * clears `settings.activity_warned_at` — it makes real accounts look like a human used the product
 * today, and inflates the day counter that picks the 10- vs 30-day threshold (schedule_disable.md §3).
 * It also appends a `profile_active_days` row per profile, which would put the suite's own browsing
 * into the Admin Stats DAU/WAU chart as if real users had been there.
 *
 * That can only ever delay a pause, never cause one, but it is still the suite writing to columns
 * it does not own.
 *
 * Handled globally rather than per spec, because these columns are written by the framework on
 * *every* request rather than by any one spec's own actions. A per-spec `afterAll` would also race:
 * spec files run in parallel workers against the same profile, so one file could snapshot a value
 * another file had already bumped and then restore that. One snapshot before the run and one
 * restore after it has neither problem, and it covers specs added later for free.
 *
 * Restores by exact profile id, and only the columns it read — never a broad sweep. The day log has
 * no columns to put back, so it is bounded by `rowid` instead: everything appended after the mark is
 * removed, and rows that existed before the run are never touched.
 *
 * Not named `*.spec.ts`, so Playwright does not collect this as a test file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');
const SNAPSHOT_PATH = path.join(__dirname, '..', 'test-results', '.activity-snapshot.json');

interface ActivityRow {
  id: number;
  last_active_at: string | null;
  active_day_last: string | null;
  active_days_count: number;
  activity_warned_at: string | null;
}

interface Snapshot {
  rows: ActivityRow[];
  maxActiveDayRowid: number;   // highest profile_active_days rowid before the suite ran
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

/** Every profile's presence columns, written to a file — globalSetup and globalTeardown are separate loads. */
export function snapshotActivity(): void {
  const db = openDb();
  try {
    const rows = db.prepare(`
      SELECT p.id, p.last_active_at, p.active_day_last, p.active_days_count, s.activity_warned_at
      FROM profiles p LEFT JOIN settings s ON s.profile_id = p.id
    `).all() as unknown as ActivityRow[];
    const mark = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM profile_active_days')
      .get() as unknown as { m: number };
    fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
    const snap: Snapshot = { rows, maxActiveDayRowid: mark.m };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap));
  } finally {
    db.close();
  }
}

/** Puts back exactly what `snapshotActivity` read. A missing snapshot means the setup never ran. */
export function restoreActivity(): void {
  if (!fs.existsSync(SNAPSHOT_PATH)) return;
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
  // A snapshot this code cannot read is treated as one that is not there — the same rule as the
  // line above. Throwing here would skip the restore entirely, which is the outcome this file
  // exists to prevent; a file written by an older shape would do exactly that.
  if (!Array.isArray(snap?.rows)) {
    console.warn('[activity] snapshot unreadable, presence columns not restored:', SNAPSHOT_PATH);
    fs.rmSync(SNAPSHOT_PATH, { force: true });
    return;
  }
  const rows = snap.rows;
  const db = openDb();
  try {
    const profiles = db.prepare(
      'UPDATE profiles SET last_active_at = ?, active_day_last = ?, active_days_count = ? WHERE id = ?',
    );
    const settings = db.prepare('UPDATE settings SET activity_warned_at = ? WHERE profile_id = ?');
    for (const r of rows) {
      profiles.run(r.last_active_at, r.active_day_last, r.active_days_count, r.id);
      settings.run(r.activity_warned_at, r.id);
    }
    // Only what this run appended. A `DELETE … WHERE day = <today>` would take a real user's
    // genuine visit with it.
    db.prepare('DELETE FROM profile_active_days WHERE rowid > ?').run(snap.maxActiveDayRowid);
  } finally {
    db.close();
    fs.rmSync(SNAPSHOT_PATH, { force: true });
  }
}
