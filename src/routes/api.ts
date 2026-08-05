/**
 * API Routes — Manual run trigger, test email, status, group CRUD.
 */

import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { runPipeline, getIsRunning, getRunStatus, requestStop, isStopRequested, calcOpenAiCost, type RunOptions } from '../pipeline/runner';
import type { DateRange } from '../pipeline/fetcher';
import { sendTestEmail, sendTopUpRequest } from '../pipeline/emailReport';
import { JOB_TYPES } from '../pipeline/types';
import { startSchedule, stopSchedule, getScheduleStatus } from '../pipeline/scheduler';
import { runDiscovery } from '../pipeline/atsDiscovery';
import { runLeverDiscovery } from '../pipeline/leverDiscovery';
import { runValidation } from '../pipeline/atsValidation';
import { startAtsDiscoveryCron, stopAtsDiscoveryCron, startLeverDiscoveryCron, stopLeverDiscoveryCron, startAtsValidationCron, stopAtsValidationCron, startGhPoolCron, stopGhPoolCron, startAshbyPoolCron, stopAshbyPoolCron, startLeverPoolCron, stopLeverPoolCron, startTelegramIngestCron, stopTelegramIngestCron, ATS_DISCOVERY_CRON, ATS_LEVER_CRON, ATS_VALIDATION_CRON } from '../pipeline/atsScheduler';
import { fetchGreenhousePool, fetchAshbyPool, fetchLeverPool, resolvePoolCountries, unresolvedPoolElements } from '../pipeline/atsPoolFetcher';
import { tryAcquirePoolLock, releasePoolLock, getActivePoolFetch } from '../pipeline/poolLock';
import { runTelegramIngest } from '../pipeline/telegramIngest';
import { FIXED_SCHEMA_PROMPT } from '../pipeline/telegramExtract';
import { activeRuns, tryStartRun, createRun, endRun, cancelRun, listActiveRuns, emitToRun } from '../pipeline/atsRunState';
import { getDb, getMatchesCount, createProfile, MIN_RUN_CREDITS, isPaymentReady, resolveSpendKeys, PaymentError, type SettingsRow, type SearchGroupRow, type BlacklistedCompanyRow, type RunJobLogRow, type JobWithState, type CvRow, FALLBACK_AI_MODEL, DEFAULT_CV_COMPARISON_PROMPT, DEFAULT_PROVIDER_SELECTION, DEFAULT_PROVIDER_SELECTION_JSON, type ProfileRow } from '../db';
import { resolveCountries, getCanonicalCountries, loadLocationData, labelsToCountrySet, lookupCountry, canonicalRegion, isSourceCountry, isRegionLabel } from '../pipeline/locationNormalizer';
import { acquirePoolLock } from '../pipeline/poolLock';
import { INDEED_CODE } from '../pipeline/providers/indeed';
import { config } from '../config';
import { checkOpenAiBalance } from '../utils/openaiBalance';
import { companyKey } from '../uiHelpers';
import { getCompanyProfile, getCompanyUserContext, buildCompanyLinks } from './company';
import OpenAI from 'openai';

const router = Router();

// Pre-flight check — validates everything required to run the pipeline
router.get('/preflight', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const profileId = req.profile.id;
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;
    const activeGroups = db
      .prepare('SELECT * FROM search_groups WHERE profile_id = ? AND is_active = 1 ORDER BY id ASC')
      .all(profileId) as SearchGroupRow[];

    const errors: string[] = [];

    const useJhCredits = (settings?.use_jh_credits ?? 1) !== 0;
    if (useJhCredits) {
      // Resolving through the chokepoint keeps this advisory check on exactly the same rule the
      // runner enforces, so the UI can never green-light a run the pipeline will refuse.
      try {
        const { openAiKey, apifyToken } = resolveSpendKeys(db, profileId);
        if (!openAiKey)  errors.push('Global OpenAI API key is not configured — ask admin to add it in Settings → Admin → Global API Keys.');
        if (!apifyToken) errors.push('Global Apify API token is not configured — ask admin to add it in Settings → Admin → Global API Keys.');
      } catch (err) {
        errors.push((err as Error).message);
      }
    } else {
      // No config.* fallback here: own-keys means the profile's own keys. Falling back to the
      // instance env vars let a profile run the pipeline on the operator's accounts, unmetered —
      // credit deduction only happens in credits mode, so that spend left no trace anywhere.
      const openAiKey = settings?.user_openai_api_key?.trim();
      const apifyKey  = settings?.user_apify_api_token?.trim();
      if (!openAiKey) errors.push('OpenAI API key is not set — add it in Settings → AI Setup → Use my own API keys.');
      if (!apifyKey)  errors.push('Apify API token is not set — add it in Settings → AI Setup → Use my own API keys.');
    }

    if (activeGroups.length === 0) {
      errors.push('No active Roles configured — add at least one Role in Settings.');
    } else {
      for (const g of activeGroups) {
        const effectiveProfileDesc = g.use_main_profile_description
          ? settings?.profile_description?.trim()
          : g.profile_description?.trim();
        if (!effectiveProfileDesc || !g.scoring_criteria?.trim()) {
          const name = g.group_name ? `"${g.group_name}"` : `#${g.id}`;
          errors.push(`Role ${name} is missing Profile Description or Scoring Criteria — edit the Role in Settings.`);
        }
      }
    }

    if (!settings?.dedup_system_prompt?.trim())
      errors.push('Deduplication prompt is empty — fill it in Settings → AI Settings.');
    if (!settings?.summary_prompt?.trim())
      errors.push('Summary prompt is empty — fill it in Settings → AI Settings.');

    res.json({ ok: errors.length === 0, errors });
  } catch (err) {
    res.json({ ok: false, errors: ['Failed to check configuration: ' + (err as Error).message] });
  }
});

// Trigger a manual pipeline run
router.post('/run', async (req: Request, res: Response) => {
  const profileId = req.profile.id;
  if (getIsRunning(profileId)) {
    res.status(409).json({ success: false, error: 'Pipeline is already running.' });
    return;
  }

  const b = req.body as Record<string, unknown>;

  // Parse optional groupIds
  const groupIds = Array.isArray(b.groupIds)
    ? (b.groupIds as unknown[]).map((id) => parseInt(String(id), 10)).filter((n) => !isNaN(n))
    : undefined;

  // Parse optional dateRange
  let dateRange: DateRange = '24h';
  if (b.dateRange === '7d') dateRange = '7d';
  else if (b.dateRange === 'month') dateRange = 'month';

  // Parse optional providers override
  const validProviders = ['harvestapi', 'valig', 'indeed', 'stepstone', 'greenhouse', 'ashby', 'lever', 'telegram'];
  const providers = Array.isArray(b.providers)
    ? (b.providers as unknown[]).map(String).filter((p) => validProviders.includes(p))
    : undefined;

  const resolvedProviders = providers?.length ? providers : undefined;
  const runOptions: RunOptions = { groupIds, dateRange, providers: resolvedProviders };

  // Check the profile can pay for this run: credits above the floor, or its own keys actually
  // saved. The own-keys arm is what stops a profile running the pipeline on the instance's env
  // keys — `GET /preflight` only advises the UI, so this handler is the gate. runner.ts repeats
  // the check because a scheduled run never passes through here.
  const db = getDb();
  const settings = db.prepare('SELECT use_jh_credits, credits_balance, user_openai_api_key, user_apify_api_token FROM settings WHERE profile_id = ?').get(profileId) as { use_jh_credits: number; credits_balance: number; user_openai_api_key: string; user_apify_api_token: string } | undefined;
  if ((settings?.use_jh_credits ?? 1) !== 0) {
    const balance = settings?.credits_balance ?? 0;
    if (balance < MIN_RUN_CREDITS) {
      res.status(402).json({ success: false, error: `Insufficient credits ($${balance.toFixed(2)}). Please top up to at least $${MIN_RUN_CREDITS.toFixed(2)} to run.` });
      return;
    }
  } else if (!isPaymentReady(settings)) {
    res.status(402).json({ success: false, error: 'Own API keys are not set. Add your OpenAI key and Apify token in Settings → AI Setup, or switch to credits.' });
    return;
  }

  // Persist Run Once date range + provider selection as defaults for next time
  // (separate columns from the schedule, so the two don't overwrite each other).
  db.prepare('UPDATE settings SET run_date_range = ?, run_providers = COALESCE(?, run_providers) WHERE profile_id = ?')
    .run(dateRange, resolvedProviders ? JSON.stringify(resolvedProviders) : null, profileId);

  // Respond immediately, run in background
  res.json({ success: true, message: 'Pipeline started. Check dashboard for results.' });

  runPipeline('manual', profileId, runOptions).catch((err) => {
    console.error('[api] Manual pipeline run failed:', err);
  });
});

// Stop the run in progress. Cooperative: the pipeline stops at its next checkpoint, so the
// in-flight provider/LLM call still finishes. Never touches the schedule.
router.post('/run/stop', (req: Request, res: Response) => {
  if (!requestStop(req.profile.id)) {
    res.status(409).json({ success: false, error: 'No run is in progress.' });
    return;
  }
  res.json({ success: true });
});

// Pipeline status (used by Run Now polling)
router.get('/status', (req: Request, res: Response) => {
  const profileId = req.profile.id;
  const { isRunning, lastRun, stage } = getRunStatus(profileId);

  // Also fetch the latest DB run for the dashboard card
  const db = getDb();
  const lastDbRun = db.prepare(`
    SELECT
      MIN(ran_at)            AS ran_at,
      SUM(jobs_fetched)      AS jobs_fetched,
      SUM(jobs_scored)       AS jobs_scored,
      SUM(jobs_strong_match) AS jobs_strong_match,
      SUM(jobs_weak_match)   AS jobs_weak_match,
      SUM(jobs_no_match)     AS jobs_no_match,
      SUM(jobs_duplicate)    AS jobs_duplicate,
      SUM(duration_ms)       AS duration_ms,
      CASE
        WHEN COUNT(*) = SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) THEN 'success'
        WHEN COUNT(*) = SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) THEN 'failed'
        WHEN SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) > 0 THEN 'stopped'
        ELSE 'partial_error'
      END AS status,
      GROUP_CONCAT(error_log, '\n') AS error_log
    FROM search_runs
    WHERE profile_id = ?
      AND trigger != 'cv'
      AND COALESCE(session_id, CAST(id AS TEXT)) = (
        SELECT COALESCE(session_id, CAST(id AS TEXT))
        FROM search_runs WHERE profile_id = ? AND status != 'running' AND trigger != 'cv'
        ORDER BY ran_at DESC LIMIT 1
      )
      AND status != 'running'
  `).get(profileId, profileId);

  res.json({
    isRunning,
    stopRequested: isStopRequested(profileId),
    lastRun: lastRun || lastDbRun || null,
    stage: stage || null,
  });
});

