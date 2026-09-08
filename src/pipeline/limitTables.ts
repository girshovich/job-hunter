/**
 * Turning a provider account's measured limits into a concurrency ceiling, and into a label a
 * person can read.
 *
 * **Nothing here is a user setting.** Both providers are asked directly what they allow — Apify via
 * `GET /v2/users/me/limits`, OpenAI via the `x-ratelimit-limit-*` headers on any real call — and
 * that answer wins. The tables below exist for two narrow jobs: naming the plan or tier we
 * measured, and a conservative floor for an account we have never managed to ask.
 *
 * They are hand-maintained and they will go stale — Apify cut Free from 25 to 5 and still documents
 * 25 — which is exactly why they no longer decide anything. Derivations from them are shown only
 * when unambiguous; a number matching nothing prints no name at all rather than a wrong one.
 */

// ── Concurrency from measured limits ─────────────────────────────────────────

/**
 * Concurrent scoring calls a model's published limits support.
 *
 *   concurrency = min(TPM / 25,000, RPM / 10) × 0.6,  floor 1, cap 32
 *
 * The inputs (APIlimits.md §3.1): ~2,500 tokens per scoring call measured across 2,055 stored
 * descriptions, an assumed 6s per call, and a 0.6 utilisation factor carrying that assumption's
 * uncertainty. RPM binds first on small accounts, TPM on large ones.
 *
 * **The cap at 32 is deliberate and is what binds from Tier 2 up.** Uncapped, a Tier 3 account
 * would allow 96 — but the median run scores 11 jobs, so concurrency past ~32 buys seconds inside a
 * 20-minute run while a 429 costs whole postings. Seconds gained against job data lost: stay low.
 */
export function concurrencyFromLimits(rpm: number, tpm: number): number {
  if (!(rpm > 0) || !(tpm > 0)) return OPENAI_FALLBACK_CONCURRENCY;
  const raw = Math.min(tpm / 25_000, rpm / 10) * 0.6;
  return Math.max(1, Math.min(32, Math.floor(raw)));
}

/** An account we have never successfully measured. Conservative on purpose. */
export const OPENAI_FALLBACK_CONCURRENCY = 4;
export const APIFY_FALLBACK_CONCURRENCY = 4;

/**
 * One slot is held back below the account's real ceiling, preserving the 24-of-25 convention the
 * gate shipped with: a run started by hand from the Apify console must still fit.
 */
export function apifyConcurrencyFromCeiling(ceiling: number): number {
  return ceiling > 0 ? Math.max(1, ceiling - 1) : APIFY_FALLBACK_CONCURRENCY;
}

// ── Naming what we measured ──────────────────────────────────────────────────

/**
 * TPM per tier × model, read off platform.openai.com on 2026-09-08.
 *
 * Used **only** to put a name on measured headers. Note the collision this avoids: 4M TPM means
 * Tier 3 on `gpt-5.4-mini` but Tier 4 on `gpt-5.6-terra`, so a tier can never be derived without
 * knowing which model reported it.
 */
export const OPENAI_TIER_TPM: Record<string, Record<string, number>> = {
  free:  { 'gpt-5.6-luna':      60_000, 'gpt-5.4-mini':     100_000, 'gpt-5.6-terra':     10_000 },
  tier1: { 'gpt-5.6-luna':     500_000, 'gpt-5.4-mini':     200_000, 'gpt-5.6-terra':    500_000 },
  tier2: { 'gpt-5.6-luna':   2_000_000, 'gpt-5.4-mini':   2_000_000, 'gpt-5.6-terra':  1_000_000 },
  tier3: { 'gpt-5.6-luna':   4_000_000, 'gpt-5.4-mini':   4_000_000, 'gpt-5.6-terra':  2_000_000 },
  tier4: { 'gpt-5.6-luna':  10_000_000, 'gpt-5.4-mini':  10_000_000, 'gpt-5.6-terra':  4_000_000 },
  tier5: { 'gpt-5.6-luna': 180_000_000, 'gpt-5.4-mini': 180_000_000, 'gpt-5.6-terra': 40_000_000 },
};

export const OPENAI_TIER_LABELS: Record<string, string> = {
  free: 'Free tier', tier1: 'Tier 1', tier2: 'Tier 2', tier3: 'Tier 3', tier4: 'Tier 4', tier5: 'Tier 5',
};

