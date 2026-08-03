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

// DS v2 email constants (literal hex — mail clients don't resolve CSS vars).
const EMAIL_FONT = "'Plus Jakarta Sans',ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const BRAND_FUCHSIA = '#F0398A'; // logo.webp "Job Search" wordmark

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

function scoreBadgeStyle(): string {
  // Digest only ever carries strong matches → v2 §5.1 badge, strong tone.
  return 'display:inline-block;height:23px;line-height:23px;padding:0 9px;border-radius:7px;font-size:12px;font-weight:800;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;background:#eef7f1;color:#178049;';
}

function statCell(label: string, value: number, color: string, index: number, total: number): string {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  return `<td class="jh-stat-cell${isFirst ? ' jh-stat-cell-first' : ''}${isLast ? ' jh-stat-cell-last' : ''}" width="${(100 / total).toFixed(4)}%" style="width:${(100 / total).toFixed(4)}%;padding-left:${isFirst ? 0 : 4}px;padding-right:${isLast ? 0 : 4}px;vertical-align:top;">
  <div class="jh-stat" style="box-sizing:border-box;width:100%;text-align:center;padding:11px 6px;border:1px solid #e7e9ee;border-radius:8px;background:#fbfcfe;">
    <div class="jh-stat-num" style="font-size:19px;font-weight:800;color:${color};line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-0.02em;">${value}</div>
    <div class="jh-stat-lab" style="font-size:10.5px;font-weight:600;color:#6b7280;margin-top:6px;">${label}</div>
  </div>
</td>`;
}

function escapeHtml(str: string | null | undefined): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Shared shell for transactional emails (login code aside — that one is
 * header-less, see auth.ts). `headerMode` picks the brand-white or alert-red
 * header; the caller supplies the inner card body.
 */