// Send test email
router.post('/test-email', async (req: Request, res: Response) => {
  try {
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(req.profile.id) as SettingsRow;
    const resendApiKey = settings.resend_api_key || config.resendApiKey;
    const emailFrom = settings.email_from || config.emailFrom;
    const profileRow = db.prepare('SELECT email FROM profiles WHERE id = ?').get(req.profile.id) as { email: string } | undefined;
    const recipientEmail = profileRow?.email || '';
    if (!recipientEmail) {
      return res.status(400).json({ success: false, error: 'No profile email configured.' });
    }
    await sendTestEmail(recipientEmail, resendApiKey, emailFrom, (settings.app_url || '').trim());
    res.json({ success: true, message: `Test email sent to ${recipientEmail}` });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// Top-up request — user asks for credits; the message is emailed to the operator.
router.post('/topup-request', async (req: Request, res: Response) => {
  try {
    const message = String(req.body.message || '').trim();
    if (!message) {
      return res.status(400).json({ success: false, error: 'Please write a message before sending.' });
    }
    const db = getDb();
    const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(req.profile.id) as SettingsRow;
    const resendApiKey = settings.resend_api_key || config.resendApiKey;
    const emailFrom = settings.email_from || config.emailFrom;
    const profileRow = db.prepare('SELECT email FROM profiles WHERE id = ?').get(req.profile.id) as { email: string } | undefined;
    // Same operator lookup the rate-limit alert uses.
    const adminEmail = (db.prepare('SELECT email FROM profiles WHERE is_admin = 1 LIMIT 1').get() as { email?: string } | undefined)?.email;
    if (!adminEmail) {
      return res.status(500).json({ success: false, error: 'Could not send your request. Please use Telegram.' });
    }
    await sendTopUpRequest(
      adminEmail,
      profileRow?.email || '',
      Number(settings.credits_balance || 0),
      message.slice(0, 2000),
      resendApiKey,
      emailFrom,
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

// ---- API Key Tests ----

router.post('/test/apify', async (req: Request, res: Response) => {
  const token = String((req.body as Record<string, unknown>).token || '').trim();
  if (!token) {
    res.status(400).json({ success: false, error: 'No token provided.' });
    return;
  }
  try {
    const response = await fetch(`https://api.apify.com/v2/users/me?token=${encodeURIComponent(token)}`);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Apify API error ${response.status}: ${text.slice(0, 200)}`);
    }
    const data = await response.json() as { data?: { username?: string } };
    const username = data?.data?.username || 'unknown';
    res.json({ success: true, message: `Connected as ${username}` });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

router.post('/test/openai', async (req: Request, res: Response) => {
  const key = String((req.body as Record<string, unknown>).token || '').trim();
  if (!key) {
    res.status(400).json({ success: false, error: 'No API key provided.' });
    return;
  }
  try {
    const db = getDb();
    const settings = db.prepare('SELECT ai_model FROM settings WHERE profile_id = ?').get(req.profile.id) as { ai_model: string } | undefined;
    const model = settings?.ai_model?.trim() || FALLBACK_AI_MODEL;
    const OpenAI = (await import('openai')).default;
    const client = new OpenAI({ apiKey: key });
    await client.responses.create({
      model,
      input: [{ role: 'user', content: 'Say ok' }],
      max_output_tokens: 16,
    });
    res.json({ success: true, message: 'OpenAI key is valid.' });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

router.post('/test/resend', async (req: Request, res: Response) => {
  const key = String((req.body as Record<string, unknown>).token || '').trim();
  if (!key) {
    res.status(400).json({ success: false, error: 'No API key provided.' });
    return;
  }
  try {
    const { Resend } = await import('resend');
    const resend = new Resend(key);
    const { data, error } = await resend.domains.list();
    if (error) {
      // A "restricted to send emails only" error means auth passed — key is valid, just limited scope
      if (error.message?.toLowerCase().includes('restricted')) {
        res.json({ success: true, message: 'Resend key is valid (email-only permissions).' });
        return;
      }
      throw new Error(error.message);
    }
    const count = (data as { data?: unknown[] })?.data?.length ?? 0;
    res.json({ success: true, message: `Resend key is valid. ${count} domain(s) configured.` });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// ── Admin: set credits balance for a profile ──
router.post('/admin/credits', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const targetProfileId = parseInt(String(b.profileId || '0'), 10);
  const credits = parseFloat(String(b.credits ?? ''));

  if (isNaN(targetProfileId) || targetProfileId <= 0) {
    return res.status(400).json({ error: 'Invalid profileId.' });
  }
  if (isNaN(credits) || credits < 0) {
    return res.status(400).json({ error: 'Credits must be a number ≥ 0.' });
  }

  const profile = db.prepare('SELECT id FROM profiles WHERE id = ?').get(targetProfileId);
  if (!profile) {
    return res.status(404).json({ error: 'Profile not found.' });
  }

  db.prepare('UPDATE settings SET credits_balance = ? WHERE profile_id = ?').run(credits, targetProfileId);
  res.json({ success: true, credits });
});

// ── Admin: create profile ──
router.post('/profiles', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    return res.status(403).json({ success: false, error: 'Admin only.' });
  }
  const db = getDb();
  const body = req.body as Record<string, string>;
  const email = String(body.email || '').trim().toLowerCase();

  if (!email || !email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ success: false, error: 'Invalid email.' });
  }
  const existing = db.prepare('SELECT id FROM profiles WHERE email = ?').get(email);
  if (existing) {
    return res.status(400).json({ success: false, error: 'A profile with this email already exists.' });
  }

  const { id: newId, createdAt } = createProfile(db, email);

  res.json({ success: true, profile: { id: newId, email, is_admin: 0, created_at: createdAt } });
});

// ── Admin: delete profile ──
router.post('/profiles/:id/delete', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) {
    return res.status(403).json({ success: false, error: 'Admin only.' });
  }
  const targetId = parseInt(req.params.id, 10);
  if (targetId === req.profile.id) {
    return res.status(400).json({ success: false, error: 'Cannot delete your own account.' });
  }

  const db = getDb();
  const target = db.prepare('SELECT * FROM profiles WHERE id = ?').get(targetId) as ProfileRow | undefined;
  if (!target) {
    return res.status(404).json({ success: false, error: 'Profile not found.' });
  }
  if (target.is_admin === 1) {
    return res.status(400).json({ success: false, error: 'Cannot delete the admin account.' });
  }

  db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(targetId);
  db.prepare('DELETE FROM profiles WHERE id = ?').run(targetId);

  res.json({ success: true });
});

// Stats summary for dashboard polling
router.get('/stats', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;

  const totalJobs = (db.prepare('SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ?').get(profileId) as { c: number }).c;
  const newJobs = (
    db.prepare(`SELECT COUNT(*) as c FROM job_profile_states WHERE profile_id = ? AND seen = 0 AND is_duplicate = 0 AND ai_verdict = 'STRONG_MATCH'`).get(profileId) as { c: number }
  ).c;
  const lastRun = db.prepare(`
    SELECT
      MIN(ran_at)            AS ran_at,
      SUM(jobs_fetched)      AS jobs_fetched,
      SUM(jobs_scored)       AS jobs_scored,
      SUM(jobs_strong_match) AS jobs_strong_match,
      SUM(jobs_weak_match)   AS jobs_weak_match,
      SUM(jobs_no_match)     AS jobs_no_match,
      SUM(jobs_duplicate)    AS jobs_duplicate,
      SUM(duration_ms)       AS duration_ms,
      CASE
        WHEN COUNT(*) = SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) THEN 'success'
        WHEN COUNT(*) = SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) THEN 'failed'
        WHEN SUM(CASE WHEN status = 'stopped' THEN 1 ELSE 0 END) > 0 THEN 'stopped'
        ELSE 'partial_error'
      END AS status,
      GROUP_CONCAT(error_log, '\n') AS error_log
    FROM search_runs
    WHERE profile_id = ?
      AND trigger != 'cv'
      AND COALESCE(session_id, CAST(id AS TEXT)) = (
        SELECT COALESCE(session_id, CAST(id AS TEXT))
        FROM search_runs WHERE profile_id = ? AND status != 'running' AND trigger != 'cv'
        ORDER BY ran_at DESC LIMIT 1
      )
      AND status != 'running'
  `).get(profileId, profileId);

  res.json({ totalJobs, newJobs, lastRun, isRunning: getIsRunning(profileId) });
});

// ---- Cron Schedule ----

router.get('/schedule/status', (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const settings = db.prepare('SELECT email_send_time, timezone, schedule_date_range, schedule_group_ids, cron_schedule, scraping_providers, run_date_range, run_providers FROM settings WHERE profile_id = ?').get(profileId) as Pick<SettingsRow, 'email_send_time' | 'timezone' | 'schedule_date_range' | 'schedule_group_ids' | 'cron_schedule' | 'scraping_providers' | 'run_date_range' | 'run_providers'> | undefined;
  const savedGroupIds: number[] = settings?.schedule_group_ids ? JSON.parse(settings.schedule_group_ids) : [];
  const groups = db.prepare('SELECT id, group_name, is_active FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as Array<{ id: number; group_name: string; is_active: number }>;
  res.json({
    success: true,
    ...getScheduleStatus(profileId),
    email_send_time: settings?.email_send_time || '07:00',
    timezone: settings?.timezone || 'Asia/Yerevan',
    schedule_date_range: settings?.schedule_date_range || '24h',
    schedule_group_ids: savedGroupIds,
    scraping_providers: JSON.parse(settings?.scraping_providers || DEFAULT_PROVIDER_SELECTION_JSON),
    run_date_range: settings?.run_date_range || '24h',
    run_providers: JSON.parse(settings?.run_providers || DEFAULT_PROVIDER_SELECTION_JSON),
    groups,
  });
});

router.post('/schedule/start', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const b = req.body as Record<string, unknown>;

  // Layer 1 already refuses an unfunded run at fire time; this only turns a silent 3am failure into
  // an immediate error. Same wording as POST /api/run so the two gates cannot read differently.
  const paySettings = db.prepare('SELECT use_jh_credits, credits_balance, user_openai_api_key, user_apify_api_token FROM settings WHERE profile_id = ?').get(profileId) as
    { use_jh_credits: number; credits_balance: number; user_openai_api_key: string; user_apify_api_token: string } | undefined;
  if (!isPaymentReady(paySettings)) {
    const balance = paySettings?.credits_balance ?? 0;
    res.status(402).json({
      success: false,
      error: (paySettings?.use_jh_credits ?? 1) !== 0
        ? `Insufficient credits ($${balance.toFixed(2)}). Please top up to at least $${MIN_RUN_CREDITS.toFixed(2)} to run.`
        : 'Own API keys are not set. Add your OpenAI key and Apify token in Settings → AI Setup, or switch to credits.',
    });
    return;
  }

  const emailSendTime = String(b.email_send_time || '').trim() || null;
  const timezone = String(b.timezone || '').trim() || null;
  const scheduleDateRange = (b.schedule_date_range === '7d' ? '7d' : '24h') as '24h' | '7d';
  // schedule_days: '*' for daily, or '1,3,5' etc. for specific days
  const scheduleDays = String(b.schedule_days || '*').trim().replace(/[^0-9,*]/g, '') || '*';
  // group_ids: snapshot the explicitly selected IDs; if none provided, snapshot currently active ones
  let groupIds: number[] = Array.isArray(b.group_ids)
    ? (b.group_ids as unknown[]).map((id) => parseInt(String(id), 10)).filter((n) => !isNaN(n))
    : [];

  // Always snapshot a concrete list so the schedule runs exactly those roles,
  // regardless of future is_active changes.
  if (groupIds.length === 0) {
    const activeNow = db.prepare('SELECT id FROM search_groups WHERE profile_id = ? AND is_active = 1 ORDER BY id ASC').all(profileId) as Array<{ id: number }>;
    groupIds = activeNow.map((g) => g.id);
  }

  // Parse and validate providers
  const validSchedProviders = ['harvestapi', 'valig', 'indeed', 'stepstone', 'greenhouse', 'ashby', 'lever', 'telegram'];
  const rawSchedProviders = Array.isArray(b.providers)
    ? (b.providers as unknown[]).map(String).filter((p) => validSchedProviders.includes(p))
    : [];
  const schedProviders = rawSchedProviders.length > 0 ? rawSchedProviders : [...DEFAULT_PROVIDER_SELECTION];

  const updates: string[] = [];
  const params: unknown[] = [];
  if (emailSendTime) {
    updates.push('email_send_time = ?');
    params.push(emailSendTime);
  }
  if (timezone) {
    updates.push('timezone = ?');
    params.push(timezone);
  }
  // Build and save the full cron expression
  const timeVal = emailSendTime || '07:00';
  const [hStr, mStr] = timeVal.split(':');
  const expression = `${parseInt(mStr || '0', 10)} ${parseInt(hStr || '7', 10)} * * ${scheduleDays}`;
  updates.push('cron_schedule = ?', 'schedule_date_range = ?', 'schedule_group_ids = ?', 'scraping_providers = ?', 'schedule_active = ?', 'updated_at = ?');
  params.push(expression, scheduleDateRange, JSON.stringify(groupIds), JSON.stringify(schedProviders), 1, new Date().toISOString());
  db.prepare(`UPDATE settings SET ${updates.join(', ')} WHERE profile_id = ?`).run(...params, profileId);

  const settings = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(profileId) as Pick<SettingsRow, 'timezone'> | undefined;
  const tz = settings?.timezone || 'Asia/Yerevan';
  startSchedule(profileId, expression, tz, scheduleDateRange, groupIds, schedProviders);
  const allGroups = db.prepare('SELECT id, group_name, is_active FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(profileId) as Array<{ id: number; group_name: string; is_active: number }>;
  res.json({ success: true, expression, timezone: tz, schedule_date_range: scheduleDateRange, schedule_group_ids: groupIds, scraping_providers: schedProviders, groups: allGroups });
});

router.post('/schedule/stop', (req: Request, res: Response) => {
  stopSchedule(req.profile.id);
  getDb().prepare(`UPDATE settings SET schedule_active = 0 WHERE profile_id = ?`).run(req.profile.id);
  res.json({ success: true });
});

// ---- Search Groups CRUD ----

interface GroupBody {
  group_name: string;
  locations: string[];
  keywords: string[];
  job_type: string;
  work_modes: string[];
  profile_description: string;
  use_main_profile_description: number;
  industries_list: string;
  other_expectations: string;
  scoring_criteria: string;
  no_match_criteria: string;
  disqualifiers: string;
  hate_industries: string;
  salary_expectation: string;
  other_disqualifiers: string;
  title_filter: string;
  score_no_match_max: number;
  score_weak_match_max: number;
  score_strong_match_min: number;
}

function parseGroupBody(body: unknown): GroupBody {
  const b = body as Record<string, unknown>;

  const locations = (Array.isArray(b.locations) ? b.locations : [])
    .map((l: unknown) => String(l).trim())
    .filter(Boolean);

  const keywords = (Array.isArray(b.keywords) ? b.keywords : [])
    .map((k: unknown) => String(k).trim())
    .filter(Boolean);

  const workModes = (Array.isArray(b.work_modes) ? b.work_modes : [])
    .map((w: unknown) => String(w).trim())
    .filter(Boolean);

  // Job types: canonical tokens; empty array = no filter (all types). Kept empty when
  // the user clears every checkbox — the "default to full-time" is a UI/new-role default only.
  const jobTypes = (Array.isArray(b.job_type) ? b.job_type : [])
    .map((t: unknown) => String(t).toLowerCase().trim())
    .filter((t) => (JOB_TYPES as readonly string[]).includes(t));

  const noMatchMax   = parseInt(String(b.score_no_match_max), 10);
  const weakMatchMax = parseInt(String(b.score_weak_match_max), 10);
  const strongMin    = parseInt(String(b.score_strong_match_min), 10);

  const useMainProfile = (b.use_main_profile_description === 1 || b.use_main_profile_description === true || b.use_main_profile_description === '1') ? 1 : 0;

  if (locations.length === 0) throw new Error('At least one location is required.');
  if (keywords.length === 0)  throw new Error('At least one keyword is required.');
  if (!useMainProfile && !String(b.profile_description || '').trim()) throw new Error('A profile description is required.');
  if (!String(b.scoring_criteria || '').trim()) throw new Error('A role scoring guide is required.');
  if (!String(b.no_match_criteria || '').trim()) throw new Error('At least one rejection rule is required.');
  if (
    isNaN(noMatchMax) || isNaN(weakMatchMax) || isNaN(strongMin) ||
    noMatchMax < 0 || noMatchMax > 99 ||
    weakMatchMax <= noMatchMax || weakMatchMax > 99 ||
    strongMin !== weakMatchMax + 1
  ) {
    throw new Error(
      'Invalid score thresholds. Ensure: 0 ≤ no_match_max < weak_match_max, and strong_match_min = weak_match_max + 1',
    );
  }

  return {
    group_name: String(b.group_name || '').trim().slice(0, 50),
    locations,
    keywords,
    job_type: JSON.stringify(jobTypes),
    work_modes: workModes,
    profile_description: String(b.profile_description || ''),
    use_main_profile_description: useMainProfile,
    industries_list: String(b.industries_list || ''),
    other_expectations: String(b.other_expectations || ''),
    scoring_criteria: String(b.scoring_criteria || ''),
    no_match_criteria: String(b.no_match_criteria || ''),
    disqualifiers: String(b.disqualifiers || ''),
    hate_industries: String(b.hate_industries || ''),
    salary_expectation: String(b.salary_expectation || ''),
    other_disqualifiers: String(b.other_disqualifiers || ''),
    title_filter: String(b.title_filter || '').trim(),
    score_no_match_max: noMatchMax,
    score_weak_match_max: weakMatchMax,
    score_strong_match_min: strongMin,
  };
}

// Resolve location strings → country name + Indeed/Greenhouse/Ashby mapping (used by the role edit modal)
router.post('/resolve-locations', async (req: Request, res: Response) => {
  try {
    const raw = (req.body as Record<string, unknown>).locations;
    const locations = Array.isArray(raw) ? (raw as unknown[]).map(String).filter(Boolean) : [];
    if (locations.length === 0) { res.json({}); return; }
    const countryNames = await resolveCountries(locations);
    const result: Record<string, { countryName: string | null; code: string | null; atsSupported: boolean }> = {};
    for (const loc of locations) {
      const countryName = countryNames.get(loc) ?? null;
      const code = countryName ? (INDEED_CODE[countryName.toLowerCase().trim()] ?? null) : null;
      result[loc] = { countryName, code, atsSupported: countryName != null };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /api/groups — list groups for active profile
router.get('/groups', (req: Request, res: Response) => {
  const db = getDb();
  const groups = db.prepare('SELECT * FROM search_groups WHERE profile_id = ? ORDER BY id ASC').all(req.profile.id) as SearchGroupRow[];
  res.json({ success: true, groups });
});

// POST /api/groups — create a group under active profile
router.post('/groups', (req: Request, res: Response) => {
  try {
    const db = getDb();
    const profileId = req.profile.id;
    const count = (db.prepare('SELECT COUNT(*) as c FROM search_groups WHERE profile_id = ?').get(profileId) as { c: number }).c;
    if (count >= 15) {
      res.status(409).json({ success: false, error: 'Maximum of 15 roles reached.' });
      return;
    }
    const body = parseGroupBody(req.body);
    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO search_groups (profile_id, group_name, locations, keywords, job_type, work_modes, ai_system_prompt, profile_description, use_main_profile_description, industries_list, other_expectations, scoring_criteria, no_match_criteria, disqualifiers, hate_industries, salary_expectation, other_disqualifiers, title_filter, score_no_match_max, score_weak_match_max, score_strong_match_min, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      profileId,
      body.group_name,
      JSON.stringify(body.locations),
      JSON.stringify(body.keywords),
      body.job_type,
      JSON.stringify(body.work_modes),
      body.profile_description,
      body.use_main_profile_description,
      body.industries_list,
      body.other_expectations,
      body.scoring_criteria,
      body.no_match_criteria,
      body.disqualifiers,
      body.hate_industries,
      body.salary_expectation,
      body.other_disqualifiers,
      body.title_filter,
      body.score_no_match_max,
      body.score_weak_match_max,
      body.score_strong_match_min,
      now, now,
    );

    const created = db
      .prepare('SELECT * FROM search_groups WHERE id = ?')
      .get(result.lastInsertRowid) as SearchGroupRow;

    res.status(201).json({ success: true, group: created });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// PUT /api/groups/:id — update a group
router.put('/groups/:id', (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid group id.' });
      return;
    }

    const body = parseGroupBody(req.body);
    const db = getDb();

    const existing = db.prepare('SELECT id FROM search_groups WHERE id = ? AND profile_id = ?').get(id, req.profile.id);
    if (!existing) {
      res.status(404).json({ success: false, error: 'Group not found.' });
      return;
    }

    db.prepare(`
      UPDATE search_groups
      SET group_name = ?, locations = ?, keywords = ?, job_type = ?, work_modes = ?,
          profile_description = ?, use_main_profile_description = ?, industries_list = ?, other_expectations = ?,
          scoring_criteria = ?, no_match_criteria = ?,
          disqualifiers = ?, hate_industries = ?, salary_expectation = ?, other_disqualifiers = ?,
          title_filter = ?, score_no_match_max = ?, score_weak_match_max = ?, score_strong_match_min = ?, updated_at = ?
      WHERE id = ?
    `).run(
      body.group_name,
      JSON.stringify(body.locations),
      JSON.stringify(body.keywords),
      body.job_type,
      JSON.stringify(body.work_modes),
      body.profile_description,
      body.use_main_profile_description,
      body.industries_list,
      body.other_expectations,
      body.scoring_criteria,
      body.no_match_criteria,
      body.disqualifiers,
      body.hate_industries,
      body.salary_expectation,
      body.other_disqualifiers,
      body.title_filter,
      body.score_no_match_max,
      body.score_weak_match_max,
      body.score_strong_match_min,
      new Date().toISOString(),
      id,
    );

    const updated = db
      .prepare('SELECT * FROM search_groups WHERE id = ?')
      .get(id) as SearchGroupRow;

    res.json({ success: true, group: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: (err as Error).message });
  }
});

// PATCH /api/groups/:id — toggle is_active only
router.patch('/groups/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid group id.' });
    return;
  }

  const db = getDb();
  const b = req.body as Record<string, unknown>;
  const isActive = b.is_active === true || b.is_active === 1;

  const existing = db.prepare('SELECT * FROM search_groups WHERE id = ? AND profile_id = ?').get(id, req.profile.id) as import('../db').SearchGroupRow | undefined;
  if (!existing) {
    res.status(404).json({ success: false, error: 'Group not found.' });
    return;
  }

  db.prepare('UPDATE search_groups SET is_active = ?, updated_at = ? WHERE id = ?').run(
    isActive ? 1 : 0,
    new Date().toISOString(),
    id,
  );

  const updated = db.prepare('SELECT * FROM search_groups WHERE id = ?').get(id) as import('../db').SearchGroupRow;
  res.json({ success: true, group: updated });
});

// DELETE /api/groups/:id — delete a group (blocked if it's the last one for this profile)
router.delete('/groups/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid group id.' });
    return;
  }

  const db = getDb();
  const profileId = req.profile.id;

  const count = (
    db.prepare('SELECT COUNT(*) as c FROM search_groups WHERE profile_id = ?').get(profileId) as { c: number }
  ).c;
  if (count <= 1) {
    res.status(409).json({ success: false, error: 'Cannot delete the last role.' });
    return;
  }

  try {
    db.transaction(() => {
      // Orphan any referencing rows (data is preserved, group_id → null)
      db.prepare('UPDATE job_profile_states SET group_id = NULL WHERE group_id = ?').run(id);
      db.prepare('UPDATE run_job_logs SET group_id = NULL WHERE group_id = ?').run(id);
      const changes = db.prepare('DELETE FROM search_groups WHERE id = ? AND profile_id = ?').run(id, profileId).changes;
      if (changes === 0) throw Object.assign(new Error('Group not found.'), { status: 404 });
    });
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ success: false, error: (err as Error).message });
    return;
  }

  res.json({ success: true });
});

// PATCH /api/jobs/:id/verdict — override a job's verdict
router.patch('/jobs/:id/verdict', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ success: false, error: 'Invalid job id.' });
    return;
  }

  const b = req.body as Record<string, unknown>;
  const verdict = String(b.verdict || '').trim();
  const allowed = ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE'];
  if (!allowed.includes(verdict)) {
    res.status(400).json({ success: false, error: `Invalid verdict. Must be one of: ${allowed.join(', ')}` });
    return;
  }

  const db = getDb();
  const changes = db.prepare(`
    UPDATE job_profile_states SET ai_verdict = ?, is_duplicate = ?
    WHERE job_id = ? AND profile_id = ?
  `).run(verdict, verdict === 'DUPLICATE' ? 1 : 0, id, req.profile.id).changes;

  if (changes === 0) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return;
  }

  res.json({ success: true, matchesCount: getMatchesCount(req.profile.id) });
});

// PATCH /api/run-log/:id/verdict — override verdict for a run log entry; inserts into jobs table if not yet stored
router.patch('/run-log/:id/verdict', (req: Request, res: Response) => {
  const logId = parseInt(req.params.id, 10);
  if (isNaN(logId)) { res.status(400).json({ success: false, error: 'Invalid log id.' }); return; }

  const b = req.body as Record<string, unknown>;
  const verdict = String(b.verdict || '').trim();
  const allowed = ['STRONG_MATCH', 'WEAK_MATCH', 'NO_MATCH', 'DUPLICATE'];
  if (!allowed.includes(verdict)) {
    res.status(400).json({ success: false, error: `Invalid verdict. Must be one of: ${allowed.join(', ')}` });
    return;
  }

  const db = getDb();
  const profileId = req.profile.id;

  const log = db.prepare(`
    SELECT rjl.* FROM run_job_logs rjl
    INNER JOIN search_runs sr ON sr.id = rjl.run_id
    WHERE rjl.id = ? AND sr.profile_id = ?
  `).get(logId, profileId) as RunJobLogRow | undefined;

  if (!log) {
    res.status(404).json({ success: false, error: 'Log entry not found.' });
    return;
  }

  db.prepare('UPDATE run_job_logs SET ai_verdict = ? WHERE id = ?').run(verdict, logId);

  const now = new Date().toISOString();
  const logJobSource = log.job_source || 'LinkedIn';
  const existingJob = db.prepare('SELECT id FROM jobs WHERE linkedin_job_id = ? AND job_source = ?')
    .get(log.linkedin_job_id, logJobSource) as { id: number } | undefined;
  let internalJobId: number;
  if (existingJob) {
    db.prepare(`
      UPDATE job_profile_states SET ai_verdict = ?, is_duplicate = ?
      WHERE job_id = ? AND profile_id = ?
    `).run(verdict, verdict === 'DUPLICATE' ? 1 : 0, existingJob.id, profileId);
    internalJobId = existingJob.id;
  } else {
    db.prepare(`
      INSERT OR IGNORE INTO jobs
        (linkedin_job_id, job_source, provider, title, company, location, description, url, fetched_at)
      VALUES (?, ?, 'unknown', ?, ?, ?, '', ?, ?)
    `).run(log.linkedin_job_id, logJobSource, log.title, log.company, log.location, log.url, log.logged_at);
    const { id: jobId } = db.prepare(`SELECT id FROM jobs WHERE linkedin_job_id = ? AND job_source = ?`)
      .get(log.linkedin_job_id, logJobSource) as { id: number };
    db.prepare(`
      INSERT OR IGNORE INTO job_profile_states
        (job_id, profile_id, group_id, fetched_at, ai_score, ai_verdict, original_ai_verdict,
         is_duplicate, rejection_category, seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(jobId, profileId, log.group_id, now,
           log.ai_score ?? 0, verdict, log.ai_verdict,
           verdict === 'DUPLICATE' ? 1 : 0, log.rejection_category);
    internalJobId = jobId;
  }

  res.json({ success: true, internal_job_id: internalJobId, matchesCount: getMatchesCount(profileId) });
});

// PATCH /api/jobs/:id/applied — set applied status (0 = not applied, 1 = applied, 2 = won't apply)
router.patch('/jobs/:id/applied', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid job id.' }); return; }
  const b = req.body as Record<string, unknown>;
  const raw = Number(b.applied);
  const applied = raw === 1 || raw === 2 ? raw : 0;
  const db = getDb();
  const changes = db.prepare(`
    UPDATE job_profile_states SET applied = ? WHERE job_id = ? AND profile_id = ?
  `).run(applied, id, req.profile.id).changes;
  if (changes === 0) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  res.json({ success: true, matchesCount: getMatchesCount(req.profile.id) });
});

// GET /api/company?name=... — everything the company details modal renders.
// Basics are shared across profiles; context is always scoped to the caller's profile.
router.get('/company', (req: Request, res: Response) => {
  const raw = String(req.query.name || '').trim();
  const key = companyKey(raw);
  if (!key) { res.status(400).json({ success: false, error: 'Company name required.' }); return; }
  const basics = getCompanyProfile(key);
  res.json({
    success: true,
    key,
    basics,
    context: getCompanyUserContext(req.profile.id, key),
    links: buildCompanyLinks(basics?.display_name || raw),
  });
});

// POST /api/company/retry-enrichment — clears a failed enrichment so the next run retries it.
// Deliberately does not call the LLM from a web request.
router.post('/company/retry-enrichment', (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  const key = companyKey(String(b.company || ''));
  if (!key) { res.status(400).json({ success: false, error: 'Company name required.' }); return; }
  getDb().prepare(
    `UPDATE companies SET enrich_status = NULL, enrich_attempted_at = NULL WHERE company = ?`,
  ).run(key);
  res.json({ success: true, enrich_status: null });
});

// GET /api/company-notes?company=... — fetch note for a company
router.get('/company-notes', (req: Request, res: Response) => {
  const company = companyKey(String(req.query.company || ''));
  if (!company) { res.json({ note: '' }); return; }
  const db = getDb();
  const row = db.prepare('SELECT note FROM company_notes WHERE profile_id = ? AND company = ?').get(req.profile.id, company) as { note: string } | undefined;
  res.json({ note: row?.note || '' });
});

// PATCH /api/company-notes — upsert note for a company
router.patch('/company-notes', (req: Request, res: Response) => {
  const b = req.body as Record<string, unknown>;
  const company = companyKey(String(b.company || ''));
  const note = String(b.note ?? '').trim().slice(0, 5000);
  if (!company) { res.status(400).json({ success: false, error: 'Company name required.' }); return; }
  const db = getDb();
  db.prepare(`
    INSERT INTO company_notes (profile_id, company, note, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, company) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at
  `).run(req.profile.id, company, note, new Date().toISOString());
  res.json({ success: true });
});

// PATCH /api/jobs/:id/notes — save user notes
router.patch('/jobs/:id/notes', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid job id.' }); return; }
  const b = req.body as Record<string, unknown>;
  const notes = String(b.notes ?? '').trim().slice(0, 5000);
  const db = getDb();
  const changes = db.prepare(`
    UPDATE job_profile_states SET user_notes = ? WHERE job_id = ? AND profile_id = ?
  `).run(notes || null, id, req.profile.id).changes;
  if (changes === 0) { res.status(403).json({ success: false, error: 'Forbidden' }); return; }
  res.json({ success: true });
});

// GET /api/check-openai-balance — remaining credit on the profile's OWN OpenAI key.
// Own-keys mode only: on credits the relevant figure is the JH credits balance, and answering with
// the operator's OpenAI account standing would expose it to every signed-in user.
router.get('/check-openai-balance', async (req: Request, res: Response) => {
  const db = getDb();
  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(req.profile.id) as SettingsRow | undefined;
  if ((settings?.use_jh_credits ?? 1) !== 0) {
    res.json({ success: false, error: 'Not applicable on credits — see your credits balance.' });
    return;
  }
  const apiKey = settings?.user_openai_api_key?.trim();
  if (!apiKey) {
    res.json({ success: false, error: 'No OpenAI API key configured in Settings.' });
    return;
  }
  try {
    const result = await checkOpenAiBalance(apiKey);
    res.json({ success: true, ...result });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ success: false, error: msg });
  }
});

// ---- Company Blacklist CRUD ----

// GET /api/blacklist
router.get('/blacklist', (req: Request, res: Response) => {
  const db = getDb();
  const entries = db
    .prepare('SELECT * FROM blacklisted_companies WHERE profile_id = ? ORDER BY company_name ASC')
    .all(req.profile.id) as BlacklistedCompanyRow[];
  res.json({ success: true, entries });
});

// POST /api/blacklist
router.post('/blacklist', (req: Request, res: Response) => {
  try {
    const b = req.body as Record<string, unknown>;
    const companyName = String(b.company_name || '').trim();
    const notes = String(b.notes || '').trim();
    const profileId = req.profile.id;

    if (!companyName) {
      res.status(400).json({ success: false, error: 'Company name is required.' });
      return;
    }

    const db = getDb();
    const result = db
      .prepare('INSERT INTO blacklisted_companies (profile_id, company_name, notes, created_at) VALUES (?, ?, ?, ?)')
      .run(profileId, companyName, notes, new Date().toISOString());

    const created = db
      .prepare('SELECT * FROM blacklisted_companies WHERE id = ?')
      .get(result.lastInsertRowid) as BlacklistedCompanyRow;

    res.status(201).json({ success: true, entry: created });
  } catch (err) {
    const msg = (err as Error).message;
    const isDupe = msg.includes('UNIQUE');
    res.status(400).json({ success: false, error: isDupe ? 'That company is already blacklisted.' : msg });
  }
});

// PUT /api/blacklist/:id
router.put('/blacklist/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid id.' }); return; }

  try {
    const b = req.body as Record<string, unknown>;
    const companyName = String(b.company_name || '').trim();
    const notes = String(b.notes || '').trim();

    if (!companyName) {
      res.status(400).json({ success: false, error: 'Company name is required.' });
      return;
    }

    const db = getDb();
    const changes = db
      .prepare('UPDATE blacklisted_companies SET company_name = ?, notes = ? WHERE id = ? AND profile_id = ?')
      .run(companyName, notes, id, req.profile.id).changes;

    if (changes === 0) { res.status(404).json({ success: false, error: 'Entry not found.' }); return; }

    const updated = db
      .prepare('SELECT * FROM blacklisted_companies WHERE id = ?')
      .get(id) as BlacklistedCompanyRow;

    res.json({ success: true, entry: updated });
  } catch (err) {
    const msg = (err as Error).message;
    const isDupe = msg.includes('UNIQUE');
    res.status(400).json({ success: false, error: isDupe ? 'That company is already blacklisted.' : msg });
  }
});

