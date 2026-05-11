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

  console.log('[lever-discovery] Starting HuggingFace discovery via Python script');
  if (runId) emitToRun(runId, { msg: 'Querying HuggingFace dataset via Python (this takes ~2 min)…' });

  await new Promise<void>((resolve, reject) => {
    // Use uv run (no venv needed) if available, otherwise fall back to python3.
  // Set LEVER_PYTHON_CMD env var to override (e.g. a venv path).
  const pythonCmd = process.env.LEVER_PYTHON_CMD;
  const [cmd, args] = pythonCmd
    ? [pythonCmd, [scriptPath, '--skip-validation', '--output', path.join(scriptDir, 'lever_companies.csv')]]
    : ['uv',      ['run', '--with', 'duckdb', '--with', 'pandas', scriptPath, '--skip-validation', '--output', path.join(scriptDir, 'lever_companies.csv')]];

  const proc = cp.spawn(cmd, args, { cwd: scriptDir });

    proc.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        console.log('[lever-discovery]', line);
        if (runId && !isCancelled(runId)) emitToRun(runId, { msg: line });
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      // Python progress bars and warnings go to stderr — show as info, not errors
      const line = chunk.toString().trim();
      if (line) console.log('[lever-discovery]', line);
    });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Python script exited with code ${code}`));
    });

    proc.on('error', (err) => reject(err));
  });

  if (!fs.existsSync(rawCsvPath)) {
    const msg = `lever_slugs_raw.csv not found after script run (expected at ${rawCsvPath})`;
    if (runId) emitToRun(runId, { msg, done: true });
    throw new Error(msg);
  }

  const csvRows = readRawCsv(rawCsvPath);
  if (runId) emitToRun(runId, { msg: `${csvRows.length} slugs found. Inserting into database…` });

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
    ? `Cancelled — ${inserted} new, ${skipped} already known`
    : `Done — ${inserted} new, ${skipped} already known`;

  console.log(`[lever-discovery] inserted=${inserted} skipped=${skipped}`);
  if (runId) emitToRun(runId, { msg: doneMsg, done: true, cancelled, inserted, skipped });
  return { inserted, skipped };
}
