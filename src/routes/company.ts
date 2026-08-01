/**
 * Company details modal loaders. Split in two on purpose: shared company basics carry no
 * profile scoping at all, profile-specific context always takes a profile_id.
 */

import { getDb } from '../db';

export interface CompanyBasics {
  display_name: string | null;
  logo_url: string | null;
  short_description: string | null;
  employee_count: number | null;
  employee_range: string | null;
  is_agency: number | null;   // NULL = unknown
  source_note: string | null;
  enrich_status: string | null;
  enriched_at: string | null;
}

export interface CompanyUserContext {
  allJobs: number;
  strongMatches: number;
  applications: number;
  note: string;
  blacklisted: boolean;
}

/** Shared company basics. Takes no profileId — this data is the same for every user. */
export function getCompanyProfile(key: string): CompanyBasics | null {
  if (!key) return null;
  const db = getDb();
  const row = db.prepare<CompanyBasics>(`
    SELECT display_name, logo_url, short_description, employee_count, employee_range,
           is_agency, source_note, enrich_status, enriched_at
      FROM companies WHERE company = ?
  `).get(key);
  return row ?? null;
}

// Counts mirror the Matches / All Jobs list queries exactly (jobs.ts) so a stat always equals
// what its link shows: BLACKLISTED/FILTERED are never listed, strong matches exclude duplicates,
// and the all-jobs count includes them (verdict=all).
const COUNT_BASE = `
  FROM job_profile_states jps JOIN jobs j ON j.id = jps.job_id
  WHERE jps.profile_id = ?
    AND LOWER(TRIM(j.company)) = ?
    AND jps.ai_verdict NOT IN ('BLACKLISTED', 'FILTERED')
`;

export function getCompanyUserContext(profileId: number, key: string): CompanyUserContext {
  const empty = { allJobs: 0, strongMatches: 0, applications: 0, note: '', blacklisted: false };
  if (!key) return empty;
  const db = getDb();
  const count = (extra: string): number =>
    (db.prepare<{ c: number }>(`SELECT COUNT(*) AS c ${COUNT_BASE} ${extra}`).get(profileId, key)?.c) ?? 0;

  const note = db.prepare<{ note: string }>(
    'SELECT note FROM company_notes WHERE profile_id = ? AND company = ?',
  ).get(profileId, key);

  const blacklisted = db.prepare(
    'SELECT 1 FROM blacklisted_companies WHERE profile_id = ? AND LOWER(TRIM(company_name)) = ?',
  ).get(profileId, key);

  return {
    allJobs: count(''),
    strongMatches: count("AND jps.ai_verdict = 'STRONG_MATCH' AND jps.is_duplicate = 0"),
    applications: count('AND jps.applied = 1'),
    note: note?.note || '',
    blacklisted: !!blacklisted,
  };
}

/** Applied count only — used by the job-detail header badge, which loads server-side. */
export function getCompanyAppliedCount(profileId: number, key: string): number {
  if (!key) return 0;
  return (getDb().prepare<{ c: number }>(
    `SELECT COUNT(*) AS c ${COUNT_BASE} AND jps.applied = 1`,
  ).get(profileId, key)?.c) ?? 0;
}

/**
 * Server-built filter URLs, so the client never assembles query strings itself.
 * Quoted `company` is the list pages' exact-match operator (jobs.ts); matching folds case, so
 * the display name can go in the box as the user knows it.
 */
export function buildCompanyLinks(name: string): { allJobs: string; strongMatches: string; applications: string } {
  const c = encodeURIComponent(`"${name}"`);
  return {
    allJobs: `/history?company=${c}&verdict=all`,
    strongMatches: `/jobs?company=${c}&verdict=STRONG_MATCH`,
    applications: `/jobs?company=${c}&verdict=all&status=applied`,
  };
}