// DELETE /api/blacklist/:id
router.delete('/blacklist/:id', (req: Request, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) { res.status(400).json({ success: false, error: 'Invalid id.' }); return; }

  const db = getDb();
  const changes = db.prepare('DELETE FROM blacklisted_companies WHERE id = ? AND profile_id = ?').run(id, req.profile.id).changes;

  if (changes === 0) { res.status(404).json({ success: false, error: 'Entry not found.' }); return; }

  res.json({ success: true });
});


// POST /api/jobs/:id/cv-compare — compare job to a saved CV using OpenAI
router.post('/jobs/:id/cv-compare', async (req: Request, res: Response) => {
  const db = getDb();
  const profileId = req.profile.id;
  const jobId = parseInt(req.params.id, 10);
  if (isNaN(jobId)) { res.status(400).json({ error: 'Invalid job id.' }); return; }

  const body = req.body as Record<string, unknown>;
  const cvId = parseInt(String(body.cv_id || '0'), 10);
  if (!cvId || isNaN(cvId)) { res.status(400).json({ error: 'cv_id is required.' }); return; }

  const jobRow = db.prepare(`
    SELECT j.*, jps.*, COALESCE(jd.description_text, j.description) AS description_text
    FROM jobs j JOIN job_profile_states jps ON jps.job_id = j.id
    LEFT JOIN job_descriptions jd ON jd.job_id = j.id
    WHERE j.id = ? AND jps.profile_id = ?
  `).get(jobId, profileId) as (JobWithState & { description_text?: string }) | undefined;
  const job = jobRow ? { ...jobRow, description: jobRow.description_text ?? jobRow.description } : undefined;
  if (!job) { res.status(404).json({ error: 'Job not found.' }); return; }

  const cv = db.prepare('SELECT * FROM cvs WHERE id = ? AND profile_id = ?').get(cvId, profileId) as CvRow | undefined;
  if (!cv) { res.status(404).json({ error: 'CV not found.' }); return; }

  const settings = db.prepare('SELECT * FROM settings WHERE profile_id = ?').get(profileId) as SettingsRow;

  // Metered like a pipeline run. This call used to fall back to the instance's env key with no
  // balance check and no deduction, which made it a free proxy onto the operator's OpenAI account.
  let openaiKey: string;
  try {
    ({ openAiKey: openaiKey } = resolveSpendKeys(db, profileId));
  } catch (err) {
    res.status(err instanceof PaymentError ? 402 : 400).json({ error: (err as Error).message });
    return;
  }
  if (!openaiKey) { res.status(400).json({ error: 'OpenAI API key not configured.' }); return; }

  const prompt = settings?.cv_comparison_prompt?.trim() || DEFAULT_CV_COMPARISON_PROMPT;
  const model = settings?.ai_model_hard?.trim() || FALLBACK_AI_MODEL;
  const jobText = `JOB TITLE: ${job.title}\nCOMPANY: ${job.company}\nLOCATION: ${job.location || 'N/A'}\nWORK MODE: ${job.work_mode || 'N/A'}\n\nDESCRIPTION:\n${(job.description || '').substring(0, 12000)}`;

  try {
    const client = new OpenAI({ apiKey: openaiKey });
    let responseText: string;
    let usage: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;

    if (cv.mime_type === 'application/pdf') {
      // PDF: send as base64 file input
      const response = await client.responses.create({
        model,
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_file' as const,
                filename: cv.filename,
                file_data: `data:application/pdf;base64,${cv.content_b64}`,
              },
              {
                type: 'input_text' as const,
                text: `\nHere is the job description:\n\n${jobText}\n\n${prompt}`,
              },
            ],
          },
        ],
      });
      responseText = response.output_text;
      usage = response.usage;
    } else {
      // Text-based CV
      const cvText = Buffer.from(cv.content_b64, 'base64').toString('utf-8');
      const response = await client.responses.create({
        model,
        input: [
          {
            role: 'user',
            content: `MY CV:\n\n${cvText}\n\nJOB POSTING:\n\n${jobText}\n\n${prompt}`,
          },
        ],
      });
      responseText = response.output_text;
      usage = response.usage;
    }

    if (!responseText) throw new Error('Empty response from OpenAI');

    db.prepare('UPDATE job_profile_states SET cv_assessment = ? WHERE job_id = ? AND profile_id = ?').run(responseText, jobId, profileId);
    recordCvCompareCost(db, profileId, model, usage);
    res.json({ ok: true, assessment: responseText });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Bill a CV comparison into the same AI cost line the pipeline uses: a `search_runs` row with
 * `trigger = 'cv'`. The Stats cost chart aggregates that table without filtering on trigger, so the
 * spend appears in the existing AI series for free; the three surfaces that list *runs* exclude the
 * trigger explicitly so these rows never masquerade as pipeline runs.
 *
 * Deduction mirrors the runner: clamp the balance at zero and bank any shortfall separately.
 * Best-effort — a failure here must not lose the assessment the user already paid for.
 */
