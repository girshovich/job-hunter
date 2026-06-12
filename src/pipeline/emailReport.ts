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

function scorePillStyle(): string {
  // Digest only ever carries strong matches, so every pill is the strong green.
  return 'display:inline-block;flex:none;height:26px;line-height:26px;min-width:50px;padding:0 9px;border-radius:999px;font-size:12.5px;font-weight:600;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;background:#1E9E5A;color:#ffffff;';
}

function statBadge(label: string, value: number, color: string): string {
  return `<div class="jh-stat" style="flex:1 1 0;min-width:0;box-sizing:border-box;text-align:center;padding:11px 4px;border:1px solid #F3F4F6;border-radius:8px;background:#FCFCFD;">
    <div class="jh-stat-num" style="font-size:19px;font-weight:800;color:${color};line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">${value}</div>
    <div class="jh-stat-lab" style="font-size:10.5px;font-weight:600;color:#6B7280;margin-top:6px;">${label}</div>
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

  const statsHtml = `<div class="jh-stats-grid" style="display:flex;gap:5px;flex-wrap:nowrap;">
    ${statBadge('Fetched', stats.jobsFetched, '#6B7280')}
    ${statBadge('Strong', stats.strongMatch, '#059669')}
    ${statBadge('Weak', stats.weakMatch, '#D97706')}
    ${statBadge('No match', stats.noMatch, '#DC2626')}
    ${statBadge('Duplicate', stats.duplicates, '#7C3AED')}
    ${statBadge('Filtered', stats.filtered, '#64748B')}
    ${statBadge('Blacklisted', stats.blacklisted, '#9CA3AF')}
  </div>`;

  const jobCards = jobs.length === 0
    ? `<div style="background:white;border:1px solid #E5E7EB;border-radius:12px;box-shadow:0 1px 2px 0 rgba(16,24,40,0.05);padding:24px 16px;">
        <p style="color:#6B7280;text-align:center;margin:0;font-size:14px;">No strong matches this run.</p>
      </div>`
    : jobs.map((job) => `
      <div class="jh-job" style="background:white;border:1px solid #E5E7EB;border-radius:12px;box-shadow:0 1px 2px 0 rgba(16,24,40,0.05);padding:14px 16px;margin-bottom:10px;">
        <div class="jh-top" style="display:flex;gap:12px;align-items:flex-start;">
          <div style="min-width:0;flex:1;">
            <h3 class="jh-title" style="margin:0;font-size:16px;font-weight:700;color:#111827;line-height:1.3;letter-spacing:-0.01em;">
              <a href="${escapeHtml(job.url || '#')}" style="color:#111827;text-decoration:none;">${escapeHtml(job.title)}</a>
            </h3>
            <p class="jh-meta" style="margin:4px 0 0;font-size:13px;color:#6B7280;line-height:1.4;">
              <b style="color:#374151;font-weight:600;">${escapeHtml(job.company)}</b>${job.location ? ` · ${escapeHtml(job.location)}` : ''}${job.work_mode ? ` · <span style="text-transform:capitalize;">${escapeHtml(job.work_mode)}</span>` : ''}
            </p>
          </div>
          <div class="jh-score" style="${scorePillStyle()}">${job.ai_score}%</div>
        </div>
        ${job.ai_summary ? `<p class="jh-desc" style="margin:8px 0 0;font-size:13px;color:#6B7280;line-height:1.5;">${escapeHtml(job.ai_summary)}</p>` : ''}
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Hunter</title>
<style>
  /* Inline styles are the desktop base (works in every client, incl. Outlook).
     These rules only override for narrow screens; !important is required to
     beat the inline styles. Clients that ignore media queries keep desktop. */
  @media (max-width:640px){
    .jh-stage{padding:14px 12px 32px !important;}
    .jh-header{padding:13px 18px !important;border-radius:8px !important;}
    .jh-h1{font-size:17px !important;}
    .jh-stats-card{padding:14px 14px 12px !important;}
    .jh-stats-h2{font-size:14.5px !important;}
    .jh-stats-grid{gap:4px !important;}
    .jh-stat{padding:8px 1px !important;}
    .jh-stat-num{font-size:15px !important;}
    .jh-stat-lab{font-size:7.5px !important;letter-spacing:-0.02em !important;white-space:nowrap !important;margin-top:5px !important;}
    .jh-job{padding:13px 14px !important;margin-bottom:9px !important;}
    .jh-top{gap:10px !important;}
    .jh-title{font-size:13.5px !important;line-height:1.28 !important;}
    .jh-meta{font-size:12.5px !important;}
    .jh-desc{font-size:12.5px !important;margin-top:7px !important;}
    .jh-score{height:25px !important;line-height:25px !important;min-width:46px !important;font-size:12px !important;}
  }
</style>
</head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F9FAFB;margin:0;padding:0;">
  <div class="jh-stage" style="max-width:640px;margin:0 auto;padding:20px 16px;">

    <!-- Header -->
    <div class="jh-header" style="background:#2F6BFF;background:linear-gradient(180deg,#3B74FF,#2F6BFF);border-radius:12px;padding:14px 22px;margin-bottom:16px;box-shadow:0 6px 18px rgba(47,107,255,0.22);">
      <h1 class="jh-h1" style="margin:0;font-size:18px;font-weight:800;color:#ffffff;letter-spacing:-0.01em;">Job Hunter</h1>
    </div>

    <!-- Stats + heading -->
    <div class="jh-stats-card" style="background:white;border:1px solid #E5E7EB;border-radius:12px;padding:16px;margin-bottom:16px;">
      <h2 class="jh-stats-h2" style="margin:0 0 12px;font-size:15px;font-weight:700;color:#111827;">${escapeHtml(heading)}</h2>
      ${statsHtml}
    </div>

    <!-- Jobs -->
    ${jobCards}

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
