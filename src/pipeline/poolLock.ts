// In-memory mutex ensuring only one ATS pool fetch runs at a time (single Node process).

let active: string | null = null;
const waiters: Array<() => void> = [];

/** The source currently holding the lock, or null. For 409 messages. */
export function getActivePoolFetch(): string | null {
  return active;
}

/** Non-blocking acquire. Returns true if acquired, false if a fetch is already running. */
export function tryAcquirePoolLock(source: string): boolean {
  if (active) return false;
  active = source;
  return true;
}

/** Queuing acquire. Resolves once the lock is held. Use for cron so runs serialize. */
export function acquirePoolLock(source: string): Promise<void> {
  if (!active) {
    active = source;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active = source;
      resolve();
    });
  });
}

/** Release the lock and hand it to the next queued waiter, if any. */
export function releasePoolLock(): void {
  active = null;
  const next = waiters.shift();
  if (next) next();
}