export function emailFrame(headerMode: 'brand' | 'alert', bodyHtml: string): string {
  const header = headerMode === 'alert'
    ? `<div style="background:#ef6d70;border:1px solid #fcd9d6;border-radius:16px;padding:20px 24px;text-align:center;">
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:#000000;">Yet Another Job Search</h1>
      </div>`
    : `<div style="background:#ffffff;border:1px solid #ebedf1;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,0.05);padding:20px 24px;text-align:center;">
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;color:${BRAND_FUCHSIA};">Yet Another Job Search</h1>
      </div>`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Job Search</title></head>
<body style="font-family:${EMAIL_FONT};background:#f3f4f7;margin:0;padding:0;">
  <div style="max-width:520px;margin:0 auto;padding:24px 16px;">
    ${header}
    <div style="background:#ffffff;border:1px solid #ebedf1;border-radius:16px;box-shadow:0 1px 2px rgba(16,24,40,0.05);padding:24px;margin-top:16px;">
      ${bodyHtml}
    </div>
    <p style="text-align:center;color:#8a91a0;font-size:12px;margin-top:24px;">Sent by Job Search</p>
  </div>
</body>
</html>`;
}

function buildEmailHtml(
  jobs: JobWithState[],
  stats: RunStats,
  heading: string,
  appUrl: string,
): string {
  const baseUrl = appUrl.replace(/\/$/, '');
  const escapedBaseUrl = escapeHtml(baseUrl);
  const ctaHtml = baseUrl
    ? `<div style="text-align:center;margin-top:16px;">
        <a href="${escapedBaseUrl}/jobs" style="display:inline-block;background:#4373ff;color:white;text-decoration:none;padding:12px 26px;border-radius:11px;font-size:14px;font-weight:700;">
          View your matches
        </a>
      </div>`
    : '';

  const statItems = [
    { label: 'Fetched', value: stats.jobsFetched, color: '#131722' },
    { label: 'Strong', value: stats.strongMatch, color: '#178049' },
    { label: 'Weak', value: stats.weakMatch, color: '#b54708' },
    { label: 'No match', value: stats.noMatch, color: '#b42318' },
    { label: 'Duplicate', value: stats.duplicates, color: '#6941c6' },
    { label: 'Filtered', value: stats.filtered, color: '#5b6472' },
    { label: 'Blacklisted', value: stats.blacklisted, color: '#8a91a0' },
  ];

  const statsHtml = `<table class="jh-stats-grid" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0;table-layout:fixed;">
    <tr>
      ${statItems.map((item, index) => statCell(item.label, item.value, item.color, index, statItems.length)).join('')}
    </tr>
  </table>`;

  const jobCards = jobs.length === 0
    ? `<div style="background:white;border:1px solid #e6e8ee;border-radius:14px;box-shadow:0 1px 2px 0 rgba(16,24,40,0.05);padding:24px 16px;">
        <p style="color:#5b6472;text-align:center;margin:0;font-size:14px;">No strong matches this run.</p>
      </div>`
    : jobs.map((job) => `
      <div class="jh-job" style="background:white;border:1px solid #e6e8ee;border-radius:14px;box-shadow:0 1px 2px 0 rgba(16,24,40,0.05);padding:14px 16px;margin-bottom:10px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="vertical-align:top;padding-right:10px;">
              <h3 class="jh-title" style="margin:0;font-size:16px;font-weight:700;color:#131722;line-height:1.3;letter-spacing:-0.01em;">
                <a href="${baseUrl ? `${escapedBaseUrl}/job/${job.id}` : '#'}" style="color:#131722;text-decoration:none;">${escapeHtml(job.title)}</a>
              </h3>
              <p class="jh-meta" style="margin:4px 0 0;font-size:13px;color:#5b6472;line-height:1.4;">
                <b style="color:#3a4250;font-weight:600;">${escapeHtml(job.company)}</b>${(job.country || job.location) ? ` · ${escapeHtml(job.country || job.location)}` : ''}${job.work_mode ? ` · <span style="text-transform:capitalize;">${escapeHtml(job.work_mode)}</span>` : ''}
              </p>
            </td>
            <td style="vertical-align:top;text-align:right;white-space:nowrap;width:1%;">
              <span class="jh-score" style="${scoreBadgeStyle()}">${job.ai_score}%</span>
            </td>
          </tr>
        </table>
        ${job.ai_summary ? `<p class="jh-desc" style="margin:8px 0 0;font-size:13.5px;color:#3a4250;line-height:1.5;">${escapeHtml(job.ai_summary)}</p>` : ''}
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Search</title>
<style>
  /* Inline styles are the desktop base (works in every client, incl. Outlook).
     These rules only override for narrow screens; !important is required to
     beat the inline styles. Clients that ignore media queries keep desktop. */
  @media (max-width:640px){
    .jh-stage{padding:14px 12px 32px !important;}
    .jh-header{padding:16px 18px !important;border-radius:14px !important;}
    .jh-h1{font-size:20px !important;}
    .jh-stats-card{padding:14px 14px 12px !important;}
    .jh-stats-h2{font-size:14.5px !important;}
    .jh-stat-cell{padding-left:2px !important;padding-right:2px !important;}
    .jh-stat-cell-first{padding-left:0 !important;}
    .jh-stat-cell-last{padding-right:0 !important;}
    .jh-stat{padding:8px 1px !important;}
    .jh-stat-num{font-size:15px !important;}
    .jh-stat-lab{font-size:7.5px !important;letter-spacing:-0.02em !important;white-space:nowrap !important;margin-top:5px !important;}
    .jh-job{padding:13px 14px !important;margin-bottom:9px !important;}
    .jh-title{font-size:14px !important;line-height:1.28 !important;}
    .jh-meta{font-size:12.5px !important;}
    .jh-desc{font-size:12.5px !important;margin-top:7px !important;}
    .jh-score{height:22px !important;line-height:22px !important;font-size:12px !important;}
  }
</style>
</head>
<body style="font-family:${EMAIL_FONT};background:#f3f4f7;margin:0;padding:0;">
  <div class="jh-stage" style="max-width:680px;margin:0 auto;padding:20px 16px;">

    <!-- Header -->
    <div class="jh-header" style="background:#ffffff;border:1px solid #ebedf1;border-radius:16px;padding:20px 24px;margin-bottom:16px;box-shadow:0 1px 2px rgba(16,24,40,0.05);text-align:center;">
      <h1 class="jh-h1" style="margin:0;font-size:24px;font-weight:800;color:${BRAND_FUCHSIA};letter-spacing:-0.02em;">Yet Another Job Search</h1>
    </div>

    <!-- Stats + heading -->
    <div class="jh-stats-card" style="background:white;border:1px solid #ebedf1;border-radius:16px;padding:18px 18px 16px;margin-bottom:16px;">
      <h2 class="jh-stats-h2" style="margin:0 0 14px;font-size:15px;font-weight:800;color:#131722;letter-spacing:-0.01em;">${escapeHtml(heading)}</h2>
      ${statsHtml}
    </div>

    <!-- Jobs -->
    ${jobCards}

    ${ctaHtml}

    <!-- Footer -->
    <p class="jh-footer" style="text-align:center;color:#8a91a0;font-size:12px;line-height:1.6;margin:26px 4px 0;">
      Sent by Job Search${baseUrl ? ` · <a href="${escapedBaseUrl}" style="color:#4373ff;text-decoration:none;font-weight:600;">${escapedBaseUrl}</a>` : ''}
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
  const subject = n > 0 ? `${n} jobs found // Job Search` : 'no jobs found // Job Search';
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

export async function sendTestEmail(recipientEmail: string, resendApiKey: string, emailFrom: string, appUrl: string): Promise<void> {
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
      salary: null,
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

  const html = buildEmailHtml(mockJobs, mockStats, "Today's matches", appUrl);
  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: '[TEST] Job Search — Email Preview',
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Test email sent to ${recipientEmail}`);
}

export async function sendTopUpRequest(
  adminEmail: string,
  userEmail: string,
  balance: number,
  message: string,
  resendApiKey: string,
  emailFrom: string,
): Promise<void> {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const html = emailFrame('brand', `
      <h3 style="margin:0 0 14px;font-size:17px;font-weight:800;color:#131722;letter-spacing:-0.01em;">Top-up request</h3>
      <p style="color:#3a4250;font-size:14px;line-height:1.6;margin:0 0 16px;">
        <strong>${userEmail}</strong> · current balance $${balance.toFixed(2)}
      </p>
      <pre style="white-space:pre-wrap;font-family:inherit;color:#131722;font-size:14px;line-height:1.6;background:#fbfcfe;border:1px solid #e7e9ee;border-radius:12px;padding:16px;margin:0;">${escaped}</pre>`);

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: adminEmail,
    reply_to: userEmail,
    subject: `Job Search — top-up request from ${userEmail}`,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Top-up request from ${userEmail} sent to ${adminEmail}`);
}

