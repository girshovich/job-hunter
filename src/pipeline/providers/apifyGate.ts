/**
 * Apify concurrency gate.
 *
 * Apify caps concurrent Actor runs **per account**, and nothing else in the pipeline models that
 * ceiling: valig, indeed and stepstone each fan out their whole `keyword × location` grid in one
 * `Promise.all`, and harvestapi adds one more call. Providers and roles run sequentially inside a
 * pipeline, but `MAX_CONCURRENT_RUNS` pipelines can be in flight at once and in credits mode they
 * all resolve to the operator's token — so the gate is keyed by **token**, not by run or provider.
 * A per-run limiter would not hold the account-wide ceiling.
 *
 * The ceiling used to be the module constant `APIFY_CONCURRENCY_LIMIT` (24, sized for Apify's old
 * free tier). It is now a per-account setting resolved by `resolveLimits` and passed in on every
 * call, so it can change while the process is running — the user edits their Apify plan, or
 * detection reports a different number. See `concurrencyGate.ts` for why that rules out `p-limit`.
 *
 * In-process only: a second Node process (blue/green deploy overlap, pm2 cluster) gets its own
 * limiter and its own budget.
 */

import { KeyedGate } from '../concurrencyGate';
import { APIFY_FALLBACK_CONCURRENCY } from '../limitTables';

const gate = new KeyedGate('apifyGate', APIFY_FALLBACK_CONCURRENCY);

/**
 * The providers that actually queue behind this gate. The other four (`greenhouse`, `ashby`,
 * `lever`, `telegram`) filter a locally-held pool in SQL and start no Actor at all, so a run made
 * only of those never consults the ceiling — and must not pay to discover it.
 *
 * Keep in step with the imports of `apifyGate` across `pipeline/providers/`.
 */
export const APIFY_PROVIDERS = new Set(['harvestapi', 'valig', 'indeed', 'stepstone']);

/**
 * Run `fn` against this token's budget. `limit` is the account's current ceiling, from
 * `resolveLimits`; passing a different one re-ceilings the gate in place, with no restart and
 * without disturbing work already running.
 */
export function apifyGate<T>(token: string, limit: number, fn: () => Promise<T>): Promise<T> {
  return gate.run(token, limit, async () => {
    try {
      return await fn();
    } catch (err) {
      // Rewritten here rather than in each provider: every gated call passes through this one
      // point, and the raw actor error ("You will exceed your limit of N concurrent Actor runs")
      // reaches the user as an opaque provider failure that says nothing about the setting that
      // caused it. The gate is also the only place that knows the ceiling it was enforcing.
      if (isApifyConcurrencyError(err)) throw new ApifyConcurrencyError(err, limit);
      throw err;
    }
  });
}

/**
 * Apify refused a run because the account is already at its concurrent-run ceiling.
 *
 * That is a *configuration* failure, not an outage: the Apify plan setting claims more headroom
 * than the account has. It is also expensive to hit — a provider's grid goes out as one
 * `Promise.all`, so one rejection unwinds the whole wave while its siblings keep billing.
 */
export class ApifyConcurrencyError extends Error {
  constructor(public readonly cause: unknown, enforcedLimit: number) {
    super(
      `${(cause as Error)?.message ?? String(cause)} — your Apify plan setting may be too high. ` +
      `We allowed ${enforcedLimit} concurrent Actor run(s); the account refused at that level. ` +
      `Lower the Apify plan in Settings, or check the account's real limit.`,
    );
    this.name = 'ApifyConcurrencyError';
  }
}

/** True for both the raw actor error and our wrapped form. */
export function isApifyConcurrencyError(err: unknown): boolean {
  if (err instanceof ApifyConcurrencyError) return true;
  const msg = (err as Error)?.message ?? '';
  return /exceed your limit of \d+ concurrent actor runs/i.test(msg)
    || /concurrent actor runs?\b.*\blimit/i.test(msg);
}

/**
 * Calls already running or waiting on this token — i.e. how much of the budget is spoken for.
 * **Read it before enqueueing a batch:** a gated call does not start until the next microtask, so a
 * count taken straight after enqueue reports the whole batch as pending and is useless. A snapshot,
 * stale the moment it is read — for a human reading logs, not for anything automated.
 */
export function apifyOutstandingCount(token: string): number {
  return gate.outstanding(token);
}
