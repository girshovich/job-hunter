import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';
import { resolveAshbyCompanyName } from './ashbyCompanyName';

interface AtsBoard {
  id: number;
  ats: string;
  slug: string;
  company_name: string | null;
  is_active: number;
}

const ENDPOINTS: Record<string, (slug: string) => string> = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  lever:      (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  ashby:      (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
};

async function withConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (queue.length) {
      if (shouldStop?.()) return;
      const item = queue.shift()!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function extractCompanyName(ats: string, slug: string, body: unknown): Promise<string | null> {
  if (ats === 'ashby') {
    return resolveAshbyCompanyName(slug, body as { organization?: { name?: string } } | null);
  }
  if (ats === 'greenhouse') {
    try {
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const board = await res.json() as { name?: string };
        return board?.name ?? null;
      }
    } catch { /* ignore */ }
    return null;
  }
  if (ats === 'lever') {
    return slug
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return null;
}

export async function runValidation(db: Database, runId?: string): Promise<{ active: number; dead: number; errors: number }> {
  console.log('[ats-validation] Starting validation run');

  const rows = db.prepare<AtsBoard>(`
    SELECT id, ats, slug, company_name, is_active FROM ats_boards
    WHERE is_active = 1
       OR (is_active = 0 AND (validated_at IS NULL OR validated_at < datetime('now', '-30 days')))
  `).all();

  console.log(`[ats-validation] Validating ${rows.length} boards`);
  if (runId) emitToRun(runId, { msg: `Validating ${rows.length} boards…`, total: rows.length, processed: 0 });

  let active = 0;
  let dead = 0;
  let errors = 0;
  let processed = 0;

  const setDead = db.prepare(`UPDATE ats_boards SET is_active = 0, validated_at = ? WHERE id = ?`);
  const setActive = db.prepare(`
    UPDATE ats_boards
    SET is_active = 1, company_name = COALESCE(?, company_name), validated_at = ?
    WHERE id = ?
  `);

  const emitProgress = () => {
    if (!runId) return;
    emitToRun(runId, { msg: `${processed}/${rows.length} checked — ${active} active, ${dead} dead, ${errors} errors`, processed, total: rows.length, active, dead, errors });
  };

  await withConcurrency(rows, 10, async (row) => {
    const url = ENDPOINTS[row.ats]?.(row.slug);
    if (!url) { errors++; processed++; if (processed % 50 === 0) emitProgress(); return; }

    const now = new Date().toISOString();
    let res: Response;

    try {
      res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      errors++; processed++; if (processed % 50 === 0) emitProgress();
      return;
    }

    if (res.status === 404) {
      setDead.run(now, row.id);
      dead++; processed++; if (processed % 50 === 0) emitProgress();
      return;
    }

    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      } catch {
        errors++; processed++; if (processed % 50 === 0) emitProgress();
        return;
      }
      if (res.status === 429) {
        errors++; processed++; if (processed % 50 === 0) emitProgress();
        return;
      }
    }

    if (!res.ok) {
      errors++; processed++; if (processed % 50 === 0) emitProgress();
      return;
    }

    const body = await res.json().catch(() => null);
    const companyName = await extractCompanyName(row.ats, row.slug, body);
    setActive.run(companyName, now, row.id);
    active++; processed++; if (processed % 50 === 0) emitProgress();
  }, runId ? () => isCancelled(runId) : undefined);

  const cancelled = runId ? isCancelled(runId) : false;
  const doneMsg = cancelled
    ? `Cancelled — ${processed}/${rows.length} checked (${active} active, ${dead} dead, ${errors} errors)`
    : `Done — ${active} active, ${dead} dead, ${errors} errors`;

  console.log(`[ats-validation] Done. active=${active} dead=${dead} errors=${errors}`);
  if (runId) emitToRun(runId, { msg: doneMsg, done: true, cancelled, active, dead, errors, processed, total: rows.length });
  return { active, dead, errors };
}
