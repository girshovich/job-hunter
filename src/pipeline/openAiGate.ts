/**
 * OpenAI scoring concurrency gate.
 *
 * Replaces the per-call `pLimit(SCORING_CONCURRENCY)` that `scoreJobs` and the runner's re-score
 * loop each built for themselves. That was a limit per *call site*, not per account: six concurrent
 * pipelines each took 5 and quietly made 30 — a number nobody chose and nothing enforced.
 *
 * **Keyed by API key *and model*, because that is how OpenAI meters.** Rate limits are published
 * per model × tier and the three models do not share them, so one bucket per key would have to pick
 * a single number for both models a run uses — `ai_model` for scoring, `ai_model_hard` for the
 * re-score pass. With the ceiling flapping between the two as phases alternate, one profile's
 * re-score would also raise the ceiling under another profile's scoring. Separate buckets are both
 * simpler and truer to the upstream limit.
 *
 * The consequence to keep in mind: "Tier 3 = 32" is 32 *per model*, so a key running scoring and
 * re-scoring at once can reach 64 in total. At ~2,500 tokens a call that is ~800K TPM per model
 * against 4M/2M budgets — comfortable. It is not an account-wide guarantee, and neither is it meant
 * to be: `companyEnrichment` (3) and `telegramExtract` (5) still hold their own limiters
 * (APIlimits.md caveat C4).
 */

import { KeyedGate } from './concurrencyGate';
import { OPENAI_FALLBACK_CONCURRENCY } from './limitTables';

const gate = new KeyedGate('openAiGate', OPENAI_FALLBACK_CONCURRENCY);

/**
 * Run `fn` against the budget for this key on this model. `concurrency` is the account's measured
 * ceiling for that model, from `resolveLimits().openAiConcurrencyFor(model)`.
 *
 * The key is part of the Map key and is a secret, so nothing here is ever logged — `KeyedGate`
 * prints only its label and the numbers.
 */
export function openAiGate<T>(apiKey: string, model: string, concurrency: number, fn: () => Promise<T>): Promise<T> {
  return gate.run(`${apiKey}::${model}`, concurrency, fn);
}
