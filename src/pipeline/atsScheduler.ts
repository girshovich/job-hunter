import cron from 'node-cron';
import { runDiscovery } from './atsDiscovery';
import { runValidation } from './atsValidation';
import { getDb } from '../db';

let discoveryTask: ReturnType<typeof cron.schedule> | null = null;
let validationTask: ReturnType<typeof cron.schedule> | null = null;

export function startAtsDiscoveryCron(expression: string): void {
  discoveryTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[ats-discovery] Invalid cron expression "${expression}" — using fallback "0 3 1 * *"`);
    expression = '0 3 1 * *';
  }
  discoveryTask = cron.schedule(expression, async () => {
    console.log('[ats-discovery] Starting scheduled discovery run');
    try {
      const result = await runDiscovery(getDb());
      console.log('[ats-discovery] Done:', result);
    } catch (err) {
      console.error('[ats-discovery] Error:', err);
    }
  });
  console.log(`[ats-discovery] Cron scheduled: "${expression}"`);
}

export function stopAtsDiscoveryCron(): void {
  discoveryTask?.stop();
  discoveryTask = null;
  console.log('[ats-discovery] Cron stopped');
}

export function startAtsValidationCron(expression: string): void {
  validationTask?.stop();
  if (!cron.validate(expression)) {
    console.warn(`[ats-validation] Invalid cron expression "${expression}" — using fallback "0 4 * * 1"`);
    expression = '0 4 * * 1';
  }
  validationTask = cron.schedule(expression, async () => {
    console.log('[ats-validation] Starting scheduled validation run');
    try {
      const result = await runValidation(getDb());
      console.log('[ats-validation] Done:', result);
    } catch (err) {
      console.error('[ats-validation] Error:', err);
    }
  });
  console.log(`[ats-validation] Cron scheduled: "${expression}"`);
}

export function stopAtsValidationCron(): void {
  validationTask?.stop();
  validationTask = null;
  console.log('[ats-validation] Cron stopped');
}
