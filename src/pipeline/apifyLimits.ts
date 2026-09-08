/**
 * Apify account-limit detection.
 *
 * `GET /v2/users/me/limits` reports the calling token's own `maxConcurrentActorJobs`. That is
 * better data than the plan dropdown in both directions: the published plan tables are known to lag
 * reality (docs.apify.com still showed Free = 25 months after it became 5), and a dropdown is a
 * human self-report that nobody re-checks after changing plan.
 *
 * So a **fresh detection wins outright** and the dropdown is the fallback for when detection is
 * down. The alternative — `min(dropdown, detected)` — would have left every existing profile
 * throttled at the conservative default with no way for detection to lift it.
 *
 * Detection must never be able to fail or noticeably delay a run: 3s hard timeout, every error
 * swallowed, and the cached value used regardless. Measured at ~0.5s against runs of 68-350s.
 */

import type { Database } from '../db';
import { deriveApifyPlan } from './limitTables';

const DETECT_TIMEOUT_MS = 3_000;

/**
 * How long a *failed* detection is remembered before the token is tried again.
 *
 * Only a success is written to the database, so without this a token whose detection keeps failing
 * looks permanently stale and every single run start pays the full timeout again — 3s per run, on
 * every run, for as long as Apify's endpoint is unwell. In memory rather than in a column because
 * the cost being avoided is per-process and a restart is a perfectly good reason to re-check.
 */
const FAILURE_BACKOFF_MS = 60 * 60_000;
const failedUntil = new Map<string, number>();

/** `maxConcurrentActorJobs` for this token, or `null` if the account could not be asked. */
export async function detectApifyConcurrency(token: string): Promise<number | null> {
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DETECT_TIMEOUT_MS);
  try {
    const res = await fetch('https://api.apify.com/v2/users/me/limits', {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[apifyLimits] detection returned HTTP ${res.status}; using the plan setting`);
      return null;
    }
    const body = await res.json() as { data?: { limits?: { maxConcurrentActorJobs?: number } } };
    const max = Number(body?.data?.limits?.maxConcurrentActorJobs);
    return Number.isFinite(max) && max > 0 ? max : null;
  } catch (err) {
    const reason = (err as Error).name === 'AbortError' ? `timed out after ${DETECT_TIMEOUT_MS}ms` : (err as Error).message;
    console.warn(`[apifyLimits] detection failed (${reason}); using the plan setting`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect and cache against a settings row. Returns the detected ceiling, or `null` when the account
 * could not be asked — in which case the stored value is left exactly as it was, so a transient
 * outage never downgrades a profile that has a good answer on file.
 *
 * `profileId` is the row to cache against, and the caller decides which row that is — the two
 * callers legitimately differ. A run caches against the row its token was resolved *from* (the
 * admin row in credits mode), so the cache and the limit stay together. "Test key" caches against
 * the row of whoever pressed it, because the token is theirs; routing that through the resolver
 * instead would let any credits user overwrite the operator's ceiling with their own account's.
 */
export async function refreshApifyLimits(
  db: Database,
  profileId: number,
  token: string,
  opts: { honourBackoff?: boolean } = {},
): Promise<number | null> {
  // Only the automatic run-start path backs off. A user pressing "Test key" is asking us to go and
  // look right now — silently skipping that because the same token failed earlier would make the
  // button appear broken exactly when they are trying to fix the thing that broke.
  if (opts.honourBackoff) {
    const until = failedUntil.get(token) ?? 0;
    if (Date.now() < until) return null;
  }

  const detected = await detectApifyConcurrency(token);
  if (detected == null) {
    failedUntil.set(token, Date.now() + FAILURE_BACKOFF_MS);
    return null;
  }
  failedUntil.delete(token);
  // The plan name is a label for the UI, derived from the ceiling. '' when the ceiling matches no
  // published plan, which means a negotiated one — we show the capability alone rather than guess.
  db.prepare(`
    UPDATE settings SET apify_concurrency_detected = ?, apify_limits_checked_at = ?, apify_plan = ?
    WHERE profile_id = ?
  `).run(detected, new Date().toISOString(), deriveApifyPlan(detected), profileId);
  return detected;
}