/**
 * The tier every measured model agrees on, or `''` when they do not agree, when a model is not in
 * the table, or when nothing matches exactly.
 *
 * Unanimity is a free confidence check: three models independently landing on the same tier is
 * strong evidence, and any disagreement means the account has bespoke limits — in which case we
 * print no tier rather than pick one. Verified against the operator's account, where mini (4M),
 * luna (4M) and terra (2M) all resolve to tier3.
 */
export function deriveOpenAiTier(perModel: Record<string, { tpm: number }>): string {
  const votes = new Set<string>();
  for (const [model, m] of Object.entries(perModel)) {
    const tier = Object.keys(OPENAI_TIER_TPM).find((t) => OPENAI_TIER_TPM[t][model] === m.tpm);
    if (!tier) return '';
    votes.add(tier);
  }
  return votes.size === 1 ? [...votes][0] : '';
}

/**
 * Apify account ceilings per published plan (`maxConcurrentActorJobs`), used only for naming.
 *
 * Free is the post-2026 figure; the docs still say 25. Anything not matching exactly is a
 * negotiated plan and gets no name — the operator's own account reports 29, which is no published
 * plan at all.
 */
export const APIFY_PLAN_CEILING: Record<string, number> = {
  free: 5, starter: 32, scale: 128, business: 256,
};

export const APIFY_PLAN_LABELS: Record<string, string> = {
  free: 'Free', starter: 'Starter', scale: 'Scale', business: 'Business',
};

/** The plan whose published ceiling matches exactly, or `''` for a negotiated one. */
export function deriveApifyPlan(ceiling: number): string {
  return Object.keys(APIFY_PLAN_CEILING).find((p) => APIFY_PLAN_CEILING[p] === ceiling) ?? '';
}

// ── Describing it to a person ────────────────────────────────────────────────

export interface LimitLine {
  /** "Tier 3", "Starter", or '' when the measurement matches no published plan. */
  name: string;
  /** What it means in work we do, never in tokens. */
  capability: string;
  /** ISO timestamp of the measurement, or '' if never measured. */
  checkedAt: string;
  /** Something the user should act on. Usually ''. */
  warning: string;
}

/**
 * Turn measured limits into two lines a job-seeker can read.
 *
 * **Never shows raw TPM.** "4,000,000 tokens per minute" tells a user nothing; "up to 32 jobs
 * scored at once" tells them exactly what it buys. The tier or plan name is shown alongside only
 * when the measurement matches a published figure exactly — a negotiated account gets the
 * capability with no name, because a confidently wrong plan label is worse than none.
 *
 * `softModel` is the model that scores every job, so its number is the one that describes a run.
 */
export function describeAccountLimits(
  limits: {
    apifyConcurrency: number; apifyConcurrencyDetected: number; apifyCheckedAt: string; apifyPlan: string;
    openAiTier: string; openAiLimits: Record<string, { at: string }>;
    openAiConcurrencyFor(model: string): number;
  },
  softModel: string,
): { apify: LimitLine; openai: LimitLine } {
  const measuredApify = limits.apifyConcurrencyDetected > 0 && !!limits.apifyCheckedAt;
  const scoring = limits.openAiConcurrencyFor(softModel);

  // Per model, not per row. An account can have `gpt-5.4-mini` on file and have never been asked
  // about `gpt-5.6-luna` — reading a row-level "checked at" would then date-stamp a number that is
  // really the fallback, which reads as a measurement and is not one.
  const softEntry = limits.openAiLimits[softModel];
  const measuredOpenAi = !!softEntry?.at;

  return {
    apify: {
      name: measuredApify ? (APIFY_PLAN_LABELS[limits.apifyPlan] ?? '') : '',
      capability: measuredApify
        ? `up to ${limits.apifyConcurrency} job searches at once`
        : `not measured yet — using a safe default of ${limits.apifyConcurrency}`,
      checkedAt: measuredApify ? limits.apifyCheckedAt : '',
      warning: '',
    },
    openai: {
      name: measuredOpenAi ? (OPENAI_TIER_LABELS[limits.openAiTier] ?? '') : '',
      capability: measuredOpenAi
        ? `up to ${scoring} job${scoring === 1 ? '' : 's'} scored at once`
        : `not measured yet — using a safe default of ${scoring}`,
      checkedAt: measuredOpenAi ? softEntry.at : '',
      // The one case worth interrupting someone about: a free OpenAI account cannot finish a
      // normal run, and no concurrency setting can fix that (APIlimits.md §3.1.1).
      warning: limits.openAiTier === 'free'
        ? 'Free OpenAI accounts also have a small daily cap, so larger runs may stop part-way. Adding credit to the account lifts both limits.'
        : '',
    },
  };
}
