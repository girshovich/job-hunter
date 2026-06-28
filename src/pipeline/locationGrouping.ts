import { getDb } from '../db';

/**
 * Merges incoming location labels and countries into an existing job's child tables.
 * Uses INSERT OR IGNORE so already-present rows are skipped.
 * Returns true if any new row was inserted (useful for logging).
 */
export function groupOrDrop(
  matchedRoleId: number,
  incoming: { labels: string[]; countries: string[] },
): boolean {
  const db = getDb();
  const insertLoc = db.prepare<unknown>(`INSERT OR IGNORE INTO job_locations (job_id, label) VALUES (?, ?)`);
  const insertCountry = db.prepare<unknown>(`INSERT OR IGNORE INTO job_countries (job_id, country) VALUES (?, ?)`);

  let added = false;
  for (const label of incoming.labels) {
    if (insertLoc.run(matchedRoleId, label).changes > 0) added = true;
  }
  for (const country of incoming.countries) {
    if (insertCountry.run(matchedRoleId, country).changes > 0) added = true;
  }
  return added;
}
