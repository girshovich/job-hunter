/**
 * Custom job statuses — the list, its types, and the history log.
 *
 * A status is the user's word; its **type** is how the app understands it, and the type is what
 * every filter, shortcut, colour and statistic reads (application_status.md §4, D1–D2). The user
 * never picks a colour — several statuses sharing one is the point.
 *
 * Two tables and one column carry this:
 *   `statuses`           — one ordered list per profile, capped at 15 live rows, soft-deleted
 *   `job_status_events`  — the diary: one row per move, oldest first when read
 *   `job_profile_states.status_id` — the denormalised answer to "where is this now", because
 *                          every list query filters and groups on it (§5, Trap 1)
 */

import { getDb, seedStatusesForProfile, type StatusType, type StatusRow } from './db';

export { DEFAULT_STATUSES, MAX_STATUSES, seedStatusesForProfile } from './db';

/** Status names are chips before they are records — a long one breaks the rail and the list card
 *  long before it breaks the admin table. Fifteen characters fits every default, the longest
 *  being "Hiring Manager" at fourteen. */
export const MAX_STATUS_NAME = 15;
export type { StatusType, StatusRow } from './db';

export const STATUS_TYPES: StatusType[] = ['new', 'wont', 'applied', 'progress', 'offer', 'rejected'];

/**
 * What each type means to the app. `bucket` drives the three sidebar shortcuts, `countsApplied`
 * drives every application statistic, and the chip colours come straight from §10's table.
 *
 * `wont` deliberately does NOT count as an application and `rejected` deliberately does — one
 * never became an application, the other applied and then ended (§4.2). One bucket for "dead"
 * would corrupt every statistic the moment a user withdrew from anything.
 */
export const TYPE_META: Record<StatusType, {
  label: string;
  bucket: 'new' | 'dead' | 'applied' | 'live' | 'ended';
  countsApplied: boolean;
  chip: string;        // inline style for a solid status chip
  dot: string;         // the colour alone, for menu dots and rail dots
}> = {
  new:      { label: 'New',         bucket: 'new',     countsApplied: false, dot: '#1f2634',         chip: 'background:#1f2634;color:#fff' },
  wont:     { label: 'Not applying', bucket: 'dead',    countsApplied: false, dot: 'var(--faint)',    chip: 'background:var(--faint);color:#fff' },
  applied:  { label: 'Applied',     bucket: 'applied', countsApplied: true,  dot: 'var(--sky-ink)',  chip: 'background:var(--sky-ink);color:#fff' },
  progress: { label: 'In Progress', bucket: 'live',    countsApplied: true,  dot: 'var(--green)',    chip: 'background:var(--green);color:#fff' },
  // The only status that is not flat, and the only one with dark ink — DS v2 reserves gradients
  // for the singular, and the avatar is the only other one (D27, §10.3).
  offer:    { label: 'Offer',       bucket: 'live',    countsApplied: true,  dot: 'var(--gold)',     chip: 'background:linear-gradient(135deg,#ffd166,var(--gold));color:var(--gold-ink);box-shadow:inset 0 1px 0 rgba(255,255,255,.55),0 1px 2px rgba(190,130,10,.3)' },
  rejected: { label: 'Rejected',    bucket: 'ended',   countsApplied: true,  dot: 'var(--red)',      chip: 'background:var(--red);color:#fff' },
};

/** The types that mean "this became an application" — the arithmetic behind every Applied count. */
export const APPLIED_TYPES: StatusType[] = STATUS_TYPES.filter((t) => TYPE_META[t].countsApplied);

/** The three sidebar shortcuts, defined by type so a status created today lands in the right one. */
export const PRESETS: Array<{ id: string; label: string; buckets: Array<'new' | 'dead' | 'applied' | 'live' | 'ended'> }> = [
  { id: 'new',   label: 'New',        buckets: ['new'] },
  { id: 'act',   label: 'In Progress', buckets: ['live'] },
  { id: 'touch', label: 'Progress History', buckets: ['live', 'ended'] },
];

/**
 * The types a user may give a status. `new`, `wont` and `applied` are missing on purpose: each is
 * a single built-in row carrying the meaning the old three-state column migrated onto, and a
 * second status of one of those types would make "is this an application?" ambiguous. What the
 * user actually wants to name are the stages between applying and an answer.
 */
export const ASSIGNABLE_TYPES: StatusType[] = ['progress', 'offer', 'rejected'];

/**
 * The list's order, and it is not the user's to arrange: **by type, then by name**. Ordering was
 * manual at first (D21 read it as "the order they arranged"), but a hand-sorted list is a chore
 * that earns nothing here — the type already groups the list meaningfully and the name orders it
 * predictably, so the picker's "Move on" split lands in the same place every time without anyone
 * maintaining it.
 */
const TYPE_RANK = STATUS_TYPES.map((t, i) => `WHEN '${t}' THEN ${i}`).join(' ');
const STATUS_ORDER = `ORDER BY CASE type ${TYPE_RANK} ELSE 99 END, name COLLATE NOCASE ASC, id ASC`;