export async function sendLowCreditsEmail(
  recipientEmail: string,
  balance: number,
  resendApiKey: string,
  emailFrom: string,
): Promise<void> {
  const html = emailFrame('alert', `
      <h3 style="margin:0 0 12px;font-size:18px;font-weight:800;color:#000000;letter-spacing:-0.01em;">Your Job Search credits are low</h3>
      <p style="color:#000000;font-size:14px;line-height:1.6;margin:0 0 14px;">
        Your current balance is <strong style="color:#b42318;">$${balance.toFixed(2)}</strong>,
        which is below the minimum required ($0.50) to run new job searches.
        Your scheduled runs have been paused.
      </p>
      <p style="color:#000000;font-size:14px;line-height:1.6;margin:0 0 4px;">
        Top up your credits to continue using Job Search.
      </p>
      <a href="#" style="display:inline-block;background:#4373ff;color:#fff;text-decoration:none;padding:11px 20px;border-radius:11px;font-size:14px;font-weight:700;margin-top:12px;">
        Top up credits
      </a>`);

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: 'Job Search — Low credits balance',
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
  const html = emailFrame('alert', `
      <h3 style="margin:0 0 12px;font-size:18px;font-weight:800;color:#000000;letter-spacing:-0.01em;">OpenAI rate limit hit during scoring</h3>
      <p style="color:#000000;font-size:14px;line-height:1.6;margin:0;">
        A pipeline run hit an OpenAI rate limit (HTTP 429) after automatic retries, so some jobs were left unscored.
        This usually means the shared account's tier limit was exceeded during the morning spike.
        Consider raising the OpenAI usage tier or lowering <code>SCORING_CONCURRENCY</code>.
      </p>`);

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: 'Job Search — OpenAI rate limit hit',
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Sent rate-limit alert to ${recipientEmail}`);
}

export async function sendDiscoveryEmptyAlert(
  recipientEmail: string,
  label: string,
  resendApiKey: string,
  emailFrom: string,
): Promise<void> {
  const html = emailFrame('alert', `
      <h3 style="margin:0 0 12px;font-size:18px;font-weight:800;color:#000000;letter-spacing:-0.01em;">${label} returned zero companies</h3>
      <p style="color:#000000;font-size:14px;line-height:1.6;margin:0;">
        A scheduled ${label} run completed but produced <strong>no records at all</strong> — neither new nor
        already-known companies. This usually signals an upstream contract break (the source dataset moved,
        emptied, or changed schema) rather than a normal no-op. Check the server logs and the discovery source.
      </p>`);

  const resend = new Resend(resendApiKey);
  const { error } = await resend.emails.send({
    from: emailFrom,
    to: recipientEmail,
    subject: `Job Search — ${label} returned empty`,
    html,
  });
  if (error) throw new Error(error.message);
  console.log(`[email] Sent empty-discovery alert (${label}) to ${recipientEmail}`);
}

export type { RunStats };
