import cron from 'node-cron';
import { runDiscovery } from './atsDiscovery';
import { runLeverDiscovery } from './leverDiscovery';
import { runValidation } from './atsValidation';
import { fetchGreenhousePool, fetchAshbyPool } from './atsPoolFetcher';
import { acquirePoolLock, releasePoolLock } from './poolLock';
import { runTelegramIngest } from './telegramIngest';
import { getDb } from '../db';

let discoveryTask:        ReturnType<typeof cron.schedule> | null = null;
let leverDiscoveryTask:   ReturnType<typeof cron.schedule> | null = null;
let validationTask:       ReturnType<typeof cron.schedule> | null = null;
let ghPoolTask:           ReturnType<typeof cron.schedule> | null = null;
let ashbyPoolTask:        ReturnType<typeof cron.schedule> | null = null;
let telegramIngestTask:   ReturnType<typeof cron.schedule> | null = null;

export function startAtsDiscoveryCron(expression: string, timezone = 'UTC'): void {
  discoveryTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[ats-discovery] Invalid cron expression "${expression}" — using fallback "0 8 1 * *"`);
    expression = '0 8 1 * *';
  }
  discoveryTask = cron.schedule(expression, async () => {
    console.log('[ats-discovery] Starting scheduled discovery run');
    try {
      const result = await runDiscovery(getDb());
      console.log('[ats-discovery] Done:', result);
    } catch (err) {
      console.error('[ats-discovery] Error:', err);
    }
  }, { timezone });
  console.log(`[ats-discovery] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopAtsDiscoveryCron(): void {
  discoveryTask?.stop();
  discoveryTask = null;
  console.log('[ats-discovery] Cron stopped');
}

export function startLeverDiscoveryCron(expression: string, timezone = 'UTC'): void {
  leverDiscoveryTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[lever-discovery] Invalid cron expression "${expression}" — using fallback "0 8 1 * *"`);
    expression = '0 8 1 * *';
  }
  leverDiscoveryTask = cron.schedule(expression, async () => {
    console.log('[lever-discovery] Starting scheduled discovery run');
    try {
      const result = await runLeverDiscovery(getDb());
      console.log('[lever-discovery] Done:', result);
    } catch (err) {
      console.error('[lever-discovery] Error:', err);
    }
  }, { timezone });
  console.log(`[lever-discovery] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopLeverDiscoveryCron(): void {
  leverDiscoveryTask?.stop();
  leverDiscoveryTask = null;
  console.log('[lever-discovery] Cron stopped');
}

export function startAtsValidationCron(expression: string, timezone = 'UTC'): void {
  validationTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[ats-validation] Invalid cron expression "${expression}" — using fallback "0 8 * * 0"`);
    expression = '0 8 * * 0';
  }
  validationTask = cron.schedule(expression, async () => {
    console.log('[ats-validation] Starting scheduled validation run');
    try {
      const result = await runValidation(getDb());
      console.log('[ats-validation] Done:', result);
    } catch (err) {
      console.error('[ats-validation] Error:', err);
    }
  }, { timezone });
  console.log(`[ats-validation] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopAtsValidationCron(): void {
  validationTask?.stop();
  validationTask = null;
  console.log('[ats-validation] Cron stopped');
}

export function startGhPoolCron(expression: string, timezone = 'UTC'): void {
  ghPoolTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[gh-pool] Invalid cron expression "${expression}" — using fallback "0 5 * * *"`);
    expression = '0 5 * * *';
  }
  ghPoolTask = cron.schedule(expression, async () => {
    console.log('[gh-pool] Starting scheduled Greenhouse pool fetch');
    await acquirePoolLock('Greenhouse');
    try {
      const result = await fetchGreenhousePool(getDb());
      console.log('[gh-pool] Done:', result);
    } catch (err) {
      console.error('[gh-pool] Error:', err);
    } finally {
      releasePoolLock();
    }
  }, { timezone });
  console.log(`[gh-pool] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopGhPoolCron(): void {
  ghPoolTask?.stop();
  ghPoolTask = null;
  console.log('[gh-pool] Cron stopped');
}

export function startAshbyPoolCron(expression: string, timezone = 'UTC'): void {
  ashbyPoolTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[ashby-pool] Invalid cron expression "${expression}" — using fallback "0 5 * * *"`);
    expression = '0 5 * * *';
  }
  ashbyPoolTask = cron.schedule(expression, async () => {
    console.log('[ashby-pool] Starting scheduled Ashby pool fetch');
    await acquirePoolLock('Ashby');
    try {
      const result = await fetchAshbyPool(getDb());
      console.log('[ashby-pool] Done:', result);
    } catch (err) {
      console.error('[ashby-pool] Error:', err);
    } finally {
      releasePoolLock();
    }
  }, { timezone });
  console.log(`[ashby-pool] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopAshbyPoolCron(): void {
  ashbyPoolTask?.stop();
  ashbyPoolTask = null;
  console.log('[ashby-pool] Cron stopped');
}

export function startTelegramIngestCron(expression: string, timezone = 'UTC'): void {
  telegramIngestTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[telegram-ingest] Invalid cron expression "${expression}" — using fallback "0 5 * * *"`);
    expression = '0 5 * * *';
  }
  telegramIngestTask = cron.schedule(expression, async () => {
    console.log('[telegram-ingest] Starting scheduled ingest run');
    try {
      const result = await runTelegramIngest(getDb());
      console.log('[telegram-ingest] Done:', result);
    } catch (err) {
      console.error('[telegram-ingest] Error:', err);
    }
  }, { timezone });
  console.log(`[telegram-ingest] Cron scheduled: "${expression}" (${timezone})`);
}

export function stopTelegramIngestCron(): void {
  telegramIngestTask?.stop();
  telegramIngestTask = null;
  console.log('[telegram-ingest] Cron stopped');
}

export function startPoolCleanupCron(): void {
  // Always-on: delete unclaimed pool jobs older than 30 days
  cron.schedule('0 3 * * *', () => {
    try {
      const db = getDb();
      const result = db.prepare(`
        DELETE FROM jobs
        WHERE job_source IN ('Greenhouse', 'Ashby', 'Telegram')
          AND fetched_at < datetime('now', '-30 days')
          AND id NOT IN (SELECT job_id FROM job_profile_states)
      `).run() as { changes: number };
      if (result.changes > 0)
        console.log(`[pool-cleanup] Deleted ${result.changes} stale pool jobs`);

      const postsResult = db.prepare(`
        DELETE FROM telegram_posts
        WHERE last_seen_at < datetime('now', '-5 days')
      `).run() as { changes: number };
      if (postsResult.changes > 0)
        console.log(`[pool-cleanup] Deleted ${postsResult.changes} stale telegram posts`);
    } catch (err) {
      console.error('[pool-cleanup] Error:', err);
    }
  }, { timezone: 'UTC' });
  console.log('[pool-cleanup] Cleanup cron scheduled: daily at 03:00 UTC');
}
