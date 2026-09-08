/**
 * A counting semaphore whose ceiling can change while work is in flight, plus the keyed registry
 * both provider gates are built from.
 *
 * ⚠ **This exists because `p-limit` cannot do it.** `p-limit@3.1.0` exposes no `concurrency`
 * accessor: `limiter.concurrency = 10` succeeds, changes nothing, and throws nothing — four tasks
 * queued behind a limit of 1 still run one at a time. The writable property arrived in p-limit v4,
 * which is pure ESM while this project is CommonJS (`tsconfig.json` → `"module": "commonjs"`), so
 * upgrading is a migration rather than a version bump.
 *
 * Do not "simplify" the gates back to `p-limit`. The bug that reintroduces is invisible to any test
 * that restarts the process between limit changes, which is most of them.
 *
 * `release()` hands its slot straight to the next waiter rather than decrementing and letting the
 * waiter re-acquire — the same trick as `runQueue.ts`, so a slot cannot be stolen in between.
 */
export class Semaphore {
  active = 0;
  pending = 0;
  private waiters: Array<() => void> = [];

  constructor(public max: number) {}

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    this.pending++;
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    // Pass the slot on only if the ceiling still has room for it. After a lowering, `active` can
    // sit above `max`; handing the slot along there would keep the gate over-committed forever.
    if (this.waiters.length > 0 && this.active <= this.max) {
      const next = this.waiters.shift()!;
      this.pending--;
      next();              // slot passes directly to the waiter — `active` is unchanged
    } else {
      this.active--;
    }
  }

  /** Admit whatever the current ceiling now has room for. Safe to call at any time. */
  drain(): void {
    while (this.waiters.length > 0 && this.active < this.max) {
      const next = this.waiters.shift()!;
      this.pending--;
      this.active++;
      next();
    }
  }

  /**
   * Raise or lower the ceiling. Raising admits parked waiters at once; lowering never interrupts
   * work already running, it just stops admitting until `active` falls back below `max`.
   */
  setMax(max: number): void {
    if (max <= 0 || max === this.max) return;
    this.max = max;
    this.drain();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
      // A lowering can leave waiters parked while `active` is still above `max`; once it drops back
      // under, `release` alone would never wake them.
      this.drain();
    }
  }
}

/**
 * A registry of semaphores keyed by whatever shares the budget — an Apify token, an OpenAI
 * key+model pair. The key is the thing the provider actually meters, never the run or the profile.
 */
export class KeyedGate {
  private gates = new Map<string, Semaphore>();

  constructor(private label: string, private fallbackMax: number) {}

  /** Run `fn` against `key`'s budget, updating that budget's ceiling to `max` first. */
  run<T>(key: string, max: number, fn: () => Promise<T>): Promise<T> {
    const gate = this.for(key, max);
    return gate.run(fn);
  }

  /** The semaphore for `key`, created on first use and re-ceilinged on every later call. */
  for(key: string, max: number): Semaphore {
    let gate = this.gates.get(key);
    if (!gate) {
      gate = new Semaphore(max > 0 ? max : this.fallbackMax);
      this.gates.set(key, gate);
    } else if (max > 0 && max !== gate.max) {
      console.log(
        `[${this.label}] ceiling ${gate.max} → ${max} (${gate.active} active, ${gate.pending} queued)`,
      );
      gate.setMax(max);
    }
    return gate;
  }

  /** Calls running or waiting on `key`. A snapshot, stale the moment it is read. */
  outstanding(key: string): number {
    const gate = this.gates.get(key);
    return gate ? gate.active + gate.pending : 0;
  }
}