/** Live statuses, ordered. Archived rows are invisible everywhere but history. */
export function listStatuses(profileId: number, includeArchived = false): StatusRow[] {
  const where = includeArchived ? '' : ' AND archived_at IS NULL';
  return getDb().prepare(
    `SELECT * FROM statuses WHERE profile_id = ?${where} ${STATUS_ORDER}`,
  ).all(profileId) as StatusRow[];
}

/** Every status this profile has ever had, keyed by id — history renders archived ones too. */
export function statusMap(profileId: number): Map<number, StatusRow> {
  const m = new Map<number, StatusRow>();
  for (const s of listStatuses(profileId, true)) m.set(s.id, s);
  return m;
}

/** The built-in `New` row. Written by the fetch, never picked, always first in a history (D34). */
export function newStatusId(profileId: number): number {
  const row = getDb().prepare(
    "SELECT id FROM statuses WHERE profile_id = ? AND type = 'new' AND is_builtin = 1 ORDER BY sort_order ASC LIMIT 1",
  ).get(profileId) as { id: number } | undefined;
  if (row) return row.id;
  // A profile created before the migration ran, or one whose list was emptied: seed and retry.
  seedStatusesForProfile(getDb(), profileId);
  return (getDb().prepare(
    "SELECT id FROM statuses WHERE profile_id = ? AND type = 'new' ORDER BY sort_order ASC LIMIT 1",
  ).get(profileId) as { id: number }).id;
}

/** Ids of every live status carrying one of these types. */
export function idsOfTypes(profileId: number, types: StatusType[]): number[] {
  if (types.length === 0) return [];
  return (getDb().prepare(
    `SELECT id FROM statuses WHERE profile_id = ? AND archived_at IS NULL
       AND type IN (${types.map(() => '?').join(',')}) ${STATUS_ORDER}`,
  ).all(profileId, ...types) as Array<{ id: number }>).map((r) => r.id);
}

/** A preset resolved into the real statuses that carry its types (D45). */
export function idsOfPreset(profileId: number, presetId: string): number[] {
  const p = PRESETS.find((x) => x.id === presetId);
  if (!p) return [];
  return idsOfTypes(profileId, STATUS_TYPES.filter((t) => p.buckets.includes(TYPE_META[t].bucket)));
}

/**
 * Parse `?status=`. Three shapes reach this, and all three are ours:
 *   - a comma list of status ids — what the filter and the sidebar shortcuts emit
 *   - `applied` / `new` / `wont` — the old single-word values, kept as a bookmark alias (D10, D49)
 *   - empty / absent — no status filter at all
 *
 * An unknown id is **dropped, never allowed to zero out the result** — otherwise a link to a
 * status the user has since deleted shows an empty list with nothing to explain it (D49). If every
 * value is unknown the filter is dropped entirely, which is the same reading as "all statuses"
 * and never the silently-empty app of D50.
 */
export function parseStatusParam(profileId: number, raw: string): number[] | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const ALIASES: Record<string, StatusType[]> = { new: ['new'], applied: ['applied'], wont: ['wont'] };
  if (ALIASES[trimmed]) {
    const ids = idsOfTypes(profileId, ALIASES[trimmed]);
    return ids.length ? ids : null;
  }
  const live = new Set(listStatuses(profileId).map((s) => s.id));
  const ids = trimmed.split(',')
    .map((v) => parseInt(v, 10))
    .filter((n) => Number.isFinite(n) && live.has(n));
  if (ids.length === 0) return null;
  // Sorted so `?status=b,a` and `?status=a,b` are one cache entry, not two (FL9).
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

/**
 * "Has this job ever been an application?" — the rule behind every Applied count (NR1).
 *
 * Two halves, and both are needed. The events half is the truth for anything the user has touched
 * since this shipped. The current-status half covers jobs migrated from the old `applied` column:
 * no history was invented for them (D8), so without it every pre-existing application would
 * vanish from the Stats page on deploy day.
 *
 * `jps` is the alias of `job_profile_states` in the calling query.
 */
export function everAppliedSql(jps = 'jps'): string {
  const types = APPLIED_TYPES.map((t) => `'${t}'`).join(',');
  return `(EXISTS (
      SELECT 1 FROM job_status_events e JOIN statuses es ON es.id = e.status_id
      WHERE e.job_id = ${jps}.job_id AND e.profile_id = ${jps}.profile_id AND es.type IN (${types})
    ) OR EXISTS (
      SELECT 1 FROM statuses cs WHERE cs.id = ${jps}.status_id AND cs.type IN (${types})
    ))`;
}

export interface HistoryStep {
  id: number;
  status_id: number;
  name: string;
  type: StatusType;
  changed_at: string;   // 'YYYY-MM-DD'
}

/**
 * A job's history, oldest first. Ordered by `(date, id)`, never by date alone — date-only sorting
 * reshuffles same-day steps on every render and can silently flip which one is current (D52).
 */
