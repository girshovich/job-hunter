import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Database } from '../db';
import { emitToRun, isCancelled } from './atsRunState';

// The Python script lives at the root of the Node app directory.
// Override with LEVER_SCRIPT_PATH env var if needed.
function findScript(): string {
  const custom = process.env.LEVER_SCRIPT_PATH;
  if (custom) return custom;
  return path.resolve(process.cwd(), 'build_lever_company_base.py');
}

function slugToName(slug: string): string {
  return slug
    .replace(/-\d+$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface RawCsvRow {
  company_name: string;
  lever_slug: string;
}

function readRawCsv(csvPath: string): RawCsvRow[] {
  const lines = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const slugIdx = headers.indexOf('lever_slug');
  const nameIdx = headers.indexOf('company_name');
  const rows: RawCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const slug = cols[slugIdx]?.trim();
    if (!slug) continue;
    rows.push({
      lever_slug:   slug,
      company_name: cols[nameIdx]?.trim() || slugToName(slug),
    });
  }
  return rows;
}

export async function runLeverDiscovery(
  db: Database,
  runId?: string,
): Promise<{ inserted: number; skipped: number }> {
  const scriptPath = findScript();

  if (!fs.existsSync(scriptPath)) {
    const msg = `Python script not found at ${scriptPath}. Set LEVER_SCRIPT_PATH env var or place build_lever_company_base.py in the parent directory.`;
    console.error('[lever-discovery]', msg);
    if (runId) emitToRun(runId, { msg, done: true });
    throw new Error(msg);
  }

  const scriptDir  = path.dirname(scriptPath);
  const rawCsvPath = path.join(scriptDir, 'lever_slugs_raw.csv');

  // Brief pause so the client's EventSource has time to connect before we emit.
  await new Promise((r) => setTimeout(r, 600));

  console.log('[lever-discovery] Starting HuggingFace discovery via Python script');
  if (runId) emitToRun(runId, { msg: 'Fetching company list from HuggingFace… (takes about 2 minutes)' });

  const scriptArgs = ['--skip-validation', '--output', path.join(scriptDir, 'lever_companies.csv')];

  // Priority: LEVER_PYTHON_CMD env var → uv (checks common paths) → python3 fallback
  function buildCommand(): [string, string[]] {
    if (process.env.LEVER_PYTHON_CMD)
      return [process.env.LEVER_PYTHON_CMD, [scriptPath, ...scriptArgs]];

    const uvCandidates = [
      process.env.UV_PATH,
      '/root/.local/bin/uv',
      `${process.env.HOME}/.local/bin/uv`,
      '/usr/local/bin/uv',
    ].filter(Boolean) as string[];

    for (const p of uvCandidates) {
      try { fs.accessSync(p, fs.constants.X_OK); return [p, ['run', '--with', 'duckdb', '--with', 'pandas', '--with', 'aiohttp', '--with', 'tqdm', scriptPath, ...scriptArgs]]; }
      catch { /* try next */ }
    }

    // Fall back to plain python3 (e.g. macOS dev with pip-installed packages)
    return ['python3', [scriptPath, ...scriptArgs]];
  }

  const [cmd, args] = buildCommand();
  console.log(`[lever-discovery] Using command: ${cmd}`);
  await new Promise<void>((resolve, reject) => {
  const proc = cp.spawn(cmd, args, { cwd: scriptDir });

    proc.stdout.on('data', (chunk: Buffer) => {
      // Log Python output to server console only — not surfaced in the UI
      const line = chunk.toString().trim();
      if (line) console.log('[lever-discovery]', line);
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.log('[lever-discovery]', line);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Script exited with code ${code}`));
    });

    proc.on('error', (err) => reject(
      new Error(`Failed to spawn "${cmd}": ${err.message}`)
    ));
  }).catch((err: Error) => {
    const msg = err.message;
    console.error('[lever-discovery]', msg);
    if (runId) emitToRun(runId, { msg, done: true });
    throw err;
  });

  if (!fs.existsSync(rawCsvPath)) {
    const msg = `lever_slugs_raw.csv not found after script run (expected at ${rawCsvPath})`;
    if (runId) emitToRun(runId, { msg, done: true });
    throw new Error(msg);
  }

  const csvRows = readRawCsv(rawCsvPath);
  if (runId) emitToRun(runId, { msg: `Found ${csvRows.length.toLocaleString()} companies. Saving to database…` });

  const upsert = db.prepare(`
    INSERT INTO ats_boards (ats, slug, company_name, is_active, discovered_at)
    VALUES ('lever', ?, ?, 1, ?)
    ON CONFLICT (ats, slug) DO NOTHING
  `);

  let inserted = 0;
  let skipped  = 0;
  const now = new Date().toISOString();

  for (const row of csvRows) {
    if (runId && isCancelled(runId)) break;
    const result = upsert.run(row.lever_slug, row.company_name, now) as { changes: number };
    if (result.changes > 0) inserted++;
    else skipped++;
  }

  const cancelled = runId ? isCancelled(runId) : false;
  const doneMsg   = cancelled
    ? `Cancelled — ${inserted.toLocaleString()} new companies added`
    : inserted > 0
      ? `Done — ${inserted.toLocaleString()} new companies added (${skipped.toLocaleString()} already known)`
      : `Done — no new companies (all ${skipped.toLocaleString()} already in database)`;

  console.log(`[lever-discovery] inserted=${inserted} skipped=${skipped}`);
  if (runId) emitToRun(runId, { msg: doneMsg, done: true, cancelled, inserted, skipped });
  return { inserted, skipped };
}
