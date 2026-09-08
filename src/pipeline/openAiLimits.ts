/**
 * OpenAI account-limit detection.
 *
 * There is no endpoint that reports an organisation's tier. But **every response carries the real
 * limits in its headers**, per model:
 *
 *     x-ratelimit-limit-requests: 5000        ← RPM
 *     x-ratelimit-limit-tokens:   4000000     ← TPM
 *
 * Those are the true, live, per-model figures — better than any self-reported tier, and they
 * reflect bespoke org limits a published table could never know. So we ask for them with a probe
 * that costs 16 output tokens, roughly $0.0003, once a month per account.
 *
 * **Per model, never per account.** `gpt-5.4-mini` and `gpt-5.6-terra` differ by 2x on the same
 * tier, so a single stored number applied to both would over-commit one of them.
 *
 * **What this cannot see:** the headers cover per-minute limits only. There is no RPD/TPD header,
 * so a Free-tier account's *daily* wall — the thing that actually stops it scoring 90 jobs — stays
 * invisible here and is explained in the scorer's error path instead (APIlimits.md C10).
 */

import OpenAI from 'openai';
import type { Database } from '../db';
import { concurrencyFromLimits, deriveOpenAiTier } from './limitTables';

/** A month. Tiers change when someone adds credit, which is rare and never urgent. */
export const OPENAI_LIMITS_TTL_MS = 30 * 24 * 3600_000;

const PROBE_TIMEOUT_MS = 10_000;
const FAILURE_BACKOFF_MS = 60 * 60_000;
const failedUntil = new Map<string, number>();

export interface ModelLimits {
  rpm: number;
  tpm: number;
  concurrency: number;
  at: string;
}

/** Stored as JSON on the settings row, keyed by model id. */
export type OpenAiLimitsMap = Record<string, ModelLimits>;

export function parseOpenAiLimits(json: string): OpenAiLimitsMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as OpenAiLimitsMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};   // a corrupt blob must degrade to "never measured", never throw at run start
  }
}

/** True when this model has no measurement, or one older than the TTL. */
export function isModelLimitStale(limits: OpenAiLimitsMap, model: string): boolean {
  const m = limits[model];
  if (!m?.at) return true;
  const age = Date.now() - Date.parse(m.at);
  return !Number.isFinite(age) || age >= OPENAI_LIMITS_TTL_MS;
}

/**
 * One minimal call, purely to read the rate-limit headers off the response. The answer is thrown
 * away; only the headers matter.
 */
async function probeModel(apiKey: string, model: string): Promise<ModelLimits | null> {
  const client = new OpenAI({ apiKey, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 });
  try {
    const { response } = await client.responses.create({
      model,
      input: [{ role: 'user', content: 'ok' }],
      max_output_tokens: 16,
    }).withResponse();

    const rpm = Number(response.headers.get('x-ratelimit-limit-requests'));
    const tpm = Number(response.headers.get('x-ratelimit-limit-tokens'));
    if (!Number.isFinite(rpm) || !Number.isFinite(tpm) || rpm <= 0 || tpm <= 0) {
      console.warn(`[openAiLimits] ${model}: response carried no usable rate-limit headers`);
      return null;
    }
    return { rpm, tpm, concurrency: concurrencyFromLimits(rpm, tpm), at: new Date().toISOString() };
  } catch (err) {
    console.warn(`[openAiLimits] ${model}: probe failed (${(err as Error).message.slice(0, 120)})`);
    return null;
  }
}

/**
 * Probe the given models and merge the results into the row's stored map.
 *
 * **Merged, never replaced.** In credits mode every profile resolves to the admin row while running
 * whatever models it likes, so one profile's probe must add to what another profile measured rather
 * than wipe it. Each entry carries its own timestamp for the same reason.
 *
 * Returns the merged map **and the models this call actually measured**. The two are not the same:
 * a failed probe leaves the stored map untouched — so a bad afternoon at OpenAI cannot downgrade an
 * account with good numbers on file — which means a model can be present in `limits` from an
 * earlier run while this call learned nothing. Callers that need to know whether *this* key works,
 * like the Test button, must look at `measured`, or they will pronounce a dead key healthy on the
 * strength of a month-old reading. Never throws.
 */
export async function refreshOpenAiLimits(
  db: Database,
  profileId: number,
  apiKey: string,
  models: string[],
  opts: { honourBackoff?: boolean } = {},
): Promise<{ limits: OpenAiLimitsMap; measured: string[] }> {
  const row = db.prepare('SELECT openai_limits_json FROM settings WHERE profile_id = ?')
    .get(profileId) as { openai_limits_json: string } | undefined;
  const existing = parseOpenAiLimits(row?.openai_limits_json ?? '');

  if (!apiKey) return { limits: existing, measured: [] };

  // Only the automatic run-start path backs off. Pressing "Test key" is a request to look now.
  if (opts.honourBackoff && Date.now() < (failedUntil.get(apiKey) ?? 0)) return { limits: existing, measured: [] };

  const wanted = [...new Set(models.filter(Boolean))];
  const results = await Promise.all(wanted.map((m) => probeModel(apiKey, m)));

  const merged: OpenAiLimitsMap = { ...existing };
  const measured: string[] = [];
  results.forEach((r, i) => {
    if (r) { merged[wanted[i]] = r; measured.push(wanted[i]); }
  });

  if (measured.length === 0) {
    failedUntil.set(apiKey, Date.now() + FAILURE_BACKOFF_MS);
    return { limits: existing, measured };
  }
  failedUntil.delete(apiKey);

  // The tier is a label for the UI, derived from every model measured so far. It decides nothing.
  const tier = deriveOpenAiTier(merged);
  db.prepare(`
    UPDATE settings SET openai_limits_json = ?, openai_limits_checked_at = ?, openai_tier = ?
    WHERE profile_id = ?
  `).run(JSON.stringify(merged), new Date().toISOString(), tier, profileId);

  console.log(
    `[openAiLimits] measured ${Object.entries(merged).map(([m, v]) => `${m}=${v.concurrency}`).join(' ')}`
    + `${tier ? ` (${tier})` : ' (no matching tier — bespoke limits)'}`,
  );
  return { limits: merged, measured };
}