export function jobHistory(profileId: number, jobId: number): HistoryStep[] {
  return getDb().prepare(`
    SELECT e.id, e.status_id, s.name, s.type, e.changed_at
    FROM job_status_events e JOIN statuses s ON s.id = e.status_id
    WHERE e.profile_id = ? AND e.job_id = ?
    ORDER BY e.changed_at ASC, e.id ASC
  `).all(profileId, jobId) as HistoryStep[];
}

/** Today in the profile's timezone — history dates are local, or "today" reads wrong (§5). */
export function todayIn(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function profileTimezone(profileId: number): string {
  const row = getDb().prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(profileId) as { timezone?: string } | undefined;
  return row?.timezone || 'UTC';
}

/**
 * Days between a history date and today, in the profile's timezone. Used by both elapsed
 * readouts — the card chip's `13d` and the rail heading's `for 13 days` (D37, D48).
 */
export function daysSince(dateStr: string, timezone: string): number {
  const a = Date.parse(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(todayIn(timezone) + 'T00:00:00Z');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * Point a job at a status and write the move to the diary, in one transaction.
 *
 * `applied` is kept in step for one release as a read-only fallback (§12.2 step 5) — nothing reads
 * it any more, but a rollback that lands on the old code should not find a column frozen in 2026.
 */
export function setJobStatus(profileId: number, jobId: number, statusId: number, when: string): boolean {
  const db = getDb();
  const status = db.prepare('SELECT * FROM statuses WHERE id = ? AND profile_id = ?').get(statusId, profileId) as StatusRow | undefined;
  if (!status || status.archived_at) return false;
  return db.transaction(() => {
    const changes = db.prepare(
      'UPDATE job_profile_states SET status_id = ?, applied = ? WHERE job_id = ? AND profile_id = ?',
    ).run(statusId, legacyApplied(status.type), jobId, profileId).changes;
    if (changes === 0) return false;
    db.prepare(
      "INSERT INTO job_status_events (profile_id, job_id, status_id, changed_at, source) VALUES (?, ?, ?, ?, 'user')",
    ).run(profileId, jobId, statusId, when);
    return true;
  });
}

/**
 * Recompute the denormalised current status from the log — the newest step wins, and "newest"
 * means `(date, id)` so two steps on one day keep the order they were written in (D52).
 * With no steps left the job is New again (§5).
 *
 * Callers run this inside the same transaction as the edit that made it necessary (DP12).
 */
export function recomputeCurrent(profileId: number, jobId: number): void {
  const db = getDb();
  const row = db.prepare(`
    SELECT e.status_id, s.type FROM job_status_events e JOIN statuses s ON s.id = e.status_id
    WHERE e.profile_id = ? AND e.job_id = ?
    ORDER BY e.changed_at DESC, e.id DESC LIMIT 1
  `).get(profileId, jobId) as { status_id: number; type: StatusType } | undefined;
  const statusId = row ? row.status_id : newStatusId(profileId);
  const type: StatusType = row ? row.type : 'new';
  db.prepare('UPDATE job_profile_states SET status_id = ?, applied = ? WHERE job_id = ? AND profile_id = ?')
    .run(statusId, legacyApplied(type), jobId, profileId);
}

/** The old three-state column, derived. Written, never read (§12.2 step 5). */
export function legacyApplied(type: StatusType): number {
  if (type === 'wont') return 2;
  return TYPE_META[type].countsApplied ? 1 : 0;
}

export interface Shortcut {
  id: string;
  label: string;
  ids: number[];
  href: string;
  count: number;
}

/**
 * The three Matches shortcuts, resolved for the sidebar (D40, D45).
 *
 * Each one is a **preset over the ordinary Status filter**, not a filter value of its own: its
 * types resolve to the real statuses that carry them and those ids go in the URL, so the filter
 * never shows a word the user cannot also pick. The counts are computed on the same base the
 * Matches list uses — strong, non-duplicate — so a shortcut's number always equals what clicking
 * it shows (NR3).
 */
export function shortcuts(profileId: number): Shortcut[] {
  const db = getDb();
  return PRESETS.map((p) => {
    const ids = idsOfPreset(profileId, p.id);
    const count = ids.length === 0 ? 0 : (db.prepare(`
      SELECT COUNT(*) as c FROM job_profile_states jps
      WHERE jps.profile_id = ? AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0
        AND jps.status_id IN (${ids.map(() => '?').join(',')})
    `).get(profileId, ...ids) as { c: number }).c;
    return { id: p.id, label: p.label, ids, count, href: '/jobs?status=' + ids.join(',') };
  });
}

/**
 * Which shortcut, if any, the current selection happens to be. Take one status out of a preset's
 * set and the sidebar stops claiming you are in that view — because you are not (FL4).
 */
export function activeShortcut(list: Shortcut[], selected: number[] | null): string | null {
  if (selected === null) return 'all';
  const want = selected.slice().sort((a, b) => a - b).join(',');
  const hit = list.find((s) => s.ids.slice().sort((a, b) => a - b).join(',') === want);
  return hit ? hit.id : null;
}