function recordCvCompareCost(
  db: ReturnType<typeof getDb>,
  profileId: number,
  model: string,
  usage: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined,
): void {
  try {
    const cost = calcOpenAiCost(
      model,
      usage?.input_tokens ?? 0,
      usage?.input_tokens_details?.cached_tokens ?? 0,
      usage?.output_tokens ?? 0,
    ) ?? 0;
    if (cost <= 0) return;

    db.prepare(`
      INSERT INTO search_runs (profile_id, ran_at, jobs_fetched, jobs_scored, jobs_strong_match,
        jobs_weak_match, jobs_no_match, jobs_duplicate, status, error_log, duration_ms, trigger,
        session_id, cost_openai_usd, cost_apify_usd)
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, 'success', NULL, NULL, 'cv', ?, ?, 0)
    `).run(profileId, new Date().toISOString(), randomUUID(), cost);

    const s = db.prepare('SELECT use_jh_credits, credits_balance FROM settings WHERE profile_id = ?').get(profileId) as
      { use_jh_credits: number; credits_balance: number } | undefined;
    if ((s?.use_jh_credits ?? 1) === 0) return;   // own keys — nothing to deduct

    const balance = s?.credits_balance ?? 0;
    db.prepare('UPDATE settings SET credits_balance = ?, credits_overspent_usd = credits_overspent_usd + ? WHERE profile_id = ?')
      .run(Math.max(0, balance - cost), Math.max(0, cost - balance), profileId);
  } catch (err) {
    console.warn('[api] Failed to record CV comparison cost:', (err as Error).message);
  }
}

