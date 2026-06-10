/**
 * Email Report — Generates and sends the session HTML digest via Resend.
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
  filtered: number;
  blacklisted: number;
}

function cadenceHeading(trigger: string, cronSchedule: string): string {
  if (trigger === 'manual') return 'Latest matches';
  const parts = cronSchedule.trim().split(/\s+/);
  if (parts.length === 5) {
    const dom = parts[2];
    const dow = parts[4];
    if (dom !== '*' && dom !== '?') return "This month's matches";
    if (dow !== '*' && dow !== '?' && !dow.includes(',')) return "This week's matches";
  }
  return "Today's matches";
}

function scoreColor(score: number): string {
  if (score >= 85) return '#059669';
  if (score >= 71) return '#10B981';
  return '#6B7280';
}

function statBadge(label: string, value: number, color: string): string {
  return `<div style="flex:1;min-width:70px;text-align:center;padding:8px 6px;border:1px solid #E5E7EB;border-radius:8px;">
    <div style="font-size:20px;font-weight:700;color:${color};">${value}</div>
    <div style="font-size:10px;color:#6B7280;margin-top:1px;">${label}</div>
  </div>`;
}

function escapeHtml(str: string | null | undefined): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmailHtml(
  jobs: JobWithState[],
  stats: RunStats,
  heading: string,
  appUrl: string,
): string {
  const baseUrl = appUrl.replace(/\/$/, '');
  const ctaHtml = baseUrl
    ? `<div style="text-align:center;margin-top:16px;">
        <a href="${baseUrl}/jobs" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:14px;font-weight:600;">
          View your matches
        </a>
      </div>`
    : '';

  const statsHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
    ${statBadge('Fetched', stats.jobsFetched, '#6B7280')}
    ${statBadge('Strong', stats.strongMatch, '#059669')}
    ${statBadge('Weak', stats.weakMatch, '#D97706')}
    ${statBadge('No match', stats.noMatch, '#DC2626')}
    ${statBadge('Duplicate', stats.duplicates, '#7C3AED')}
    ${statBadge('Filtered', stats.filtered, '#64748B')}
    ${statBadge('Blacklisted', stats.blacklisted, '#9CA3AF')}
  </div>`;

  const jobCards = jobs.length === 0
    ? `<p style="color:#6B7280;text-align:center;padding:24px 0;font-size:14px;">No strong matches this run.</p>`
    : jobs.map((job) => `
      <div style="border:1px solid #E5E7EB;border-radius:8px;padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:5px;">
          <div style="min-width:0;flex:1;margin-right:12px;">
            <h3 style="margin:0 0 3px;font-size:15px;font-weight:600;color:#111827;">
              <a href="${escapeHtml(job.url || '#')}" style="color:#111827;text-decoration:none;">${escapeHtml(job.title)}</a>
            </h3>
            <p style="margin:0;font-size:13px;color:#374151;">
              ${escapeHtml(job.company)}${job.location ? ` · <span style="color:#6B7280;">${escapeHtml(job.location)}</span>` : ''}${job.work_mode ? ` · <span style="color:#6B7280;text-transform:capitalize;">${escapeHtml(job.work_mode)}</span>` : ''}
            </p>
          </div>
          <div style="flex-shrink:0;display:inline-block;width:52px;height:52px;line-height:52px;text-align:center;border-radius:8px;background:${scoreColor(job.ai_score)};color:white;font-weight:700;font-size:15px;">
            ${job.ai_score}%
          </div>
        </div>
        ${job.ai_summary ? `<p style="margin:6px 0 0;font-size:13px;color:#4B5563;line-height:1.5;">${escapeHtml(job.ai_summary)}</p>` : ''}
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Hunter</title>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <div style="max-width:640px;margin:0 auto;padding:20px 16px;">

    <!-- Header -->
    <div style="background:#2563EB;border-radius:12px;padding:14px 20px;margin-bottom:16px;">
      <h1 style="margin:0;font-size:18px;font-weight:700;color:white;">Job Hunter</h1>
    </div>

    <!-- Stats + heading -->
    <div style="background:white;border:1px solid #E5E7EB;border-radius:12px;padding:14px 16px;margin-bottom:16px;">
      <h2 style="margin:0 0 10px;font-size:14px;font-weight:600;color:#111827;">${escapeHtml(heading)}</h2>
      ${statsHtml}
    </div>

    <!-- Jobs -->
    <div style="background:white;border:1px solid #E5E7EB;border-radius:12px;padding:14px 16px;">
      ${jobCards}
    </div>

    ${ctaHtml}

    <!-- Footer -->
    <p style="text-align:center;color:#9CA3AF;font-size:11px;margin-top:16px;">
      Sent by Job Hunter${baseUrl ? ` · <a href="${escapeHtml(baseUrl)}" style="color:#9CA3AF;">${escapeHtml(baseUrl)}</a>` : ''}
    </p>
  </div>
</body>
</html>`;
}

export async function sendDailyReport({
  jobIds,
  stats,
  trigger,
  cronSchedule,
  appUrl,
  recipientEmail,
  resendApiKey,
  emailFrom,
  profileId,
}: {
  jobIds: number[];
  stats: RunStats;
  trigger: string;
  cronSchedule: string;
  appUrl: string;
  recipientEmail: string;
  resendApiKey: string;
  emailFrom: string;
  profileId: number;
}): Promise<{ sent: boolean; jobCount: number }> {
  const db = getDb();

  const jobs: JobWithState[] = jobIds.length > 0
    ? db.prepare(`
        SELECT j.*, jps.*
        FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
        WHERE jps.profile_id = ? AND jps.job_id IN (${jobIds.map(() => '?').join(',')}) AND jps.is_duplicate = 0
        ORDER BY jps.ai_score DESC, jps.fetched_at DESC
      `).all(profileId, ...jobIds) as JobWithState[]
    : [];

  const n = jobs.length;
  const subject = n > 0 ? `${n} jobs found // Job Hunter` : 'no jobs found // Job Hunter';
  const heading = cadenceHeading(trigger, cronSchedule);
  const html = buildEmailHtml(jobs, stats, heading, appUrl);

  const resend = new Resend(resendApiKey);
  try {
    const { error } = await resend.emails.send({ from: emailFrom, to: recipientEmail, subject, html });
    if (error) throw new Error(error.message);
    console.log(`[email] Sent digest to ${recipientEmail} with ${n} jobs.`);
  } catch (err) {
    console.error('[email] Failed to send email:', (err as Error).message);
    return { sent: false, jobCount: n };
  }

  return { sent: true, jobCount: n };
}

export async function sendTestEmail(recipientEmail: string, resendApiKey: string, emailFrom: string): Promise<void> {
  const mockStats: RunStats = {
    jobsFetched: 42,
    jobsScored: 38,
    strongMatch: 5,
    weakMatch: 12,
    noMatch: 21,
    duplicates: 2,
    filtered: 3,
    blacklisted: 1,
  };

  const mockJobs: JobWithState[] = [
    {
      id: 1,
      linkedin_job_id: 'test-001',
      job_source: 'LinkedIn',
      provider: 'harvestapi',
      ats_slug: null,
      title: 'Senior Product Manager — Platform',
      company: 'Acme Corp',
      location: 'London, UK (Hybrid)',
      work_mode: 'hybrid',
      description: '',
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
      ai_rationale: null,
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

  const html = buildEmailHtml(mockJobs, mockStats, "Today's matches", '');
  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: '[TEST] Job Hunter — Email Preview',
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Test email sent to ${recipientEmail}`);
}

export async function sendLowCreditsEmail(
  recipientEmail: string,
  balance: number,
  resendApiKey: string,
  emailFrom: string,
): Promise<void> {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Low Credits — Job Hunter</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:linear-gradient(135deg,#DC2626,#B91C1C);border-radius:12px;padding:24px;margin-bottom:24px;color:white;">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;">Job Hunter</h1>
      <p style="margin:0;opacity:0.85;font-size:14px;">Credits Alert</p>
    </div>
    <div style="background:white;border:1px solid #E5E7EB;border-radius:8px;padding:24px;">
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#111827;">Your JH credits are low</h2>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 16px;">
        Your current balance is <strong style="color:#DC2626;">$${balance.toFixed(2)}</strong>,
        which is below the minimum required ($0.50) to run new job searches.
        Your scheduled runs have been paused.
      </p>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0 0 24px;">
        Top up your credits to continue using Job Hunter.
      </p>
      <a href="#" style="display:inline-block;background:#2563EB;color:white;text-decoration:none;padding:10px 20px;border-radius:6px;font-size:14px;font-weight:500;">
        Top Up Credits (coming soon)
      </a>
    </div>
    <p style="text-align:center;color:#9CA3AF;font-size:12px;margin-top:24px;">Sent by Job Hunter</p>
  </div>
</body>
</html>`;

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: 'Job Hunter — Low credits balance',
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Sent low credits alert to ${recipientEmail}`);
}

export async function sendRateLimitAlert(
  recipientEmail: string,
  resendApiKey: string,
  emailFrom: string,
): Promise<void> {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Rate Limit — Job Hunter</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:linear-gradient(135deg,#DC2626,#B91C1C);border-radius:12px;padding:24px;margin-bottom:24px;color:white;">
      <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;">Job Hunter</h1>
      <p style="margin:0;opacity:0.85;font-size:14px;">Rate Limit Alert</p>
    </div>
    <div style="background:white;border:1px solid #E5E7EB;border-radius:8px;padding:24px;">
      <h2 style="margin:0 0 12px;font-size:18px;font-weight:600;color:#111827;">OpenAI rate limit hit during scoring</h2>
      <p style="color:#374151;font-size:14px;line-height:1.6;margin:0;">
        A pipeline run hit an OpenAI rate limit (HTTP 429) after automatic retries, so some jobs were left unscored.
        This usually means the shared account's tier limit was exceeded during the morning spike.
        Consider raising the OpenAI usage tier or lowering <code>SCORING_CONCURRENCY</code>.
      </p>
    </div>
    <p style="text-align:center;color:#9CA3AF;font-size:12px;margin-top:24px;">Sent by Job Hunter</p>
  </div>
</body></html>`;

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: 'Job Hunter — OpenAI rate limit hit',
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Sent rate-limit alert to ${recipientEmail}`);
}

export type { RunStats };
