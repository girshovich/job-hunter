// Global in-process concurrency gate for pipeline + fetch-preview work.
// One chokepoint so no trigger path can exceed the cap. Swap internals for
// BullMQ/Redis later without touching callers.
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT_RUNS) || 6;

let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) {
    next();        // hand the slot directly to the next waiter (active stays the same)
  } else {
    active--;
  }
}

/** Run `fn` once a slot is free; release the slot when it settles. */
export async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

export function queueStats(): { active: number; waiting: number; max: number } {
  return { active, waiting: waiters.length, max: MAX_CONCURRENT };
}