// ── ATS Board Discovery & Validation (admin-only) ──

router.get('/ats/status', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const boards = db.prepare(`
    SELECT ats,
           COUNT(*) AS total,
           SUM(is_active) AS active,
           MAX(discovered_at) AS last_discovered,
           MAX(validated_at) AS last_validated
    FROM ats_boards
    GROUP BY ats
  `).all() as Array<{ ats: string; total: number; active: number; last_discovered: string; last_validated: string }>;
  const settings = db.prepare(`
    SELECT ats_discovery_enabled, ats_lever_disc_enabled, ats_validation_enabled,
           ats_pool_gh_enabled, ats_pool_ashby_enabled, ats_pool_gh_last_fetch, ats_pool_ashby_last_fetch,
           ats_pool_lever_enabled, ats_pool_lever_last_fetch,
           telegram_ingest_enabled, timezone
    FROM settings WHERE profile_id = ?
  `).get(req.profile.id) as {
    ats_discovery_enabled: number; ats_lever_disc_enabled: number; ats_validation_enabled: number;
    ats_pool_gh_enabled: number; ats_pool_ashby_enabled: number;
    ats_pool_gh_last_fetch: string | null; ats_pool_ashby_last_fetch: string | null;
    ats_pool_lever_enabled: number; ats_pool_lever_last_fetch: string | null;
    telegram_ingest_enabled: number; timezone: string;
  } | undefined;
  const ghCount       = (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE job_source = 'Greenhouse'`).get() as { c: number }).c;
  const ashbyCount    = (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE job_source = 'Ashby'`).get() as { c: number }).c;
  const leverCount    = (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE job_source = 'Lever'`).get() as { c: number }).c;
  const telegramCount = (db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE job_source = 'Telegram'`).get() as { c: number }).c;
  const telegramChannelCount = (db.prepare(`SELECT COUNT(*) AS c FROM telegram_channels WHERE is_active = 1`).get() as { c: number }).c;
  const telegramPostCount = (db.prepare(`SELECT COUNT(*) AS c FROM telegram_posts`).get() as { c: number }).c;
  const telegramLastRun = db.prepare(`
    SELECT started_at, channels, posts, inserted, edited, jobs_created, duration_ms
    FROM telegram_ingest_runs ORDER BY id DESC LIMIT 1
  `).get() ?? null;
  // Location chunk counts — all element-level. Known/Unknown read the location_country
  // cache directly (each row is one distinct chunk we've saved: resolved vs failed);
  // Need-resolving is the resolver's own work-set (chunks seen in jobs, not yet cached),
  // so the badge matches what "Resolve now" will do and drains to 0 after a run.
  const resolvedLocationCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM location_country WHERE country != ''`,
  ).get() as { c: number }).c;
  const unknownLocationCount = (db.prepare(
    `SELECT COUNT(*) AS c FROM location_country WHERE country = ''`,
  ).get() as { c: number }).c;
  const newUnresolvedLocationCount = unresolvedPoolElements(db).length;
  res.json({
    boards,
    settings,
    poolCounts: {
      greenhouse: ghCount,
      ashby: ashbyCount,
      lever: leverCount,
      resolvedLocations: resolvedLocationCount,
      unknownLocations: unknownLocationCount,
      newUnresolvedLocations: newUnresolvedLocationCount,
    },
    telegramCounts: {
      jobs: telegramCount,
      channels: telegramChannelCount,
      posts: telegramPostCount,
      lastRun: telegramLastRun,
    },
  });
});

router.post('/ats/discover', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const runId = tryStartRun({ kind: 'discover', label: 'Discovery (GH & Ashby)', unit: 'boards', cancellable: true });
  if (!runId) return res.status(409).json({ error: 'Discovery is already running.' });
  res.json({ runId });
  runDiscovery(getDb(), runId)
    .then((r) => console.log('[ats-discovery] Manual run complete:', r))
    .catch((e) => console.error('[ats-discovery] Manual run error:', e))
    .finally(() => endRun(runId));
});

router.post('/ats/discover-lever', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const runId = tryStartRun({ kind: 'discover-lever', label: 'Discovery (Lever)', unit: 'boards', cancellable: true });
  if (!runId) return res.status(409).json({ error: 'Lever discovery is already running.' });
  res.json({ runId });
  runLeverDiscovery(getDb(), runId)
    .then((r) => console.log('[lever-discovery] Manual run complete:', r))
    .catch((e) => console.error('[lever-discovery] Manual run error:', e))
    .finally(() => endRun(runId));
});

router.post('/ats/validate', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const runId = tryStartRun({ kind: 'validate', label: 'Validation', unit: 'boards', cancellable: true });
  if (!runId) return res.status(409).json({ error: 'Validation is already running.' });
  res.json({ runId });
  runValidation(getDb(), runId)
    .then((r) => console.log('[ats-validation] Manual run complete:', r))
    .catch((e) => console.error('[ats-validation] Manual run error:', e))
    .finally(() => endRun(runId));
});

router.get('/ats/stream/:runId', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) { res.status(403).end(); return; }
  const run = activeRuns.get(req.params.runId);
  if (!run) { res.status(404).end(); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (data: string) => res.write(data);
  for (const msg of run.log) send(`data: ${JSON.stringify({ msg })}\n\n`);   // replay buffered log
  if (run.progress) send(`data: ${JSON.stringify(run.progress)}\n\n`);        // replay last progress
  // If the run already finished (e.g. a fast, all-cached resolve completes before the
  // client's stream even connects), replay the terminal event too — not just its text —
  // so a late subscriber finalizes immediately instead of hanging until an idle timeout.
  if (run.done) { send(`data: ${JSON.stringify({ done: true, cancelled: run.cancelled })}\n\n`); res.end(); return; }
  run.listeners.add(send);
  req.on('close', () => run.listeners.delete(send));
});

router.delete('/ats/run/:runId', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  return cancelRun(req.params.runId)
    ? res.json({ success: true })
    : res.status(404).json({ error: 'Run not found.' });
});

router.get('/ats/active', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) { res.status(403).json({ error: 'Admin only.' }); return; }
  res.json(listActiveRuns());
});

router.post('/ats/pool/fetch-greenhouse', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  if (!tryAcquirePoolLock('Greenhouse')) {
    return res.status(409).json({ error: `A ${getActivePoolFetch()} pool fetch is already running.` });
  }
  const runId = createRun({ kind: 'pool-gh', label: 'Greenhouse pool fetch', unit: 'boards', cancellable: true });
  res.json({ runId });
  fetchGreenhousePool(getDb(), runId)
    .then((r) => console.log('[gh-pool] Manual fetch complete:', r))
    .catch((e) => console.error('[gh-pool] Manual fetch error:', e))
    .finally(() => { releasePoolLock(); endRun(runId); });
});

router.post('/ats/pool/fetch-ashby', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  if (!tryAcquirePoolLock('Ashby')) {
    return res.status(409).json({ error: `A ${getActivePoolFetch()} pool fetch is already running.` });
  }
  const runId = createRun({ kind: 'pool-ashby', label: 'Ashby pool fetch', unit: 'boards', cancellable: true });
  res.json({ runId });
  fetchAshbyPool(getDb(), runId)
    .then((r) => console.log('[ashby-pool] Manual fetch complete:', r))
    .catch((e) => console.error('[ashby-pool] Manual fetch error:', e))
    .finally(() => { releasePoolLock(); endRun(runId); });
});

router.post('/ats/pool/fetch-lever', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  if (!tryAcquirePoolLock('Lever')) {
    return res.status(409).json({ error: `A ${getActivePoolFetch()} pool fetch is already running.` });
  }
  const runId = createRun({ kind: 'pool-lever', label: 'Lever pool fetch', unit: 'boards', cancellable: true });
  res.json({ runId });
  fetchLeverPool(getDb(), runId)
    .then((r) => console.log('[lever-pool] Manual fetch complete:', r))
    .catch((e) => console.error('[lever-pool] Manual fetch error:', e))
    .finally(() => { releasePoolLock(); endRun(runId); });
});

router.post('/ats/pool/resolve-countries', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const runId = tryStartRun({ kind: 'resolve-countries', label: 'Resolving job countries', unit: 'locations', cancellable: true });
  if (!runId) return res.status(409).json({ error: 'Country resolution is already running.' });
  res.json({ runId });
  resolvePoolCountries(getDb(), runId)
    .then((r) => console.log('[pool] Resolve countries complete:', r))
    .catch((e) => console.error('[pool] Resolve countries error:', e))
    .finally(() => endRun(runId));
});

router.post('/ats/pool/recheck-unknown-countries', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const runId = tryStartRun({ kind: 'recheck-unknowns', label: 'Re-checking unknown countries', unit: 'locations', cancellable: true });
  if (!runId) return res.status(409).json({ error: 'Re-check is already running.' });
  res.json({ runId });
  resolvePoolCountries(getDb(), runId, { recheckUnknowns: true })
    .then((r) => console.log('[pool] Re-check unknown countries complete:', r))
    .catch((e) => console.error('[pool] Re-check unknown countries error:', e))
    .finally(() => endRun(runId));
});

router.post('/ats/pool/settings', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const b = req.body as Record<string, unknown>;
  const ghEnabled    = !!b.gh_enabled;
  const ashbyEnabled = !!b.ashby_enabled;
  const leverEnabled = !!b.lever_enabled;

  const db = getDb();
  const row = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(req.profile.id) as { timezone: string } | undefined;
  const tz = row?.timezone || 'UTC';

  db.prepare(`
    UPDATE settings SET ats_pool_gh_enabled = ?, ats_pool_ashby_enabled = ?, ats_pool_lever_enabled = ? WHERE profile_id = ?
  `).run(ghEnabled ? 1 : 0, ashbyEnabled ? 1 : 0, leverEnabled ? 1 : 0, req.profile.id);

  if (ghEnabled) startGhPoolCron('0 5 * * *', tz);
  else stopGhPoolCron();

  if (ashbyEnabled) startAshbyPoolCron('15 5 * * *', tz);
  else stopAshbyPoolCron();

  if (leverEnabled) startLeverPoolCron('45 5 * * *', tz);
  else stopLeverPoolCron();

  res.json({ success: true, timezone: tz });
});

router.post('/ats/settings', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const b = req.body as Record<string, unknown>;
  const discoveryEnabled     = !!b.discovery_enabled;
  const leverDiscEnabled     = !!b.lever_disc_enabled;
  const validationEnabled    = !!b.validation_enabled;

  const db = getDb();
  const row = db.prepare('SELECT timezone FROM settings WHERE profile_id = ?').get(req.profile.id) as { timezone: string } | undefined;
  const tz = row?.timezone || 'UTC';

  db.prepare(`
    UPDATE settings
    SET ats_discovery_enabled  = ?, ats_discovery_cron  = ?,
        ats_lever_disc_enabled = ?, ats_lever_disc_cron = ?,
        ats_validation_enabled = ?, ats_validation_cron = ?
    WHERE profile_id = ?
  `).run(
    discoveryEnabled  ? 1 : 0, ATS_DISCOVERY_CRON,
    leverDiscEnabled  ? 1 : 0, ATS_LEVER_CRON,
    validationEnabled ? 1 : 0, ATS_VALIDATION_CRON,
    req.profile.id,
  );

  if (discoveryEnabled) startAtsDiscoveryCron(ATS_DISCOVERY_CRON, tz);
  else stopAtsDiscoveryCron();

  if (leverDiscEnabled) startLeverDiscoveryCron(ATS_LEVER_CRON, tz);
  else stopLeverDiscoveryCron();

  if (validationEnabled) startAtsValidationCron(ATS_VALIDATION_CRON, tz);
  else stopAtsValidationCron();

  res.json({ success: true, timezone: tz });
});

// ── Telegram admin routes ────────────────────────────────────────────────────

router.post('/telegram/settings', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const b = req.body as Record<string, unknown>;
  const enabled = !!b.enabled;
  const newPrompt = typeof b.extract_prompt === 'string' ? b.extract_prompt.trim() : null;

  const db = getDb();
  const row = db.prepare('SELECT timezone, telegram_extract_prompt FROM settings WHERE profile_id = ?').get(req.profile.id) as { timezone: string; telegram_extract_prompt: string } | undefined;
  const tz = row?.timezone || 'UTC';

  if (newPrompt !== null && newPrompt.length > 0) {
    db.prepare(`UPDATE settings SET telegram_ingest_enabled = ?, telegram_extract_prompt = ? WHERE profile_id = ?`).run(enabled ? 1 : 0, newPrompt, req.profile.id);
  } else {
    db.prepare(`UPDATE settings SET telegram_ingest_enabled = ? WHERE profile_id = ?`).run(enabled ? 1 : 0, req.profile.id);
  }

  if (enabled) startTelegramIngestCron('30 5 * * *', tz);
  else stopTelegramIngestCron();

  res.json({ success: true, timezone: tz });
});

router.post('/telegram/fetch-now', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  if (!tryAcquirePoolLock('Telegram')) {
    return res.status(409).json({ error: `A ${getActivePoolFetch()} pool fetch is already running.` });
  }
  const runId = createRun({ kind: 'telegram', label: 'Telegram fetch', cancellable: false });
  res.json({ success: true, runId });
  emitToRun(runId, { msg: 'Telegram fetch started…' });
  runTelegramIngest(getDb())
    .then((r) => { console.log('[telegram] Manual fetch complete:', r); emitToRun(runId, { msg: `Done: ${JSON.stringify(r)}`, done: true }); })
    .catch((e) => { console.error('[telegram] Manual fetch error:', e); emitToRun(runId, { msg: `Failed: ${e.message}`, done: true }); })
    .finally(() => { releasePoolLock(); endRun(runId); });
});

router.get('/telegram/channels', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const channels = db.prepare(`SELECT channel_username, added_at, is_active FROM telegram_channels ORDER BY added_at DESC`).all();
  res.json({ channels });
});

router.post('/telegram/channels', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const username = (req.body as Record<string, unknown>).channel_username;
  if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,64}$/.test(username.trim())) {
    return res.status(400).json({ error: 'Invalid channel username.' });
  }
  const clean = username.trim().toLowerCase();
  const db = getDb();
  db.prepare(`INSERT INTO telegram_channels (channel_username) VALUES (?) ON CONFLICT(channel_username) DO UPDATE SET is_active = 1`).run(clean);
  res.json({ success: true, channel_username: clean });
});

router.delete('/telegram/channels/:username', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  db.prepare(`UPDATE telegram_channels SET is_active = 0 WHERE channel_username = ?`).run(req.params.username);
  res.json({ success: true });
});

router.get('/telegram/settings', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const row = db.prepare(`SELECT telegram_ingest_enabled, telegram_extract_prompt FROM settings WHERE profile_id = ?`).get(req.profile.id) as { telegram_ingest_enabled: number; telegram_extract_prompt: string } | undefined;
  res.json({ enabled: !!(row?.telegram_ingest_enabled), extract_prompt: row?.telegram_extract_prompt || '', fixed_schema: FIXED_SCHEMA_PROMPT });
});

// ── Region definitions (admin-only) ─────────────────────────────────────────

/**
 * Re-derives job_countries for an explicit set of job ids (diff-scoped re-derive).
 * Each job's labels are re-expanded via labelsToCountrySet, which resolves region
 * aliases to their canonical's members and country names/synonyms to countries.
 * Batched and pool-locked. Returns how many jobs were re-derived.
 */
async function reDeriveJobs(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = getDb();
  const BATCH = 100;
  let changed = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const batchIds = ids.slice(i, i + BATCH);
    await acquirePoolLock('region-re-derive');
    try {
      db.transaction(() => {
        for (const jobId of batchIds) {
          const labels = db.prepare<{ label: string }>(`SELECT label FROM job_locations WHERE job_id = ?`)
            .all(jobId).map((r) => r.label);
          db.prepare(`DELETE FROM job_countries WHERE job_id = ?`).run(jobId);
          for (const c of labelsToCountrySet(labels)) {
            db.prepare(`INSERT OR IGNORE INTO job_countries (job_id, country) VALUES (?, ?)`).run(jobId, c);
          }
          changed++;
        }
      });
    } finally {
      releasePoolLock();
    }
  }
  return changed;
}

/** Distinct job ids whose job_locations.label (lowercased) matches any changed key. */
function jobIdsForLabels(keys: string[]): number[] {
  if (keys.length === 0) return [];
  const db = getDb();
  const placeholders = keys.map(() => '?').join(',');
  return db.prepare<{ job_id: number }>(
    `SELECT DISTINCT job_id FROM job_locations WHERE LOWER(label) IN (${placeholders})`,
  ).all(...keys).map((r) => r.job_id);
}

/** All label keys (lowercased) a region's jobs may be tagged with: canonical name + its aliases. */
function regionLabelKeys(name: string): string[] {
  const db = getDb();
  const aliases = db.prepare<{ alias: string }>(
    `SELECT alias FROM region_aliases WHERE region_name = ? COLLATE NOCASE`,
  ).all(name).map((r) => r.alias.toLowerCase());
  return [...new Set([name.toLowerCase(), ...aliases])];
}

/** Re-derive every job tagged with a region (by canonical name or any alias). */
async function reDeriveRegion(regionName: string): Promise<number> {
  return reDeriveJobs(jobIdsForLabels(regionLabelKeys(regionName)));
}

router.get('/regions', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  // Canonical region set = region_definitions.name ∪ region_aliases.region_name, so
  // member-less regions (e.g. EMEA before populating) still list.
  const names = db.prepare<{ name: string }>(`
    SELECT name FROM (
      SELECT name AS name FROM region_definitions
      UNION
      SELECT region_name AS name FROM region_aliases
    ) GROUP BY LOWER(name) ORDER BY name ASC
  `).all();
  const regions = names.map(({ name }) => {
    const members = db.prepare<{ country: string; is_active: number }>(
      `SELECT country, is_active FROM region_definitions WHERE name = ? COLLATE NOCASE ORDER BY country ASC`,
    ).all(name);
    const aliases = db.prepare<{ alias: string }>(
      `SELECT alias FROM region_aliases WHERE region_name = ? COLLATE NOCASE ORDER BY alias ASC`,
    ).all(name).map((r) => r.alias);
    // Count jobs tagged with the canonical name OR any alias — same key set the
    // re-derive uses, so the displayed count matches what an edit re-derives.
    const labelKeys = [...new Set([name.toLowerCase(), ...aliases.map((a) => a.toLowerCase())])];
    const ph = labelKeys.map(() => '?').join(',');
    const affectedCount = (db.prepare<{ c: number }>(
      `SELECT COUNT(DISTINCT job_id) as c FROM job_locations WHERE LOWER(label) IN (${ph})`,
    ).get(...labelKeys) as { c: number }).c;
    return { name, members, aliases, affectedCount, is_active: members.some((m) => m.is_active) };
  });
  res.json({ regions });
});

/** Existing region's stored (canonical-cased) name matching `input` case-insensitively, or undefined. */
function existingRegionName(input: string): string | undefined {
  const db = getDb();
  const row = db.prepare<{ name: string }>(`
    SELECT name FROM (
      SELECT name FROM region_definitions
      UNION
      SELECT region_name AS name FROM region_aliases
    ) WHERE LOWER(name) = LOWER(?) LIMIT 1
  `).get(input) as { name: string } | undefined;
  return row?.name;
}

router.post('/regions/:name/members', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const body = req.body as Record<string, unknown>;
  const country = String(body.country || '').toLowerCase().trim();
  if (!country) return res.status(400).json({ error: 'country required' });
  // Reuse an existing region's stored casing so "emea" can't create a second "EMEA".
  const existing = existingRegionName(req.params.name);
  if (!existing) {
    // Creating a NEW region — guard the shared label namespace.
    if (isSourceCountry(req.params.name)) {
      return res.status(400).json({ error: `'${req.params.name}' is a country name; a region can't share a country's name.` });
    }
    const owner = canonicalRegion(req.params.name);
    if (owner) {
      return res.status(409).json({ error: `'${req.params.name}' is already an alias of region '${owner}'.` });
    }
  } else if (body.create === true) {
    // The Create-region form sets create=true; reject if the region already exists.
    return res.status(409).json({ error: `Region '${existing}' already exists — add countries from its card above.` });
  }
  const name = existing ?? req.params.name;
  const now = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO region_definitions (name, country, is_active, updated_at) VALUES (?, ?, 1, ?)`).run(name, country, now);
  loadLocationData(); // refresh in-memory caches before re-derive
  const changed = await reDeriveRegion(name);
  res.json({ success: true, changed });
});

