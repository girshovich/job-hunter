/**
 * Shared fan-out control for the live description hydration the three ATS pool providers do.
 *
 * Pool jobs carry no description until claimed (PRD §7.13), so a run fetches them per board at
 * query time. The original `Promise.all(entries.map(...))` fired every board at once: with 2 500+
 * boards in the pool a broad search opened thousands of simultaneous connections to a single host,
 * and one request that neither resolved, rejected nor aborted wedged the whole run indefinitely
 * (observed: two runs parked 35 and 68 minutes at 0% CPU with no open sockets).
 *
 * Both guarantees below are load-bearing. The worker pool stops the stampede; the deadline race is
 * what actually bounds the call, because the per-request 15s abort demonstrably was not enough.
 */

const HYDRATE_CONCURRENCY = 10;
const HYDRATE_DEADLINE_MS = 90_000;

export interface HydrationOutcome {
  hydrated: number;
  total: number;
}

export async function hydrateBoards<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
): Promise<HydrationOutcome> {
  if (items.length === 0) return { hydrated: 0, total: 0 };

  const queue = items.slice();
  let hydrated = 0;
  let expired = false;

  let reachDeadline!: () => void;
  const deadline = new Promise<void>((resolve) => { reachDeadline = resolve; });
  const timer = setTimeout(() => { expired = true; reachDeadline(); }, HYDRATE_DEADLINE_MS);

  // Workers must never throw. Once the deadline wins the race these promises are orphaned, and a
  // late rejection with nothing left to catch it surfaces as an unhandled rejection.
  const workers = Array.from({ length: Math.min(HYDRATE_CONCURRENCY, queue.length) }, async () => {
    while (queue.length && !expired) {
      const item = queue.shift()!;
      try {
        await fn(item);
        hydrated++;
      } catch { /* best-effort: the row keeps whatever description it already had */ }
    }
  });

  try {
    await Promise.race([Promise.all(workers), deadline]);
  } finally {
    clearTimeout(timer);
  }

  return { hydrated, total: items.length };
}
