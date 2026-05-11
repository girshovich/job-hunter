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

export interface AtsRun {
  type: 'discovery' | 'validation';
  cancelled: boolean;
  listeners: Set<(data: string) => void>;
}

export const activeRuns = new Map<string, AtsRun>();

export function emitToRun(runId: string, event: AtsProgressEvent): void {
  const run = activeRuns.get(runId);
  if (!run) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const listener of run.listeners) {
    listener(payload);
  }
}

export function isCancelled(runId: string): boolean {
  return activeRuns.get(runId)?.cancelled ?? false;
}