router.delete('/regions/:name/members/:country', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const { name, country } = req.params;
  db.prepare(`DELETE FROM region_definitions WHERE name = ? COLLATE NOCASE AND country = ?`).run(name, country.toLowerCase());
  loadLocationData();
  const changed = await reDeriveRegion(name);
  res.json({ success: true, changed });
});

router.post('/regions/:name/toggle', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const name = req.params.name;
  const now = new Date().toISOString();
  const row = db.prepare<{ is_active: number }>(`SELECT MAX(is_active) as is_active FROM region_definitions WHERE name = ? COLLATE NOCASE`).get(name);
  const newActive = (row?.is_active ?? 1) === 1 ? 0 : 1;
  db.prepare(`UPDATE region_definitions SET is_active = ?, updated_at = ? WHERE name = ? COLLATE NOCASE`).run(newActive, now, name);
  res.json({ success: true, is_active: newActive });
});

router.get('/regions/:name/affected-count', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const name = req.params.name;
  const count = (db.prepare<{ c: number }>(
    `SELECT COUNT(DISTINCT job_id) as c FROM job_locations WHERE LOWER(label) = LOWER(?)`,
  ).get(name) as { c: number }).c;
  res.json({ count });
});

router.delete('/regions/:name', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const name = req.params.name;
  const keys = regionLabelKeys(name); // snapshot keys (incl. aliases) before delete
  db.prepare(`DELETE FROM region_definitions WHERE name = ? COLLATE NOCASE`).run(name);
  db.prepare(`DELETE FROM region_aliases WHERE region_name = ? COLLATE NOCASE`).run(name);
  loadLocationData();
  const changed = await reDeriveJobs(jobIdsForLabels(keys));
  res.json({ success: true, changed });
});

