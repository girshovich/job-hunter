/**
 * Shared job-detail loader — builds the locals the `job-detail-body` partial needs.
 * Used by the standalone `/job/:id` page (dashboard.ts) and the Matches detail pane (jobs.ts).
 */

import { getDb, type JobWithState, type SettingsRow, type CvRow } from '../db';
import { getPreferredCountries } from '../pipeline/locationNormalizer';
import { companyKey } from '../uiHelpers';
import { getCompanyAppliedCount } from './company';
import { jobHistory, listStatuses, statusMap, idsOfTypes, daysSince, profileTimezone,
         APPLIED_TYPES, type HistoryStep, type StatusRow } from '../statuses';

export interface JobDetailLocals {
  job: JobWithState & { description?: string };
  original: JobWithState | undefined;
  duplicatesOfThis: Array<JobWithState & { description?: string }>;
  cvs: Omit<CvRow, 'content_b64'>[];
  settings: SettingsRow | undefined;
  companyNote: string;
  companyAppliedCount: number;
  locationLabels: string[];
  locPref: ReturnType<typeof getPreferredCountries>;
  /** The status rail, oldest first — `New` always opens it (D34). */
  history: HistoryStep[];
  /** Live statuses, the user's own order, for the picker and the step editor. */
  statuses: StatusRow[];
  /** The job's current status, or null if it somehow has none. Archived rows resolve too. */
  currentStatus: StatusRow | null;
  /** Days since the newest step. `-1` when the count is suppressed — a Rejected-type status, or
   *  a status the log has no step for (a job migrated from the old `applied` column). */
  elapsedDays: number;
  /** True when the current status has no step of its own, so the rail must derive it (D8). */
  derivedCurrent: boolean;
  /** Emitted by the `Applied N×` chip's link, regenerated on every render (D49). */
  appliedStatusIds: string;
}

export function loadJobDetail(profileId: number, id: number): JobDetailLocals | null {
  const db = getDb();

  const jobRow = db.prepare(`
    SELECT j.*, jps.*, c.logo_url, c.is_agency, c.employee_count, c.employee_range,
           COALESCE(jd.description_text, j.description) AS description_text
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
    WHERE j.id = ? AND jps.profile_id = ?
  `).get(id, profileId) as (JobWithState & { description_text?: string }) | undefined;
  const job = jobRow ? { ...jobRow, description: jobRow.description_text ?? jobRow.description } : undefined;
  if (!job) return null;

  // Duplicate chain
  let original: JobWithState | undefined;
  if (job.duplicate_of_job_id) {
    const originalRow = db.prepare(`
      SELECT j.*, jps.*, c.logo_url, COALESCE(jd.description_text, j.description) AS description_text
      FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
      LEFT JOIN job_descriptions jd ON jd.job_id = j.id
      LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
      WHERE j.id = ? AND jps.profile_id = ?
    `).get(job.duplicate_of_job_id, profileId) as (JobWithState & { description_text?: string }) | undefined;
    original = originalRow ? { ...originalRow, description: originalRow.description_text ?? originalRow.description } : undefined;
  }

  const duplicateRows = db.prepare(`
    SELECT j.*, jps.*, c.logo_url, COALESCE(jd.description_text, j.description) AS description_text
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    LEFT JOIN companies c ON c.company = LOWER(TRIM(j.company))
    WHERE jps.duplicate_of_job_id = ? AND jps.profile_id = ?
    ORDER BY jps.fetched_at DESC
  `).all(job.id, profileId) as Array<JobWithState & { description_text?: string }>;
  const duplicatesOfThis = duplicateRows.map((row) => ({
    ...row,
    description: row.description_text ?? row.description,
  }));

  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow | undefined;
  const cvs = db.prepare('SELECT id, filename, mime_type, file_size, uploaded_at FROM cvs WHERE profile_id = ? ORDER BY uploaded_at DESC').all(profileId) as Omit<CvRow, 'content_b64'>[];
  const key = companyKey(job.company);
  const companyNoteRow = db.prepare('SELECT note FROM company_notes WHERE profile_id = ? AND company = ?').get(profileId, key) as { note: string } | undefined;
  const companyNote = companyNoteRow?.note || '';
  const companyAppliedCount = getCompanyAppliedCount(profileId, key);

  const locationLabelRows = db.prepare(`SELECT label FROM job_locations WHERE job_id = ? ORDER BY rowid ASC`).all(id) as Array<{ label: string }>;
  const locationLabels = locationLabelRows.map((r) => r.label);

  const history = jobHistory(profileId, id);
  const statuses = listStatuses(profileId);
  const currentStatus = job.status_id != null ? (statusMap(profileId).get(job.status_id) ?? null) : null;
  // A rejection is not a waiting room — the count means "how long have I been waiting", so both
  // Rejected-type statuses carry none (D35, D37).
  const newest = history.length > 0 ? history[history.length - 1] : null;
  // A job migrated from the old `applied` column carries its status but no step for it: there was
  // no timestamp for when the user applied, and inventing one from `fetched_at` would put fiction
  // in an audit log (D8). The rail renders that status as a trailing step with **no date**, and
  // the elapsed count is suppressed — the honest answer to "how long has this been sitting" is
  // that we do not know. Both resolve themselves the first time the user touches the job.
  const derivedCurrent = !!currentStatus && currentStatus.type !== 'new'
    && (!newest || newest.status_id !== currentStatus.id);
  const elapsedDays = (!currentStatus || currentStatus.type === 'rejected' || !newest || derivedCurrent)
    ? -1
    : daysSince(newest.changed_at, profileTimezone(profileId));

  return {
    job, original, duplicatesOfThis, cvs, settings, companyNote, companyAppliedCount,
    locationLabels, locPref: getPreferredCountries(profileId),
    history, statuses, currentStatus, elapsedDays, derivedCurrent,
    appliedStatusIds: idsOfTypes(profileId, APPLIED_TYPES).join(','),
  };
}
