/**
 * Shared job-detail loader — builds the locals the `job-detail-body` partial needs.
 * Used by the standalone `/job/:id` page (dashboard.ts) and the Matches detail pane (jobs.ts).
 */

import { getDb, type JobWithState, type SettingsRow, type CvRow } from '../db';
import { getPreferredCountries } from '../pipeline/locationNormalizer';
import { companyKey } from '../uiHelpers';
import { getCompanyAppliedCount } from './company';

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

  return { job, original, duplicatesOfThis, cvs, settings, companyNote, companyAppliedCount, locationLabels, locPref: getPreferredCountries(profileId) };
}