// Region aliases (admin-only): an alias lets another spelling resolve to the same
// region. Adding one also folds historical job_locations rows that used the alias
// spelling onto the canonical name, then re-derives them.
router.post('/regions/:name/aliases', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const name = req.params.name;
  const alias = String((req.body as Record<string, unknown>).alias || '').toLowerCase().trim();
  if (!alias) return res.status(400).json({ error: 'alias required' });
  if (alias === name.toLowerCase()) return res.status(400).json({ error: 'alias equals the region name' });
  // Collision guards (one label namespace): an alias must not already be a country
  // name or belong to another region — otherwise it would silently shadow/steal it.
  if (lookupCountry(alias)) {
    return res.status(400).json({ error: `'${alias}' is a country name; aliases must be region labels.` });
  }
  const owner = canonicalRegion(alias);
  if (owner && owner.toLowerCase() !== name.toLowerCase()) {
    return res.status(409).json({ error: `'${alias}' is already the region '${owner}'. Delete that region first to reuse the name.` });
  }
  const now = new Date().toISOString();
  // Jobs currently tagged with the alias spelling, captured before relabeling.
  const ids = jobIdsForLabels([alias]);
  db.transaction(() => {
    db.prepare(`INSERT OR REPLACE INTO region_aliases (alias, region_name, updated_at) VALUES (?, ?, ?)`).run(alias, name, now);
    // Fold alias-spelled labels onto the canonical name (OR IGNORE + delete collapses
    // a job that already carries both the canonical and the alias label).
    db.prepare(`UPDATE OR IGNORE job_locations SET label = ? WHERE LOWER(label) = ?`).run(name, alias);
    db.prepare(`DELETE FROM job_locations WHERE LOWER(label) = ?`).run(alias);
  });
  loadLocationData();
  const changed = await reDeriveJobs(ids);
  res.json({ success: true, changed });
});

