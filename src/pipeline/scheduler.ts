/**
 * Cron Scheduler — start/stop scheduled pipeline runs, one cron instance per profile.
 * Singleton module so state persists across API requests.
 */

import cron from 'node-cron';
import { runPipeline } from './runner';
import type { DateRange } from './fetcher';

interface ScheduleEntry {
  job: ReturnType<typeof cron.schedule>;
  expression: string;
  timezone: string;
  dateRange: DateRange;
  groupIds: number[];
  providers: string[];
}

const schedules = new Map<number, ScheduleEntry>();

export function startSchedule(
  profileId: number,
  expression: string,
  timezone: string,
  dateRange: DateRange = '24h',
  groupIds: number[] = [],
  providers: string[] = [],
): void {
  stopSchedule(profileId);

  if (!cron.validate(expression)) {
    console.warn(`[cron] Invalid expression: "${expression}" — using fallback "0 7 * * *"`);
    expression = '0 7 * * *';
  }

  const job = cron.schedule(expression, () => {
    const jitterMs = Math.floor(Math.random() * 10 * 60_000); // 0–10 min
    console.log(`[cron] Profile ${profileId} fired; delaying ${Math.round(jitterMs / 1000)}s (jitter)`);
    // stop() cancels future cron fires but not an already-scheduled setTimeout; that run completes normally
    setTimeout(() => {
      console.log(`[cron] Profile ${profileId} triggered at ${new Date().toISOString()}`);
      runPipeline('scheduled', profileId, {
        dateRange,
        groupIds: groupIds.length > 0 ? groupIds : undefined,
        providers: providers.length > 0 ? providers : undefined,
      }).catch((err) =>
        console.error(`[cron] Profile ${profileId} pipeline failed:`, err),
      );
    }, jitterMs);
  }, { timezone });

  schedules.set(profileId, { job, expression, timezone, dateRange, groupIds, providers });
  console.log(`[cron] Profile ${profileId} schedule started: "${expression}" (${timezone})`);
}

export function stopSchedule(profileId: number): void {
  const entry = schedules.get(profileId);
  if (entry) {
    entry.job.stop();
    schedules.delete(profileId);
    console.log(`[cron] Profile ${profileId} schedule stopped.`);
  }
}

export function getScheduleStatus(profileId: number): {
  active: boolean;
  expression: string | null;
  timezone: string | null;
  dateRange: DateRange | null;
  groupIds: number[] | null;
  providers: string[] | null;
} {
  const entry = schedules.get(profileId);
  return {
    active: !!entry,
    expression: entry?.expression ?? null,
    timezone: entry?.timezone ?? null,
    dateRange: entry?.dateRange ?? null,
    groupIds: entry?.groupIds ?? null,
    providers: entry?.providers ?? null,
  };
}
