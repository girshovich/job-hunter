import { randomUUID } from 'crypto';

export interface AtsProgressEvent {
  msg: string;
  done?: boolean;
  cancelled?: boolean;
  inserted?: number;
  skipped?: number;
  processed?: number;
  total?: number;
  active?: number;
  dead?: number;
  errors?: number;
}

const LOG_CAP = 200;
const STALE_MS = 15 * 60 * 1000; // staleness watchdog: clear a run only if it stops emitting
                                 // for this long (genuinely wedged). A healthy long run keeps
                                 // emitting progress, so it is NEVER cleared — only a stalled one.

export interface AtsRun {
  type: 'discovery' | 'validation';      // existing, unused — leave it
  kind: string;                          // dedup + reattach key
  label: string;
  unit: string;                          // 'boards' | 'locations' | ''
  startedAt: number;
  lastEmitAt: number;                    // updated on every emit; drives the staleness watchdog
  cancellable: boolean;                  // drives whether the UI shows Stop
  cancelled: boolean;
  done: boolean;
  progress: { processed: number; total: number } | null;
  log: string[];
  listeners: Set<(data: string) => void>;
}

export const activeRuns = new Map<string, AtsRun>();

function makeRun(o: { kind: string; label: string; unit?: string; cancellable: boolean }): AtsRun {
  return { type: 'discovery', kind: o.kind, label: o.label, unit: o.unit ?? '',
    startedAt: Date.now(), lastEmitAt: Date.now(), cancellable: o.cancellable, cancelled: false, done: false,
    progress: null, log: [], listeners: new Set() };
}

/** Guarded create (per-kind). Returns runId, or null if that kind is already running. */
export function tryStartRun(o: { kind: string; label: string; unit?: string; cancellable: boolean }): string | null {
  if (findActiveByKind(o.kind)) return null;
  const runId = randomUUID();
  activeRuns.set(runId, makeRun(o));
  return runId;
}

/** Unguarded create — for jobs whose guard is poolLock (pool fetches, telegram). */
export function createRun(o: { kind: string; label: string; unit?: string; cancellable: boolean }): string {
  const runId = randomUUID();
  activeRuns.set(runId, makeRun(o));
  return runId;
}

/** Clear a run (call from .finally). */
export function endRun(runId: string): void {
  const run = activeRuns.get(runId);
  if (run) run.done = true;
  setTimeout(() => activeRuns.delete(runId), 5_000);
}

export function findActiveByKind(kind: string): AtsRun | undefined {
  for (const r of activeRuns.values()) if (r.kind === kind && !r.done) return r;
  return undefined;
}

export function listActiveRuns() {
  const out = [];
  for (const [runId, r] of activeRuns.entries()) {
    if (r.done) continue;
    out.push({ runId, kind: r.kind, label: r.label, unit: r.unit, cancellable: r.cancellable,
      startedAt: r.startedAt, progress: r.progress });
  }
  return out;
}

export function cancelRun(runId: string): boolean {
  const r = activeRuns.get(runId);
  if (!r) return false;
  r.cancelled = true;
  // Push a terminal event now so a connected client stops spinning immediately, instead of
  // waiting for the work loop's next isCancelled check (which breaks out and skips the final emit).
  emitToRun(runId, { msg: 'Cancelled.', done: true, cancelled: true });
  return true;
}

export function isCancelled(runId: string): boolean {
  return activeRuns.get(runId)?.cancelled ?? false;
}

export function emitToRun(runId: string, event: AtsProgressEvent): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  run.lastEmitAt = Date.now();   // proves the run is alive — resets the staleness timer
  if (event.msg) { run.log.push(event.msg); if (run.log.length > LOG_CAP) run.log.shift(); }
  if (typeof event.total === 'number') {
    run.progress = { processed: event.processed ?? run.progress?.processed ?? 0, total: event.total };
  }
  if (event.done) run.done = true;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const listener of run.listeners) {
    listener(payload);
  }
}

// Staleness watchdog: clear a run only when it has gone SILENT (no emit) for STALE_MS — i.e. it
// is genuinely wedged. A healthy long run keeps emitting progress, so its lastEmitAt stays fresh
// and it is never touched. Does NOT stop the underlying work (best-effort safety net only).
// Emits a terminal done so any connected client stops spinning. One timer for the whole map.
setInterval(() => {
  const now = Date.now();
  for (const [runId, run] of activeRuns.entries()) {
    if (!run.done && now - run.lastEmitAt > STALE_MS) {
      emitToRun(runId, { msg: '[watchdog] no progress — clearing stalled run', done: true, cancelled: true });
    }
  }
}, 60_000).unref();
