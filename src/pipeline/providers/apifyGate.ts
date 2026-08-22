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
 * In-process only: a second Node process (blue/green deploy overlap, pm2 cluster) gets its own
 * limiter and its own budget.
 */

import pLimit from 'p-limit';

// 25 is the free-tier ceiling; 24 leaves one slot for anything started outside the gate, such as a
// manual run from the Apify console. Raise it to the plan's real ceiling. Note `0` falls through
// to the default — to disable the gate, set a large number.
export const APIFY_CONCURRENCY_LIMIT = Number(process.env.APIFY_CONCURRENCY) || 24;

const gates = new Map<string, ReturnType<typeof pLimit>>();

export function apifyGate<T>(token: string, fn: () => Promise<T>): Promise<T> {
  let limit = gates.get(token);
  if (!limit) {
    limit = pLimit(APIFY_CONCURRENCY_LIMIT);
    gates.set(token, limit);
  }
  return limit(fn);
}

/**
 * Calls already running or waiting on this token — i.e. how much of the budget is spoken for.
 * **Read it before enqueueing a batch:** `p-limit` starts nothing until the next microtask, so a
 * count taken straight after enqueue reports the whole batch as pending and is useless. A
 * snapshot, stale the moment it is read — for a human reading logs, not for anything automated.
 */
export function apifyOutstandingCount(token: string): number {
  const limit = gates.get(token);
  return limit ? limit.activeCount + limit.pendingCount : 0;
}
