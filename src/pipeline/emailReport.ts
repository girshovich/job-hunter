/**
 * Email Report — Generates and sends the daily HTML digest via Resend.
 * Marks all included jobs as seen=1 after successful send.
 */

import { Resend } from 'resend';
import { getDb, type JobWithState } from '../db';

interface RunStats {
  jobsFetched: number;
  jobsScored: number;
  strongMatch: number;
  weakMatch: number;
  noMatch: number;
  duplicates: number;
}

function scoreColor(score: number): string {
  if (score >= 85) return '#059669'; // emerald-600
  if (score >= 71) return '#10B981'; // emerald-500
  return '#6B7280'; // gray-500
}

function buildEmailHtml(
  jobs: JobWithState[],
  stats: RunStats,
  recipientEmail: string,
): string {
  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const jobCards = jobs.length === 0
    ? `<p style="color:#6B7280;text-align:center;padding:32px 0;">No new strong matches today.</p>`
    : jobs.map((job) => `
      <div style="border:1px solid #E5E7EB;border-radius:8px;padding:20px;margin-bottom:16px;background:#FAFAFA;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;">
          <div>
            <h3 style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827;">
              <a href="${job.url || '#'}" style="color:#111827;text-decoration:none;">${escapeHtml(job.title)}</a>
            </h3>
            <p style="margin:0;font-size:14px;color:#374151;">
              ${escapeHtml(job.company)}
              ${job.location ? ` · <span style="color:#6B7280;">${escapeHtml(job.location)}</span>` : ''}
              ${job.work_mode ? ` · <span style="color:#6B7280;text-transform:capitalize;">${job.work_mode}</span>` : ''}
            </p>
          </div>
          <div style="text-align:right;flex-shrink:0;margin-left:16px;">
            <span style="display:inline-block;background:${scoreColor(job.ai_score)};color:white;font-weight:700;font-size:18px;padding:4px 12px;border-radius:6px;">
              ${job.ai_score}%
            </span>
          </div>
        </div>
        ${job.ai_rationale ? `
        <div style="margin-top:12px;padding:12px;background:#F3F4F6;border-radius:6px;font-size:13px;color:#374151;line-height:1.5;">
          ${escapeHtml(job.ai_rationale)}
        </div>` : ''}
        <div style="margin-top:12px;">
          <a href="${job.url || '#'}" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;">
            View on ${escapeHtml(job.job_source || 'LinkedIn')} →
          </a>
        </div>
      </div>
    `).join('');

  const statsHtml = `
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:24px;">
      ${statBadge('Fetched', stats.jobsFetched, '#6B7280')}
      ${statBadge('Strong Match', stats.strongMatch, '#059669')}
      ${statBadge('Weak Match', stats.weakMatch, '#ca8a04')}
      ${statBadge('No Match', stats.noMatch, '#DC2626')}
      ${statBadge('Duplicates', stats.duplicates, '#7C3AED')}
    </div>
  `;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LinkedIn Job Hunter — ${dateStr}</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <div style="max-width:680px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#1D4ED8,#2563EB);border-radius:12px;padding:24px;margin-bottom:24px;color:white;">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;">LinkedIn Job Hunter</h1>
      <p style="margin:0;opacity:0.85;font-size:14px;">${dateStr}</p>
    </div>

    <!-- Run Stats -->
    <div style="background:white;border:1px solid #E5E7EB;border-radius:8px;padding:20px;margin-bottom:24px;">
      <h2 style="margin:0 0 16px;font-size:14px;font-weight:600;color:#6B7280;text-transform:uppercase;letter-spacing:0.05em;">Today's Run</h2>
      ${statsHtml}
    </div>

    <!-- Jobs -->
    <div style="background:white;border:1px solid #E5E7EB;border-radius:8px;padding:20px;">
      <h2 style="margin:0 0 16px;font-size:16px;font-weight:600;color:#111827;">
        New Matches
        <span style="font-size:13px;font-weight:400;color:#6B7280;margin-left:8px;">(${jobs.length} job${jobs.length !== 1 ? 's' : ''})</span>
      </h2>
      ${jobCards}
    </div>

    <!-- Footer -->
    <p style="text-align:center;color:#9CA3AF;font-size:12px;margin-top:24px;">
      Sent by LinkedIn Job Hunter · <a href="http://localhost:3000" style="color:#6B7280;">Dashboard</a>
    </p>
  </div>
</body>
</html>`;
}

function statBadge(label: string, value: number, color: string): string {
  return `<div style="flex:1;min-width:80px;text-align:center;padding:12px;border:1px solid #E5E7EB;border-radius:6px;">
    <div style="font-size:22px;font-weight:700;color:${color};">${value}</div>
    <div style="font-size:11px;color:#6B7280;margin-top:2px;">${label}</div>
  </div>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function sendDailyReport(
  stats: RunStats,
  recipientEmail: string,
  resendApiKey: string,
  emailFrom: string,
  profileId: number,
): Promise<{ sent: boolean; jobCount: number }> {
  const db = getDb();

  // Collect unseen, non-duplicate strong match jobs for this profile only
  const jobs = db.prepare(`
    SELECT j.*, jps.*
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    WHERE jps.profile_id = ? AND jps.seen = 0 AND jps.is_duplicate = 0 AND jps.ai_verdict = 'STRONG_MATCH'
    ORDER BY jps.ai_score DESC, jps.fetched_at DESC
  `).all(profileId) as JobWithState[];

  const dateStr = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const subject =
    jobs.length > 0
      ? `${jobs.length} new job match${jobs.length !== 1 ? 'es' : ''} — ${dateStr}`
      : `No new matches today — ${dateStr}`;

  const html = buildEmailHtml(jobs, stats, recipientEmail);

  const resend = new Resend(resendApiKey);

  try {
    const { error } = await resend.emails.send({
      from: emailFrom,
      to: recipientEmail,
      subject,
      html,
    });
    if (error) throw new Error(error.message);
    console.log(`[email] Sent daily report to ${recipientEmail} with ${jobs.length} jobs.`);
  } catch (err) {
    console.error('[email] Failed to send email:', (err as Error).message);
    return { sent: false, jobCount: jobs.length };
  }

  // Mark all included jobs as seen
  if (jobs.length > 0) {
    const now = new Date().toISOString();
    const ids = jobs.map((j) => j.job_id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(
      `UPDATE job_profile_states SET seen = 1, seen_at = ? WHERE job_id IN (${placeholders}) AND profile_id = ?`,
    ).run(now, ...ids, profileId);
    console.log(`[email] Marked ${ids.length} jobs as seen.`);
  }

  return { sent: true, jobCount: jobs.length };
}

export async function sendTestEmail(recipientEmail: string, resendApiKey: string, emailFrom: string): Promise<void> {
  const mockStats: RunStats = {
    jobsFetched: 42,
    jobsScored: 38,
    strongMatch: 5,
    weakMatch: 12,
    noMatch: 21,
    duplicates: 2,
  };

  const mockJobs: JobWithState[] = [
    {
      id: 1,
      linkedin_job_id: 'test-001',
      job_source: 'LinkedIn',
      provider: 'harvestapi',
      title: 'Senior Product Manager — Platform',
      company: 'Acme Corp',
      location: 'London, UK (Hybrid)',
      work_mode: 'hybrid',
      description: 'Test job description',
      url: 'https://linkedin.com',
      apply_url: null,
      posted_date: new Date().toISOString().split('T')[0],
      country: 'United Kingdom',
      fetched_at: new Date().toISOString(),
      job_id: 1,
      profile_id: 1,
      group_id: null,
      ai_score: 87,
      ai_verdict: 'STRONG_MATCH',
      original_ai_verdict: 'STRONG_MATCH',
      ai_rationale: 'Excellent match — senior IC PM role at a high-growth B2B SaaS company with strong platform scope. Hybrid in London aligns well with preferences.',
      ai_summary: 'Acme Corp builds a B2B SaaS platform for enterprise workflow automation.',
      rejection_category: null,
      cv_assessment: null,
      is_duplicate: 0,
      duplicate_of_job_id: null,
      seen: 0,
      seen_at: null,
      applied: 0,
      user_notes: null,
    },
  ];

  const html = buildEmailHtml(mockJobs, mockStats, recipientEmail);

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: `[TEST] LinkedIn Job Hunter — Email Preview`,
    html,
  });
  if (error) throw new Error(error.message);

  console.log(`[email] Test email sent to ${recipientEmail}`);
}

export type { RunStats };