router.delete('/regions/:name/aliases/:alias', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const { name } = req.params;
  const alias = String(req.params.alias || '').toLowerCase().trim();
  db.prepare(`DELETE FROM region_aliases WHERE alias = ? AND region_name = ? COLLATE NOCASE`).run(alias, name);
  loadLocationData();
  // Re-derive any job still tagged with the alias spelling (it no longer expands).
  const changed = await reDeriveJobs(jobIdsForLabels([alias]));
  res.json({ success: true, changed });
});

// ── Country synonyms (admin-only) ────────────────────────────────────────────
// Editor is driven off countries.json: one row per canonical country, with the
// lowercase synonyms that resolve to it. Add/remove persist one synonym at a time
// (guardrailed + diff-scoped re-derive), mirroring the region editor.

router.get('/country-synonyms', (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const rows = db.prepare<{ synonym: string; country: string }>(
    `SELECT synonym, country FROM country_synonyms`,
  ).all();
  const byCountry = new Map<string, string[]>();
  for (const { synonym, country } of rows) {
    if (!byCountry.has(country)) byCountry.set(country, []);
    byCountry.get(country)!.push(synonym);
  }
  const countries = getCanonicalCountries().map((country) => ({
    country,
    synonyms: (byCountry.get(country) || []).sort((a, b) => a.localeCompare(b)),
  }));
  res.json({ countries });
});

// Add one synonym → country (guardrailed + diff-scoped re-derive).
router.post('/country-synonyms', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const body = req.body as Record<string, unknown>;
  const synonym = String(body.synonym || '').toLowerCase().trim();
  const country = String(body.country || '').trim();
  if (!synonym || !country) return res.status(400).json({ error: 'synonym and country required' });
  if (!isSourceCountry(country)) return res.status(400).json({ error: `'${country}' is not a known country.` });
  if (synonym === country.toLowerCase()) return res.status(400).json({ error: 'synonym equals the country name' });
  // Guardrails (one label namespace): a synonym can't be a country name (countries.json
  // is the immutable source of truth) nor a region name/alias (it would shadow the region).
  if (isSourceCountry(synonym)) return res.status(400).json({ error: `'${synonym}' is a country name; it can't be a synonym.` });
  if (isRegionLabel(synonym)) return res.status(400).json({ error: `'${synonym}' is a region name; it can't be a synonym.` });
  // No silent steal: reject if it's already a synonym of a different country.
  const existing = db.prepare<{ country: string }>(`SELECT country FROM country_synonyms WHERE synonym = ?`).get(synonym) as { country: string } | undefined;
  if (existing && existing.country.toLowerCase() !== country.toLowerCase()) {
    return res.status(409).json({ error: `'${synonym}' is already a synonym of ${existing.country}.` });
  }
  db.prepare(`INSERT OR REPLACE INTO country_synonyms (synonym, country) VALUES (?, ?)`).run(synonym, country);
  loadLocationData();
  const changed = await reDeriveJobs(jobIdsForLabels([synonym]));
  res.json({ success: true, changed });
});

// Remove one synonym (diff-scoped re-derive).
router.delete('/country-synonyms/:synonym', async (req: Request, res: Response) => {
  if (!req.profile.isAdmin) return res.status(403).json({ error: 'Admin only.' });
  const db = getDb();
  const synonym = String(req.params.synonym || '').toLowerCase().trim();
  db.prepare(`DELETE FROM country_synonyms WHERE synonym = ?`).run(synonym);
  loadLocationData();
  const changed = await reDeriveJobs(jobIdsForLabels([synonym]));
  res.json({ success: true, changed });
});

export { router as apiRouter };
